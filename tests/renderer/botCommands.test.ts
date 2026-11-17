/**
 * The owner's `/` commands in a bot's chat, read without the UI: what a message asks for, what the composer's list
 * offers while one is typed, which model a word names, and the lines `/status` and `/model` show.
 */
import { describe, expect, it } from 'vitest'
import { botCommandSuggestions, parseBotCommand, resolveModelWord, type BotCommandContext } from '../../src/renderer/components/bots/botCommands'
import { modelListText, statusText } from '../../src/renderer/components/bots/runBotCommand'
import { withNotes, type BotChatRow } from '../../src/renderer/components/bots/botChatShape'
import type { BotDetail, BotSummary } from '../../src/shared/bots/personal/chat'
import type { LlmProviderOption } from '../../src/shared/settings'

describe('parseBotCommand', () => {
  // [text, what it asks for]; null is an ordinary message, sent to the bot.
  const rows: Array<[string, ReturnType<typeof parseBotCommand>]> = [
    ['hello', null],
    ['/Users/me/notes.txt is broken', null],
    ['a /clear in the middle', null],
    ['/', null],
    ['/clear', { kind: 'clear' }],
    ['  /CLEAR  ', { kind: 'clear' }],
    ['/stop', { kind: 'stop' }],
    ['/status', { kind: 'status' }],
    ['/pause', { kind: 'pause' }],
    ['/resume', { kind: 'resume' }],
    ['/memory', { kind: 'memory' }],
    ['/reset', { kind: 'reset' }],
    ['/clear now', { kind: 'invalid', text: '/clear takes nothing after it.' }],
    ['/forget', { kind: 'forget', history: false }],
    ['/forget history', { kind: 'forget', history: true }],
    ['/forget   History', { kind: 'forget', history: true }],
    ['/forget everything', { kind: 'invalid', text: 'Use /forget or /forget history.' }],
    ['/xyz', { kind: 'unknown', name: 'xyz' }],
    ['/xyz do the thing', { kind: 'unknown', name: 'xyz' }],
    ['/model', { kind: 'model-list' }],
    ['/model work', { kind: 'invalid', text: 'Use /model <slot> <model> [description], or /model <slot> off.' }],
    ['/model talk claude:opus-5.5', { kind: 'model-set', slot: 'talk', model: 'claude:opus-5.5' }],
    ['/model Image openrouter:flux', { kind: 'model-set', slot: 'images', model: 'openrouter:flux' }],
    ['/model iosdev openai-codex:gpt-6.1-sol iOS apps, Swift, Xcode', { kind: 'model-set', slot: 'iosdev', model: 'openai-codex:gpt-6.1-sol', description: 'iOS apps, Swift, Xcode' }],
    ['/model IOSdev openai-codex:gpt-6.1-sol   iOS   apps', { kind: 'model-set', slot: 'iosdev', model: 'openai-codex:gpt-6.1-sol', description: 'iOS apps' }],
    ['/model iosdev openai-codex:gpt-6.1-sol', { kind: 'model-set', slot: 'iosdev', model: 'openai-codex:gpt-6.1-sol' }],
    ['/model talk claude:opus-5.5 for chat', { kind: 'invalid', text: 'Only a custom slot takes a description.' }],
    ['/model iosdev off', { kind: 'model-off', slot: 'iosdev' }],
    ['/model iosdev OFF', { kind: 'model-off', slot: 'iosdev' }],
    ['/model work off', { kind: 'invalid', text: "work is a base slot; it can't be removed." }],
    ['/model iosdev off now', { kind: 'invalid', text: 'Use /model <slot> <model> [description], or /model <slot> off.' }],
    ['/model 9lives claude:opus', { kind: 'invalid', text: 'A slot name is a letter, then letters, digits, - or _ (up to 24).' }],
    [`/model iosdev claude:opus ${'x'.repeat(201)}`, { kind: 'invalid', text: 'Keep the description under 200 characters.' }]
  ]
  it.each(rows)('%j', (text, expected) => {
    expect(parseBotCommand(text)).toEqual(expected)
  })
})

