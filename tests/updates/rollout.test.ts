/**
 * Update everywhere's coordinator (#476, step 3), driven against a world of computers: each other computer has a real
 * request hub (`RemoteUpdates`) and an app that downloads, counts down and installs; this computer's hub is the one its
 * own app uses. Only the network between them is scripted (online, a lost reply), and the clock.
 *
 * Inputs listed:
 * - who: this computer (behind or up to date), a computer between this version and the target, at the target, newer,
 *   on another channel, a development build, a phone, revoked, without its app open, one that can't update itself,
 *   one offline, one too old to say its version, a machine this computer installed over SSH;
 * - when: all ready, one still downloading at the prepare deadline, the person cancelling before or after confirming;
 * - what goes wrong: a lost install reply, a computer gone past the reconnect deadline and back later, this computer's
 *   own install not taking, the service restarting before or after the person confirmed;
 * - later: retry of a failed row (version asked first, access asked again), an offline computer that comes back.
 */
import { describe, expect, it } from 'vitest'
import { NetError } from '../../src/shared/net/errors'
import type { SshRecordView, SshUpdateResult } from '../../src/shared/net/local'
import { REMOTE_UPDATE_LIMITS, type RemoteUpdateLimits } from '../../src/shared/remoteUpdates'
import { SELF_NODE, type Rollout } from '../../src/shared/updateRollout'
import type { UpdateThereParams } from '../../src/mms/updates/askUpdate'
import { RemoteUpdates } from '../../src/mms/updates/remoteUpdates'
import { UpdateRollouts, type RolloutPeer } from '../../src/mms/updates/rollout'

const TARGET = '1.3.0'
const LIMITS: RemoteUpdateLimits = { ...REMOTE_UPDATE_LIMITS, pollMs: 1_000, countdownMs: 10_000, rolloutPrepareMs: 60_000, rolloutReconnectMs: 120_000, rolloutRecheckMs: 30_000 }

interface Box {
  node: string
  name: string
  version: string
  /** What its presence row last said: verification must never read it. */
  seen?: string
  channel?: 'stable' | 'nightly'
  online: boolean
  /** Its app is open and takes requests. */
  app: boolean
  /** Its app can install (false: a build that can't update itself). */
  self?: boolean
  /** Its Mousse predates the update report: it says nothing about updating itself. */
  noReport?: boolean
  full: boolean
  kind?: string
  revoked?: boolean
  /** Downloads never finish. */
  slow?: boolean
  /** Its install runs but the new version does not take. */
  failsInstall?: boolean
  /** Goes offline when it installs, and stays so until the test brings it back. */
  staysAway?: boolean
  hub: RemoteUpdates
  installs: number
  turns?: number
}

