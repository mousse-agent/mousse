import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { OwnerRoutes } from '../../../../src/mms/bridge/routed/OwnerRoutes'
import { reassemblePagedReply } from '../../../../src/mms/bridge/routed/pages'
import { RoutedStaging } from '../../../../src/mms/bridge/routed/staging'
import type { Clock } from '../../../../src/mms/net/contracts'
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
  type NodeCapability,
  type NodeDelegation,
  type Roster,
  type RpcArtifactRef,
  type RpcId,
  type StreamDescriptor
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

export interface RoutedOwnerOptions {
  caps?: NodeCapability[]
  maxMode?: PermissionMode
  /** Offers `routed.stage`, with these limits (bytes). */
  staging?: { item?: number; caller?: number; total?: number; ttlMs?: number }
  clock?: Clock
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
  const routes = new OwnerRoutes({
    services: f.mms,
    rpc: f.targetRpc,
    policy,
    audit,
    clock,
    track: (work) => work,
    ...(staging ? { staging } : {})
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
