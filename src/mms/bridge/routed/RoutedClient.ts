import { NetError, newId, type NodeId, type RpcId } from '../../../shared/net'
import {
  ROUTED_LARGE_READS,
  ROUTED_LARGE_READS_PER_CALLER,
  ROUTED_METHODS,
  ROUTED_STAGED_KEY,
  isRoutedPagedReply,
  isRoutedReply,
  routedKeysAt,
  routedNetMethod,
  routedParamsForOwner,
  type RoutedPage,
  type RoutedReply,
  type RoutedRow,
  type RoutedStreamKind,
  type RoutedStreamOpened
} from '../../../shared/bridge/routed'
import { qualifyRoutedResult } from '../../../shared/bridge/routedIds'
import type { SyncSession } from '../../net/contracts'
import { DomainRpcError } from '../../protocol/domainRegistry'
import {
  computerOffline,
  computerOutdated,
  isLinkLoss,
  mayHaveHappened,
  refusalError,
  translateNetError,
  type ComputerRef
} from './computerErrors'
import { reassemblePagedReply } from './pages'
import type { RoutedStager } from './stager'

/** A value larger than this goes ahead of the call as a staged value instead of inside it. */
export const ROUTED_INLINE_MAX_BYTES = 48 * 1024
/** How long a call waits for a lost link to come back before it gives up with "offline". */
const RECONNECT_WINDOW_MS = 30_000
const RECONNECT_POLL_MS = 150
/** Deadlines of a call: most are quick, a Git action or a publish can run for minutes. */
const DEFAULT_DEADLINE_MS = 60_000
const LONG_DEADLINE_MS = 10 * 60_000
const LONG_METHODS = new Set([
  'git.push',
  'git.pull',
  'git.fetch',
  'git.commit',
  'git.checkout',
  'publish.start',
  'pullRequests.create',
  'pullRequests.draft',
  'actions.undoLatest',
  'actions.redo',
  'actions.revertCode',
  'workspace.restore',
  'workspace.discardPendingChanges'
])

export interface RoutedClientDeps {
  /** An open session with `node`; throws `peer_offline` when there is none. */
  session(node: NodeId): SyncSession
  computer(node: NodeId): ComputerRef
  stager?: RoutedStager
  /** Ends every wait when the profile closes. */
  signal: AbortSignal
  delay?: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface RoutedCallOptions {
  /** The request id of the caller: a retry of the same request reaches the same execution. */
  idem?: string
  signal?: AbortSignal
  /** Reports what the owner sends while the call runs. */
  onProgress?: (data: unknown) => void
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** A key press or a resize that is not answered in this long is not worth waiting for: a terminal's next input would queue behind it. */
const SEQUENCED_DEADLINE_MS = 15_000
const deadlineOf = (method: string): number =>
  ROUTED_METHODS[method]?.sequenced
    ? SEQUENCED_DEADLINE_MS
    : LONG_METHODS.has(method)
      ? LONG_DEADLINE_MS
      : DEFAULT_DEADLINE_MS
/** The longest a call takes in all: its own deadline and the wait for a link that went. */
const totalMs = (method: string): number => deadlineOf(method) + RECONNECT_WINDOW_MS
const timedOut = (computer: ComputerRef): DomainRpcError =>
  new DomainRpcError('deadline_exceeded', `${computer.name} did not answer in time.`, {
    node: computer.node,
    name: computer.name
  })

const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '')

/**
 * The calling side of the routed API: one call to one computer. It sends only the keys the owner's
 * version of the row knows, stages values that do not fit a request, follows a paged reply to the
 * end, and finds the outcome of a call whose reply was lost (the same request id, never a fresh one).
 * Every failure it raises is a `DomainRpcError` a window can show.
 */
export class RoutedClient {
  private readonly versionCache = new WeakMap<SyncSession, Promise<Record<string, number> | undefined>>()
  private readonly large = new Map<NodeId, { running: number; waiting: Array<() => void> }>()
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>

  constructor(private readonly deps: RoutedClientDeps) {
    this.sleep = deps.delay ?? delay
  }

