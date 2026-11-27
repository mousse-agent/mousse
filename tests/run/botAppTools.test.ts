/**
 * Bot Phase 1 §5.5, §5.6, §5.10: the bot's own app tools. They act on the bot the engine says the
 * thread belongs to, never on arguments; schedules are checked and labelled; depth and model
 * changes go through `BotToolHost.setModel`; only the owner's chat changes the bot for good.
 */
import { describe, expect, it } from 'vitest'
import { createBotActivitySink } from '../../src/mms/bots/activity/BotActivitySink'
import type { BotModelChange, BotToolHost } from '../../src/mms/bots/seams'
import type { BotProfileFacts } from '../../src/mms/bots/profile'
import { createAppToolRegistry } from '../../src/mms/run/mcp/appTools'
import { botTools, USE_MODEL_REFUSED, workNoteAnswer, type BotAppToolDeps } from '../../src/mms/run/mcp/appTools/bots'
import { SILENT_REPLY } from '../../src/shared/bots/personal/wakes'
import type { MousseTool, ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import type { BotLane, BotModelSlots, BotSchedule } from '../../src/shared/bots/personal/definition'
import { MAX_BOT_SCHEDULES } from '../../src/shared/bots/personal/definition'
import type { BotModelOption } from '../../src/shared/bots/personal/methods'
import { BOT_ITEM_TOOLS } from '../../src/shared/bots/personal/items'
import { BOT_MEMORY_TOOLS } from '../../src/shared/bots/personal/memory'
import { botScheduleLabel } from '../../src/shared/scheduleLabel'
import { fakeAppToolHost } from './appToolsFixture'

/** The Runs on choices: Opus on a Claude subscription, and on a paid API key; Haiku and GPT models beside them. */
const CHOICES: BotModelOption[] = [
  { instanceId: 'claude', entry: 'Claude Code', model: 'claude-opus-4-6', label: 'Claude Opus 4.6', efforts: [], credential: 'subscription', account: 'acct-1', names: ['claude-opus-4-6', 'claude opus 4.6', 'opus 4.6', 'opus'] },
  { instanceId: 'claude', entry: 'Claude Code', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', efforts: [], credential: 'subscription', account: 'acct-1', names: ['claude-haiku-4-5', 'claude haiku 4.5', 'haiku 4.5', 'haiku'] },
  { instanceId: 'pi:key', entry: 'Anthropic API', model: 'claude-opus-4-6', label: 'Claude Opus 4.6', efforts: [], credential: 'api_key', names: ['claude-opus-4-6', 'claude opus 4.6', 'opus 4.6', 'opus'] },
  { instanceId: 'pi:openai', entry: 'OpenAI', model: 'gpt-5', label: 'GPT-5', efforts: [], credential: 'api_key', names: ['gpt-5', 'gpt'] },
  { instanceId: 'pi:openai', entry: 'OpenAI', model: 'gpt-5-mini', label: 'GPT-5 mini', efforts: [], credential: 'api_key', names: ['gpt-5-mini', 'gpt', 'mini'] },
  { instanceId: 'pi:openai', entry: 'OpenAI', model: 'default', label: 'Default', efforts: [], credential: 'api_key', names: ['default'] }
]
const ON_SUB = { instanceId: 'claude', model: 'claude-opus-4-6', credential: 'subscription' }
const ON_KEY = { instanceId: 'pi:key', model: 'claude-opus-4-6', credential: 'api_key' }
const ROWS_ON_SUB: BotModelSlots = { talk: ON_SUB, light: ON_SUB, medium: ON_SUB, hard: ON_SUB } as BotModelSlots

function fakeBots(lane: BotLane = 'chat', options: { owner?: string; changes?: boolean; rows?: BotModelSlots; choices?: BotModelOption[]; work?: Partial<BotToolHost['work']>; cards?: boolean; profile?: BotProfileFacts } = {}) {
  const schedules: Array<{ scheduleId: string; when: BotSchedule['when']; prompt: string; label: string; from?: string }> = []
  const wakes: Array<{ from: string; input: Parameters<NonNullable<BotToolHost['wakes']>['add']>[2] }> = []
  const watched: Array<{ from: string; input: Parameters<NonNullable<BotToolHost['watchers']>['start']>[2] }> = []
  const profiles: Array<{ name?: string; description?: string; look?: Record<string, string> }> = []
  const models: Array<{ scope: 'now' | 'always'; choice: BotModelChange }> = []
  const works: Array<{ title: string; brief: string; key: string; level?: string }> = []
  const host = {
    // The owner's message the chat turn holds.
    ownerWords: () => options.owner ?? 'Please use Opus 4.6 from now on',
    rows: () => options.rows ?? ROWS_ON_SUB,
    activationOf: (threadId) => (threadId === 'home' ? { botId: 'b1', activationId: 'a1', lane, memoryLane: lane } : undefined),
    schedules: {
      add: (_botId, s, from) => {
        const entry = { scheduleId: `s${schedules.length + 1}`, ...s, label: botScheduleLabel(s.when), ...(options.cards && from ? { from } : {}) }
        schedules.push(entry)
        return { scheduleId: entry.scheduleId, label: entry.label, ...(options.cards && from ? { card: true as const } : {}) }
      },
      remove: (_botId, scheduleId) => {
        const at = schedules.findIndex((entry) => entry.scheduleId === scheduleId)
        if (at < 0) return false
        schedules.splice(at, 1)
        return true
      },
      list: () => schedules.map((entry) => ({ scheduleId: entry.scheduleId, label: entry.label, nextAt: '2026-11-09T09:00:00.000Z' }))
    },
    setProfile: (_botId, p) => {
      profiles.push(p)
    },
    ...(options.profile ? { profile: () => options.profile! } : {}),
    setModel: (_botId, _activationId, scope, choice) => {
      models.push({ scope, choice })
      return { changed: options.changes ?? true }
    },
    watchers: {
      start: (_botId, from, input) => {
        if (input.match === '(a+)+') throw new Error('match may not repeat a group that repeats itself, such as (a+)+.')
        watched.push({ from, input })
        return { watcherId: `rem_w${watched.length}`, until: '2026-11-08T10:00:00.000Z' }
      },
      list: () => watched.map((entry, index) => ({ id: `rem_w${index + 1}`, title: entry.input.title ?? 'x', command: entry.input.command, startedAt: '2026-11-08T09:00:00.000Z', until: '2026-11-08T10:00:00.000Z' })),
      stop: (_botId, watcherId) => watcherId === 'rem_w1',
      // An ended command's whole output: 300 lines, of which 1,000 fell out before them.
      output: (_botId, watcherId) => watcherId === 'rem_w1'
        ? { id: 'rem_w1', title: 'Nightly', command: 'gh run watch 123', startedAt: '2026-11-08T09:00:00.000Z', end: { kind: 'exit' as const, code: 1 }, endedAt: '2026-11-08T09:30:00.000Z', output: Array.from({ length: 300 }, (_, i) => `\u001b[32mjob ${1001 + i}\u001b[0m`).join('\n'), droppedLines: 1_000 }
        : undefined
    },
    wakes: {
      wait: async (_botId, from, input) => {
        wakes.push({ from, input })
        return { wakeId: 'wait1', dueAt: input.dueAt ?? '2026-11-08T09:00:00.000Z', label: '' }
      },
      add: async (_botId, from, input) => {
        wakes.push({ from, input })
        return { wakeId: `w${wakes.length}`, dueAt: input.dueAt ?? '2026-11-08T09:00:00.000Z', label: input.event?.kind === 'pr' ? `when ${input.event.repo}#${input.event.number} merges` : input.event ? 'when "Fix login" finishes' : '' }
      }
    },
    work: {
      start: async (_botId, _from, input) => {
        works.push(input)
        return { workId: 'w1', status: 'started' as const, ahead: [] }
      },
      list: () => ({ now: [], recent: [] }),
      stop: async () => 'stopped' as const,
      note: () => 'noted' as const,
      ...options.work
    }
  } as BotToolHost
  const activity = createBotActivitySink({ emit: () => {} })
  const deps: BotAppToolDeps = { host, activity, models: { pickable: async () => options.choices ?? CHOICES } }
  const tools = new Map(botTools(() => deps).map((tool) => [tool.name, tool]))
  const ctx = (threadId = 'home', activationId = 'a1', appTools: readonly string[] = []): ToolCallContext => ({
    caller: { threadId, runId: 'r1', provider: 'pi', accessLevel: 'lineage' },
    turn: { threadId, bot: { role: 'activation', activationId, appTools: new Set(appTools) } as unknown as BotAuthority } as ToolCallContext['turn'],
    toolCallId: 'call-1',
    signal: new AbortController().signal,
    transport: 'mcp'
  })
  const call = async (name: string, args: Record<string, unknown>, context = ctx()) => {
    const outcome = await (tools.get(name) as MousseTool).handler(args, context)
    return { ...outcome, value: outcome.isError || !/^[[{]/.test(outcome.text) ? undefined : JSON.parse(outcome.text) }
  }
  return { schedules, profiles, models, works, wakes, watched, activity, call, ctx }
}

describe('schedule tools', () => {
  it('bot_schedule_add with a weekday 09:00 cron returns "every weekday · 09:00", writes through the host and gives an outcome chip', async () => {
    const bots = fakeBots()
    bots.activity.onAllowed({ botId: 'b1', activationId: 'a1', dispatchId: 'd1' }, { tool: 'bot_schedule_add', input: { when: { kind: 'cron', expr: '0 9 * * 1-5' }, prompt: 'Go through my inbox' } })
    const added = await bots.call('bot_schedule_add', { when: { kind: 'cron', expr: '0 9 * * 1-5' }, prompt: 'Go through my inbox' })
    expect(added.value).toEqual({ scheduleId: 's1', label: 'every weekday · 09:00' })
    expect(bots.schedules).toEqual([{ scheduleId: 's1', when: { kind: 'cron', expr: '0 9 * * 1-5' }, prompt: 'Go through my inbox', label: 'every weekday · 09:00' }])
    expect(bots.activity.drain('d1')).toEqual([{ icon: 'schedule', text: 'every weekday · 09:00' }])
  })

  it('passes a fixed line and its end through the schedule tool', async () => {
    const bots = fakeBots()
    const result = await bots.call('bot_schedule_add', { when: { kind: 'interval', minutes: 60 }, say: 'Take your pills', until: '2030-11-21' })
    expect(result.isError).toBeFalsy()
    expect(bots.schedules[0]).toMatchObject({ say: 'Take your pills', until: '2030-11-21' })
  })

  it('bot_schedule_add from a chat turn hands the turn to the host, which shows the automation as a card; no chip repeats it', async () => {
    const bots = fakeBots('chat', { cards: true })
    bots.activity.onAllowed({ botId: 'b1', activationId: 'a1', dispatchId: 'd1' }, { tool: 'bot_schedule_add', input: { when: { kind: 'interval', minutes: 30 }, prompt: 'Check the build' } })
    expect((await bots.call('bot_schedule_add', { when: { kind: 'interval', minutes: 30 }, prompt: 'Check the build' })).value).toEqual({ scheduleId: 's1', label: 'every 30 minutes' })
    expect(bots.schedules[0]).toMatchObject({ from: 'a1' })
    expect(bots.activity.drain('d1')).toEqual([])
  })

  it('refuses a schedule past the ceiling, an interval under a minute, and a bad time', async () => {
    const bots = fakeBots()
    for (let n = 0; n < MAX_BOT_SCHEDULES; n += 1) expect((await bots.call('bot_schedule_add', { when: { kind: 'interval', minutes: 30 + n }, prompt: `task ${n}` })).isError).toBeFalsy()
    const past = await bots.call('bot_schedule_add', { when: { kind: 'interval', minutes: 60 }, prompt: 'one more' })
    expect(past).toMatchObject({ isError: true, text: expect.stringContaining(`${MAX_BOT_SCHEDULES} schedules`) })
    expect(bots.schedules).toHaveLength(MAX_BOT_SCHEDULES)
    const fresh = fakeBots()
    expect(await fresh.call('bot_schedule_add', { when: { kind: 'interval', minutes: 0 }, prompt: 'x' })).toMatchObject({ isError: true, text: expect.stringContaining('at least 1') })
    expect(await fresh.call('bot_schedule_add', { when: { kind: 'cron', expr: '0 9 * *' }, prompt: 'x' })).toMatchObject({ isError: true })
    expect(await fresh.call('bot_schedule_add', { when: { kind: 'interval', minutes: 30 }, prompt: '  ' })).toMatchObject({ isError: true })
    expect(fresh.schedules).toEqual([])
  })

  it('lists and removes the bot\'s schedules', async () => {
    const bots = fakeBots()
    await bots.call('bot_schedule_add', { when: { kind: 'interval', minutes: 30 }, prompt: 'x' })
    expect((await bots.call('bot_schedule_list', {})).value).toMatchObject({ schedules: [{ scheduleId: 's1', label: 'every 30 minutes', nextAt: '2026-11-09T09:00:00.000Z' }] })
    expect((await bots.call('bot_schedule_remove', { scheduleId: 's1' })).value).toEqual({ removed: true })
    expect(await bots.call('bot_schedule_remove', { scheduleId: 's1' })).toMatchObject({ isError: true })
  })

  it('an unattended run can look at its schedules but not change them', async () => {
    const bots = fakeBots('run')
    expect(await bots.call('bot_schedule_add', { when: { kind: 'interval', minutes: 30 }, prompt: 'x' })).toMatchObject({ isError: true, text: expect.stringContaining('owner') })
    expect((await bots.call('bot_schedule_list', {})).value).toEqual({ schedules: [] })
  })

  it('acts only for the bot the engine names: another thread or activation is refused', async () => {
    const bots = fakeBots()
    expect(await bots.call('bot_schedule_list', {}, bots.ctx('other-thread'))).toMatchObject({ isError: true, text: 'Only a bot can use this.' })
    expect(await bots.call('bot_schedule_add', { when: { kind: 'interval', minutes: 30 }, prompt: 'x' }, bots.ctx('home', 'a2'))).toMatchObject({ isError: true })
    expect(bots.schedules).toEqual([])
  })
})

describe('set_depth and use_model', () => {
  it('set_depth now asks the engine for a reload with the new depth; always saves it', async () => {
    const bots = fakeBots()
    expect((await bots.call('set_depth', { depth: 'deep', scope: 'now' })).value).toMatchObject({ ok: true })
    expect((await bots.call('set_depth', { depth: 'quick', scope: 'always' })).value).toMatchObject({ ok: true })
    expect(bots.models).toEqual([{ scope: 'now', choice: { depth: 'deep' } }, { scope: 'always', choice: { depth: 'quick' } }])
    expect(await bots.call('set_depth', { depth: 'max', scope: 'now' })).toMatchObject({ isError: true })
  })

  it('set_depth on a model the owner picked with its own level says nothing changed, so the bot never promises more time (#673)', async () => {
    const bots = fakeBots('chat', { changes: false })
    const now = (await bots.call('set_depth', { depth: 'deep', scope: 'now' })).value
    expect(now).toMatchObject({ ok: true, changed: false, note: expect.stringContaining('Nothing changes here') })
    expect(now.note).toContain('level hard')
    expect(now.note).not.toMatch(/Mousse continues/)
    expect((await bots.call('set_depth', { depth: 'deep', scope: 'always' })).value).toMatchObject({ ok: true, changed: false, note: expect.stringContaining('nothing changes now') })
  })

  it('a run may change its depth for now only', async () => {
    const bots = fakeBots('run')
    expect((await bots.call('set_depth', { depth: 'deep', scope: 'now' })).value).toMatchObject({ ok: true })
    expect(await bots.call('set_depth', { depth: 'deep', scope: 'always' })).toMatchObject({ isError: true })
    expect(bots.models).toEqual([{ scope: 'now', choice: { depth: 'deep' } }])
  })

  it('a run never switches its model, for now or for good', async () => {
    const bots = fakeBots('run')
    for (const scope of ['now', 'always'])
      expect(await bots.call('use_model', { model: 'Opus', scope })).toMatchObject({ isError: true, text: expect.stringContaining('Only the owner') })
    expect(bots.models).toEqual([])
  })

  it('use_model takes the model the owner named in full, on the entry each row is on, for the rows they said, with a chip (#673)', async () => {
    const bots = fakeBots()
    bots.activity.onAllowed({ botId: 'b1', activationId: 'a1', dispatchId: 'd1' }, { tool: 'use_model', input: { model: 'Opus', scope: 'always' } })
    expect((await bots.call('use_model', { model: 'Opus', scope: 'always' })).value).toEqual({ ok: true, scope: 'always', for: 'all' })
    // The owner sees the change, never the model's name.
    expect(bots.activity.drain('d1')).toEqual([{ icon: 'think', text: 'switched models', highlight: 'from now on' }])
    expect((await bots.call('use_model', { model: 'opus 4.6', scope: 'always', for: 'work' })).value).toMatchObject({ ok: true, for: 'work' })
    expect((await bots.call('use_model', { model: 'opus', scope: 'now' })).value).toEqual({ ok: true, scope: 'now' })
    // Two entries offer it: each row stays on the subscription it is on, with what that entry signs in with now.
    const pick = { instanceId: 'claude', model: 'claude-opus-4-6', credential: 'subscription', account: 'acct-1' }
    expect(bots.models).toEqual([
      { scope: 'always', choice: { slots: { talk: pick, light: pick, medium: pick, hard: pick } } },
      { scope: 'always', choice: { slots: { light: pick, medium: pick, hard: pick } } },
      { scope: 'now', choice: { pick } }
    ])
    expect(await bots.call('use_model', { model: 'opus', scope: 'always', for: 'images' })).toMatchObject({ isError: true })
  })

  it('use_model with two entries offering the model: a row on neither of them is refused, never moved to the paid key', async () => {
    const elsewhere = { instanceId: 'pi:openai', model: 'gpt-5' } as BotModelSlots['talk']
    const bots = fakeBots('chat', { rows: { talk: elsewhere, light: ON_KEY, medium: ON_KEY, hard: ON_KEY } as BotModelSlots })
    expect((await bots.call('use_model', { model: 'Opus 4.6', scope: 'always' })).value).toEqual({ ok: false, reason: USE_MODEL_REFUSED })
    // Work is on the API key already: it stays there.
    expect((await bots.call('use_model', { model: 'Opus 4.6', scope: 'always', for: 'work' })).value).toMatchObject({ ok: true })
    expect(bots.models).toEqual([{ scope: 'always', choice: { slots: { light: ON_KEY, medium: ON_KEY, hard: ON_KEY } } }])
    // On one entry only: every row goes there.
    const one = fakeBots('chat', { owner: 'Use Haiku 4.5 for everything from now on', rows: { talk: elsewhere, light: elsewhere, medium: elsewhere, hard: elsewhere } as BotModelSlots })
    expect((await one.call('use_model', { model: 'haiku', scope: 'always' })).value).toMatchObject({ ok: true })
    expect(Object.values((one.models[0]!.choice as { slots: Record<string, { instanceId: string }> }).slots).map((pick) => pick.instanceId)).toEqual(['claude', 'claude', 'claude', 'claude'])
  })

  it('use_model always needs the model\'s full name in the owner\'s own message; a family word, a number or a generic word never does (#673)', async () => {
    // The owner asked to think harder; the bot reaches for a model on its own.
    const unasked = fakeBots('chat', { owner: 'Think harder about this from now on' })
    expect((await unasked.call('use_model', { model: 'Opus', scope: 'always' })).value).toEqual({ ok: false, reason: USE_MODEL_REFUSED })
    expect(unasked.models).toEqual([])
    // The owner gave the full name, in other words than the bot passed.
    for (const owner of ['Switch to Claude Opus 4.6 for good', 'use opus-4.6 from now on', 'Use Opus 4.6.', 'run claude-opus-4-6 always']) {
      const named = fakeBots('chat', { owner })
      expect((await named.call('use_model', { model: 'claude-opus-4-6', scope: 'always' })).value).toMatchObject({ ok: true })
    }
    // A family word alone is not enough for good, nor a word that only contains a name.
    for (const owner of ['Use Opus.', 'the opuscule please', 'switch to haiku from now on'])
      expect((await fakeBots('chat', { owner }).call('use_model', { model: 'opus', scope: 'always' })).value).toEqual({ ok: false, reason: USE_MODEL_REFUSED })
    // The bot's own words are never what is accepted: the owner named Haiku 4.5, the bot asks for Opus.
    expect((await fakeBots('chat', { owner: 'Use Haiku 4.5 from now on' }).call('use_model', { model: 'Opus 4.6', scope: 'always' })).value).toEqual({ ok: false, reason: USE_MODEL_REFUSED })
    // A longer name the owner said is that model, not the shorter one inside it.
    const mini = fakeBots('chat', { owner: 'use GPT-5 mini from now on' })
    expect((await mini.call('use_model', { model: 'gpt-5 mini', scope: 'always', for: 'talk' })).value).toMatchObject({ ok: true })
    expect(mini.models).toEqual([{ scope: 'always', choice: { slots: { talk: { instanceId: 'pi:openai', model: 'gpt-5-mini', credential: 'api_key' } } } }])
  })

  it('ordinary sentences with "5", "haiku", "pro", "mini" or "default" switch nothing, for now or for good (#673)', async () => {
    const sentences = [
      'remind me at 5',
      'write a haiku about autumn',
      'can you summarise this like a pro?',
      'book the mini cooper for Saturday',
      'leave the default settings as they are',
      'call me at 5 and send me a haiku',
      'I need a mini summary, pro tips only, by default'
    ]
    for (const owner of sentences) {
      for (const model of ['5', 'haiku', 'pro', 'mini', 'default', 'gpt-5', 'opus']) {
        const bots = fakeBots('chat', { owner, rows: { talk: { instanceId: 'pi:openai', model: 'gpt-5' }, light: ON_SUB, medium: ON_SUB, hard: ON_SUB } as BotModelSlots })
        expect((await bots.call('use_model', { model, scope: 'always' })).value).toEqual({ ok: false, reason: USE_MODEL_REFUSED })
        expect(bots.models).toEqual([])
      }
    }
    // For this chat, a family word is enough only when it names one model on Talk's entry: "haiku" in a sentence about a
    // poem would name Haiku 4.5 on the Claude entry, so a sentence like that is refused there too while Talk is elsewhere.
    for (const owner of sentences) {
      const bots = fakeBots('chat', { owner, rows: { talk: { instanceId: 'pi:openai', model: 'gpt-5' }, light: ON_SUB, medium: ON_SUB, hard: ON_SUB } as BotModelSlots })
      for (const model of ['5', 'haiku', 'pro', 'mini', 'default'])
        expect((await bots.call('use_model', { model, scope: 'now' })).value).toEqual({ ok: false, reason: USE_MODEL_REFUSED })
      expect(bots.models).toEqual([])
    }
  })

  it('use_model now needs the owner to name the model: a family word counts only when it names one model on Talk\'s entry (#673)', async () => {
    // Talk is on the Claude subscription, which offers one Opus: "opus" is enough for this chat.
    const family = fakeBots('chat', { owner: 'try opus for this one' })
    expect((await family.call('use_model', { model: 'opus', scope: 'now' })).value).toEqual({ ok: true, scope: 'now' })
    expect(family.models).toEqual([{ scope: 'now', choice: { pick: { instanceId: 'claude', model: 'claude-opus-4-6', credential: 'subscription', account: 'acct-1' } } }])
    // No words for a model at all: refused, where before it needed none.
    expect((await fakeBots('chat', { owner: 'please think harder on this' }).call('use_model', { model: 'opus', scope: 'now' })).value).toEqual({ ok: false, reason: USE_MODEL_REFUSED })
    // A family word names two models on Talk's entry: refused.
    const two = fakeBots('chat', { owner: 'use gpt for this', rows: { talk: { instanceId: 'pi:openai', model: 'gpt-5' }, light: ON_SUB, medium: ON_SUB, hard: ON_SUB } as BotModelSlots })
    expect((await two.call('use_model', { model: 'gpt', scope: 'now' })).value).toEqual({ ok: false, reason: USE_MODEL_REFUSED })
  })
})

describe('work_start levels (#673)', () => {
  it('takes light, medium or hard, or none (the bot\'s usual level), and refuses anything else', async () => {
    const bots = fakeBots()
    expect((await bots.call('work_start', { title: 'Look up', brief: 'Find the opening hours.', level: 'light' })).value).toMatchObject({ status: 'started' })
    expect((await bots.call('work_start', { title: 'Research', brief: 'Compare three vacuums.' })).value).toMatchObject({ status: 'started' })
    expect(await bots.call('work_start', { title: 'Odd', brief: 'Something.', level: 'max' })).toMatchObject({ isError: true, text: 'level is light, medium or hard.' })
    expect(bots.works.map((work) => work.level)).toEqual(['light', undefined])
  })
})

/** The SSD search, running, as `work_list` lists it. */
const SSD_SEARCH = { now: [{ workId: 'w1', title: 'SSD search', status: 'running' as const, startedAt: '2026-11-13T10:00:00.000Z', kind: 'work' as const }], recent: [] }

describe('the bot speaks of its work as its own', () => {
  it('a note to running work: the answer says what the bot now does there, and the chip reads "noted" with the job on hover', async () => {
    const bots = fakeBots('chat', { work: { list: () => SSD_SEARCH, reach: () => 'now' } })
    bots.activity.onAllowed({ botId: 'b1', activationId: 'a1', dispatchId: 'd1' }, { tool: 'work_note', input: { workId: 'w1', note: 'Use the browser tab that is already open.' } })
    const noted = await bots.call('work_note', { workId: 'w1', note: 'Use the browser tab that is already open.' })
    expect(noted.value).toMatchObject({ result: 'noted', reaches: 'now' })
    expect(noted.value.note).toContain('"SSD search"')
    expect(noted.value.note).toContain('"Use the browser tab that is already open."')
    expect(noted.value.note).not.toMatch(/pass|the work (gets|has)/i)
    expect(bots.activity.drain('d1')).toEqual([{ icon: 'think', text: 'noted', title: 'For SSD search' }])
  })

  it('a note that came after the job ended: the answer says it was already finished and offers to do it again, with no chip', async () => {
    const bots = fakeBots('chat', { work: { list: () => ({ now: [], recent: [{ workId: 'w1', title: 'SSD search', status: 'done' as const, endedAt: '2026-11-13T10:05:00.000Z' }] }), note: () => 'ended' as const } })
    bots.activity.onAllowed({ botId: 'b1', activationId: 'a1', dispatchId: 'd1' }, { tool: 'work_note', input: { workId: 'w1', note: 'Use the open tab.' } })
    const late = await bots.call('work_note', { workId: 'w1', note: 'Use the open tab.' })
    expect(late.value).toMatchObject({ result: 'ended', note: expect.stringContaining('already finished "SSD search"') })
    expect(late.value.note).toContain('offer to do it again')
    expect(late.value).not.toHaveProperty('reaches')
    expect(bots.activity.drain('d1')).toEqual([])
  })

  it('a note passed on from a turn the owner did not start: no promise to the owner, and silence unless they need to know now', async () => {
    const asked: string[] = []
    const bots = fakeBots('chat', { work: { list: () => SSD_SEARCH, reach: () => 'now', fromOwner: (_botId, from) => { asked.push(from); return false } } })
    const noted = await bots.call('work_note', { workId: 'w1', note: 'Prices changed since you started.' })
    // Asked about the turn the tool runs in.
    expect(asked).toEqual(['a1'])
    expect(noted.value).toMatchObject({ result: 'noted', reaches: 'now' })
    expect(noted.value.note).toContain('"SSD search"')
    expect(noted.value.note).toContain(SILENT_REPLY)
    expect(noted.value.note).toMatch(/don't tell them they did/)
    expect(noted.value.note).not.toContain('I\'ll')
    // Wherever the work takes it in, the answer is the same.
    for (const reach of ['after_compaction', 'step_end', 'start'] as const) {
      const answer = workNoteAnswer(reach, 'Prices changed since you started.', 'SSD search', { fromOwner: false })
      expect(answer).toContain(SILENT_REPLY)
      expect(answer).not.toContain('I\'ll')
    }

    // The owner's own turn: the bot still says, as itself, what it does from now on.
    for (const fromOwner of [() => true, undefined]) {
      const owner = fakeBots('chat', { work: { list: () => SSD_SEARCH, reach: () => 'now', ...(fromOwner ? { fromOwner } : {}) } })
      const answer = (await owner.call('work_note', { workId: 'w1', note: 'Use the open tab.' })).value.note
      expect(answer).toContain('I\'ll … from here on')
      expect(answer).not.toContain(SILENT_REPLY)
    }
  })

  it('a note passed on from a turn the owner did not start, to work that ended or cannot take it: never the owner\'s words, never a rerun offer', async () => {
    // The race: a wake passes an update on just as the work finishes.
    const ended = fakeBots('chat', { work: { list: () => ({ now: [], recent: [{ workId: 'w1', title: 'SSD search', status: 'done' as const, endedAt: '2026-11-13T10:05:00.000Z' }] }), note: () => 'ended' as const, fromOwner: () => false } })
    const late = await ended.call('work_note', { workId: 'w1', note: 'Prices changed since you started.' })
    expect(late.value).toMatchObject({ result: 'ended' })
    expect(late.value.note).toContain('"SSD search" had already finished')
    expect(late.value.note).toContain(SILENT_REPLY)
    expect(late.value.note).not.toMatch(/offer to do it again|before the owner said this|Tell them so/)
    // Every other refusal: the same, and a question's is never passed on as the owner's answer.
    for (const outcome of ['held', 'approval', 'question', 'waiting'] as const) {
      const bots = fakeBots('chat', { work: { list: () => SSD_SEARCH, note: () => outcome, fromOwner: () => false } })
      const answer = (await bots.call('work_note', { workId: 'w1', note: 'Prices changed since you started.' })).value.note
      expect(answer, outcome).toContain(SILENT_REPLY)
      expect(answer, outcome).toMatch(/don't tell them they did/)
      expect(answer, outcome).not.toMatch(/Tell (the owner|them) (so|their)|offer to stop it|pass them on with question_answer/)
    }
  })

  it('stopping a job: the chip names it, as "started" does', async () => {
    const bots = fakeBots('chat', { work: { list: () => SSD_SEARCH } })
    bots.activity.onAllowed({ botId: 'b1', activationId: 'a1', dispatchId: 'd1' }, { tool: 'work_stop', input: { workId: 'w1' } })
    expect((await bots.call('work_stop', { workId: 'w1' })).value).toMatchObject({ result: 'stopped', note: expect.stringContaining('You stopped "SSD search"') })
    expect(bots.activity.drain('d1')).toEqual([{ icon: 'think', text: 'stopped', highlight: 'SSD search' }])
  })
})

describe('set_profile', () => {
  it('renames the bot or changes its description, within the limits, in the chat only', async () => {
    const bots = fakeBots()
    bots.activity.onAllowed({ botId: 'b1', activationId: 'a1', dispatchId: 'd1' }, { tool: 'set_profile', input: { name: '  Inbox   helper ' } })
    expect((await bots.call('set_profile', { name: '  Inbox   helper ' })).value).toEqual({ ok: true })
    expect(bots.activity.drain('d1')).toEqual([{ icon: 'name', text: 'renamed itself', highlight: 'Inbox helper' }])
    expect(bots.profiles).toEqual([{ name: 'Inbox helper' }])
    expect(await bots.call('set_profile', { name: 'x'.repeat(61) })).toMatchObject({ isError: true })
    expect(await bots.call('set_profile', {})).toMatchObject({ isError: true })
    expect(await fakeBots('run').call('set_profile', { name: 'Taken over' })).toMatchObject({ isError: true })
  })

  it('changes only the look fields given, from the lists the face draws, in the chat only', async () => {
    const bots = fakeBots()
    expect((await bots.call('set_profile', { look: { colour: 'blue', accessory: 'headphones' } })).value).toEqual({ ok: true })
    expect(bots.profiles).toEqual([{ look: { colour: 'blue', accessory: 'headphones' } }])
    for (const look of [{ colour: 'plaid' }, { hat: 'cap' }, {}, 'blue', { kind: 7 }]) {
      expect(await bots.call('set_profile', { look })).toMatchObject({ isError: true })
    }
    expect(bots.profiles).toHaveLength(1)
    expect(await fakeBots('run').call('set_profile', { look: { colour: 'blue' } })).toMatchObject({ isError: true })
  })
})

describe('get_profile', () => {
  const FACTS: BotProfileFacts = {
    name: 'Inbox helper',
    description: 'Sorts the inbox.',
    look: { colour: 'blue', accessory: 'headphones' },
    facePicture: '/bots/b1/files/face.png',
    filesFolder: '/bots/b1/files',
    rows: ROWS_ON_SUB,
    depth: 'normal',
    image: null,
    custom: [],
    devices: { here: 'Studio Mac', access: 'this_computer', reach: [] },
    secrets: [{ name: 'GITHUB_TOKEN', label: 'GitHub' }],
    allowed: { web: true, shell: false, browser: false, threads: false, mcp: [], automation: [] } as unknown as BotProfileFacts['allowed']
  }

  it('reads the bot its own profile in plain sections, models by the names its owner sees, in every lane', async () => {
    for (const lane of ['chat', 'run'] as const) {
      const { text, isError } = await fakeBots(lane, { profile: FACTS }).call('get_profile', {})
      expect(isError).toBeFalsy()
      for (const title of ['Who you are', 'How you run', 'What you can reach', 'What you may do']) expect(text).toContain(`${title}\n- `)
      expect(text).toContain('Look: a blue mouse with headphones and black pill eyes (')
      expect(text).toContain('/bots/b1/files/face.png')
      expect(text).toContain('Talking (this chat): Opus 4.6 on Claude Code')
      expect(text).toContain('GITHUB_TOKEN (GitHub)')
      expect(text).toContain('Allowed: search the web and read pages')
    }
  })

  it('says so when no face picture is saved yet, and errors where the host has no profile', async () => {
    const { facePicture: _, ...none } = FACTS
    expect((await fakeBots('chat', { profile: none }).call('get_profile', {})).text).toContain('Face picture: none saved yet')
    expect(await fakeBots().call('get_profile', {})).toMatchObject({ isError: true })
  })
})

describe('question_ask (#1123)', () => {
  /** The bot's tools with a question host that keeps what it is asked. */
  function asking(lane: BotLane) {
    const bots = fakeBots(lane)
    const asked: unknown[] = []
    const deps = { host: { ...{} as BotToolHost, activationOf: (threadId: string) => (threadId === 'home' ? { botId: 'b1', activationId: 'a1', lane, memoryLane: lane } : undefined), questions: { ask: (_botId: string, _activationId: string, asks: ReadonlyArray<{ spec: unknown }>) => { asked.push(...asks.map((ask) => ask.spec)); return { asked: true, text: 'Shown under your reply.', questionIds: asks.map((_, n) => `q_${n}`) } } } } as BotToolHost }
    const tool = botTools(() => deps).find((entry) => entry.name === 'question_ask')!
    return { asked, call: (args: Record<string, unknown>) => tool.handler(args, bots.ctx()) }
  }

  // What the tool takes, and what it refuses with a reason the bot can act on. Nothing refused reaches the host.
  const ROWS: Array<[string, Record<string, unknown>, unknown]> = [
    ['choices as labels', { question: 'Which flat?', choices: ['A', 'B'] }, { question: 'Which flat?', choices: [{ label: 'A' }, { label: 'B' }], other: true }],
    ['choices with a detail, no Other', { question: 'Which?', choices: [{ label: 'A', detail: '2 bed' }, 'B'], other: false }, { question: 'Which?', choices: [{ label: 'A', detail: '2 bed' }, { label: 'B' }], other: false }],
    ['yes or no', { question: 'Shall I?', yesNo: true }, { question: 'Shall I?', choices: [{ label: 'Yes' }, { label: 'No' }], other: true }],
    ['no question', { choices: ['A', 'B'] }, 'refused'],
    ['one choice', { question: 'Q?', choices: ['A'] }, 'refused'],
    ['six choices', { question: 'Q?', choices: ['A', 'B', 'C', 'D', 'E', 'F'] }, 'refused'],
    ['the same label twice', { question: 'Q?', choices: ['A', 'a'] }, 'refused'],
    ['a label over 40 characters', { question: 'Q?', choices: ['A'.repeat(41), 'B'] }, 'refused'],
    ['choices and yesNo', { question: 'Q?', choices: ['A', 'B'], yesNo: true }, 'refused'],
    ['neither choices nor yesNo', { question: 'Q?' }, 'refused'],
    ['a question over 600 characters', { question: 'Q'.repeat(601), yesNo: true }, 'refused']
  ]
  it.each(ROWS)('%s', async (_name, args, expected) => {
    const { asked, call } = asking('chat')
    const outcome = await call(args)
    if (expected === 'refused') {
      expect(outcome.isError).toBe(true)
      expect(asked).toEqual([])
    } else {
      expect(outcome.isError).toBeFalsy()
      expect(asked).toEqual([expected])
    }
  })
})

describe('registration', () => {
  it('lists the bot tools in the bots family, and WP6\'s memory tools beside them', () => {
    const { families } = createAppToolRegistry({ host: fakeAppToolHost().host, bots: () => undefined })
    expect(families.bots).toEqual(['permission_ask', 'consult', 'bot_schedule_add', 'schedule_done', 'bot_schedule_remove', 'bot_schedule_list', 'mcp_servers', 'set_profile', 'get_profile', 'set_depth', 'work_start', 'work_list', 'work_stop', 'work_note', 'remind', 'work_wait', 'wake', 'watch_start', 'watch_list', 'watch_stop', 'reminder_list', 'reminder_cancel', 'make_image', 'show_card', 'bot_list', 'bot_send', 'use_model', 'subagent_start', 'subagent_send', 'subagent_wait', 'subagent_result', 'subagent_stop', 'tool_catalogue', 'use_tool'])
    // With `botMemory`, WP6's memory tools and the open items' tools follow them in the same family.
    const withMemory = createAppToolRegistry({ host: fakeAppToolHost().host, botMemory: { activationOf: () => undefined } })
    expect(withMemory.families.bots.slice(0, families.bots.length)).toEqual(families.bots)
    for (const name of withMemory.families.bots.slice(families.bots.length)) expect([...BOT_MEMORY_TOOLS, ...BOT_ITEM_TOOLS] as readonly string[]).toContain(name)
  })

  it('without the engine wired, the bot\'s own tools refuse', async () => {
    const tool = botTools(() => undefined).find((entry) => entry.name === 'bot_schedule_list')!
    expect(tool.available?.({ bot: { activationId: 'a1' } } as unknown as Parameters<NonNullable<MousseTool['available']>>[0])).toBe('Only a bot can use this.')
  })
})

describe('wake', () => {
  it.each(['checks', 'review'] as const)('passes the PR %s condition to the engine', async (on) => {
    const bots = fakeBots()
    await bots.call('wake', { brief: 'Report.', pr: 'acme/app#12', on })
    expect(bots.wakes[0]?.input.event).toMatchObject({ kind: 'pr', on })
  })
  it('rejects an invalid condition or one without a pull request', async () => {
    const bots = fakeBots()
    for (const args of [{ pr: 'acme/app#12', on: 'other' }, { inMinutes: 2, on: 'review' }]) {
      expect(await bots.call('wake', { brief: 'Report.', ...args })).toMatchObject({ isError: true })
    }
    expect(bots.wakes).toHaveLength(0)
  })

  it('sets a wake at a time, on a pull request, or on a thread (with "use your threads"), from the chat turn, with a chip', async () => {
    const bots = fakeBots()
    bots.activity.onAllowed({ botId: 'b1', activationId: 'a1', dispatchId: 'd1' }, { tool: 'wake', input: {} })
    expect((await bots.call('wake', { brief: 'Check the deploy.', inMinutes: 20 })).value).toMatchObject({ wakeId: 'w1', when: expect.any(String) })
    expect((await bots.call('wake', { brief: 'Tell them it shipped.', pr: 'https://github.com/acme/app/pull/12', hours: 48 })).value).toMatchObject({ waitsFor: 'when acme/app#12 merges' })
    expect((await bots.call('wake', { brief: 'Sum it up.', thread: 't1' }, bots.ctx('home', 'a1', ['thread_list', 'thread_read', 'thread_wait']))).value).toMatchObject({ waitsFor: 'when "Fix login" finishes' })
    expect(bots.wakes.map((entry) => ({ from: entry.from, event: entry.input.event, hours: entry.input.hours }))).toEqual([
      { from: 'a1', event: undefined, hours: undefined },
      { from: 'a1', event: { kind: 'pr', repo: 'acme/app', number: 12 }, hours: 48 },
      { from: 'a1', event: { kind: 'thread', threadId: 't1' }, hours: undefined }
    ])
    expect(bots.activity.drain('d1').map((chip) => chip.highlight)).toEqual([expect.any(String), 'when acme/app#12 merges', 'when "Fix login" finishes'])
  })

  it.each([
    ['no brief', { inMinutes: 5 }, 'brief'],
    ['no time and nothing to wait for', { brief: 'x' }, 'Give one of'],
    ['a time and a thread both', { brief: 'x', inMinutes: 5, thread: 't1' }, 'Give one of'],
    ['a pull request it can not read', { brief: 'x', pr: '#12' }, 'owner/repo#12'],
    ['a thread without "use your threads"', { brief: 'x', thread: 't1' }, 'use your threads']
  ])('refuses %s, setting nothing', async (_name, args, words) => {
    const bots = fakeBots()
    expect(await bots.call('wake', args)).toMatchObject({ isError: true, text: expect.stringContaining(words) })
    expect(bots.wakes).toEqual([])
  })

  it('work never sets one', async () => {
    const bots = fakeBots('run')
    expect(await bots.call('wake', { brief: 'x', inMinutes: 5 })).toMatchObject({ isError: true, text: expect.stringContaining('Only your chat') })
    expect(bots.wakes).toEqual([])
  })
})

describe('background commands', () => {
  it('watch_start hands the command, brief, title, match and time limit to the engine from the chat turn; list and stop by id', async () => {
    const bots = fakeBots()
    const started = await bots.call('watch_start', { command: 'gh run watch 123', brief: 'Tell them if the nightly passed.', title: 'Nightly', match: 'completed', minutes: 90 })
    expect(started.value).toMatchObject({ watcherId: 'rem_w1', stopsBy: expect.any(String) })
    expect(bots.watched).toEqual([{ from: 'a1', input: { command: 'gh run watch 123', brief: 'Tell them if the nightly passed.', title: 'Nightly', match: 'completed', minutes: 90 } }])
    expect((await bots.call('watch_list', {})).value).toEqual([expect.objectContaining({ id: 'rem_w1', command: 'gh run watch 123', stopsBy: expect.any(String) })])
    expect((await bots.call('watch_stop', { watcherId: 'rem_w1' })).value).toEqual({ stopped: true })
    expect(await bots.call('watch_stop', { watcherId: 'rem_w9' })).toMatchObject({ isError: true, text: expect.stringContaining('watch_list') })
  })

  it('watch_list with a command\'s id reads its output a page at a time, from the end, without colors', async () => {
    const bots = fakeBots()
    const last = (await bots.call('watch_list', { watcherId: 'rem_w1', lines: 50 })).value as Record<string, unknown>
    expect(last).toMatchObject({ watcherId: 'rem_w1', ended: { kind: 'exit', code: 1 }, fromLine: 1251, toLine: 1300, lastLine: 1300, more: expect.stringContaining('before 1251') })
    expect(String(last.output).split('\n')).toHaveLength(50)
    expect(String(last.output).split('\n')[0]).toBe('job 1251')
    const back = (await bots.call('watch_list', { watcherId: 'rem_w1', lines: 500, before: 1251 })).value as Record<string, unknown>
    expect(back).toMatchObject({ fromLine: 1001, toLine: 1250 })
    expect(back.more).toBeUndefined()
    expect(await bots.call('watch_list', { watcherId: 'rem_w9' })).toMatchObject({ isError: true, text: expect.stringContaining('no background command with that id') })
  })

  it.each([
    ['no command', { brief: 'x' }, 'command'],
    ['no brief', { command: 'make' }, 'brief'],
    ['a match the engine refuses', { command: 'make', brief: 'x', match: '(a+)+' }, 'repeats itself']
  ])('watch_start refuses %s', async (_name, args, words) => {
    const bots = fakeBots()
    expect(await bots.call('watch_start', args)).toMatchObject({ isError: true, text: expect.stringContaining(words) })
    expect(bots.watched).toEqual([])
  })

  // #1360: a run starts one (the engine checks its start, `BOT_TURN_KINDS`); stopping one stays the chat's.
  it('work hands a start to the engine, and never stops one', async () => {
    const bots = fakeBots('run')
    expect(await bots.call('watch_start', { command: 'make', brief: 'x' })).not.toMatchObject({ isError: true })
    expect(bots.watched.map((entry) => entry.input.command)).toEqual(['make'])
    expect(await bots.call('watch_stop', { watcherId: 'rem_w1' })).toMatchObject({ isError: true, text: expect.stringContaining('Only your chat') })
  })
})

describe('work_wait', () => {
  it('uses the same PR and time forms, with why as the continuation brief', async () => {
    const bots = fakeBots('run')
    expect((await bots.call('work_wait', { why: 'Read the checks', pr: 'acme/app#12', on: 'checks' }, { ...bots.ctx(), turn: { ...bots.ctx().turn, bot: { ...bots.ctx().turn.bot!, role: 'activation' } } })).isError).toBeFalsy()
    expect(bots.wakes[0]?.input).toMatchObject({ brief: 'Read the checks', event: { kind: 'pr', repo: 'acme/app', number: 12, on: 'checks' } })
    expect((await bots.call('work_wait', { why: 'Later', inMinutes: 30 }, { ...bots.ctx(), turn: { ...bots.ctx().turn, bot: { ...bots.ctx().turn.bot!, role: 'activation' } } })).isError).toBeFalsy()
    expect(bots.wakes[1]?.input.dueAt).toBeDefined()
  })
  it('tells chat to use wake', async () => {
    expect(await fakeBots().call('work_wait', { why: 'Later', inMinutes: 30 })).toMatchObject({ isError: true, text: expect.stringContaining('Use wake') })
  })
})

it('page-check schedules reject say and invalid URLs before saving, and keep the page setting', async () => {
  const bots = fakeBots()
  for (const onlyIfChanged of [{url:'file:///etc/passwd'},{url:'https://u:p@example.com'},{url:'https://example.com',contains:'x'.repeat(201)}]) {
    expect((await bots.call('bot_schedule_add',{when:{kind:'interval',minutes:15},prompt:'Watch tickets',onlyIfChanged})).isError).toBe(true)
  }
  expect((await bots.call('bot_schedule_add',{when:{kind:'interval',minutes:15},say:'Hi',onlyIfChanged:{url:'https://example.com'}})).isError).toBe(true)
  const result=await bots.call('bot_schedule_add',{when:{kind:'interval',minutes:15},prompt:'Watch tickets',onlyIfChanged:{url:'https://example.com',contains:'tickets'}})
  expect(result.isError).toBeFalsy()
  expect(bots.schedules[0]).toMatchObject({onlyIfChanged:{url:'https://example.com',contains:'tickets'}})
})

it('accepts the exact flattened let-alone request Codex sent in the live trial', async () => {
  const tools = botTools()
  const tool = tools.find(t => t.name === 'permission_ask')!
  let permission: unknown
  const ctx = fakeBots().ctx()
  ctx.turn.bot!.escalate = request => { permission = request.permission; return 'Asked' }
  const result = await tool.handler({ ask: 'let_alone', scheduleId: 's-67020d90', serverId: 'trial-drive.9be4eb770a', tool: 'upload_file', reason: 'Let it do that without asking.' }, ctx)
  expect(result.text).toBe('Asked')
  expect(permission).toEqual({ ask: 'let_alone', scheduleId: 's-67020d90', serverId: 'trial-drive.9be4eb770a', tool: 'upload_file' })
})
it.each([true, false])('the escalate definition describes the wrapped ask only with asks first on: %s', on => {
  const tool = botTools().find(t => t.name === 'permission_ask')!
  const ctx = fakeBots().ctx()
  if (on) ctx.turn.bot!.holdMcp = () => ({ text: 'Held' })
  const definition = tool.definition!(ctx.turn)
  expect(definition.description.includes("permission: {ask:'let_alone', scheduleId, serverId, tool}")).toBe(on)
  expect(JSON.stringify(definition.parameters).includes('let_alone')).toBe(on)
})
