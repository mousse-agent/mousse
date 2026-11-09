import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadDbClient } from '../src/mms/data/threadDb/threadDbClient'
import { ThreadDbStore } from '../src/mms/data/threadDb/threadDbStore'
import { ThreadDbEngine } from '../src/mms/data/threadDb/threadDbEngine'
import { sameAsSkeleton, skeletonOf } from '../src/mms/data/threadDb/jsonSkeleton'
import { legacyFingerprint } from '../src/mms/data/legacyThreadData'
import type { ChatMessage, NativeLlmContext } from '../src/shared/types'

const message = (id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'user', content, timestamp: '2026-01-01T00:00:00.000Z', ...extra }) as ChatMessage

function context(messages: unknown[], retired?: unknown[]): NativeLlmContext {
  return { version: 2, messages, ...(retired ? { retiredMessages: retired } : {}), fidelity: 'native', activeStartIndex: 0 } as unknown as NativeLlmContext
}

describe('ThreadDbStore', () => {
  let dir: string
  let client: ThreadDbClient
  let store: ThreadDbStore

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-threaddb-')))
    client = new ThreadDbClient({ script: null })
    store = new ThreadDbStore(client)
    client.callSync('create', dir)
  })

  afterEach(async () => {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes only the rows that changed', () => {
    const messages = Array.from({ length: 50 }, (_, i) => message(`m${i}`, `text ${i}`))
    expect(store.save(dir, { messages }).inserted).toBe(50)
    const loaded = store.load(dir).messages
    loaded[49].content += ' more'
    const stats = store.save(dir, { messages: loaded })
    expect(stats).toMatchObject({ inserted: 0, updated: 1, deleted: 0 })
    loaded.push(message('m50', 'new'))
    expect(store.save(dir, { messages: loaded })).toMatchObject({ inserted: 1, updated: 0, deleted: 0 })
    expect(store.save(dir, { messages: loaded })).toMatchObject({ inserted: 0, updated: 0, deleted: 0, bytes: 0 })
  })

  it('keeps row identity through replaced objects, splices and repeated ids', () => {
    const messages = [message('a', '1'), message('dup', 'x'), message('dup', 'y'), message('b', '2')]
    store.save(dir, { messages })
    const loaded = store.load(dir).messages
    // A replaced object (like a streamed message rebuilt with a spread) updates its own row.
    loaded[0] = { ...loaded[0], content: '1!' }
    // A removal in the middle deletes one row and moves nothing.
    loaded.splice(1, 1)
    const stats = store.save(dir, { messages: loaded })
    expect(stats).toMatchObject({ inserted: 0, updated: 1, deleted: 1 })
    const fresh = new ThreadDbStore(client).load(dir).messages
    expect(fresh.map((m) => [m.id, m.content])).toEqual([['a', '1!'], ['dup', 'y'], ['b', '2']])
  })

  it('inserts between rows without moving them, and renumbers only when out of room', () => {
    store.save(dir, { messages: [message('a', 'a'), message('z', 'z')] })
    let loaded = store.load(dir).messages
    for (let i = 0; i < 30; i++) {
      loaded.splice(1, 0, message(`n${i}`, `n${i}`))
      store.save(dir, { messages: loaded })
      loaded = store.load(dir).messages
    }
    const fresh = new ThreadDbStore(client).load(dir).messages
    expect(fresh.map((m) => m.id)).toEqual(loaded.map((m) => m.id))
    expect(fresh[0].id).toBe('a')
    expect(fresh.at(-1)!.id).toBe('z')
  })

  it('round-trips the model context and subagent sessions as rows', () => {
    const llmContext = context([{ role: 'user', content: 'hi' }, { role: 'assistant', content: [] }], [{ role: 'user', content: 'old' }])
    const sessions = [{
      version: 2, agentId: 'agent-1', worktreePath: '/w', task: 't', assignment: {}, runState: 'idle', updatedAt: 'x',
      messages: [message('s1', 'sub')], history: [{ role: 'user', content: 'h' }],
      nativeContext: context([{ role: 'user', content: 'nc' }])
    }]
    store.save(dir, { messages: [message('a', 'a')], agents: [], tasks: [], llmContext, mousseAgentSessions: sessions as never })
    const back = new ThreadDbStore(client).load(dir)
    expect(back.llmContext).toEqual(llmContext)
    expect(back.mousseAgentSessions).toEqual(sessions)
    // Dropping the retired list and the sessions removes their rows.
    const again = store.load(dir)
    delete again.llmContext!.retiredMessages
    store.save(dir, { llmContext: again.llmContext, mousseAgentSessions: null })
    const after = new ThreadDbStore(client).load(dir)
    expect(after.llmContext!.retiredMessages).toBeUndefined()
    expect(after.mousseAgentSessions).toEqual([])
    store.save(dir, { llmContext: null })
    expect(new ThreadDbStore(client).load(dir).llmContext).toBeUndefined()
  })

  it('never removes a row another writer added that this writer has not seen', () => {
    const owner = store
    owner.save(dir, { messages: [message('a', 'a')] })
    const session = owner.load(dir).messages
    const peer = new ThreadDbStore(new ThreadDbClient({ script: null }))
    const peerView = peer.load(dir).messages
    peerView.push(message('peer', 'scheduled result'))
    peer.save(dir, { messages: peerView })
    // The owner saves its own view, which never had the peer's message.
    session.push(message('b', 'b'))
    owner.save(dir, { messages: session })
    const ids = new ThreadDbStore(client).load(dir).messages.map((m) => m.id)
    expect(ids).toEqual(['a', 'peer', 'b'])
    // Once the owner's view includes it, the owner may remove it like any other row.
    const merged = owner.load(dir).messages.filter((m) => m.id !== 'peer')
    owner.save(dir, { messages: merged })
    expect(new ThreadDbStore(client).load(dir).messages.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('reports changes since a sequence, including removals', () => {
    store.save(dir, { messages: [message('a', 'a'), message('b', 'b')] })
    const seq = store.info(dir).seq
    const loaded = store.load(dir).messages
    loaded[0].content = 'A'
    loaded.splice(1, 1)
    store.save(dir, { messages: loaded })
    const changes = client.callSync('changes', dir, seq)
    expect(changes.reset).toBe(false)
    expect(changes.rows.map((row) => JSON.parse(row.payload).content)).toEqual(['A'])
    expect(changes.removed).toHaveLength(1)
  })

  it('a failed save leaves memory describing what is on disk', () => {
    store.save(dir, { messages: [message('a', 'a')] })
    const loaded = store.load(dir).messages
    loaded.push({ id: 'bad', role: 'user', content: 'x', timestamp: 'x', big: 10n } as unknown as ChatMessage)
    expect(() => store.save(dir, { messages: loaded })).toThrow()
    expect(store.load(dir).messages.map((m) => m.id)).toEqual(['a'])
  })

  it('treats a moved or deleted database as missing instead of recreating it', () => {
    store.save(dir, { messages: [message('a', 'a')] })
    client.quiesce(dir)
    rmSync(join(dir, 'thread.db'))
    expect(() => client.callSync('load', dir)).toThrow(/No thread database/)
    expect(existsSync(join(dir, 'thread.db'))).toBe(false)
  })
})

describe('thread database import', () => {
  let dir: string
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-threadimport-')))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('builds a verified copy of the JSON files and refuses a source that changed', () => {
    const messages = Array.from({ length: 20 }, (_, i) => message(`m${i}`, `t${i}`))
    writeFileSync(join(dir, 'messages.json'), JSON.stringify(messages))
    writeFileSync(join(dir, 'agents.json'), '[]')
    writeFileSync(join(dir, 'tasks.json'), '[]')
    const engine = new ThreadDbEngine({ idleCloseMs: 0 })
    const fingerprint = legacyFingerprint(dir)
    const built = engine.build(dir, { tmpName: 'thread.db.import-test', transactional: false, fingerprint })
    expect(built).toMatchObject({ ok: true, messages: 20 })
    writeFileSync(join(dir, 'messages.json'), JSON.stringify(messages.slice(1)))
    const stale = engine.build(dir, { tmpName: 'thread.db.import-test2', transactional: false, fingerprint })
    expect(stale).toEqual({ ok: false, stale: true })
    expect(readdirSync(dir).filter((name) => name.includes('import-test2'))).toEqual([])
  })
})

