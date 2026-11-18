import { tellingLine } from '../../src/shared/bots/personal/tellingSettings'
/**
 * What changed in Mousse for bots (src/mms/bots/changelog.ts): a bot with history is told the entries it has not seen,
 * after its memory, until a chat turn that carried them settles; a new bot is told nothing. And no bot prompt text or
 * tool description may still say what an entry removed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_CHANGELOG, BOT_CHANGELOG_LATEST, BOT_CHANGELOG_PACK_ENTRIES } from '../../src/mms/bots/changelog'
import { BotChatProjection } from '../../src/mms/bots/chat/projection'
import { BOT_BASE_INSTRUCTIONS, BOT_CHAT_INSTRUCTIONS, BOT_RUN_INSTRUCTIONS, BOT_SUBAGENT_INSTRUCTIONS } from '../../src/mms/bots/instructions'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { createBotJournal } from '../../src/mms/bots/memory/capture'
import { BOT_MEMORY_PROTOCOL, createBotContextProvider } from '../../src/mms/bots/memory/contextPack'
import { BotStore } from '../../src/mms/bots/store/BotStore'
import { BOT_TOOLS } from '../../src/mms/run/mcp/appTools/bots'
import { BOT_MEMORY_TOOL_DEFINITIONS } from '../../src/mms/run/mcp/appTools/botMemory'

const HEADER = 'Mousse changed since you last ran.'
const FIX = 'replace each memory entry these contradict with memory_save'

let home: string
let store: BotStore
let memory: BotMemoryStore
let chat: BotChatProjection

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bot-changelog-'))
  const clock = () => Date.UTC(2026, 10, 15, 23, 0)
  store = new BotStore({ profileHome: home, clock })
  memory = new BotMemoryStore({ db: store.db, clock, timeZone: () => 'Europe/London' })
  const journal = createBotJournal({ store: memory, readThread: () => ({ messages: [] }), listThreads: () => [] })
  chat = new BotChatProjection({ store, journal, emit: () => {} })
})
afterEach(() => {
  store.close()
  rmSync(home, { recursive: true, force: true })
})

const packs = () => createBotContextProvider({ store: memory, journal: { syncThread: async () => {} } })
type Provider = ReturnType<typeof packs>
const settled = (provider: Provider, activationId: string, consult = false) =>
  provider.afterDispatch({ botId: 'ada', activationId, dispatchId: `${activationId}:1`, lane: 'chat', threadId: `t-${activationId}`, endedBy: 'settled', ...(consult ? { consult: true as const } : {}) })
/** A bot made before the change: it has chatted and remembers the old behaviour. */
const existingBot = () => {
  chat.post({ botId: 'ada', author: 'owner', kind: 'text', text: 'Hi', activationId: 'act-0' })
  memory.save('ada', { lane: 'chat', kind: 'note', text: 'Wakes wait out 22:00 to 08:00.' })
}

