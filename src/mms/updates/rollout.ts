import { randomUUID } from 'node:crypto'
import { NetError } from '../../shared/net/errors'
import type { SshRecordView, SshUpdateResult } from '../../shared/net/local'
import { compareVersions, isDevBuild } from '../../shared/net/version'
import {
  isReleaseVersion,
  parseRemoteUpdateStatus,
  remoteUpdateLimits,
  type RemoteUpdateError,
  type RemoteUpdateLimits,
  type RemoteUpdateStatus
} from '../../shared/remoteUpdates'
import {
  canRetryRow,
  isRowActive,
  parseRollout,
  rolloutTargets,
  SELF_NODE,
  type Rollout,
  type RolloutRow,
  type RolloutView
} from '../../shared/updateRollout'
import type { SelfUpdateReport } from '../../shared/updates'
import type { UpdateThereParams } from './askUpdate'
import type { RemoteUpdates } from './remoteUpdates'

/** A computer as `bridge.nodes` lists it (both networkings). */
export interface RolloutPeer {
  node: string
  name?: string
  kind: string
  self: boolean
  revoked: boolean
  state: string
  version?: string
  update?: SelfUpdateReport
  olderThanThis?: boolean
  otherChannel?: boolean
}

/** Where the rollout is kept: one row of the profile's database (`rolloutStore.ts`). */
export interface RolloutStore {
  read(): unknown
  write(value: Rollout | null): void
}

export interface RolloutDeps {
  store: RolloutStore
  peers(): Promise<RolloutPeer[]>
  sshRecords(): Promise<SshRecordView[]>
  /** `net.update.there` on whichever networking reaches the computer. */
  ask(params: UpdateThereParams): Promise<unknown>
  sshUpdate(id: string, version: string): Promise<SshUpdateResult>
  /** This home's update requests: this computer's own part goes through its app like another computer's. */
  hub: RemoteUpdates
  selfName(): string
  /** The version this service runs. */
  version(): string
  /** The rollout changed: windows read it again. */
  changed(): void
  limits?: RemoteUpdateLimits
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  newId?: () => string
}

/** One short line per reason a computer stopped. */
const ERROR_TEXT: Record<RemoteUpdateError, string> = {
  not_accepting: "Mousse isn't open there",
  busy: 'Already updating',
  version_unavailable: "Its update feed doesn't offer this version",
  download_failed: 'Download failed',
  install_failed: "Didn't install",
  expired: 'Timed out',
  forbidden: 'Needs Full control there',
  cancelled: 'Cancelled',
  unknown_job: 'Its update request was lost'
}

const UNREACHABLE = 'unreachable' as const
type Reach<T> = T | typeof UNREACHABLE

const atLeast = (version: string | undefined, target: string): boolean => {
  const order = version ? compareVersions(version, target) : undefined
  return order === 0 || order === 1
}

/**
 * Update everywhere for one profile (#476, step 3). Keeps one rollout, saved in the profile's database, and drives
 * it: every computer downloads the exact version in parallel (this one through its own app); once the person
 * confirmed and all are ready, or the prepare deadline passed, the ready ones install, machines set up over SSH are
 * installed from here, and this computer restarts last, only when it needs the version. Each computer's version is
 * then asked of that computer again; no answer reads "Couldn't verify", corrected when it later reports the version.
 * A computer that was offline, failed or was cancelled is updated again only by its row's retry.
 *
 * Nothing runs at startup: a rollout this service finds after a restart resumes the first time a window reads it.
 */
export class UpdateRollouts {
  private current: Rollout | null | undefined
  /** The rollout this process started; one found unconfirmed after a restart is dropped. */
  private owned: string | null = null
  private running: Promise<void> | null = null
  private readonly retrying = new Set<string>()
  /** Rollouts cancelled or dismissed: a call still under way for one never saves it back. */
  private readonly dropped = new Set<string>()
  private lastReverify = 0
  private starting = false
  private stopped = false
  private readonly limits: RemoteUpdateLimits
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly newId: () => string