function world(opts: { self?: string; boxes?: Array<Partial<Box> & { node: string }>; ssh?: Array<{ node: string; version: string }> } = {}) {
  let now = 1_000_000
  let ids = 0
  const store = { value: null as unknown, read: () => store.value, write: (value: unknown) => void (store.value = value ? JSON.parse(JSON.stringify(value)) : null) }
  const newHub = () => new RemoteUpdates({ now: () => now, limits: LIMITS, newId: () => `job-${++ids}` })
  const boxes = new Map<string, Box>()
  for (const spec of opts.boxes ?? []) {
    const box: Box = { name: spec.node, version: '1.2.0', online: true, app: true, full: true, installs: 0, ...spec, hub: newHub() }
    box.seen ??= box.version
    if (box.app) box.hub.attach('app')
    box.hub.activeTurns = () => box.turns ?? 0
    boxes.set(box.node, box)
  }
  const ssh = new Map((opts.ssh ?? []).map((item) => [item.node, { ...item, id: `ssh-${item.node}` }]))
  const me = { version: opts.self ?? '1.2.0', hub: newHub(), app: true, installed: false, failsInstall: false, turns: 0 }
  me.hub.attach('me-app')
  me.hub.activeTurns = () => me.turns
  /** A lost reply: the next call of this step to this node runs there, and its answer never comes back. */
  const lose = new Set<string>()
  const asked: Array<{ node: string; step: string }> = []
  let sshCalls: Array<{ id: string; version: string }> = []

  /** Each app does what its countdown or download would. */
  const runApps = () => {
    for (const box of boxes.values()) {
      if (!box.app || !box.online) continue
      const job = box.hub.current()
      if (!job) continue
      if (job.phase === 'preparing' && !box.slow) box.hub.progress('app', job.id, { phase: 'ready' })
      if ((job.phase === 'countdown' || job.phase === 'waiting') && box.hub.begin('app', job.id).go === true) {
        box.installs++
        if (!box.failsInstall) box.version = job.version
        // The app quit for the installer and opens again: a new service, with no request.
        box.hub = newHub()
        box.hub.attach('app')
        if (box.staysAway) box.online = false
      }
    }
    const job = me.hub.current()
    if (job?.phase === 'preparing') me.hub.progress('me-app', job.id, { phase: 'ready' })
    if (job && (job.phase === 'countdown' || job.phase === 'waiting') && me.hub.begin('me-app', job.id).go === true) me.installed = true
  }
  const sleep = async (ms: number) => {
    now += ms
    runApps()
    await new Promise((resolve) => setImmediate(resolve))
  }
  const ask = async (params: UpdateThereParams): Promise<unknown> => {
    const box = boxes.get(params.node)
    asked.push({ node: params.node, step: params.step })
    if (!box || !box.online) throw new NetError('peer_offline')
    const from = { node: 'me', name: 'Me', stillAllowed: () => box.full }
    let answer: unknown
    switch (params.step) {
      case 'version':
        answer = { version: box.version, update: { channel: box.channel ?? 'stable', self: box.self ?? true, ...(box.app ? { requests: true } : {}) } }
        break
      case 'prepare':
        if (!box.full) throw new NetError('forbidden')
        answer = box.hub.prepare(from, params.version!, params.rollout)
        break
      case 'status':
        answer = box.hub.status('me', params.job!)
        break
      case 'install':
        answer = box.hub.install('me', params.job!, params.runningTurns ?? 0)
        break
      case 'cancel':
        answer = box.hub.cancel('me', params.job!)
        break
      default:
        throw new NetError('bad_request')
    }
    if (lose.delete(`${params.node}:${params.step}`)) throw new NetError('timeout')
    return answer
  }
  const peers = async (): Promise<RolloutPeer[]> =>
    [...boxes.values()].map((box) => ({
      node: box.node,
      name: box.name,
      kind: box.kind ?? 'computer',
      self: false,
      revoked: box.revoked ?? false,
      state: box.online ? 'open' : 'closed',
      ...(box.seen ? { version: box.seen } : { olderThanThis: true }),
      ...(box.noReport ? {} : { update: { channel: box.channel ?? 'stable', self: box.self ?? true, ...(box.app && box.online ? { requests: true as const } : {}) } }),
      ...(box.channel && box.channel !== 'stable' ? { otherChannel: true } : {})
    }))
  const records = async (): Promise<SshRecordView[]> =>
    [...ssh.values()].map((item) => ({ id: item.id, endpoint: `user@${item.node}`, node: item.node as SshRecordView['node'], phase: 'running' as SshRecordView['phase'], owner: 'managed' as SshRecordView['owner'], version: item.version, recoverable: false, createdAt: 0, updatedAt: 0 }))
  const sshUpdate = async (id: string, version: string): Promise<SshUpdateResult> => {
    sshCalls.push({ id, version })
    const item = [...ssh.values()].find((entry) => entry.id === id)!
    item.version = version
    return { ok: true, version }
  }
  let changes = 0
  const make = () =>
    new UpdateRollouts({
      store,
      peers,
      sshRecords: records,
      ask,
      sshUpdate,
      hub: me.hub,
      selfName: () => 'Studio',
      version: () => me.version,
      changed: () => void changes++,
      limits: LIMITS,
      now: () => now,
      sleep,
      newId: () => `rollout-${++ids}`
    })
  let rollouts = make()
  const row = (node: string) => (store.value as Rollout | null)?.rows.find((item) => item.node === node)
  const until = async (check: () => boolean, label: string) => {
    for (let index = 0; index < 2_000; index++) {
      if (check()) return
      await sleep(LIMITS.pollMs)
    }
    throw new Error(`never: ${label} (${JSON.stringify(store.value)})`)
  }
  /** This computer's app quit for its installer and opened again: a new service, on `version`. */
  const restart = (version = me.version) => {
    rollouts.stop()
    me.version = version
    me.hub = newHub()
    me.hub.attach('me-app')
    rollouts = make()
    return rollouts
  }
  return {
    boxes,
    me,
    store,
    lose,
    asked,
    row,
    until,
    restart,
    sleep,
    get rollouts() {
      return rollouts
    },
    get ssh() {
      return sshCalls
    },
    clearSsh: () => void (sshCalls = []),
    advance: (ms: number) => void (now += ms),
    saved: () => store.value as Rollout | null
  }
}

