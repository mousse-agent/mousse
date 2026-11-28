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

  it('never repeats the old watcher advice to a bot that saw it', async () => {
    existingBot()
    memory.write(() => memory.setState('ada', 'changelog_seen', 9))
    const pack = await packs().chatPreamble({ botId: 'ada', activationId: 'act-watch-rule' })
    // The newest entries only (`BOT_CHANGELOG_PACK_ENTRIES`).
    expect(pack).toContain(BOT_CHANGELOG.at(-1)!.text)
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

// Old bots read every entry they have not seen, oldest first: a later entry never says what an earlier one removed.
it('later entries never say a removed behaviour', () => {
  for (const entry of BOT_CHANGELOG) for (const gone of entry.gone ?? []) {
    for (const text of BOT_CHANGELOG.filter(later => later.id > entry.id).map(later => later.text)) expect(text).not.toMatch(gone)
  }
})
it('all memory wish instructions save telling wishes as owner memory', () => {
  for (const text of [BOT_BASE_INSTRUCTIONS, BOT_MEMORY_PROTOCOL, BOT_MEMORY_TOOL_DEFINITIONS.memory_save.description]) {
    expect(text).toContain('including how or when to be told')
    expect(text).not.toContain('telling_set')
  }
})

it('C6 support rollback omits the switch-on advice and still delivers it after re-enabling', async () => {
  const undo = changelogUpTo(38)
  try {
    existingBot()
    memory.write(() => memory.setState('ada', 'changelog_seen', 23))
    let on = false
    const provider = createBotContextProvider({ store: memory, journal: { syncThread: async () => {} }, asksFirstEnabled: () => on })
    const off = await provider.chatPreamble({ botId: 'ada', activationId: 'c6-off' })
    expect(off).not.toContain('Tools that send or change things now ask your owner first')
    expect(off).not.toContain(BOT_CHANGELOG.find(entry => entry.id === 28)!.text)
    expect(off).toContain(BOT_CHANGELOG.find(entry => entry.id === 29)!.text)
    await settled(provider, 'c6-off')
    on = true
    // A later non-switch entry must not make the withheld switch entry count as delivered, including across restart.
    const restarted = createBotContextProvider({ store: memory, journal: { syncThread: async () => {} }, asksFirstEnabled: () => on })
    expect(await restarted.chatPreamble({ botId: 'ada', activationId: 'c6-on' })).toContain('Tools that send or change things now ask your owner first')
    await settled(restarted, 'c6-on')
    const next = await restarted.chatPreamble({ botId: 'ada', activationId: 'c6-after' })
    expect(next).not.toContain('Tools that send or change things now ask your owner first')
  } finally { undo() }
})

it('C6 support rollback shows entries 29 and 30 while E1 entry 28 stays pending, then delivers 28 once', async () => {
  // The pack as it was at entry 39: later entries push 28 out of its window (`changelogUpTo`).
  const undo = changelogUpTo(39)
  try {
    existingBot()
    memory.write(() => memory.setState('ada', 'changelog_seen', 27))
    const e1 = BOT_CHANGELOG.find(entry => entry.id === 28)!
    const bindingAdvice = BOT_CHANGELOG.find(entry => entry.id === 29)!
    // The experimental support switch withholds E1. The contiguous cursor must wait at 27.
    const provider = createBotContextProvider({ store: memory, journal: { syncThread: async () => {} }, asksFirstEnabled: () => false })
    for (let turn = 0; turn < 3; turn++) {
      const activationId = `c6-seen-off-${turn}`
      const off = await provider.chatPreamble({ botId: 'ada', activationId })
      expect(off).toContain(bindingAdvice.text)
      expect(off).not.toContain(e1.text)
      await settled(provider, activationId)
      expect(memory.getState<number>('ada', 'changelog_seen')).toBe(27)
    }
    const on = createBotContextProvider({ store: memory, journal: { syncThread: async () => {} }, asksFirstEnabled: () => true })
    const enabled = await on.chatPreamble({ botId: 'ada', activationId: 'c6-seen-on' })
    expect(enabled).toContain(e1.text)
    expect(enabled).toContain(bindingAdvice.text)
    await settled(on, 'c6-seen-on')
    expect(memory.getState<number>('ada', 'changelog_seen')).toBe(BOT_CHANGELOG.at(-1)!.id)
    for (let turn = 0; turn < 3; turn++) {
      const after = await on.chatPreamble({ botId: 'ada', activationId: `c6-seen-after-${turn}` })
      expect(after).not.toContain(e1.text)
      expect(after).not.toContain(bindingAdvice.text)
    }
  } finally { undo() }
})

/**
 * The changelog as it was up to entry `id`, until the returned undo: a case about an older entry reads the pack a bot
 * got then, before newer entries pushed that entry out of the pack's window (`BOT_CHANGELOG_PACK_ENTRIES`).
 */
function changelogUpTo(id: number): () => void {
  const changes = BOT_CHANGELOG as import('../../src/mms/bots/changelog').BotChangelogEntry[]
  const later = changes.filter((entry) => entry.id > id)
  changes.splice(changes.length - later.length, later.length)
  return () => void changes.push(...later)
}

it('tells existing bots that a pasted secret arrives by name', async () => {
  existingBot()
  memory.write(() => memory.setState('ada', 'changelog_seen', 25))
  const undo = changelogUpTo(37)
  try {
    const text = await packs().chatPreamble({ botId: 'ada', activationId: 'pasted-secret' })
    expect(text).toContain('Your owner can keep a pasted key as a secret')
    expect(text).toContain('secret_run')
  } finally { undo() }
})

it('rollback delivers later independent advice without marking hidden advice seen', async () => {
  existingBot()
  memory.write(() => memory.setState('ada', 'changelog_seen', 26))
  // E1's entry 28 is gated too. Model a later independent entry without publishing a new changelog id.
  const changes = BOT_CHANGELOG as import('../../src/mms/bots/changelog').BotChangelogEntry[]
  const later = { id: BOT_CHANGELOG_LATEST + 1, date: '2026-11-19', text: 'Later independent advice.' }
  const undo = changelogUpTo(37)
  changes.push(later)
  try {
    const off = createBotContextProvider({ store: memory, journal: { syncThread: async () => {} }, asksFirstEnabled: () => false })
    expect(await off.chatPreamble({ botId: 'ada', activationId: 'later-off' })).toContain(later.text)
    await settled(off, 'later-off')
    const restarted = createBotContextProvider({ store: memory, journal: { syncThread: async () => {} }, asksFirstEnabled: () => true })
    const text = await restarted.chatPreamble({ botId: 'ada', activationId: 'later-on' })
    expect(text).toContain(BOT_CHANGELOG.find(e => e.id === 27)!.text)
    expect(text).toContain(BOT_CHANGELOG.find(e => e.id === 28)!.text)
  } finally {
    changes.pop()
    undo()
  }
})

it('C6 support rollback stops before the next unseen hidden entry when there are two', async () => {
  existingBot()
  memory.write(() => memory.setState('ada', 'changelog_seen', 27))
  const changelog = [
    {id:27, date:'2026-11-19', asksFirst:true, text:'First hidden advice.'},
    {id:28, date:'2026-11-19', text:'Visible advice before the next hidden entry.'},
    {id:29, date:'2026-11-19', asksFirst:true, text:'Second hidden advice.'},
    {id:30, date:'2026-11-19', text:'Later visible advice.'}
  ] as const
  let on = false
  const options = {store:memory, journal:{syncThread:async()=>{}}, asksFirstEnabled:()=>on, changelog}
  const provider = createBotContextProvider(options)
  for (let turn = 0; turn < 2; turn++) {
    const activationId = `two-hidden-off-${turn}`
    const pack = await provider.chatPreamble({botId:'ada', activationId})
    expect(pack).toContain(changelog[3].text)
    expect(pack).not.toContain(changelog[2].text)
    await settled(provider, activationId)
    expect(memory.getState<number>('ada','changelog_seen')).toBe(28)
  }
  on = true
  const restarted = createBotContextProvider(options)
  expect(await restarted.chatPreamble({botId:'ada',activationId:'two-hidden-on'})).toContain(changelog[2].text)
  await settled(restarted,'two-hidden-on')
  expect(memory.getState<number>('ada','changelog_seen')).toBe(30)
  expect(await restarted.chatPreamble({botId:'ada',activationId:'two-hidden-after'})).not.toContain(HEADER)
})

it('E1 r2 existing bots learn the argument rule with entry 28', async () => {
  const undo = changelogUpTo(39)
  try {
    existingBot()
    memory.write(() => memory.setState('ada', 'changelog_seen', 27))
    const pack = await packs().chatPreamble({ botId: 'ada', activationId: 'act-argument-rule' })
    expect(pack).toContain('same top-level argument names')
    expect(pack).toContain('only plain text like a message body or a file name may change')
    expect(pack).toContain('New addresses and other destinations still ask')
  } finally { undo() }
})

it.each([28, 29])('entry 30 supersedes the binding-only advice after seen entry %s', async seen => {
  existingBot()
  memory.write(() => memory.setState('ada', 'changelog_seen', seen))
  const pack = await packs().chatPreamble({ botId: 'ada', activationId: 'service-reads-30' })
  const binding = BOT_CHANGELOG.find(entry => entry.id === 29)!
  const reads = BOT_CHANGELOG.find(entry => entry.id === 30)!
  expect(reads.text).toContain('secret_fetch is now available')
  expect(reads.text).toContain('replaces the earlier advice to keep working without a bound key')
  expect(pack).toContain(reads.text)
  if (seen === 28) {
    expect(pack).toContain(binding.text)
    expect(pack.indexOf(binding.text)).toBeLessThan(pack.indexOf(reads.text))
  } else {
    expect(pack).not.toContain(binding.text)
  }
})
