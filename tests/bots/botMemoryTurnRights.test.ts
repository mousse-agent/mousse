import { afterEach, expect, it } from 'vitest'
import { botMemoryTools } from '../../src/mms/run/mcp/appTools/botMemory'
import { createBotContextProvider } from '../../src/mms/bots/memory/contextPack'
import { createBotJournal } from '../../src/mms/bots/memory/capture'
import { appTurn } from '../run/appToolsFixture'
import { botFixture, createBot, finish, flush, start, type BotFixture } from './botFixture'
import { disposeFixtures, memoryFixture } from './memory/memoryFixture'

let f: BotFixture | undefined
afterEach(() => { f?.close(); disposeFixtures() })

// Owner messages (including continuations), tapped answers, all bot-started chat kinds,
// and an unknown future kind: memory rights must never come from the requested kind.
it.each([
  ['chat:message', true], ['chat:after:message', true], ['answer:question', true],
  ['create:bot', false], ['wake:event', false], ['question:q:default', false], ['future:start', false]
])('%s saves and forgets only with its turn’s memory rights', async (key, ownerStarted) => {
  f = botFixture()
  const { botId } = await createBot(f, { reply: 'Hello' })
  const memory = memoryFixture()
  const { store } = memory
  const saved = ['owner', 'note'].map((kind) => store.save(botId, { lane: 'chat', kind: kind as 'owner' | 'note', text: `Original ${kind}` }))
  const activation = await f.bots.enqueueChat(botId, key, 'Continue')
  await flush()
  const { payload } = await start(f, activation.id)
  const tools = new Map(botMemoryTools({ activationOf: (id) => f!.bots.tools.activationOf(id), memory: store }).map((tool) => [tool.name, tool]))
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await tools.get(name)!.handler(args, {
      caller: { threadId: payload.threadId, runId: payload.runId, provider: 'pi', modeCeiling: 'default', accessLevel: 'lineage' },
      turn: { turnToken: 't', ...appTurn({ threadId: payload.threadId, runId: payload.runId }) },
      toolCallId: 'call', signal: new AbortController().signal, transport: 'mcp'
    })
    return { ...result, value: JSON.parse(result.text) }
  }
  for (const kind of ['owner', 'note']) {
    const result = await call('memory_save', { kind, text: `New ${kind}`, lane: 'chat', ownerStarted: true })
    expect(result.isError).toBeUndefined()
    expect(store.active(botId).find((entry) => entry.text === `New ${kind}`)?.kind).toBe(ownerStarted ? kind : 'run_note')
    if (!ownerStarted) expect(result.value).toMatchObject({ kind: 'run_note', note: 'In a run or a turn you started yourself, saves are run notes.' })
  }
  for (const entry of saved) {
    if ('error' in entry) throw new Error(entry.error)
    const result = await call('memory_save', { kind: 'owner', text: 'Replacement', replaces: entry.ref })
    expect(result.isError === true).toBe(!ownerStarted)
    if (!ownerStarted) expect(result.value.reason).toContain('A run or a turn you started yourself')
  }
  // Run notes may still be replaced in an unattended turn.
  if (!ownerStarted) {
    const note = store.active(botId).find((entry) => entry.kind === 'run_note')!
    expect((await call('memory_save', { kind: 'note', text: 'Updated run note', replaces: note.ref })).isError).toBeUndefined()
  }
  const said = memory.message({ botId, id: 'owner-row', author: 'owner', text: 'Original owner' })
  const forgot = await call('memory_forget', { id: 'm1', refs: [`j${said}`], reason: 'Remove this' })
  if (ownerStarted) expect(forgot.isError).toBeUndefined()
  else {
    expect(forgot).toMatchObject({ isError: true, value: { reason: 'Ask the owner in the chat.' } })
    expect(store.active(botId).find((entry) => entry.id === 'm1')?.text).toBe('Original owner')
    expect(store.search(botId, { query: 'Original owner', kinds: ['chat'] }).some((hit) => hit.ref === `j${said}`)).toBe(true)
  }
  await finish(f, payload)
})

it.each([
  ['chat:message', true], ['answer:q', true], ['create:bot', false], ['wake:event', false], ['question:q:default', false]
])('%s gates the standing-wish fallback after the real dispatch', async (key, ownerStarted) => {
  f = botFixture()
  const { botId } = await createBot(f, { reply: 'Hello' })
  const memory = memoryFixture()
  const journal = createBotJournal({ store: memory.store, readThread: () => ({ messages: [] }), listThreads: () => [] })
  f.host.context = createBotContextProvider({ store: memory.store, journal })
  const activation = await f.bots.enqueueChat(botId, key, 'Continue')
  await flush()
  // Even owner-shaped history must not be promoted by a bot-started turn.
  memory.message({ botId, id: 'wish', activationId: activation.id, author: 'owner', text: 'Always keep your replies short.' })
  const { payload } = await start(f, activation.id)
  await finish(f, payload)
  expect(memory.store.active(botId).filter((entry) => entry.kind === 'owner')).toHaveLength(ownerStarted ? 1 : 0)
})