  /** The versions of the routed rows `node` accepts; undefined for a computer from before the API. */
  async versions(node: NodeId, session = this.deps.session(node)): Promise<Record<string, number> | undefined> {
    let held = this.versionCache.get(session)
    if (!held) {
      held = (async () => {
        try {
          const info = (await session.rpc('net.info', {}, {
            id: newId('rpc'),
            deadlineMs: 10_000,
            signal: this.deps.signal
          })) as { routed?: unknown } | null
          const routed = info?.routed
          if (!routed || typeof routed !== 'object' || Array.isArray(routed)) return undefined
          const out: Record<string, number> = {}
          for (const [method, version] of Object.entries(routed))
            if (Number.isSafeInteger(version)) out[method] = version as number
          return out
        } catch (error) {
          // A computer from before `net.info` answers `forbidden`: it has none of the API.
          if (error instanceof NetError && error.code === 'forbidden') return undefined
          throw error
        }
      })()
      this.versionCache.set(session, held)
      held.catch(() => this.versionCache.delete(session))
    }
    return held
  }

  /** The keys of a call that the owner's version of the row accepts; the first it does not know, or undefined. */
  async unsupportedKey(
    node: NodeId,
    method: string,
    row: RoutedRow,
    params: Record<string, unknown>
  ): Promise<{ outdated: boolean; key?: string; version?: number }> {
    const versions = await this.versions(node)
    const version = versions?.[method]
    if (version === undefined) return { outdated: true }
    const known = new Set(routedKeysAt(row, version))
    for (const [key, value] of Object.entries(params))
      if (value !== undefined && !known.has(key)) return { outdated: true, key }
    return { outdated: false, version }
  }