describe('who a rollout targets', () => {
  it('compares each computer with the target version, not with this one', async () => {
    const w = world({
      self: '1.2.0',
      boxes: [
        // Between this computer's version and the target: behind the target, so updated.
        { node: 'between', version: '1.2.5' },
        { node: 'older', version: '1.1.0' },
        { node: 'at-target', version: TARGET },
        { node: 'newer', version: '1.4.0' },
        // Another channel keeps its own updates (and its tag in Devices).
        { node: 'nightly', version: '1.2.0-nightly.20261120.1', channel: 'nightly' },
        { node: 'dev', version: '0.0.0-dev' },
        { node: 'phone', kind: 'phone' },
        { node: 'gone', revoked: true },
        { node: 'closed-app', app: false },
        { node: 'no-updater', self: false, app: false },
        { node: 'away', online: false },
        { node: 'ancient', seen: undefined, app: false },
        { node: 'unreported', noReport: true, app: false }
      ],
      ssh: [{ node: 'server', version: '1.0.0' }]
    })
    w.boxes.set('server', { node: 'server', name: 'server', version: '1.0.0', seen: '1.0.0', online: false, app: false, self: false, full: true, hub: new RemoteUpdates(), installs: 0 })
    const plan = await w.rollouts.plan(TARGET)
    const by = Object.fromEntries(plan.map((row) => [row.node, `${row.via}/${row.phase}`]))
    expect(by).toEqual({
      [SELF_NODE]: 'self/ready',
      between: 'request/ready',
      older: 'request/ready',
      'closed-app': 'manual/manual',
      'no-updater': 'manual/manual',
      away: 'request/offline',
      ancient: 'manual/manual',
      unreported: 'manual/manual',
      server: 'ssh/ready'
    })
    expect(plan.find((row) => row.node === 'closed-app')?.error).toBe("Mousse isn't open there")
    // Online with a version but no report: its build predates update requests, whether its app is open or not.
    expect(plan.find((row) => row.node === 'unreported')?.error).toBe('Too old to update from here')
  })

  it('leaves this computer out when it already runs the target', async () => {
    const w = world({ self: TARGET, boxes: [{ node: 'laptop' }] })
    expect((await w.rollouts.plan(TARGET)).map((row) => row.node)).toEqual(['laptop'])
  })
})

