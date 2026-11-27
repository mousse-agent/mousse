/**
 * Which other computers' bots the viewing computer lists (`PeerDirectory.botComputers`): unlike the computers whose
 * threads are listed, a roster device that is away stays (its bots are listed offline from their copy), a pairing that
 * no longer accepts this one is left out (so its bots go), and an unreadable roster or a starting engine says "not
 * known" rather than "none", so nothing is forgotten on a bad moment.
 */
import { describe, expect, it } from 'vitest'
import { PeerDirectory, type EngineDirectoryPort, type PeerRow } from '../../../src/mms/bridge/peers'
import { newId, type NodeId } from '../../../src/shared/net'

const SELF = newId('node') as NodeId
const AWAY = newId('node') as NodeId
const HERE = newId('node') as NodeId
const PAIRED = newId('node') as NodeId
const REFUSING = newId('node') as NodeId

function directory(options: { roster?: 'ok' | 'unreadable'; engine?: { settled?: boolean; refusing?: boolean } } = {}) {
  const delegation = (subject: NodeId, name: string) => ({ payload: { subject, keyEpoch: 1, issuedAt: 1, name, caps: ['read', 'settings'] } })
  const identity = {
    self: () => ({ user: 'user', node: SELF }),
    pinnedRootKey: () => 'root',
    roster: () => (options.roster === 'unreadable' ? undefined : { payload: { nodes: [delegation(SELF, 'This one'), delegation(AWAY, 'Away'), delegation(HERE, 'Here')], revoked: [] } }),
    verifySigned: (signed: { payload: unknown }) => signed.payload
  }
  const runtime = {
    identity,
    connections: { connected: (node: NodeId) => node === HERE },
    policy: { get: () => ({ blocked: false }) },
    enrollment: { nodeKind: () => undefined }
  }
  const row = (node: NodeId, name: string) => ({ node, name }) as PeerRow
  const engine = options.engine && {
    on: () => true,
    settled: () => options.engine!.settled !== false,
    rows: () => [row(PAIRED, 'Paired'), row(REFUSING, 'Refusing')],
    accepted: (node: NodeId) => !(options.engine!.refusing && node === REFUSING)
  }
  return new PeerDirectory({
    net: { featureEnabled: () => true, runtime: () => runtime } as never,
    engine: () => engine as unknown as EngineDirectoryPort | undefined
  })
}

describe('the computers whose bots are listed', () => {
  it('keep a roster device that is away, which the computers whose threads are listed leave out', () => {
    const peers = directory()
    expect(peers.computers()?.map((ref) => ref.node)).toEqual([HERE])
    expect(peers.botComputers()).toEqual({ computers: [{ node: AWAY, name: 'Away' }, { node: HERE, name: 'Here' }], v1Unknown: false })
  })

  it('leave out a pairing that no longer accepts this one, so its bots go', () => {
    const peers = directory({ engine: { refusing: true } })
    expect(peers.botComputers()?.computers.map((ref) => ref.node)).toEqual([AWAY, HERE, PAIRED])
  })

  it('say the v1 devices are not known, rather than none, while the roster can’t be read and the engine is on', () => {
    expect(directory({ roster: 'unreadable', engine: {} }).botComputers()).toEqual({ computers: [{ node: PAIRED, name: 'Paired' }, { node: REFUSING, name: 'Refusing' }], v1Unknown: true })
    expect(directory({ roster: 'unreadable' }).botComputers()).toBeUndefined()
  })

  it('are not known while the engine is still starting', () => {
    expect(directory({ engine: { settled: false } }).botComputers()).toBeUndefined()
  })
})