describe('ThreadDbStore keeps rows its caller never saw', () => {
  let dir: string
  let client: ThreadDbClient
  let store: ThreadDbStore
  let peer: ThreadDbStore

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-threaddb-peer-')))
    client = new ThreadDbClient({ script: null })
    store = new ThreadDbStore(client)
    peer = new ThreadDbStore(new ThreadDbClient({ script: null }))
    client.callSync('create', dir)
  })

  afterEach(async () => {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const ids = (): string[] => new ThreadDbStore(client).load(dir).messages.map((m) => m.id)

  it('after the thread left the cache', () => {
    store.save(dir, { messages: [message('a', 'a')] })
    const held = store.load(dir).messages
    peer.save(dir, { messages: [...peer.load(dir).messages, message('peer', 'p')] })
    store.forget(dir)
    held.push(message('b', 'b'))
    store.save(dir, { messages: held })
    expect(ids()).toEqual(['a', 'peer', 'b'])
  })

  it('in the model context, where rows have no id', () => {
    const context = (messages: unknown[]) => ({ version: 2, messages, fidelity: 'native', activeStartIndex: 0 }) as unknown as NativeLlmContext
    store.save(dir, { llmContext: context([{ role: 'user', content: 'a' }]) })
    const mine = store.load(dir).llmContext!
    const theirs = peer.load(dir).llmContext!
    peer.save(dir, { llmContext: { ...theirs, messages: [...theirs.messages, { role: 'user', content: 'peer' }] } as NativeLlmContext })
    store.save(dir, { llmContext: { ...mine, messages: [...mine.messages, { role: 'user', content: 'owner' }] } as NativeLlmContext })
    const contents = new ThreadDbStore(client).load(dir).llmContext!.messages.map((m) => (m as { content: string }).content)
    expect(contents).toEqual(['a', 'peer', 'owner'])
  })

  it('but removes what it saw, even when it clears the list or replaces every message with a copy', () => {
    peer.save(dir, { messages: [message('only', 'x')] })
    const loaded = store.load(dir).messages
    loaded.splice(0)
    expect(store.save(dir, { messages: loaded }).deleted).toBe(1)
    expect(ids()).toEqual([])
    peer.save(dir, { messages: [message('p1', 'x'), message('p2', 'y')] })
    const copies = store.load(dir).messages.map((m) => structuredClone(m)).filter((m) => m.id !== 'p1')
    store.save(dir, { messages: copies })
    expect(ids()).toEqual(['p2'])
  })
})