describe('the bot changelog in the pack', () => {
  it('tells a bot with history the newest unseen changes after its memory, with the fix, until a chat turn carrying it settles', async () => {
    existingBot()
    const provider = packs()
    const first = await provider.chatPreamble({ botId: 'ada', activationId: 'act-1' })
    expect(first.indexOf(HEADER)).toBeGreaterThan(first.indexOf('</bot_memory>'))
    for (const entry of BOT_CHANGELOG.slice(-BOT_CHANGELOG_PACK_ENTRIES)) expect(first).toContain(entry.text)
    expect(first).toContain(FIX)

    // A run follows the changes but can't fix core memory, and does not mark them seen.
    const run = await provider.runPreamble({ botId: 'ada', activationId: 'act-run' })
    expect(run).toContain(HEADER)
    expect(run).not.toContain(FIX)

    // A consult of the turn settling marks nothing; the turn itself does.
    await settled(provider, 'act-1', true)
    expect(await provider.chatPreamble({ botId: 'ada', activationId: 'act-2' })).toContain(HEADER)
    await settled(provider, 'act-1')
    expect(await provider.chatPreamble({ botId: 'ada', activationId: 'act-3' })).not.toContain(HEADER)
    expect(await provider.runPreamble({ botId: 'ada', activationId: 'act-run-2' })).not.toContain(HEADER)
  })

  it('lists only the entries after the one the bot has seen', async () => {
    existingBot()
    memory.write(() => memory.setState('ada', 'changelog_seen', BOT_CHANGELOG_LATEST - 1))
    const pack = await packs().chatPreamble({ botId: 'ada', activationId: 'act-1' })
    expect(pack).toContain(BOT_CHANGELOG.at(-1)!.text)
    expect(pack).not.toContain(BOT_CHANGELOG[0]!.text)
  })

  it('tells a bot that saw the old watcher advice that every chat turn can start commands', async () => {
    existingBot()
    memory.write(() => memory.setState('ada', 'changelog_seen', 9))
    const pack = await packs().chatPreamble({ botId: 'ada', activationId: 'act-watch-rule' })
    expect(pack).toMatch(/any chat turn can start a background command with watch_start/i)
    expect(pack).not.toMatch(/only.*chat turn.*owner.*own message/i)
    expect(pack).not.toMatch(/tell your owner what to start/i)
  })

  it('tells a new bot nothing: it has no history to correct', async () => {
    const provider = packs()
    chat.post({ botId: 'ada', author: 'owner', kind: 'text', text: 'Hello', activationId: 'act-1' })
    expect(await provider.chatPreamble({ botId: 'ada', activationId: 'act-1' })).not.toContain(HEADER)
    expect(await provider.runPreamble({ botId: 'ada', activationId: 'act-run' })).not.toContain(HEADER)
  })
})

describe('the bot changelog entries', () => {
  it('have increasing ids and real dates', () => {
    BOT_CHANGELOG.forEach((entry, index) => {
      expect(entry.id).toBe(index + 1)
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isNaN(Date.parse(entry.date))).toBe(false)
    })
  })

  it('a removed behaviour is said nowhere in a bot\'s prompt text or tool descriptions', () => {
    const texts: Record<string, string> = {
      base: BOT_BASE_INSTRUCTIONS,
      chat: BOT_CHAT_INSTRUCTIONS,
      run: BOT_RUN_INSTRUCTIONS,
      subagent: BOT_SUBAGENT_INSTRUCTIONS,
      memoryProtocol: BOT_MEMORY_PROTOCOL,
      ...Object.fromEntries(BOT_TOOLS.map((tool) => [`tool ${tool.name}`, JSON.stringify(tool)])),
      ...Object.fromEntries(Object.values(BOT_MEMORY_TOOL_DEFINITIONS).map((tool) => [`tool ${tool.name}`, JSON.stringify(tool)]))
    }
    for (const entry of BOT_CHANGELOG) {
      for (const pattern of entry.gone ?? []) {
        for (const [where, text] of Object.entries(texts)) expect(text, `${where} still says ${pattern} (changelog entry ${entry.id})`).not.toMatch(pattern)
      }
    }
  })
})

// Quiet settings and the changelog are read together by old bots.
it('quiet-hour advice agrees with settings and later entries', () => {
  const advice = BOT_CHANGELOG.map(entry => entry.text).join('\n')
  expect(advice).not.toMatch(/there are no quiet hours|never tell your owner you hold anything/i)
  expect(BOT_CHANGELOG.find(entry => entry.id === 15)!.text).toMatch(/quiet hours now exist/i)
  for (const entry of BOT_CHANGELOG) for (const gone of entry.gone ?? []) {
    for (const text of [tellingLine({}, { from: '22:00', to: '08:00' })!, ...BOT_CHANGELOG.filter(later => later.id > entry.id).map(later => later.text)]) expect(text).not.toMatch(gone)
  }
})
it('all memory wish instructions route telling wishes to settings', () => {
  for (const text of [BOT_BASE_INSTRUCTIONS, BOT_MEMORY_PROTOCOL, BOT_MEMORY_TOOL_DEFINITIONS.memory_save.description]) {
    expect(text).toContain('(how or when to be told: telling_set instead)')
  }
})

it('tells existing bots that a pasted secret arrives by name', async () => {
  existingBot()
  memory.write(() => memory.setState('ada', 'changelog_seen', 24))
  const text = await packs().chatPreamble({ botId: 'ada', activationId: 'pasted-secret' })
  expect(text).toContain('Your owner can keep a pasted key as a secret')
  expect(text).toContain('secret_run')
})