describe('a rollout', () => {
  it('prepares everywhere at once, installs the others first and this computer last, then checks each version there', async () => {
    const w = world({ boxes: [{ node: 'laptop' }, { node: 'desk' }], ssh: [{ node: 'server', version: '1.1.0' }] })
    w.boxes.set('server', { node: 'server', name: 'server', version: '1.1.0', online: true, app: false, self: false, full: true, hub: new RemoteUpdates(), installs: 0 })
    await w.rollouts.start(TARGET)
    // Nothing installs before the person confirms.
    for (let index = 0; index < 5; index++) await w.sleep(LIMITS.pollMs)
    expect(w.saved()!.rows.map((row) => row.phase)).toEqual(['ready', 'ready', 'ready', 'ready'])
    expect(w.boxes.get('laptop')!.installs + w.boxes.get('desk')!.installs + w.ssh.length).toBe(0)

    w.asked.length = 0
    w.rollouts.confirm({ [SELF_NODE]: 0, laptop: 0, desk: 0, server: 0 })
    await w.until(() => w.me.installed, 'this computer installs')
    // The others installed before this computer restarted.
    expect(w.boxes.get('laptop')!.installs).toBe(1)
    expect(w.boxes.get('desk')!.installs).toBe(1)
    expect(w.ssh).toEqual([{ id: 'ssh-server', version: TARGET }])
    expect(w.row('server')?.phase).toBe('updated')
    expect(w.saved()!.step).toBe('restarting')

    // The new service, on the new version: the rollout goes on when a window reads it.
    const fresh = w.restart(TARGET)
    await fresh.view()
    await w.until(() => w.saved()!.step === 'done', 'done')
    expect(w.saved()!.rows.map((row) => [row.node, row.phase])).toEqual([
      [SELF_NODE, 'updated'],
      ['laptop', 'updated'],
      ['desk', 'updated'],
      ['server', 'updated']
    ])
    // Each computer was asked its version itself; its presence row still says the old one.
    expect(w.boxes.get('laptop')!.seen).toBe('1.2.0')
    expect(new Set(w.asked.filter((call) => call.step === 'version').map((call) => call.node))).toEqual(new Set(['desk', 'laptop']))
  })

  it('reads a lost reply as "Couldn\'t verify", and corrects it when the computer later says it updated', async () => {
    const w = world({ self: TARGET, boxes: [{ node: 'laptop', staysAway: true }, { node: 'desk' }] })
    await w.rollouts.start(TARGET)
    w.lose.add('laptop:install')
    w.rollouts.confirm({ laptop: 0, desk: 0 })
    await w.until(() => w.row('desk')?.phase === 'updated', 'desk updated')
    // The reply was lost, the install ran, and the laptop has not come back.
    expect(w.boxes.get('laptop')!.installs).toBe(1)
    expect(w.row('laptop')?.phase).toBe('installing')
    w.advance(LIMITS.rolloutReconnectMs)
    await w.until(() => w.saved()!.step === 'done', 'done')
    expect(w.row('laptop')).toMatchObject({ phase: 'unverified' })

    // Back, on the new version: reading the results asks it again.
    w.boxes.get('laptop')!.online = true
    w.advance(LIMITS.rolloutRecheckMs)
    await w.rollouts.view()
    await w.until(() => w.row('laptop')?.phase === 'updated', 'laptop corrected')
  })

  it('installs only the ready ones once the prepare deadline passes, and never the late one afterwards', async () => {
    const w = world({ self: TARGET, boxes: [{ node: 'laptop' }, { node: 'slow', slow: true }] })
    await w.rollouts.start(TARGET)
    w.rollouts.confirm({ laptop: 0, slow: 0 })
    await w.until(() => w.saved()!.step === 'done', 'done')
    expect(w.row('laptop')?.phase).toBe('updated')
    expect(w.row('slow')).toMatchObject({ phase: 'failed', error: "Didn't download in time" })
    // Its request there was dropped: finishing the download later installs nothing.
    const slow = w.boxes.get('slow')!
    slow.slow = false
    for (let index = 0; index < 20; index++) await w.sleep(LIMITS.pollMs)
    expect(slow.installs).toBe(0)
    expect(slow.hub.current()).toBeNull()
  })

  it('marks only this computer failed when its own install did not take, and still checks the others', async () => {
    const w = world({ boxes: [{ node: 'laptop' }] })
    await w.rollouts.start(TARGET)
    w.rollouts.confirm({ [SELF_NODE]: 0, laptop: 0 })
    await w.until(() => w.me.installed, 'this computer installs')
    // The app opened again on the old version (`notAppliedVersion`).
    const fresh = w.restart('1.2.0')
    await fresh.view()
    await w.until(() => w.saved()!.step === 'done', 'done')
    expect(w.row(SELF_NODE)).toMatchObject({ phase: 'failed' })
    expect(w.row('laptop')).toMatchObject({ phase: 'updated' })
  })
})

