/**
 * Bot Phase 1 §5.8 (bot-ui C3): activity chips. Mousse makes them from allowed calls: live chips
 * are attempts, settled chips roll up by kind with counts and a highlight, and app tools give
 * outcome chips once they return. The model never writes a chip, and no chip names a model.
 */
import { describe, expect, it } from 'vitest'
import { BOT_ACTIVITY_MIN_INTERVAL_MS, BOT_ACTIVITY_SAME_CALL_MS, createBotActivitySink, type BotActivityEvent } from '../../src/mms/bots/activity/BotActivitySink'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { chipForCall, rollUpChips, type BotChipCall } from '../../src/shared/bots/personal/chips'

const ctx = { home: '/home/me', filesFolder: '/home/me/.mousse/profiles/p1/bots/files/b1', scratch: '/home/me/.mousse/profiles/p1/bots/scratch/a1' }
const search = (query: string): BotChipCall => ({ tool: 'web_search', input: { query } })
const fetch = (url: string): BotChipCall => ({ tool: 'web_fetch', input: { url } })
// Claude Code's saved tool outputs: where its gate finds them (`NormalisedCall.own`), nested or with Windows casing.
const spill = '/home/me/.claude/projects/-home-me--mousse-profiles-p1-bots-scratch-a1/0f6c2d1e-sess/tool-results/mcp-mousse-browser_observe-123.txt'
const nestedSpill = '/home/me/.claude/projects/-home-me--mousse-profiles-p1-bots-scratch-a1/0f6c2d1e-sess/subagents/agent-1/tool-results/toolu_1.txt'
const windowsSpill = 'C:\\Users\\Me\\.Claude\\Projects\\C--Users-Me-scratch\\s1\\Tool-Results\\toolu_2.txt'
// An owner's folder of the same shape, granted to the bot: its work, not Claude Code's.
const ordinary = '/work/projects/acme/session/tool-results/report.txt'
const ownRead = (path: string): BotChipCall => ({ tool: 'read', input: { file_path: path }, own: true })

describe('chipForCall: live chips, worded as attempts', () => {
  it('follows the wording table', () => {
    expect(chipForCall('web_search', { query: 'invoice rules' }, ctx)).toEqual({ icon: 'search', text: 'searching the web', highlight: 'invoice rules', live: true })
    expect(chipForCall('web_fetch', { url: 'https://www.example.com/a?b' }, ctx)).toEqual({ icon: 'web', text: 'reading a page', highlight: 'example.com', live: true })
    expect(chipForCall('read', { path: '/home/me/Documents/Invoices/march.pdf' }, ctx)).toEqual({ icon: 'read', text: 'reading files', highlight: 'Invoices', live: true })
    expect(chipForCall('list', { path: '/home/me/Documents/Invoices' }, ctx)).toMatchObject({ text: 'reading files', highlight: 'Invoices' })
    expect(chipForCall('edit', { file_path: '/home/me/Notes/today.md' }, ctx)).toEqual({ icon: 'edit', text: 'changing files', highlight: 'Notes', live: true })
    expect(chipForCall('write', { path: `${ctx.filesFolder}/summary.md` }, ctx)).toEqual({ icon: 'edit', text: 'saving a file', highlight: 'summary.md', live: true })
    expect(chipForCall('write', { path: `${ctx.scratch}/tmp.txt` }, ctx)).toMatchObject({ text: 'working on a draft' })
    expect(chipForCall('bot_schedule_add', { when: { kind: 'interval', minutes: 30 }, prompt: 'x' }, ctx)).toMatchObject({ icon: 'schedule', text: 'setting a schedule' })
    expect(chipForCall('memory_search', { query: 'Maya' }, ctx)).toEqual({ icon: 'memory', text: 'looking back', highlight: 'Maya', live: true })
    expect(chipForCall('set_depth', { depth: 'deep', scope: 'now' }, ctx)).toMatchObject({ icon: 'think', text: 'taking more time' })
    expect(chipForCall('set_depth', { depth: 'quick', scope: 'now' }, ctx)).toMatchObject({ text: 'going quicker' })
  })

  it('shows none for escalate (its card is the chip); use_model shows the change without naming the model (#673)', () => {
    expect(chipForCall('escalate', { permission: { tool: 'read' }, reason: 'x' }, ctx)).toBeNull()
    expect(chipForCall('use_model', { model: 'claude-opus-5-5', scope: 'now' }, ctx)).toEqual({ icon: 'think', text: 'switching models', live: true })
    expect(chipForCall('something_else', {}, ctx)).toBeNull()
  })

  it('never shows the home folder\'s or the bot\'s own folder ids', () => {
    expect(chipForCall('list', { path: '/home/me' }, ctx)).toMatchObject({ highlight: '~' })
    expect(chipForCall('read', { path: `${ctx.filesFolder}/a.md` }, ctx)).toMatchObject({ highlight: 'saved files' })
    expect(chipForCall('read', { path: `${ctx.scratch}/a.md` }, ctx)).not.toHaveProperty('highlight')
  })
  it('a granted file in a projects/…/tool-results folder shows like any other: the path alone never hides a call', () => {
    expect(chipForCall('read', { file_path: ordinary }, ctx)).toEqual({ icon: 'read', text: 'reading files', highlight: 'tool-results', live: true })
    expect(chipForCall('write', { file_path: ordinary }, ctx)).toEqual({ icon: 'edit', text: 'changing files', highlight: 'tool-results', live: true })
    expect(chipForCall('list', { path: '/work/projects/acme/session/tool-results' }, ctx)).toMatchObject({ text: 'reading files', highlight: 'tool-results' })
    expect(chipForCall('read', { path: `${ctx.filesFolder}/tool-results/a.txt` }, ctx)).toMatchObject({ text: 'reading files', highlight: 'saved files' })
    expect(chipForCall('write', { path: `${ctx.filesFolder}/tool-results/a.txt` }, ctx)).toMatchObject({ text: 'saving a file', highlight: 'a.txt' })
    expect(chipForCall('read', { path: '/home/me/Documents/tool-results/a.txt' }, ctx)).toMatchObject({ text: 'reading files', highlight: 'tool-results' })
  })
})

