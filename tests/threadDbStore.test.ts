import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadDbClient } from '../src/mms/data/threadDb/threadDbClient'
import { ThreadDbStore } from '../src/mms/data/threadDb/threadDbStore'
import { ThreadDbEngine } from '../src/mms/data/threadDb/threadDbEngine'
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