describe('ThreadDbStore removes only rows a caller had', () => {
  let dir: string
  let client: ThreadDbClient
  let store: ThreadDbStore
  let peer: ThreadDbStore

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-threaddb-had-')))
    client = new ThreadDbClient({ script: null })
    store = new ThreadDbStore(client)
    peer = new ThreadDbStore(new ThreadDbClient({ script: null }))
    client.callSync('create', dir)
  })

  afterEach(async () => {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const ids = (): string[] => new ThreadDbStore(client).load(dir).messages.map((m) => m.id)

  it('saving an old list again does not give it rows it never held', () => {
    store.save(dir, { messages: [message('a', 'a')] })
    const held = store.load(dir).messages
    peer.save(dir, { messages: [...peer.load(dir).messages, message('peer', 'p')] })
    held.push(message('own', 'o'))
    store.save(dir, { messages: held })
    store.save(dir, { messages: held })
    expect(ids()).toEqual(['a', 'peer', 'own'])
  })

  it('two lists in one process sharing messages keep each other\'s rows', () => {
    store.save(dir, { messages: [message('a', 'a')] })
    const session = store.load(dir).messages
    store.save(dir, { messages: [...session, message('local', 'l')] })
    store.save(dir, { messages: session })
    expect(ids()).toEqual(['a', 'local'])
  })

  it('a row another process edited is still the caller\'s to remove or edit', () => {
    store.save(dir, { messages: [message('a', 'a'), message('b', 'b')] })
    const mine = store.load(dir).messages
    const theirs = peer.load(dir).messages
    theirs[0]!.content = 'peer edit'
    theirs[1]!.content = 'peer edit b'
    peer.save(dir, { messages: theirs })
    // Removing `a` removes it; replacing `b` with a new object edits that row, never adds a second `b`.
    store.save(dir, { messages: [{ ...mine[1]!, content: 'owner edit' }] })
    expect(new ThreadDbStore(client).load(dir).messages.map((m) => [m.id, m.content])).toEqual([['b', 'owner edit']])
  })

  it('copies saved after the thread left the cache keep a later append', () => {
    store.save(dir, { messages: [message('a', 'a')] })
    const copies = store.load(dir).messages.map((m) => structuredClone(m))
    peer.save(dir, { messages: [...peer.load(dir).messages, message('peer', 'p')] })
    store.forget(dir)
    store.save(dir, { messages: [...copies, message('own', 'o')] })
    expect(ids()).toEqual(['a', 'peer', 'own'])
  })

  it('data from a database that was replaced removes nothing from the new one', () => {
    store.save(dir, { messages: [message('old', 'o')] })
    const old = store.load(dir).messages
    client.quiesce(dir)
    rmSync(join(dir, 'thread.db'))
    client.callSync('create', dir)
    peer.save(dir, { messages: [message('new', 'n')] })
    store.save(dir, { messages: old })
    expect(ids()).toContain('new')
  })

  it('an empty session list is known too', () => {
    const session = { version: 2, agentId: 'x', worktreePath: '/w', task: 't', assignment: {}, runState: 'idle', updatedAt: 'u', messages: [] }
    store.save(dir, { mousseAgentSessions: [session] as never })
    const first = store.load(dir).mousseAgentSessions!
    const second = store.load(dir).mousseAgentSessions!
    first[0]!.messages.push(message('local', 'l'))
    store.save(dir, { mousseAgentSessions: first })
    store.save(dir, { mousseAgentSessions: second })
    expect(new ThreadDbStore(client).load(dir).mousseAgentSessions![0]!.messages.map((m) => m.id)).toEqual(['local'])
  })
})