describe('stopping and restarting', () => {
  it('cancelled before confirming: every download stops and the rollout is gone', async () => {
    const w = world({ boxes: [{ node: 'laptop' }, { node: 'slow', slow: true }] })
    await w.rollouts.start(TARGET)
    await w.rollouts.cancel()
    expect(w.saved()).toBeNull()
    for (const box of w.boxes.values()) expect(box.hub.current()).toBeNull()
    expect(w.me.hub.current()).toBeNull()
    for (let index = 0; index < 20; index++) await w.sleep(LIMITS.pollMs)
    expect([...w.boxes.values()].map((box) => box.installs)).toEqual([0, 0])
  })

  it('cancelled after confirming: what has not started installing stops and shows Cancelled', async () => {
    const w = world({ self: TARGET, boxes: [{ node: 'laptop' }, { node: 'slow', slow: true }] })
    await w.rollouts.start(TARGET)
    w.rollouts.confirm({ laptop: 0, slow: 0 })
    // The laptop is ready and waits for the slow one.
    await w.until(() => w.row('laptop')?.phase === 'ready', 'laptop ready')
    await w.rollouts.cancel()
    await w.until(() => w.saved()!.step === 'done', 'done')
    expect(w.saved()!.rows.map((row) => [row.phase, row.error])).toEqual([['failed', 'Cancelled'], ['failed', 'Cancelled']])
    for (let index = 0; index < 20; index++) await w.sleep(LIMITS.pollMs)
    expect([...w.boxes.values()].map((box) => box.installs)).toEqual([0, 0])
  })

  it('a service that restarts before anyone confirmed drops the rollout and its downloads', async () => {
    const w = world({ boxes: [{ node: 'laptop' }] })
    await w.rollouts.start(TARGET)
    const job = w.row('laptop')!.job!
    const fresh = w.restart()
    await fresh.view()
    await w.until(() => w.saved() === null, 'dropped')
    expect(w.boxes.get('laptop')!.hub.status('me', job).phase).toBe('cancelled')
  })

  it('a service that restarts after the person confirmed carries on from the saved rollout', async () => {
    const w = world({ self: TARGET, boxes: [{ node: 'laptop' }, { node: 'desk' }] })
    await w.rollouts.start(TARGET)
    w.rollouts.confirm({ laptop: 0, desk: 0 })
    // Stopped in the middle: before it asked anyone to install.
    const fresh = w.restart()
    expect(['preparing', 'installing']).toContain(w.saved()!.step)
    await fresh.view()
    await w.until(() => w.saved()!.step === 'done', 'done')
    expect(w.saved()!.rows.map((row) => row.phase)).toEqual(['updated', 'updated'])
    expect([...w.boxes.values()].map((box) => box.installs)).toEqual([1, 1])
  })
})

describe('no update without a new click', () => {
  it('never updates a computer that was offline, even once it comes back', async () => {
    const w = world({ self: TARGET, boxes: [{ node: 'laptop' }, { node: 'away', online: false }] })
    await w.rollouts.start(TARGET)
    w.rollouts.confirm({ laptop: 0 })
    w.boxes.get('away')!.online = true
    await w.until(() => w.saved()!.step === 'done', 'done')
    for (let index = 0; index < 10; index++) await w.sleep(LIMITS.pollMs)
    expect(w.row('away')?.phase).toBe('offline')
    expect(w.asked.some((call) => call.node === 'away' && call.step !== 'version')).toBe(false)
  })

  it('retries one row: its version first, then its access, then the update', async () => {
    const w = world({ self: TARGET, boxes: [{ node: 'laptop', failsInstall: true }, { node: 'desk', slow: true }, { node: 'away', online: false }] })
    await w.rollouts.start(TARGET)
    // Not before the person confirmed.
    expect(() => w.rollouts.retry('away')).toThrow()
    w.rollouts.confirm({ laptop: 0, desk: 0 })
    await w.until(() => w.saved()!.step === 'done', 'done')
    // It installed and came back on the old version.
    expect(w.row('laptop')).toMatchObject({ phase: 'failed', error: "Didn't install" })
    expect(w.boxes.get('laptop')!.installs).toBe(1)

    // Updated by hand meanwhile: the retry finds it at the target and installs nothing.
    w.boxes.get('laptop')!.version = TARGET
    w.rollouts.retry('laptop')
    await w.until(() => w.row('laptop')?.phase === 'updated', 'laptop at target')
    expect(w.boxes.get('laptop')!.installs).toBe(1)
    expect(w.boxes.get('laptop')!.hub.current()).toBeNull()

    // Full control taken away there: refused there, so no download and no install.
    const away = w.boxes.get('away')!
    Object.assign(away, { online: true, full: false })
    w.rollouts.retry('away')
    await w.until(() => w.row('away')?.phase === 'failed', 'away refused')
    expect(away.installs).toBe(0)

    // Given back: the retry updates it.
    away.full = true
    w.rollouts.retry('away')
    await w.until(() => w.row('away')?.phase === 'updated', 'away updated')
    expect(away.installs).toBe(1)
  })
})