describe('rollUpChips: settled chips', () => {
  it('3 searches and 2 page reads are "searched the web · 3" and "read 2 pages · example.com"', () => {
    const chips = rollUpChips([search('a'), fetch('https://example.com/1'), search('b'), fetch('https://example.com/2'), search('c')], ctx)
    expect(chips).toEqual([
      { icon: 'search', text: 'searched the web', highlight: '3' },
      { icon: 'web', text: 'read 2 pages', highlight: 'example.com' }
    ])
  })

  it('one call keeps its own highlight; several folders or domains are listed short', () => {
    expect(rollUpChips([search('invoice rules')], ctx)).toEqual([{ icon: 'search', text: 'searched the web', highlight: 'invoice rules' }])
    expect(rollUpChips([fetch('https://a.com'), fetch('https://b.com'), fetch('https://c.com')], ctx)).toEqual([{ icon: 'web', text: 'read 3 pages', highlight: 'a.com +2' }])
    expect(rollUpChips([
      { tool: 'read', input: { path: '/home/me/Documents/Invoices/a.pdf' } },
      { tool: 'search', input: { path: '/home/me/Notes' } }
    ], ctx)).toEqual([{ icon: 'read', text: 'read files', highlight: 'Invoices, Notes' }])
    expect(rollUpChips([{ tool: 'write', input: { path: `${ctx.filesFolder}/a.md` } }, { tool: 'write', input: { path: `${ctx.filesFolder}/b.md` } }], ctx))
      .toEqual([{ icon: 'edit', text: 'saved 2 files', highlight: 'a.md, b.md' }])
  })

  it('a tool output Claude Code read back (its gate\'s `own`) settles to no chip, beside the files the bot really read', () => {
    expect(rollUpChips([ownRead(spill), ownRead(nestedSpill), ownRead(windowsSpill)], ctx)).toEqual([])
    expect(rollUpChips([
      ownRead(spill),
      { tool: 'read', input: { file_path: ordinary } },
      ownRead(windowsSpill),
      { tool: 'read', input: { path: '/home/me/Documents/Invoices/a.pdf' } },
      ownRead(nestedSpill)
    ], ctx)).toEqual([{ icon: 'read', text: 'read files', highlight: 'tool-results, Invoices' }])
  })

  it('counts saved files, not saves: a file written then edited is one; two files are two, even with one name', () => {
    const save = (tool: string, path: string, key = 'path'): BotChipCall => ({ tool, input: { [key]: `${ctx.filesFolder}/${path}` } })
    expect(rollUpChips([save('write', 'draft.md'), save('edit', 'draft.md', 'file_path'), save('edit', 'draft.md', 'file_path')], ctx))
      .toEqual([{ icon: 'edit', text: 'saved a file', highlight: 'draft.md' }])
    expect(rollUpChips([save('write', 'trips/notes.md'), save('write', 'work/notes.md')], ctx)).toEqual([{ icon: 'edit', text: 'saved 2 files', highlight: 'notes.md' }])
    expect(rollUpChips([save('write', 'a.md'), save('edit', 'b.md'), save('edit', 'a.md')], ctx)).toEqual([{ icon: 'edit', text: 'saved 2 files', highlight: 'a.md, b.md' }])
  })

  it('work\'s subagents settle to one chip with their titles; waiting on them and reading them show none', () => {
    const start = (title: string): BotChipCall => ({ tool: 'subagent_start', input: { title, brief: 'x' }, result: { subagent: title } })
    expect(chipForCall('subagent_start', { title: 'Prices', brief: 'x' }, ctx)).toMatchObject({ text: 'starting a subagent', highlight: 'Prices' })
    expect(rollUpChips([start('Prices'), start('Reviews'), { tool: 'subagent_wait', input: {} }, { tool: 'subagent_result', input: { subagent: 'Prices' } }, { tool: 'subagent_send', input: { subagent: 'Prices', message: 'more' } }], ctx))
      .toEqual([{ icon: 'think', text: 'used 2 subagents', highlight: 'Prices, Reviews' }])
    expect(rollUpChips([start('Prices')], ctx)).toEqual([{ icon: 'think', text: 'used a subagent', highlight: 'Prices' }])
  })

  it('a new schedule is an outcome chip with its label, once it returned', () => {
    const add: BotChipCall = { tool: 'bot_schedule_add', input: { when: { kind: 'cron', expr: '0 9 * * 1-5' }, prompt: 'inbox' }, result: { scheduleId: 's1', label: 'every weekday · 09:00' } }
    expect(rollUpChips([add], ctx)).toEqual([{ icon: 'schedule', text: 'every weekday · 09:00' }])
    // Failed or not returned: no chip claims it.
    expect(rollUpChips([{ ...add, result: { error: 'too many' } }, { ...add, result: undefined }], ctx)).toEqual([])
    expect(rollUpChips([{ tool: 'bot_schedule_list', input: {} }], ctx)).toEqual([])
  })

  it('memory saves are "remembered · …" and forgets "forgot something you asked me to", one chip each, never with the forgotten text', () => {
    const chips = rollUpChips([
      { tool: 'memory_save', input: { text: 'Maya Chen is the accountant; her mail always matters.', kind: 'owner' }, result: { id: 'm3', version: 1, gauge: 'core 200/2,000' } },
      { tool: 'memory_save', input: { text: 'Too much', kind: 'note' }, result: { error: 'over_cap', core: [] } },
      { tool: 'memory_forget', input: { id: 'm2', reason: 'asked' }, result: { forgotten: 'm2', text: 'Ana prefers calls', redacted: [] } },
      { tool: 'memory_search', input: { query: 'Maya' } },
      { tool: 'memory_list', input: {} }
    ], ctx)
    expect(chips).toEqual([
      { icon: 'memory', text: 'remembered', highlight: 'Maya Chen is the accountant; her mail…' },
      { icon: 'memory', text: 'forgot something you asked me to' },
      { icon: 'memory', text: 'looked back', highlight: '2' }
    ])
  })

  it('depth and renames show the last one; escalate shows nothing; use_model says it switched, never to what', () => {
    const chips = rollUpChips([
      { tool: 'set_depth', input: { depth: 'quick', scope: 'now' }, result: { ok: true } },
      { tool: 'set_depth', input: { depth: 'deep', scope: 'now' }, result: { ok: true } },
      { tool: 'set_profile', input: { name: 'Inbox helper' }, result: { ok: true } },
      { tool: 'set_profile', input: { name: 'Inbox buddy' }, result: { ok: true } },
      { tool: 'escalate', input: {} },
      { tool: 'use_model', input: { model: 'claude-opus-5-5' }, result: { ok: true, scope: 'now' } },
      { tool: 'use_model', input: { model: 'claude-opus-5-5', scope: 'always', for: 'work' }, result: { ok: true, scope: 'always', for: 'work' } },
      { tool: 'use_model', input: { model: 'grok' }, result: { ok: false, reason: 'not here' } }
    ], ctx)
    expect(chips).toEqual([
      { icon: 'think', text: 'taking more time' },
      { icon: 'name', text: 'renamed itself', highlight: 'Inbox buddy' },
      { icon: 'think', text: 'switched models', highlight: 'for this chat' },
      { icon: 'think', text: 'switched models', highlight: 'for work' }
    ])
    expect(JSON.stringify(chips)).not.toContain('opus')
  })
})

