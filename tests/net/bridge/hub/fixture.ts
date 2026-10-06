import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { FileKeyStore, NetIdentityService } from '../../../../src/mms/net/identity'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { FileBlobStore } from '../../../../src/mms/net/store/blobs'
import { SqliteExecutionLedger } from '../../../../src/mms/net/store/executions'
import { DurableRpcDispatcher } from '../../../../src/mms/net/sync/rpcDispatcher'
import { NetSyncSession } from '../../../../src/mms/net/sync/session'
import { NodeStreamAuthority } from '../../../../src/mms/net/sync/nodeAuthority'
import { openSecureChannel } from '../../../../src/mms/net/link/secureChannel'
import { fingerprint } from '../../../../src/mms/net/link/selfSignedCert'
import { systemClock } from '../../../../src/mms/net/clock'
import {
  RemoteApi,
  MmsRemoteBackend,
  MmsThreadSource,
  ThreadStreamAdapter
} from '../../../../src/mms/bridge/remote'
import { BridgeArtifacts } from '../../../../src/mms/bridge/artifacts'
import { BridgeHub } from '../../../../src/mms/bridge/hub'
import { newId, type NodeCapability } from '../../../../src/shared/net'
import type { StreamStore } from '../../../../src/mms/net/contracts'
import { memoryPair } from '../../harness/MemoryTransport'
import { HUB_METHODS, validateHubParams } from '../../../../src/mms/bridge/hub/validation'
export const resources: Array<() => void | Promise<void>> = []
export async function cleanup() {
  for (const close of resources.splice(0).reverse()) await close()
}
function temp() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-hub-')))
  resources.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}
