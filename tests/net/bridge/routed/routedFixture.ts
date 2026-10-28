import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { OwnerRoutes } from '../../../../src/mms/bridge/routed/OwnerRoutes'
import { reassemblePagedReply } from '../../../../src/mms/bridge/routed/pages'
import {
  PrivateSources,
  raiseStreamListenerLimits
} from '../../../../src/mms/bridge/routed/privateSources'
import { RoutedStaging } from '../../../../src/mms/bridge/routed/staging'
import { routedStreamsPort } from '../../../../src/mms/bridge/routed/streamsPort'
import { MmsThreadSource } from '../../../../src/mms/bridge/remote/MmsThreadSource'
import { isPrivateKey } from '../../../../src/mms/bridge/remote/privateStreams'
import { ThreadDisplayProjection } from '../../../../src/mms/bridge/remote/ThreadDisplayProjection'
import { ThreadStreamAdapter } from '../../../../src/mms/bridge/remote/ThreadStreamAdapter'
import type { Clock, StreamStore } from '../../../../src/mms/net/contracts'
import type { NetDatabase } from '../../../../src/mms/net/store/database'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { SqliteBridgeAudit } from '../../../../src/mms/net/store/audit'
import { SqliteNodePolicy } from '../../../../src/mms/net/store/nodePolicy'
import { encodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { systemClock } from '../../../../src/mms/net/clock'
import {
  ROUTED_METHODS,
  isRoutedPagedReply,
  isRoutedReply,
  routedNetMethod,
  type RoutedPage,
  type RoutedPagedReply,
  type RoutedReply
} from '../../../../src/shared/bridge/routed'
import {
  newId,
  type Envelope,
  type NodeCapability,
  type NodeDelegation,
  type NodeId,
  type Roster,
  type RpcArtifactRef,
  type RpcId,
  type StreamDescriptor,
  type StreamId
} from '../../../../src/shared/net'
import type { PermissionMode } from '../../../../src/shared/permissionMode'
import { fixture, resources } from '../hub/fixture'

export const COMPUTER: NodeCapability[] = ['read', 'chat', 'write', 'settings']

/** A throwaway Git repository with one commit, removed with the fixture. */
export function repo(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'routed-repo-')))
  resources.push(() => rmSync(path, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'owner@example.test')
  git('config', 'user.name', 'Owner')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(path, 'a.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  return path
}

/** The wall clock, moved by hand: timers are the real ones, only what `now()` says is the test's. */
export function testClock(
  // A minute ahead of the real clock: a clock made before the fixture would be older than the delegations it signs with.
  start = Date.now() + 60_000
): Clock & { advance(ms: number): void } {
  let offset = 0
  return {
    now: () => start + offset,
    monotonic: systemClock.monotonic,
    setTimeout: systemClock.setTimeout,
    advance: (ms) => {
      offset += ms
    }
  }
}

/** Every record of a display stream, in order, decoded. Reads the store, as a reader that attached at the start would. */
export function recordsOf(
  f: { targetStore: StreamStore; targetDb: NetDatabase },
  stream: StreamId
): Envelope[] {
  const store = f.targetStore
  const head = store.head(stream)
  const out: Envelope[] = []
  // What the stream still holds starts after what it has let go of.
  const retained = Number(
    f.targetDb.database.prepare('SELECT retained FROM net_streams WHERE id=?').get(stream)
      ?.retained ?? 0
  )
  let after = { epoch: head.epoch, seq: retained }
  while (after.seq < head.seq) {
    const page = store.read(stream, after, head.seq, 4 * 1024 * 1024)
    for (const record of page.records) out.push(decodeEnvelope(record.envelope).envelope)
    const last = page.records.at(-1)!
    after = { epoch: last.epoch, seq: last.seq }
  }
  return out
}

/**
 * What a reader of a display stream makes of its records: the snapshot (put back together and
 * checked) and the events after it. Events are read as they are, so a private stream's own kinds show.
 */
export function readStream(
  f: { targetStore: StreamStore; targetDb: NetDatabase },
  stream: StreamId,
  subject: string
): { snapshot?: any; events: Array<{ type: string; data: any }> } {
  const projection = new ThreadDisplayProjection(subject)
  let snapshot: any
  const events: Array<{ type: string; data: any }> = []
  for (const envelope of recordsOf(f, stream)) {
    const body = envelope.body as { threadId: string; type?: string; data?: any }
    if (envelope.type === 'thread.event') {
      expect(body.threadId).toBe(subject)
      events.push({ type: body.type!, data: body.data })
      continue
    }
    const update = projection.accept(envelope)
    if (update?.kind === 'snapshot') snapshot = update.value
  }
  return { snapshot, events }
}

export interface RoutedOwnerOptions {
  caps?: NodeCapability[]
  maxMode?: PermissionMode
  /** Offers `routed.stage`, with these limits (bytes). */
  staging?: { item?: number; caller?: number; total?: number; ttlMs?: number }
  /** Offers `routed.stream.open`, backed by a real display adapter over the owner's own stores. */
  streams?:
    | boolean
    | {
        idleMs?: number
        maxThreads?: number
        /** Says who is subscribed; when absent nobody is, so an idle stream can be released. */
        isSubscribed?: (stream: StreamId, holder?: string) => boolean
      }
  clock?: Clock
  /** What the owner's terminals are told about the devices: whether one is connected, its name, a first terminal. */
  terminals?: {
    connected?: (node: NodeId) => boolean
    awayMs?: number
    deviceName?: (node: NodeId) => string
    onFirstTerminal?: (info: { node: NodeId; name: string; threadId: string }) => void
  }
}

/**
 * The computer that runs the threads, with the routed API registered and one other computer
 * connected to it. `read` makes a routed call and follows a paged reply to the end, as a caller does.
 */
export async function routedOwner(options: RoutedOwnerOptions = {}) {
  const f = await fixture(options.caps ?? COMPUTER)
  const clock = options.clock ?? systemClock
  const policy = new SqliteNodePolicy(f.targetDb, systemClock)
  const audit = new SqliteBridgeAudit(f.targetDb, systemClock)
  if (options.maxMode) policy.set(f.callerNode, { maxPermissionMode: options.maxMode })
  const staging = options.staging
    ? new RoutedStaging({
        db: f.targetDb,
        blobs: f.targetBlobs,
        store: f.targetStore,
        clock,
        limits: options.staging,
        readInput: (ref, context) => f.targetArtifacts.input(ref, context, 'routed.stage')
      })
    : undefined
  // The display adapter the owner's private streams run on, as the Bridge service builds it.
  let adapter: ThreadStreamAdapter | undefined
  if (options.streams) {
    // As the Bridge service: every stream listens to the same services, so they are given room for them.
    raiseStreamListenerLimits(f.mms)
    const sources = new PrivateSources(f.mms, policy)
    const shared = new MmsThreadSource(f.mms)
    const tuning = options.streams === true ? {} : options.streams
    adapter = new ThreadStreamAdapter({
      db: f.targetDb,
      store: f.targetStore,
      generations: f.targetStore,
      identity: f.targetIdentity,
      keys: f.targetKeys,
      clock,
      // As the Bridge service: a private stream's key goes to its own sources, any other id is a thread's.
      source: {
        snapshot: (key) => (isPrivateKey(key) ? sources.snapshot(key) : shared.snapshot(key)),
        onThread: (key, listener, onError) =>
          isPrivateKey(key)
            ? sources.onThread(key, listener, onError)
            : shared.onThread(key, listener, onError)
      },
      isTurnActive: (threadId) => f.mms.orchestrator.isTurnActive(threadId),
      isSubscribed: () => false,
      ...tuning
    })
    resources.push(() => adapter?.close())
  }
  const routes = new OwnerRoutes({
    services: f.mms,
    rpc: f.targetRpc,
    policy,
    audit,
    clock,
    track: (work) => work,
    ...(options.terminals
      ? {
          connected: options.terminals.connected,
          deviceName: options.terminals.deviceName,
          onFirstTerminal: options.terminals.onFirstTerminal,
          terminalAwayMs: options.terminals.awayMs
        }
      : {}),
    ...(staging ? { staging } : {}),
    ...(adapter
      ? {
          streams: routedStreamsPort(adapter),
          // As the Bridge service does: Git progress goes to the computer that started the action.
          connectionEvent: async (
            caller: { node: NodeId },
            type: string,
            data: unknown
          ): Promise<void> => {
            if (type === 'git.operation') adapter!.pushChannel(caller.node, type, data)
          }
        }
      : {})
  })
  routes.register()
  await f.connect()

  const raw = async (
    method: string,
    params: Record<string, unknown>,
    idem?: string
  ): Promise<RoutedReply | RoutedPagedReply> => {
    const row = ROUTED_METHODS[method]
    const reply = await f.caller().rpc(routedNetMethod(method), params, {
      id: newId('rpc'),
      ...(row?.durable ? { idem: idem ?? `idem-${newId('rpc')}` } : {}),
      deadlineMs: 60_000
    })
    expect(isRoutedReply(reply) || isRoutedPagedReply(reply)).toBe(true)
    return reply as RoutedReply | RoutedPagedReply
  }
  const fetchPage = async (id: string, index: number): Promise<RoutedPage> => {
    const reply = (await f
      .caller()
      .rpc(
        routedNetMethod('page'),
        { id, index },
        { id: newId('rpc'), deadlineMs: 20_000 }
      )) as RoutedReply
    if (!reply.ok) throw new Error(`page refused: ${reply.error.code}`)
    return reply.result as RoutedPage
  }
  const settled = async (reply: RoutedReply | RoutedPagedReply): Promise<RoutedReply> =>
    isRoutedPagedReply(reply) ? reassemblePagedReply(reply.paged, fetchPage) : reply
  const call = async (method: string, params: Record<string, unknown>, idem?: string) =>
    settled(await raw(method, params, idem))
  const ok = async (method: string, params: Record<string, unknown>) => {
    const reply = await call(method, params)
    if (!reply.ok) throw new Error(`${method} refused: ${reply.error.code}: ${reply.error.message}`)
    return reply.result as Record<string, any>
  }
  const thread = (name = 'A thread', projectId?: string, projectPath?: string) =>
    f.mms.threads.createThread(name, projectId, projectPath, {})

  /** What a caller does to stage a value: opens the request's artifact stream, uploads, and publishes the record. */
  const upload = async (bytes: Buffer): Promise<{ id: RpcId; ref: RpcArtifactRef }> => {
    const id = newId('rpc')
    const descriptor = (await f
      .caller()
      .rpc(
        'bridge.artifacts.open',
        { forRpcId: id, forMethod: routedNetMethod('stage') },
        { id: newId('rpc'), idem: `open-${id}`, deadlineMs: 20_000 }
      )) as StreamDescriptor
    const blob = `blb_${createHash('sha256').update(bytes).digest('hex')}` as RpcArtifactRef['blob']
    await f.caller().putBlob(descriptor.id, blob, bytes, false)
    const identity = f.callerIdentity(),
      self = identity.self()!,
      root = identity.pinnedRootKey(self.user)!,
      roster = identity.verifySigned<Roster>(identity.roster()!, root),
      delegation = roster.nodes
        .map((row) => identity.verifySigned<NodeDelegation>(row, root))
        .filter((row) => row.subject === self.node)
        .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
    const event = newId('event')
    const envelope = encodeEnvelope({
      v: 1,
      minor: 0,
      id: event,
      stream: descriptor.id,
      type: 'artifact.published',
      crit: false,
      author: { user: self.user, node: self.node, keyEpoch: delegation.keyEpoch },
      ts: Date.now(),
      body: { rpc: id, purpose: 'input' },
      blobs: [{ id: blob, bytes: bytes.length, mime: 'application/json' }]
    })
    await f.caller().append(descriptor.id, event, envelope, f.callerKeys.signAsNode(envelope))
    return { id, ref: { stream: descriptor.id, event, blob } }
  }
  /** Stages a value (the JSON text of it) and answers the reply of `routed.stage`. */
  const stage = async (value: unknown): Promise<RoutedReply> => {
    const { id, ref } = await upload(Buffer.from(JSON.stringify(value)))
    return (await f
      .caller()
      .rpc(
        routedNetMethod('stage'),
        { input: ref },
        { id, idem: `stage-${id}`, deadlineMs: 60_000 }
      )) as RoutedReply
  }
  return {
    f,
    routes,
    policy,
    audit,
    staging,
    adapter,
    raw,
    call,
    ok,
    settled,
    thread,
    stage,
    upload,
    fetchPage
  }
}