describe('BotActivitySink', () => {
  const at = { botId: 'b1', activationId: 'a1', dispatchId: 'd1' }

  function sink() {
    let now = 1_000
    const timers: Array<{ fn: () => void; due: number }> = []
    const events: BotActivityEvent[] = []
    const activity = createBotActivitySink({
      emit: (event) => events.push(event),
      chipContext: () => ctx,
      now: () => now,
      setTimer: (fn, ms) => {
        const timer = { fn, due: now + ms }
        timers.push(timer)
        return timer
      },
      clearTimer: (handle) => {
        timers.splice(timers.indexOf(handle as (typeof timers)[number]), 1)
      }
    })
    const advance = (ms: number) => {
      now += ms
      for (const timer of timers.filter((entry) => entry.due <= now)) {
        timers.splice(timers.indexOf(timer), 1)
        timer.fn()
      }
    }
    return { activity, events, advance }
  }

  it('emits live chips at most four a second, the latest winning, and clears them when the dispatch drains', () => {
    const { activity, events, advance } = sink()
    activity.onAllowed(at, { tool: 'web_search', input: { query: 'a' } })
    activity.onAllowed(at, { tool: 'web_fetch', input: { url: 'https://example.com' } })
    activity.onAllowed(at, { tool: 'web_fetch', input: { url: 'https://example.com/2' } })
    expect(events).toEqual([{ botId: 'b1', activationId: 'a1', chip: { icon: 'search', text: 'searching the web', highlight: 'a', live: true } }])
    advance(BOT_ACTIVITY_MIN_INTERVAL_MS)
    expect(events).toHaveLength(2)
    expect(events[1].chip).toMatchObject({ text: 'reading a page', highlight: 'example.com' })
    expect(activity.liveChip('a1')).toMatchObject({ text: 'reading a page' })
    expect(activity.drain('d1')).toEqual([
      { icon: 'search', text: 'searched the web', highlight: 'a' },
      { icon: 'web', text: 'read 2 pages', highlight: 'example.com' }
    ])
    expect(events.at(-1)).toEqual({ botId: 'b1', activationId: 'a1', chip: null })
    expect(activity.liveChip('a1')).toBeUndefined()
    // Drained: the list is gone.
    expect(activity.drain('d1')).toEqual([])
  })

  it('a call with no words of its own shows "working" in place of the step before it, never its tool\'s name, and settles to no chip', () => {
    const { activity, events, advance } = sink()
    activity.onAllowed(at, { tool: 'web_search', input: { query: 'a' } })
    advance(BOT_ACTIVITY_MIN_INTERVAL_MS)
    activity.onAllowed(at, { tool: 'some_new_tool', input: { secret: 'x' } })
    expect(events.map((event) => event.chip)).toEqual([
      { icon: 'search', text: 'searching the web', highlight: 'a', live: true },
      { icon: 'think', text: 'working', live: true }
    ])
    expect(activity.drain('d1')).toEqual([{ icon: 'search', text: 'searched the web', highlight: 'a' }])
  })

  it('reading back a tool output Claude Code saved shows "working", never "tool-results", and settles to no chip', () => {
    const { activity, events, advance } = sink()
    activity.onAllowed(at, { tool: 'web_search', input: { query: 'a' } })
    advance(BOT_ACTIVITY_MIN_INTERVAL_MS)
    activity.onAllowed(at, ownRead(spill))
    advance(BOT_ACTIVITY_MIN_INTERVAL_MS)
    expect(events.at(-1)?.chip).toEqual({ icon: 'think', text: 'working', live: true })
    expect(JSON.stringify(events)).not.toContain('tool-results')
    expect(activity.drain('d1')).toEqual([{ icon: 'search', text: 'searched the web', highlight: 'a' }])
  })

  it('takes app-tool results for the activation\'s current dispatch, for outcome chips', () => {
    const { activity } = sink()
    activity.onAllowed(at, { tool: 'memory_save', input: { text: 'Invoices go to ~/Documents/Invoices', kind: 'note' } })
    activity.onAppResult({ botId: 'b1', activationId: 'a1', dispatchId: '' }, 'memory_save', { id: 'm1', version: 1, gauge: 'core 40/2,000' })
    activity.onAllowed(at, { tool: 'bot_schedule_add', input: { when: { kind: 'cron', expr: '0 9 * * 1-5' }, prompt: 'x' } })
    activity.onAppResult({ botId: 'b1', activationId: 'a1', dispatchId: '' }, 'bot_schedule_add', { scheduleId: 's1', label: 'every weekday · 09:00' })
    expect(activity.drain('d1')).toEqual([
      { icon: 'memory', text: 'remembered', highlight: 'Invoices go to ~/Documents/Invoices' },
      { icon: 'schedule', text: 'every weekday · 09:00' }
    ])
  })

  it('a thread the bot started or messaged shows at once, with the thread and what it sent, before the turn ends', () => {
    const { activity, events, advance } = sink()
    activity.onAllowed(at, { tool: 'thread_create', input: { title: 'Fix the login page' } })
    advance(BOT_ACTIVITY_MIN_INTERVAL_MS)
    activity.onAppResult({ botId: 'b1', activationId: 'a1', dispatchId: '' }, 'thread_create', { threadId: 't-new', title: 'Fix the login page', sent: 'Look at the login page.' })
    advance(BOT_ACTIVITY_MIN_INTERVAL_MS)
    const done = { icon: 'think', text: 'started thread', highlight: 'Fix the login page', thread: 't-new', said: 'Look at the login page.' }
    expect(events.at(-1)).toEqual({ botId: 'b1', activationId: 'a1', chip: done })
    // And the posted message carries it.
    expect(activity.drain('d1')).toEqual([done])
  })

  it('counts a call once when several check points allow it, and a repeat later as a new call', () => {
    const { activity, advance } = sink()
    // Locked Claude checks one call at PreToolUse, canUseTool and the registry; Pi at its gate and the registry.
    for (let check = 0; check < 3; check += 1) activity.onAllowed(at, { tool: 'web_search', input: { query: 'rules' } })
    activity.onAllowed(at, { tool: 'web_search', input: { query: 'other' } })
    activity.onAllowed(at, { tool: 'web_search', input: { query: 'other' } })
    advance(BOT_ACTIVITY_SAME_CALL_MS)
    // The same search again, later: the bot made it twice.
    activity.onAllowed(at, { tool: 'web_search', input: { query: 'rules' } })
    expect(activity.drain('d1')).toEqual([{ icon: 'search', text: 'searched the web', highlight: '3' }])
  })

  it('observes an authority: allowed calls become live chips on any runtime', () => {
    const { activity, events } = sink()
    const authority = createBotAuthority({
      activationId: 'a1',
      role: 'activation',
      permissions: { tools: ['web_search'], appTools: ['web_fetch'], mcp: [], skills: [], workspace: null },
      waiting: () => false,
      counters: { charge: () => ({ ok: true, count: 1 }) },
      time: { deadline: () => 0, signal: new AbortController().signal },
      spend: null,
      onAllowed: activity.observer(at)
    })
    authority.check({ kind: 'builtin', tool: 'web_search', nativeName: 'WebSearch', args: { query: 'rules' } })
    authority.check({ kind: 'app', tool: 'delegate_task', args: {} })
    expect(events.map((event) => event.chip?.text)).toEqual(['searching the web'])
    expect(activity.drain('d1')).toEqual([{ icon: 'search', text: 'searched the web', highlight: 'rules' }])
  })

  it('carries the gate\'s `own` from the authority to the chips: Claude Code\'s saved output, read with no file access, settles to none', () => {
    const { activity } = sink()
    const authority = createBotAuthority({
      activationId: 'a1',
      role: 'activation',
      permissions: { tools: ['read'], appTools: [], mcp: [], skills: [], workspace: null },
      waiting: () => false,
      counters: { charge: () => ({ ok: true, count: 1 }) },
      time: { deadline: () => 0, signal: new AbortController().signal },
      spend: null,
      onAllowed: activity.observer(at)
    })
    for (const path of [spill, nestedSpill, windowsSpill])
      expect(authority.check({ kind: 'builtin', tool: 'read', nativeName: 'Read', args: { file_path: path }, own: true })).toEqual({ ok: true })
    expect(activity.drain('d1')).toEqual([])
  })
})