describe('JSON fidelity of saved rows', () => {
  let dir: string
  let client: ThreadDbClient

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-threaddb-json-')))
    client = new ThreadDbClient({ script: null })
    client.callSync('create', dir)
  })

  afterEach(async () => {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps an own __proto__ key in memory, on disk and in a fresh load', () => {
    const store = new ThreadDbStore(client)
    const parsed = JSON.parse('{"id":"m","role":"user","content":"x","timestamp":"t","meta":{"__proto__":{"important":1}}}') as ChatMessage
    store.save(dir, { messages: [parsed] })
    const expected = JSON.stringify([parsed])
    expect(JSON.stringify(store.load(dir).messages)).toBe(expected)
    expect(JSON.stringify(new ThreadDbStore(client).load(dir).messages)).toBe(expected)
  })

  it('saves exactly what JSON.stringify writes, and sees every change to it', () => {
    const store = new ThreadDbStore(client)
    const tricky = [
      { n: new Number(42), s: new String('boxed'), b: new Boolean(false) },
      { keyed: { toJSON: (key: string) => (key === 'keyed' ? 'by key' : 'other') } },
      { nested: [undefined, () => 1, Symbol('x'), NaN, Infinity, -0] },
      { date: new Date('2026-01-01T00:00:00Z') },
      Object.defineProperty({}, 'getter', { enumerable: true, get: () => 'read' })
    ]
    tricky.forEach((extra, i) => {
      const value = { id: `m${i}`, role: 'user', content: 'x', timestamp: 't', extra } as unknown as ChatMessage
      store.save(dir, { messages: [value] })
      expect(JSON.stringify(new ThreadDbStore(client).load(dir).messages)).toBe(JSON.stringify([value]))
    })
    // A change only JSON sees (a boxed number, a toJSON that depends on its key) is written.
    const before = { id: 'k', role: 'user', content: 'x', timestamp: 't', extra: { x: {} } } as unknown as ChatMessage
    store.save(dir, { messages: [before] })
    const loaded = store.load(dir).messages
    ;(loaded[0] as unknown as { extra: { x: unknown } }).extra.x = new Number(42)
    expect(store.save(dir, { messages: loaded }).updated).toBe(1)
    ;(loaded[0] as unknown as { extra: { x: unknown } }).extra.x = { toJSON: (key: string) => (key === 'x' ? 2 : 1) }
    expect(store.save(dir, { messages: loaded }).updated).toBe(1)
    expect(new ThreadDbStore(client).load(dir).messages[0]).toMatchObject({ extra: { x: 2 } })
  })

  it('remembers exactly what it wrote for a value whose toJSON changes each time', () => {
    const store = new ThreadDbStore(client)
    let counter = 0
    store.save(dir, { agents: [{ toJSON: () => ({ n: ++counter }) }] as never })
    expect(store.load(dir).agents).toEqual(new ThreadDbStore(client).load(dir).agents)
  })

  it('follows JSON.stringify for functions with toJSON, boxed values, BigInt objects and cycles', () => {
    const fn = Object.assign(() => 1, { toJSON: () => 'from fn' })
    const flag = new Boolean(true)
    ;(flag as unknown as { valueOf: () => boolean }).valueOf = () => false
    expect(skeletonOf({ fn, flag })).toEqual(JSON.parse(JSON.stringify({ fn, flag })))
    expect(() => JSON.stringify(Object(1n))).toThrow(TypeError)
    expect(() => skeletonOf(Object(1n))).toThrow(TypeError)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => skeletonOf(cycle)).toThrow(TypeError)
    expect(() => sameAsSkeleton(cycle, { self: {} })).toThrow(TypeError)
  })
})