  constructor(private readonly deps: RolloutDeps) {
    this.limits = deps.limits ?? remoteUpdateLimits()
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()))
    this.newId = deps.newId ?? randomUUID
  }

  /** The rollout, and with none under way (or a finished one), the rows a rollout to `target` would have. */
  async view(target?: string): Promise<RolloutView> {
    const rollout = this.load()
    if (rollout) this.resume(rollout)
    const kept = this.load()
    if (kept && kept.step !== 'done') return { rollout: kept }
    return { rollout: kept, ...(target ? { plan: await this.plan(target) } : {}) }
  }

  /** Starts a rollout to `target`: every computer downloads; nothing installs before `confirm`. */
  async start(target: string): Promise<Rollout> {
    if (!isReleaseVersion(target) || isDevBuild(target)) throw new NetError('bad_request')
    const kept = this.load()
    // The same confirmation opened again before anyone confirmed: the same rollout.
    if (kept?.step === 'preparing' && !kept.confirmedAt && kept.version === target && this.owned === kept.id) return kept
    if (this.starting || (kept && kept.step !== 'done')) throw new NetError('conflict', 'An update of your computers is already under way.')
    this.starting = true
    let rows: RolloutRow[]
    try {
      rows = await this.plan(target, { fresh: true })
    } finally {
      this.starting = false
    }
    if (!rolloutTargets(rows).some((row) => row.node !== SELF_NODE)) throw new NetError('bad_request', 'No other computer can be updated from here.')
    // A finished rollout's results give way to the new one.
    if (this.load()) this.save(null)
    const rollout: Rollout = { id: this.newId(), version: target, startedAt: this.now(), step: 'preparing', rows }
    this.owned = rollout.id
    this.save(rollout)
    await Promise.all(rows.map((row) => this.prepareRow(rollout, row)))
    this.save(rollout)
    this.resume(rollout)
    return rollout
  }

  /**
   * The person confirmed, having seen `turns` running on each computer (by node). More than that are waited for there;
   * a computer without a count shown stops none.
   */
  confirm(turns: Record<string, number>): Rollout {
    const rollout = this.require()
    if (rollout.step !== 'preparing' || rollout.confirmedAt) throw new NetError('conflict')
    rollout.confirmedAt = this.now()
    for (const row of rollout.rows) {
      const count = turns[row.node]
      row.consentedTurns = Number.isSafeInteger(count) && count >= 0 ? count : 0
    }
    this.save(rollout)
    this.resume(rollout)
    return rollout
  }

  /**
   * Before confirming: every request is dropped and so is the rollout. After: computers that have not started
   * installing stop and show Cancelled; those installing go on and are verified.
   */
  async cancel(): Promise<void> {
    const rollout = this.load()
    if (!rollout || rollout.step === 'done') return
    const pending = rollout.rows.filter((row) => row.phase === 'downloading' || row.phase === 'ready')
    await Promise.all(pending.map((row) => this.cancelJob(row)))
    if (!rollout.confirmedAt) {
      this.owned = null
      this.save(null)
      return
    }
    for (const row of pending) Object.assign(row, { phase: 'failed', error: ERROR_TEXT.cancelled, percent: undefined })
    rollout.step = rollout.rows.some(isRowActive) ? 'verifying' : 'done'
    this.save(rollout)
  }

  /** A failed, unverified or offline computer, again: its version and access are asked first. */
  retry(node: string): Rollout {
    const rollout = this.require()
    const row = rollout.rows.find((item) => item.node === node)
    if (!row || !canRetryRow(row) || this.retrying.has(node)) throw new NetError('bad_request')
    // Before the person confirmed, nothing installs.
    if (!rollout.confirmedAt) throw new NetError('conflict')
    this.retrying.add(node)
    Object.assign(row, { phase: 'downloading', error: undefined, percent: undefined, installedAt: undefined })
    if (rollout.step === 'done') rollout.step = 'verifying'
    this.save(rollout)
    void this.retryRow(rollout, row)
      .catch(() => Object.assign(row, { phase: 'failed', error: "Couldn't reach it" }))
      .finally(() => {
        this.retrying.delete(node)
        this.save(rollout)
        this.resume(rollout)
      })
    this.resume(rollout)
    return rollout
  }

  /** Results are read: the finished rollout goes. */
  dismiss(): void {
    const rollout = this.load()
    if (!rollout) return
    if (rollout.step !== 'done') throw new NetError('conflict')
    this.owned = null
    this.save(null)
  }

  stop(): void {
    this.stopped = true
  }

  // ------------------------------------------------------------------ planning

  /** The computers below `target` on this channel, each with how it gets the version. */
  async plan(target: string, opts: { fresh?: boolean } = {}): Promise<RolloutRow[]> {
    if (!isReleaseVersion(target) || isDevBuild(target)) return []
    const rows: RolloutRow[] = []
    const mine = this.deps.version()
    if (!isDevBuild(mine) && compareVersions(mine, target) === -1) {
      const takes = this.deps.hub.accepts()
      rows.push({
        node: SELF_NODE,
        name: this.deps.selfName(),
        via: takes ? 'self' : 'manual',
        from: mine,
        phase: takes ? 'ready' : 'manual',
        ...(takes ? {} : { error: "This app can't install updates" })
      })
    }
    const [peers, records] = await Promise.all([
      this.deps.peers().catch(() => [] as RolloutPeer[]),
      this.deps.sshRecords().catch(() => [] as SshRecordView[])
    ])
    const seen = new Set<string>()
    for (const peer of peers) {
      if (peer.self || peer.revoked || peer.kind === 'phone' || seen.has(peer.node) || peer.otherChannel) continue
      if (peer.version && isDevBuild(peer.version)) continue
      const below = peer.version ? compareVersions(peer.version, target) === -1 : peer.olderThanThis === true
      if (!below) continue
      seen.add(peer.node)
      rows.push(await this.planRow(peer, records, opts.fresh === true))
    }
    return rows
  }

  private async planRow(peer: RolloutPeer, records: SshRecordView[], fresh: boolean): Promise<RolloutRow> {
    const base = { node: peer.node, name: peer.name || 'Another computer', ...(peer.version ? { from: peer.version } : {}) }
    const record = records.find((item) => item.node === peer.node && item.owner === 'managed')
    if (record) return { ...base, via: 'ssh', phase: 'ready', sshId: record.id }
    const online = peer.state === 'open'
    let update = peer.update
    // Its app may have opened since it last said: asked again when the rollout starts.
    if (fresh && online && update?.self && !update.requests) {
      const answer = await this.freshInfo(peer.node)
      if (answer !== UNREACHABLE && answer.update) update = answer.update
    }
    if (online && update?.requests) return { ...base, via: 'request', phase: 'ready' }
    if (!online && update?.self) return { ...base, via: 'request', phase: 'offline', error: 'Offline' }
    const error = update?.self === false ? (update.reason ?? "Can't update itself") : !peer.version || (online && !update) ? 'Too old to update from here' : online ? "Mousse isn't open there" : 'Offline'
    return { ...base, via: 'manual', phase: 'manual', error }
  }

  // ------------------------------------------------------------------ driving

  private resume(rollout: Rollout): void {
    if (this.running || this.stopped) return
    if (rollout.step === 'done') {
      this.reverify(rollout)
      return
    }
    // Started by a service that has stopped since, before anyone confirmed: nobody waits on it.
    if (rollout.step === 'preparing' && !rollout.confirmedAt && this.owned !== rollout.id) {
      void this.cancel()
      return
    }
    this.running = this.run(rollout)
      .catch((error) => console.warn('Update everywhere stopped:', error instanceof Error ? error.message : String(error)))
      .finally(() => {
        this.running = null
      })
  }

  private live(rollout: Rollout): boolean {
    return !this.stopped && this.current?.id === rollout.id
  }

  private async run(rollout: Rollout): Promise<void> {
    while (this.live(rollout)) {
      switch (rollout.step) {
        case 'preparing':
          await this.pollPrepare(rollout)
          if (!this.live(rollout)) return
          if (!rollout.confirmedAt) {
            // Never confirmed within a request's lifetime: the requests have expired there too.
            if (this.now() > rollout.startedAt + this.limits.requestTtlMs) {
              await this.cancel()
              return
            }
          } else if (!rollout.rows.some((row) => row.phase === 'downloading') || this.now() >= rollout.startedAt + this.limits.rolloutPrepareMs) {
            rollout.step = 'installing'
            this.save(rollout)
            continue
          }
          await this.sleep(this.limits.pollMs)
          break
        case 'installing':
          await this.install(rollout)
          break
        case 'restarting':
        case 'verifying':
          await this.verify(rollout)
          if (!this.live(rollout)) return
          if (!rollout.rows.some(isRowActive)) {
            rollout.step = 'done'
            this.save(rollout)
            return
          }
          await this.sleep(this.limits.pollMs)
          break
        case 'done':
          return
      }
    }
  }

  private async prepareRow(rollout: Rollout, row: RolloutRow): Promise<void> {
    if (row.phase !== 'ready' || (row.via !== 'self' && row.via !== 'request')) return
    try {
      const status =
        row.via === 'self'
          ? this.deps.hub.prepare({ node: SELF_NODE, name: row.name, stillAllowed: () => true, local: true }, rollout.version, rollout.id)
          : await this.askStatus({ node: row.node, step: 'prepare', version: rollout.version, rollout: rollout.id })
      this.apply(row, status)
    } catch {
      Object.assign(row, { phase: 'failed', error: "Couldn't reach it" })
    }
  }

  /** Reads each downloading or ready computer's request again. */
  private async pollPrepare(rollout: Rollout): Promise<void> {
    const rows = rollout.rows.filter((row) => (row.phase === 'downloading' || row.phase === 'ready') && row.job && row.via !== 'ssh')
    const before = JSON.stringify(rollout)
    await Promise.all(
      rows.map(async (row) => {
        const status = await this.statusOf(row)
        if (status !== UNREACHABLE) this.apply(row, status)
      })
    )
    if (JSON.stringify(rollout) !== before) this.save(rollout)
  }

  private async install(rollout: Rollout): Promise<void> {
    // Not ready by the deadline: left out, its request dropped.
    for (const row of rollout.rows.filter((item) => item.phase === 'downloading')) {
      await this.cancelJob(row)
      Object.assign(row, { phase: 'failed', error: "Didn't download in time", percent: undefined })
    }
    this.save(rollout)
    await Promise.all(
      rollout.rows
        .filter((row) => row.via === 'request' && row.phase === 'ready')
        .map(async (row) => {
          try {
            this.apply(row, await this.askStatus({ node: row.node, step: 'install', job: row.job, runningTurns: row.consentedTurns ?? 0 }))
          } catch {
            // No answer: it may have started. Its version, asked later, says.
            row.phase = 'installing'
          }
          if (row.phase === 'installing') row.installedAt = this.now()
        })
    )
    this.save(rollout)
    // One at a time: each SSH update holds this computer's SSH setup until it ends.
    for (const row of rollout.rows) {
      if (!this.live(rollout)) return
      if (row.via !== 'ssh' || row.phase !== 'ready' || !row.sshId) continue
      Object.assign(row, { phase: 'installing', installedAt: this.now() })
      this.save(rollout)
      await this.sshInstall(rollout, row)
      this.save(rollout)
    }
    await this.waitForCountdowns(rollout)
    if (!this.live(rollout)) return
    const self = rollout.rows.find((row) => row.via === 'self' && row.phase === 'ready' && row.job)
    if (self) {
      // This computer last: the service stops for the installer once its app starts it.
      rollout.step = 'restarting'
      Object.assign(self, { phase: 'installing', installedAt: this.now() })
      this.save(rollout)
      this.apply(self, this.deps.hub.install(SELF_NODE, self.job!, self.consentedTurns ?? 0))
    } else rollout.step = 'verifying'
    this.save(rollout)
  }

  /** The others count down before this computer restarts, so their status is still read here. */
  private async waitForCountdowns(rollout: Rollout): Promise<void> {
    const until = this.now() + this.limits.countdownMs + this.limits.callDeadlineMs
    const counting = new Set(rollout.rows.filter((row) => row.via === 'request' && row.phase === 'installing').map((row) => row.node))
    while (counting.size && this.now() < until && this.live(rollout)) {
      for (const row of rollout.rows.filter((item) => counting.has(item.node))) {
        const status = await this.statusOf(row)
        if (status === UNREACHABLE || (status.phase !== 'countdown' && status.phase !== 'waiting')) counting.delete(row.node)
        if (status !== UNREACHABLE) this.apply(row, status)
      }
      this.save(rollout)
      if (counting.size) await this.sleep(this.limits.pollMs)
    }
  }

  private async sshInstall(rollout: Rollout, row: RolloutRow): Promise<void> {
    try {
      const result = await this.deps.sshUpdate(row.sshId!, rollout.version)
      if (result.ok && atLeast(result.version, rollout.version)) Object.assign(row, { phase: 'updated', error: undefined })
      else Object.assign(row, { phase: 'failed', error: result.detail ?? ERROR_TEXT.install_failed })
    } catch (error) {
      Object.assign(row, { phase: 'failed', error: error instanceof Error ? error.message.split('\n')[0] : ERROR_TEXT.install_failed })
    }
  }

  /**
   * Each installing or unverified computer, asked again: its request while it lasts, then its version, from that
   * computer itself. At or past the target is updated; no answer past the reconnect deadline is "Couldn't verify".
   */
  private async verify(rollout: Rollout): Promise<void> {
    const rows = rollout.rows.filter((row) => row.phase === 'installing' || row.phase === 'unverified')
    const before = JSON.stringify(rollout)
    await Promise.all(rows.map((row) => this.verifyRow(rollout, row)))
    if (JSON.stringify(rollout) !== before) this.save(rollout)
  }

  private async verifyRow(rollout: Rollout, row: RolloutRow): Promise<void> {
    const target = rollout.version
    if (row.via === 'self') {
      const status = row.job ? this.deps.hub.status(SELF_NODE, row.job) : undefined
      if (status && status.error !== 'unknown_job') {
        this.apply(row, status)
        return
      }
      // A new service: the install ran, or did not take.
      if (atLeast(this.deps.version(), target)) Object.assign(row, { phase: 'updated', error: undefined })
      else Object.assign(row, { phase: 'failed', error: "Didn't install here" })
      return
    }
    if (row.phase === 'installing' && row.job && row.via === 'request') {
      const status = await this.statusOf(row)
      if (status !== UNREACHABLE && status.error !== 'unknown_job') {
        this.apply(row, status)
        if (row.phase !== 'installing' || status.phase !== 'installing') return
      }
    }
    const answer = await this.freshInfo(row.node)
    if (answer !== UNREACHABLE) {
      if (atLeast(answer.version, target)) Object.assign(row, { phase: 'updated', error: undefined })
      // Back on the old version past the deadline (or after it was already unverified): the install did not take.
      else if (row.phase === 'unverified' || this.now() >= (row.installedAt ?? 0) + this.limits.rolloutReconnectMs)
        Object.assign(row, { phase: 'failed', error: ERROR_TEXT.install_failed })
      return
    }
    if (row.phase === 'installing' && this.now() >= (row.installedAt ?? 0) + this.limits.rolloutReconnectMs)
      Object.assign(row, { phase: 'unverified', error: 'No answer since its install' })
  }

  /** "Couldn't verify" rows, asked again when a window reads the results, at most once per `rolloutRecheckMs`. */
  private reverify(rollout: Rollout): void {
    if (!rollout.rows.some((row) => row.phase === 'unverified')) return
    if (this.now() - this.lastReverify < this.limits.rolloutRecheckMs) return
    this.lastReverify = this.now()
    this.running = this.verify(rollout)
      .catch(() => undefined)
      .finally(() => {
        this.running = null
      })
  }

  private async retryRow(rollout: Rollout, row: RolloutRow): Promise<void> {
    const target = rollout.version
    if (row.via === 'self') {
      if (atLeast(this.deps.version(), target)) return void Object.assign(row, { phase: 'updated' })
    } else {
      const answer = await this.freshInfo(row.node)
      if (answer !== UNREACHABLE && atLeast(answer.version, target)) return void Object.assign(row, { phase: 'updated' })
      if (row.via === 'ssh') {
        Object.assign(row, { phase: 'installing', installedAt: this.now() })
        this.save(rollout)
        return this.sshInstall(rollout, row)
      }
      if (answer === UNREACHABLE) return void Object.assign(row, { phase: 'failed', error: "Couldn't reach it" })
      if (!answer.update?.requests) return void Object.assign(row, { phase: 'failed', error: ERROR_TEXT.not_accepting })
    }
    Object.assign(row, { job: undefined, phase: 'ready' })
    await this.prepareRow(rollout, row)
    this.save(rollout)
    const until = this.now() + this.limits.rolloutPrepareMs
    while (row.phase === 'downloading' && this.now() < until && this.live(rollout)) {
      await this.sleep(this.limits.pollMs)
      const status = await this.statusOf(row)
      if (status !== UNREACHABLE) this.apply(row, status)
      this.save(rollout)
    }
    if (row.phase === 'downloading') {
      await this.cancelJob(row)
      return void Object.assign(row, { phase: 'failed', error: "Didn't download in time", percent: undefined })
    }
    if (row.phase !== 'ready' || !row.job) return
    Object.assign(row, { installedAt: this.now() })
    if (row.via === 'self') {
      rollout.step = 'restarting'
      row.phase = 'installing'
      this.save(rollout)
      this.apply(row, this.deps.hub.install(SELF_NODE, row.job, row.consentedTurns ?? 0))
      return
    }
    try {
      this.apply(row, await this.askStatus({ node: row.node, step: 'install', job: row.job, runningTurns: row.consentedTurns ?? 0 }))
    } catch {
      row.phase = 'installing'
    }
  }

  // ------------------------------------------------------------------ requests

  private async askStatus(params: Omit<UpdateThereParams, 'node'> & { node: string }): Promise<RemoteUpdateStatus> {
    const status = parseRemoteUpdateStatus(await this.deps.ask(params as UpdateThereParams))
    if (!status) throw new NetError('internal')
    return status
  }

  private async statusOf(row: RolloutRow): Promise<Reach<RemoteUpdateStatus>> {
    if (!row.job) return UNREACHABLE
    if (row.via === 'self') return this.deps.hub.status(SELF_NODE, row.job)
    try {
      return await this.askStatus({ node: row.node, step: 'status', job: row.job })
    } catch {
      return UNREACHABLE
    }
  }

  /** What the computer says it runs, asked of it now: never what was kept from before. */
  private async freshInfo(node: string): Promise<Reach<{ version: string; update?: SelfUpdateReport }>> {
    try {
      const answer = (await this.deps.ask({ node, step: 'version' })) as { version?: unknown; update?: SelfUpdateReport }
      return typeof answer?.version === 'string' ? { version: answer.version, ...(answer.update ? { update: answer.update } : {}) } : UNREACHABLE
    } catch {
      return UNREACHABLE
    }
  }

  private async cancelJob(row: RolloutRow): Promise<void> {
    if (!row.job) return
    if (row.via === 'self') this.deps.hub.cancel(SELF_NODE, row.job)
    else await this.deps.ask({ node: row.node, step: 'cancel', job: row.job }).catch(() => undefined)
  }

  /** Folds a request's status into its row. */
  private apply(row: RolloutRow, status: RemoteUpdateStatus): void {
    // Its service restarted for the install and no longer knows the request: its version, asked next, says.
    if (status.error === 'unknown_job' && row.phase === 'installing') return
    if (status.job) row.job = status.job
    row.runningTurns = status.runningTurns
    switch (status.phase) {
      case 'preparing':
        Object.assign(row, { phase: 'downloading', percent: status.percent })
        break
      case 'ready':
        Object.assign(row, { phase: 'ready', percent: undefined })
        break
      case 'countdown':
      case 'waiting':
      case 'installing':
        Object.assign(row, { phase: 'installing', percent: undefined })
        break
      case 'failed':
      case 'cancelled':
        Object.assign(row, { phase: 'failed', percent: undefined, error: ERROR_TEXT[status.error ?? 'cancelled'] })
        break
    }
    for (const key of Object.keys(row) as Array<keyof RolloutRow>) if (row[key] === undefined) delete row[key]
  }

  // ------------------------------------------------------------------ storage

  private load(): Rollout | null {
    if (this.current === undefined) {
      try {
        this.current = parseRollout(this.deps.store.read())
      } catch {
        this.current = null
      }
    }
    return this.current
  }

  private require(): Rollout {
    const rollout = this.load()
    if (!rollout) throw new NetError('bad_request', 'No update of your computers is under way.')
    return rollout
  }

  private save(rollout: Rollout | null): void {
    if (rollout && (this.dropped.has(rollout.id) || (this.current && this.current.id !== rollout.id))) return
    if (!rollout && this.current) this.dropped.add(this.current.id)
    for (const row of rollout?.rows ?? []) for (const key of Object.keys(row) as Array<keyof RolloutRow>) if (row[key] === undefined) delete row[key]
    this.current = rollout
    try {
      this.deps.store.write(rollout)
    } catch (error) {
      console.warn('The update of your computers could not be saved:', error instanceof Error ? error.message : String(error))
    }
    this.deps.changed()
  }
}
