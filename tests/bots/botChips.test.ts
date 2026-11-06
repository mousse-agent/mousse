/**
 * Bot Phase 1 §5.8 (bot-ui C3): activity chips. Mousse makes them from allowed calls: live chips
 * are attempts, settled chips roll up by kind with counts and a highlight, and app tools give
 * outcome chips once they return. The model never writes a chip, and no chip names a model.
 */
import { describe, expect, it } from 'vitest'
import { BOT_ACTIVITY_MIN_INTERVAL_MS, createBotActivitySink, type BotActivityEvent } from '../../src/mms/bots/activity/BotActivitySink'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { chipForCall, rollUpChips, type BotChipCall } from '../../src/shared/bots/personal/chips'

const ctx = { home: '/home/me', filesFolder: '/home/me/.mousse/profiles/p1/bots/files/b1', scratch: '/home/me/.mousse/profiles/p1/bots/scratch/a1' }
const search = (query: string): BotChipCall => ({ tool: 'web_search', input: { query } })
const fetch = (url: string): BotChipCall => ({ tool: 'web_fetch', input: { url } })

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

  it('shows none for escalate (its card is the chip) or use_model (the model is never shown)', () => {
    expect(chipForCall('escalate', { permission: { tool: 'read' }, reason: 'x' }, ctx)).toBeNull()
    expect(chipForCall('use_model', { model: 'claude-opus-5-5', scope: 'now' }, ctx)).toBeNull()
    expect(chipForCall('something_else', {}, ctx)).toBeNull()
  })

  it('never shows the home folder\'s or the bot\'s own folder ids', () => {
    expect(chipForCall('list', { path: '/home/me' }, ctx)).toMatchObject({ highlight: '~' })
    expect(chipForCall('read', { path: `${ctx.filesFolder}/a.md` }, ctx)).toMatchObject({ highlight: 'saved files' })
    expect(chipForCall('read', { path: `${ctx.scratch}/a.md` }, ctx)).not.toHaveProperty('highlight')
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

  it('a new schedule is an outcome chip with its label, once it returned', () => {
    const add: BotChipCall = { tool: 'bot_schedule_add', input: { when: { kind: 'cron', expr: '0 9 * * 1-5' }, prompt: 'inbox' }, result: { scheduleId: 's1', label: 'every weekday · 09:00' } }
    expect(rollUpChips([add], ctx)).toEqual([{ icon: 'schedule', text: 'every weekday · 09:00' }])
    // Failed or not returned: no chip claims it.
    expect(rollUpChips([{ ...add, result: { error: 'too many' } }, { ...add, result: undefined }], ctx)).toEqual([])
    expect(rollUpChips([{ tool: 'bot_schedule_list', input: {} }], ctx)).toEqual([])
  })

  it('memory saves and forgets are "remembered · …" and "forgot · …", one chip each', () => {
    const chips = rollUpChips([
      { tool: 'memory_save', input: { text: 'Maya Chen is the accountant; her mail always matters.', kind: 'owner' }, result: { id: 'm3', version: 1, gauge: 'core 200/2,000' } },
      { tool: 'memory_save', input: { text: 'Too much', kind: 'note' }, result: { error: 'over_cap', core: [] } },
      { tool: 'memory_forget', input: { id: 'm2', reason: 'asked' }, result: { forgotten: 'm2', text: 'Ana prefers calls', redacted: [] } },
      { tool: 'memory_search', input: { query: 'Maya' } },
      { tool: 'memory_list', input: {} }
    ], ctx)
    expect(chips).toEqual([
      { icon: 'memory', text: 'remembered', highlight: 'Maya Chen is the accountant; her mail…' },
      { icon: 'memory', text: 'forgot', highlight: 'Ana prefers calls' },
      { icon: 'memory', text: 'looked back', highlight: '2' }
    ])
  })

  it('depth and renames show the last one; escalate and use_model show nothing', () => {
    expect(rollUpChips([
      { tool: 'set_depth', input: { depth: 'quick', scope: 'now' }, result: { ok: true } },
      { tool: 'set_depth', input: { depth: 'deep', scope: 'now' }, result: { ok: true } },
      { tool: 'set_profile', input: { name: 'Inbox helper' }, result: { ok: true } },
      { tool: 'set_profile', input: { name: 'Inbox buddy' }, result: { ok: true } },
      { tool: 'escalate', input: {} },
      { tool: 'use_model', input: { model: 'claude-opus-5-5' }, result: { ok: true } }
    ], ctx)).toEqual([
      { icon: 'think', text: 'taking more time' },
      { icon: 'name', text: 'renamed itself', highlight: 'Inbox buddy' }
    ])
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
})