const providers: LlmProviderOption[] = [
  { id: 'claude-code', instanceId: 'claude', label: 'Claude Code', models: [{ id: 'opus-5.5', label: 'Opus 5.5' }, { id: 'sonnet-5.5', label: 'Sonnet 5.5' }] },
  { id: 'codex', instanceId: 'openai-codex', label: 'Codex', models: [{ id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol' }, { id: 'opus-5.5', label: 'Opus 5.5' }] }
]
const labels = (input: string, context: BotCommandContext = {}) => botCommandSuggestions(input, context).map((row) => row.label)

describe('botCommandSuggestions', () => {
  it('lists every command for a lone slash, each with its action, and narrows as the owner types', () => {
    const all = botCommandSuggestions('/')
    expect(all.map((row) => row.label)).toEqual(['/clear', '/stop', '/status', '/pause', '/resume', '/memory', '/forget', '/forget history', '/reset', '/model'])
    expect(all.every((row) => row.description.length > 0)).toBe(true)
    expect(labels('/st')).toEqual(['/stop', '/status'])
    expect(labels('/FOR')).toEqual(['/forget', '/forget history'])
    expect(labels('/forget ')).toEqual(['/forget history'])
    expect(labels('/forget h')).toEqual(['/forget history'])
    expect(labels('/zzz')).toEqual([])
  })

  it('offers nothing for an ordinary message, a slash later in the text, or a second line', () => {
    expect(labels('hello')).toEqual([])
    expect(labels('see /clear')).toEqual([])
    expect(labels('/clear\nmore')).toEqual([])
    expect(labels('/clear ')).toEqual([])
  })

  it('after /model offers the base slots and the custom ones, each with what it runs on, narrowed by what is typed', () => {
    const context: BotCommandContext = { custom: [{ name: 'iosdev', description: 'iOS apps' }], slotModels: { talk: 'Opus 5.5 · Claude Code', iosdev: 'GPT 6.1 Sol · Codex' } }
    const rows = botCommandSuggestions('/model ', context)
    expect(rows.map((row) => row.label)).toEqual(['talk', 'work', 'light', 'medium', 'hard', 'images', 'iosdev'])
    expect(rows.find((row) => row.label === 'talk')?.description).toBe('Opus 5.5 · Claude Code')
    expect(rows.find((row) => row.label === 'iosdev')?.description).toBe('GPT 6.1 Sol · Codex · iOS apps')
    expect(rows.find((row) => row.label === 'work')?.fill).toBe('/model work ')
    expect(labels('/model i', context)).toEqual(['images', 'iosdev'])
  })

  it('after a slot offers the models as entry:model, filtered by id or name; a custom slot leaves room for its description and offers off once it exists', () => {
    const context: BotCommandContext = { providers, custom: [{ name: 'iosdev' }] }
    expect(labels('/model talk ', context)).toEqual(['claude:opus-5.5', 'claude:sonnet-5.5', 'openai-codex:gpt-6.1-sol', 'openai-codex:opus-5.5'])
    expect(labels('/model talk sol', context)).toEqual(['openai-codex:gpt-6.1-sol'])
    expect(labels('/model talk sonnet 5', context)).toEqual([])
    const talk = botCommandSuggestions('/model talk opus', context)
    expect(talk.map((row) => [row.label, row.fill])).toEqual([['claude:opus-5.5', '/model talk claude:opus-5.5'], ['openai-codex:opus-5.5', '/model talk openai-codex:opus-5.5']])
    expect(talk[0]!.description).toBe('Opus 5.5 · Claude Code')
    expect(labels('/model iosdev ', context)[0]).toBe('off')
    expect(botCommandSuggestions('/model iosdev gpt', context).map((row) => row.fill)).toEqual(['/model iosdev openai-codex:gpt-6.1-sol '])
    // A slot that does not exist yet has nothing to remove.
    expect(labels('/model newslot ', context)).not.toContain('off')
    expect(labels('/model talk o', context)).not.toContain('off')
  })

  it('offers the Images slot its own models', () => {
    const imageProviders: LlmProviderOption[] = [{ id: 'openrouter', instanceId: 'openrouter', label: 'OpenRouter', models: [{ id: 'flux', label: 'FLUX' }] }]
    expect(labels('/model images ', { providers, imageProviders })).toEqual(['openrouter:flux'])
  })
})

describe('resolveModelWord', () => {
  const rows: Array<[string, unknown]> = [
    ['claude:opus-5.5', { pick: { instanceId: 'claude', model: 'opus-5.5' }, label: 'Opus 5.5 · Claude Code' }],
    ['OPENAI-CODEX:GPT-6.1-SOL', { pick: { instanceId: 'openai-codex', model: 'gpt-6.1-sol' }, label: 'GPT 6.1 Sol · Codex' }],
    ['gpt-6.1-sol', { pick: { instanceId: 'openai-codex', model: 'gpt-6.1-sol' }, label: 'GPT 6.1 Sol · Codex' }],
    ['opus-5.5', { error: 'opus-5.5 is on several entries; use entry:model.' }],
    ['claude:gpt-6.1-sol', { error: 'No model claude:gpt-6.1-sol. Type /model <slot> and pick one.' }]
  ]
  it.each(rows)('%s', (word, expected) => {
    expect(resolveModelWord(word, providers)).toEqual(expected)
  })
})

describe('the lines a command shows', () => {
  const now = Date.parse('2026-11-15T10:00:00.000Z')
  const bot = { id: 'b', name: 'Bot', state: 'idle', stateText: '' } as BotSummary

  it('/status names the work and how long it has run, background commands, threads and schedules', () => {
    const summary: BotSummary = {
      ...bot,
      work: [
        { id: 'w1', title: 'SSD search', status: 'running', startedAt: '2026-11-15T09:56:00.000Z' },
        { id: 'w2', title: 'Vacuum', status: 'queued', startedAt: '2026-11-15T09:59:00.000Z' }
      ],
      watchers: [{ id: 'x1', title: 'Log watch', command: 'tail -f', startedAt: '2026-11-15T09:00:00.000Z', until: '2026-11-15T11:00:00.000Z' }],
      threads: [{ threadId: 't1', title: 'Fix build', status: 'needs_input', startedAt: '2026-11-15T09:00:00.000Z', updatedAt: '2026-11-15T09:00:00.000Z' }]
    }
    const detail: BotDetail = { summary, permissions: [], runs: [{ id: 's1', label: 'every weekday · 09:00', kind: 'schedule' }, { id: 's2', label: 'daily · 18:00', kind: 'schedule', paused: true }], reminders: [{ id: 'r1', dueAt: '2026-11-16T09:00:00.000Z', text: 'Call' }] }
    expect(statusText(summary, detail, now).split('\n')).toEqual([
      'Work: SSD search (4 min), Vacuum (waiting)',
      'Background: Log watch',
      'Threads: Fix build (needs you)',
      'Schedules: every weekday · 09:00, daily · 18:00 (off)',
      'Reminders: 1 waiting'
    ])
  })

  it('/status of an idle bot with nothing set up says so in two lines', () => {
    expect(statusText(bot, { summary: bot, permissions: [], runs: [] }, now)).toBe('Work: none\nSchedules: none')
  })

  it('/model lists each slot with its model; Work once while its levels share one; custom slots with their descriptions', () => {
    const opus = { instanceId: 'claude', model: 'opus-5.5' }
    const sol = { instanceId: 'openai-codex', model: 'gpt-6.1-sol' }
    const base = { model: null, models: [], computer: 'this_computer', computers: [], providers }
    expect(modelListText({ ...base, slots: { talk: opus, light: sol, medium: sol, hard: sol }, image: null, custom: [{ name: 'iosdev', pick: sol, description: 'iOS apps' }] }).split('\n')).toEqual([
      'talk: Opus 5.5 · Claude Code',
      'work: GPT 6.1 Sol · Codex',
      'images: None',
      'iosdev: GPT 6.1 Sol · Codex (iOS apps)'
    ])
    expect(modelListText({ ...base, slots: { talk: opus, light: opus, medium: sol, hard: sol } }).split('\n')).toEqual([
      'talk: Opus 5.5 · Claude Code', 'light: Opus 5.5 · Claude Code', 'medium: GPT 6.1 Sol · Codex', 'hard: GPT 6.1 Sol · Codex'
    ])
  })
})

describe('withNotes', () => {
  const system = (id: string, at: string): BotChatRow => ({ kind: 'system', id, at, text: id })
  it('puts each note before the first row that came after it, the newest at the end', () => {
    const rows = [system('a', '2026-11-15T09:00:00.000Z'), system('b', '2026-11-15T09:10:00.000Z')]
    const merged = withNotes(rows, [
      { id: 'n1', at: '2026-11-15T09:05:00.000Z', text: 'Chat cleared.' },
      { id: 'n2', at: '2026-11-15T09:20:00.000Z', text: 'Nope', error: true }
    ])
    expect(merged.map((row) => (row.kind === 'system' ? [row.id, row.note ?? null] : null))).toEqual([['a', null], ['n1', 'info'], ['b', null], ['n2', 'error']])
  })
})