export async function fixture(
  caps: NodeCapability[] = ['read', 'chat', 'write'],
  fault?: (point: string) => void
) {
  const home = temp(),
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await mms.start()
  resources.push(() => mms.stop())
  const targetPath = mms.getProfileHomeDir(),
    callerPath = temp(),
    targetDb = new NetDatabase({ profileDir: targetPath }),
    targetKeys = new FileKeyStore(targetPath),
    targetIdentity = new NetIdentityService({
      database: targetDb.database,
      keys: targetKeys,
      clock: systemClock,
      coordinator: targetDb
    })
  resources.push(() => targetDb.close())
  await targetIdentity.bootstrapAuthority('Hub target')
  const callerKeys = new FileKeyStore(callerPath)
  await callerKeys.initialize({ asAuthority: false })
  const user = targetIdentity.self()!.user,
    node = newId('node')
  targetIdentity.issueNodeDelegation({
    node,
    keys: callerKeys.nodeKeys(),
    name: 'Hub caller',
    caps
  })
  const targetStore = new SqliteStreamStore(targetDb),
    targetBlobs = new FileBlobStore(targetDb),
    targetLedger = new SqliteExecutionLedger(targetDb),
    targetRpc = new DurableRpcDispatcher({
      db: targetDb,
      executions: targetLedger,
      identity: targetIdentity,
      clock: systemClock
    }),
    backend = new MmsRemoteBackend(mms),
    api = new RemoteApi(backend, systemClock)
  api.register(targetRpc)
  resources.push(
    () => api.close(),
    () => targetStore.close(),
    () => targetBlobs.close()
  )
  let adapter: ThreadStreamAdapter | undefined,
    targetSession: NetSyncSession | undefined,
    callerSession: NetSyncSession | undefined,
    hub!: BridgeHub,
    callerArtifacts!: BridgeArtifacts,
    callerDb!: NetDatabase,
    callerIdentity!: NetIdentityService,
    callerStore!: SqliteStreamStore,
    callerBlobs!: FileBlobStore
  const targetArtifacts = new BridgeArtifacts({
    db: targetDb,
    identity: targetIdentity,
    keys: targetKeys,
    store: targetStore,
    blobs: targetBlobs,
    rpc: targetRpc,
    clock: systemClock,
    fallback: new NodeStreamAuthority(targetIdentity, targetStore, targetBlobs, systemClock)
  })
  function openCaller(maxJournalBytes?: number) {
    callerDb = new NetDatabase({ profileDir: callerPath, fault })
    resources.push(() => callerDb.close())
    callerIdentity = new NetIdentityService({
      database: callerDb.database,
      keys: callerKeys,
      clock: systemClock,
      coordinator: callerDb,
      self: { user, node }
    })
    callerIdentity.pinUser(user, targetKeys.rootKey()!)
    callerIdentity.acceptRoster(targetIdentity.roster()!, targetKeys.rootKey()!)
    callerStore = new SqliteStreamStore(callerDb)
    callerBlobs = new FileBlobStore(callerDb)
    resources.push(
      () => callerStore.close(),
      () => callerBlobs.close()
    )
    const callerRpc = new DurableRpcDispatcher({
      db: callerDb,
      executions: new SqliteExecutionLedger(callerDb),
      identity: callerIdentity,
      clock: systemClock
    })
    for (const [method, meta] of Object.entries(HUB_METHODS)) {
      if (method === 'bridge.artifacts.open') continue
      callerRpc.register({
        method,
        ...meta,
        ...(method === 'bridge.dispatch' ? { uploadEnabled: true } : {}),
        handle: async () => {
          throw new Error('never execute on caller')
        }
      })
    }
    hub = new BridgeHub({
      db: callerDb,
      identity: callerIdentity,
      keys: callerKeys,
      store: callerStore,
      session: () => callerSession!,
      resolveResult: (...args) => callerArtifacts.resolveResult(...args),
      maxJournalBytes
    })
    resources.push(async () => {
      hub.close()
      await hub.drain()
    })
    callerArtifacts = new BridgeArtifacts({
      db: callerDb,
      identity: callerIdentity,
      keys: callerKeys,
      store: callerStore,
      blobs: callerBlobs,
      rpc: callerRpc,
      clock: systemClock,
      fallback: new NodeStreamAuthority(callerIdentity, callerStore, callerBlobs, systemClock),
      ownsRequest: (...args) => hub.ownsRequest(...args),
      canonicalRequest: (...args) => hub.canonicalRequest(...args)
    })
  }
  openCaller()
  function makeAdapter() {
    adapter?.close()
    adapter = new ThreadStreamAdapter({
      db: targetDb,
      store: targetStore,
      generations: targetStore,
      identity: targetIdentity,
      keys: targetKeys,
      clock: systemClock,
      source: new MmsThreadSource(mms),
      onRecord: (stream, record) => {
        void targetSession?.publishRecord(stream, record)
      }
    })
    resources.push(() => adapter?.close())
    return adapter
  }
  targetRpc.register({
    method: 'bridge.thread.open',
    capability: 'read',
    mutating: false,
    validate: (value) => validateHubParams('bridge.thread.open', value),
    handle: async (value) => {
      const descriptor = adapter!.activate((value as { threadId: string }).threadId)
      return { descriptor, head: adapter!.store.head(descriptor.id) }
    }
  })
  async function connect(store: StreamStore = targetStore) {
    const transport = memoryPair(),
      [targetChannel, callerChannel] = await Promise.all([
        openSecureChannel(transport.b, {
          role: 'server',
          credentials: targetKeys.tlsCredentials(),
          deadlineMs: 2000
        }),
        openSecureChannel(transport.a, {
          role: 'client',
          credentials: callerKeys.tlsCredentials(),
          expectedPeerFingerprint: fingerprint(
            Buffer.from(targetKeys.nodeKeys().transport, 'base64url')
          ),
          deadlineMs: 2000
        })
      ])
    targetSession = new NetSyncSession({
      channel: targetChannel,
      identity: targetIdentity,
      store,
      blobs: targetBlobs,
      rpc: targetRpc,
      authority:
        store === targetStore
          ? targetArtifacts
          : new NodeStreamAuthority(targetIdentity, store, targetBlobs, systemClock)
    })
    callerSession = new NetSyncSession({
      channel: callerChannel,
      identity: callerIdentity,
      store: callerStore,
      blobs: callerBlobs,
      capabilities: ['streams.v1', 'rpc.v1', 'blobs.v1'],
      canReceive: (descriptor, peer) =>
        descriptor.kind === 'node.artifact'
          ? callerArtifacts.canReceive(descriptor, peer)
          : hub.canReceive(descriptor, peer),
      verifyRecord: (record, descriptor) =>
        descriptor.kind === 'node.artifact'
          ? callerArtifacts.verifyRecord(record, descriptor)
          : hub.verifyRecord(record, descriptor)
    })
    const a = targetSession,
      b = callerSession
    resources.push(
      () => a.close(),
      () => b.close(),
      () => transport.cut()
    )
    await Promise.all([a.opened, b.opened])
    return { target: a, caller: b, transport }
  }
  async function restartCaller() {
    hub.close()
    await hub.drain()
    callerSession?.close()
    targetSession?.close()
    callerStore.close()
    callerBlobs.close()
    callerDb.close()
    openCaller()
    return connect()
  }
  return {
    mms,
    targetPath,
    callerPath,
    targetDb,
    targetKeys,
    targetIdentity,
    targetStore,
    targetRpc,
    targetLedger,
    targetArtifacts,
    backend,
    api,
    connect,
    restartCaller,
    makeAdapter,
    target: () => targetSession!,
    caller: () => callerSession!,
    hub: () => hub,
    callerDb: () => callerDb,
    callerIdentity: () => callerIdentity,
    callerStore: () => callerStore,
    targetNode: targetIdentity.self()!.node,
    callerNode: node
  }
}