  /** Runs one routed row on `node` and returns its result, or throws what the person should see. */
  async call(
    node: NodeId,
    method: string,
    given: Record<string, unknown>,
    options: RoutedCallOptions = {}
  ): Promise<unknown> {
    const row = ROUTED_METHODS[method]
    if (!row) throw new DomainRpcError('not_available_remotely', `${method} is not available from another computer.`)
    const computer = this.deps.computer(node)
    const session = this.sessionOrOffline(node, computer)
    const known = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined))
    const verdict = await this.guard(node, session, computer, () => this.unsupportedKey(node, method, row, known))
    if (verdict.outdated) throw computerOutdated(computer, method, verdict.key)
    // A value the owner's version of the row does not take yet is sent as the nearest one it does.
    const params = routedParamsForOwner(method, verdict.version ?? row.version, known)
    // One signal ends the whole call: the window that asked closing (or giving up), the profile closing, and
    // the call's own total time. It also ends the wait for a big-read slot, and the slot is given back.
    const signal = AbortSignal.any([
      this.deps.signal,
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(totalMs(method))
    ])
    const release = ROUTED_LARGE_READS.includes(method)
      ? await this.enterLargeRead(node, signal, computer)
      : undefined
    try {
      const sent = await this.stageLarge(node, session, computer, method, row, params, signal)
      const reply = await this.invoke(node, computer, method, row, sent, { ...options, signal })
      // The ids in a refusal's details are the owner's own; they are named as the results are.
      if (!reply.ok)
        throw refusalError(reply.error, (value) =>
          value === undefined ? value : qualifyRoutedResult('error', value, { node })
        )
      return reply.result
    } finally {
      release?.()
    }
  }

  /** Opens (or reopens) a stream only this computer reads, on `node`. */
  async openStream(
    node: NodeId,
    request: { kind: RoutedStreamKind; threadId?: string; ptyId?: string }
  ): Promise<RoutedStreamOpened> {
    const computer = this.deps.computer(node)
    const session = this.sessionOrOffline(node, computer)
    const versions = await this.guard(node, session, computer, () => this.versions(node, session))
    if (versions?.['stream.open'] === undefined) throw computerOutdated(computer, 'stream.open')
    const reply = await this.guard(node, session, computer, () =>
      session.rpc(routedNetMethod('stream.open'), request, {
        id: newId('rpc'),
        deadlineMs: 30_000,
        signal: this.deps.signal
      })
    )
    if (!isRoutedReply(reply)) throw new DomainRpcError('bad_reply', 'The other computer sent an unreadable reply.')
    if (!reply.ok) throw refusalError(reply.error)
    return reply.result as RoutedStreamOpened
  }

  /** Tells the owner this computer no longer reads a stream, so the room it held is free. Best effort. */
  async closeStream(
    node: NodeId,
    request: { kind: RoutedStreamKind; threadId?: string; ptyId?: string }
  ): Promise<void> {
    try {
      const session = this.deps.session(node)
      const versions = await this.versions(node, session)
      if (versions?.['stream.close'] === undefined) return
      await session.rpc(routedNetMethod('stream.close'), request, {
        id: newId('rpc'),
        deadlineMs: 10_000,
        signal: this.deps.signal
      })
    } catch {
      // The owner lets an unread stream go after ten idle minutes anyway.
    }
  }

  private sessionOrOffline(node: NodeId, computer: ComputerRef): SyncSession {
    try {
      return this.deps.session(node)
    } catch (error) {
      throw translateNetError(error, computer, 'session') ?? error
    }
  }

  /** Runs `work` and turns what it throws into the error a person sees. */
  private async guard<T>(
    node: NodeId,
    session: SyncSession,
    computer: ComputerRef,
    work: () => Promise<T>
  ): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (this.deps.signal.aborted) throw new DomainRpcError('cancelled', 'Mousse is shutting down.')
      if (isLinkLoss(error) || session.state() !== 'open') throw computerOffline(computer)
      throw translateNetError(error, computer, 'call') ?? error
    }
  }

  /** At most two big reads at once per computer: the owner refuses the third, so the third waits here. */
  private async enterLargeRead(
    node: NodeId,
    signal: AbortSignal,
    computer: ComputerRef
  ): Promise<() => void> {
    let entry = this.large.get(node)
    if (!entry) this.large.set(node, (entry = { running: 0, waiting: [] }))
    const slots = entry
    while (slots.running >= ROUTED_LARGE_READS_PER_CALLER) {
      // A call that is cancelled or runs out of time stops waiting, so it never takes a slot it cannot use.
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal.removeEventListener('abort', give)
          resolve()
        }
        const give = (): void => {
          const at = slots.waiting.indexOf(wake)
          if (at >= 0) slots.waiting.splice(at, 1)
          reject(
            this.deps.signal.aborted
              ? new DomainRpcError('cancelled', 'Mousse is shutting down.')
              : new DomainRpcError('deadline_exceeded', `${computer.name} is busy with other reads. Try again in a moment.`)
          )
        }
        if (signal.aborted) return give()
        signal.addEventListener('abort', give, { once: true })
        slots.waiting.push(wake)
      })
    }
    slots.running += 1
    let released = false
    return () => {
      if (released) return
      released = true
      slots.running -= 1
      slots.waiting.shift()?.()
      if (!slots.running && !slots.waiting.length) this.large.delete(node)
    }
  }

  /** Moves a value too large for a request into a staged value the call names. */
  private async stageLarge(
    node: NodeId,
    session: SyncSession,
    computer: ComputerRef,
    method: string,
    row: RoutedRow,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (!row.stageable?.length) return params
    const big = row.stageable.filter(
      (key) => params[key] !== undefined && sizeOf(params[key]) > ROUTED_INLINE_MAX_BYTES
    )
    if (!big.length) return params
    const versions = await this.versions(node, session)
    if (!this.deps.stager || !routedKeysAt(row, versions?.[method] ?? 0).includes(ROUTED_STAGED_KEY))
      throw computerOutdated(computer, method, ROUTED_STAGED_KEY)
    const out = { ...params }
    const staged: Record<string, string> = {}
    for (const key of big) {
      staged[key] = await this.guard(node, session, computer, () =>
        this.deps.stager!.stage(session, params[key], signal ?? this.deps.signal)
      )
      delete out[key]
    }
    out[ROUTED_STAGED_KEY] = staged
    return out
  }

  /**
   * Sends the call and finds its reply. A write is sent once: if the link is lost before the reply
   * arrives, the call waits for the link, asks for the result of the same request id, and only if the
   * owner never saw it sends it again with the same id and idempotency key, which the owner answers
   * with the first result if it did.
   */
  private async invoke(
    node: NodeId,
    computer: ComputerRef,
    method: string,
    row: RoutedRow,
    params: Record<string, unknown>,
    options: RoutedCallOptions & { signal: AbortSignal }
  ): Promise<RoutedReply> {
    const id = newId('rpc') as RpcId
    const idem = row.durable ? `${method}:${options.idem ?? id}`.slice(0, 256) : undefined
    const deadlineMs = deadlineOf(method)
    const signal = options.signal
    let session = this.sessionOrOffline(node, computer)
    let afterLoss = false
    for (;;) {
      try {
        let reply: unknown
        if (afterLoss && row.durable) {
          // The owner may have run it already: its result is asked for before the request is repeated.
          try {
            reply = await session.rpcResult(id, { deadlineMs: 15_000, signal })
          } catch (error) {
            if (!(error instanceof NetError && error.code === 'outcome_uncertain')) throw error
            reply = await this.send(session, method, params, id, idem, deadlineMs, signal, options)
          }
        } else reply = await this.send(session, method, params, id, idem, deadlineMs, signal, options)
        return await this.settle(node, session, computer, method, reply, signal)
      } catch (error) {
        if (this.deps.signal.aborted) throw new DomainRpcError('cancelled', 'Mousse is shutting down.')
        if (signal.aborted) {
          // The window gave up, or the call ran out of its total time. A write may have gone through.
          if (row.durable) throw mayHaveHappened(computer, method)
          throw (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
            ? timedOut(computer)
            : new DomainRpcError('cancelled', 'The request was cancelled.')
        }
        // A computer that is connected and did not answer in time is slow, not gone. A read that is still
        // running there is never sent again; a write is asked for its result once, then left as unknown.
        if (error instanceof NetError && error.code === 'deadline_exceeded' && session.state() === 'open') {
          if (!row.durable) throw timedOut(computer)
          try {
            const late = await session.rpcResult(id, { deadlineMs: 15_000, signal })
            return await this.settle(node, session, computer, method, late, signal)
          } catch {
            throw mayHaveHappened(computer, method)
          }
        }
        const lost = isLinkLoss(error) || session.state() !== 'open'
        if (!lost) {
          if (error instanceof NetError && error.code === 'outcome_uncertain')
            throw mayHaveHappened(computer, method)
          throw translateNetError(error, computer, method) ?? error
        }
        // The link went away with the call in flight. A read is sent again once, a write is found again by
        // its request id; neither goes on without end, and each loss gets its own wait for the link.
        if (afterLoss && !row.durable) throw computerOffline(computer)
        session = await this.reopened(node, computer, Date.now() + RECONNECT_WINDOW_MS, signal, row.durable)
        afterLoss = true
      }
    }
  }

  private send(
    session: SyncSession,
    method: string,
    params: Record<string, unknown>,
    id: RpcId,
    idem: string | undefined,
    deadlineMs: number,
    signal: AbortSignal,
    options: RoutedCallOptions
  ): Promise<unknown> {
    return session.rpc(routedNetMethod(method), params, {
      id,
      ...(idem ? { idem } : {}),
      deadlineMs,
      signal,
      ...(options.onProgress ? { onProgress: options.onProgress } : {})
    })
  }

  private async reopened(
    node: NodeId,
    computer: ComputerRef,
    giveUpAt: number,
    signal: AbortSignal,
    durable: boolean
  ): Promise<SyncSession> {
    for (;;) {
      if (signal.aborted) throw new DomainRpcError('cancelled', 'The request was cancelled.')
      try {
        return this.deps.session(node)
      } catch {
        if (Date.now() >= giveUpAt)
          // A write may have reached the computer before the link went: say so instead of "offline".
          throw durable
            ? new DomainRpcError(
                'outcome_uncertain',
                `${computer.name} went offline before it confirmed this. It may have happened; check when it is back.`,
                { node: computer.node, name: computer.name, offline: true }
              )
            : computerOffline(computer)
        await this.sleep(RECONNECT_POLL_MS, signal)
      }
    }
  }

  /** A reply, or a paged reply followed to its end. */
  private async settle(
    node: NodeId,
    session: SyncSession,
    computer: ComputerRef,
    method: string,
    reply: unknown,
    signal: AbortSignal
  ): Promise<RoutedReply> {
    // A paged reply is also `{ ok: true }`, so it is told apart first.
    if (!isRoutedPagedReply(reply)) {
      if (isRoutedReply(reply)) return reply
      throw new DomainRpcError('bad_reply', 'The other computer sent an unreadable reply.')
    }
    const fetchPage = async (id: string, index: number): Promise<RoutedPage> => {
      const page = (await session.rpc(
        routedNetMethod('page'),
        { id, index },
        { id: newId('rpc'), deadlineMs: 20_000, signal }
      )) as RoutedReply
      if (!isRoutedReply(page)) throw new DomainRpcError('bad_reply', 'A page was unreadable.')
      if (!page.ok) throw refusalError(page.error)
      return page.result as RoutedPage
    }
    try {
      return await reassemblePagedReply(reply.paged, fetchPage)
    } catch (error) {
      if (error instanceof DomainRpcError && error.code === 'page_expired')
        // Held for a minute only; the caller asks for it again.
        throw new DomainRpcError('result_expired', `The answer from ${computer.name} expired before it was read. Try again.`, { method, node })
      throw error
    }
  }
}
