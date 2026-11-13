/**
 * Bot Phase 1 §5.5, §5.6, §5.10: the bot's own app tools. They act on the bot the engine says the
 * thread belongs to, never on arguments; schedules are checked and labelled; depth and model
 * changes go through `BotToolHost.setModel`; only the owner's chat changes the bot for good.
 */
import { describe, expect, it } from 'vitest'
import { createBotActivitySink } from '../../src/mms/bots/activity/BotActivitySink'
import type { BotModelChange, BotToolHost } from '../../src/mms/bots/seams'
import { createAppToolRegistry } from '../../src/mms/run/mcp/appTools'
import { botTools, USE_MODEL_REFUSED, type BotAppToolDeps } from '../../src/mms/run/mcp/appTools/bots'
import type { MousseTool, ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import type { BotLane, BotModelSlots, BotSchedule } from '../../src/shared/bots/personal/definition'
import type { BotModelOption } from '../../src/shared/bots/personal/methods'
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

function fakeBots(lane: BotLane = 'chat', options: { owner?: string; changes?: boolean; rows?: BotModelSlots; choices?: BotModelOption[]; work?: Partial<BotToolHost['work']> } = {}) {
  const schedules: Array<{ scheduleId: string; when: BotSchedule['when']; prompt: string; label: string }> = []
  const profiles: Array<{ name?: string; description?: string }> = []
  const models: Array<{ scope: 'now' | 'always'; choice: BotModelChange }> = []
  const works: Array<{ title: string; brief: string; key: string; level?: string }> = []
  const host = {
    // The owner's message the chat turn holds.
    ownerWords: () => options.owner ?? 'Please use Opus 4.6 from now on',
    rows: () => options.rows ?? ROWS_ON_SUB,
    activationOf: (threadId) => (threadId === 'home' ? { botId: 'b1', activationId: 'a1', lane } : undefined),
    schedules: {
      add: (_botId, s) => {
        const entry = { scheduleId: `s${schedules.length + 1}`, ...s, label: botScheduleLabel(s.when) }
        schedules.push(entry)
        return { scheduleId: entry.scheduleId, label: entry.label }
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
    setModel: (_botId, _activationId, scope, choice) => {
      models.push({ scope, choice })
      return { changed: options.changes ?? true }
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
  const ctx = (threadId = 'home', activationId = 'a1'): ToolCallContext => ({
    caller: { threadId, runId: 'r1', provider: 'pi', modeCeiling: 'default', accessLevel: 'lineage' },
    turn: { threadId, bot: { activationId } as BotAuthority } as ToolCallContext['turn'],
    toolCallId: 'call-1',
    signal: new AbortController().signal,
    transport: 'mcp'
  })
  const call = async (name: string, args: Record<string, unknown>, context = ctx()) => {
    const outcome = await (tools.get(name) as MousseTool).handler(args, context)
    return { ...outcome, value: outcome.isError ? undefined : JSON.parse(outcome.text) }
  }
  return { schedules, profiles, models, works, activity, call, ctx }
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

  it('refuses a ninth schedule, one more often than every 5 minutes, and a bad time', async () => {
    const bots = fakeBots()
    for (let n = 0; n < 8; n += 1) expect((await bots.call('bot_schedule_add', { when: { kind: 'interval', minutes: 30 + n }, prompt: `task ${n}` })).isError).toBeFalsy()
    const ninth = await bots.call('bot_schedule_add', { when: { kind: 'interval', minutes: 60 }, prompt: 'one more' })
    expect(ninth).toMatchObject({ isError: true, text: expect.stringContaining('8 schedules') })
    expect(bots.schedules).toHaveLength(8)
    const fresh = fakeBots()
    expect(await fresh.call('bot_schedule_add', { when: { kind: 'interval', minutes: 2 }, prompt: 'x' })).toMatchObject({ isError: true, text: expect.stringContaining('5 minutes') })
    expect(await fresh.call('bot_schedule_add', { when: { kind: 'cron', expr: '*/2 * * * *' }, prompt: 'x' })).toMatchObject({ isError: true, text: expect.stringContaining('5 minutes') })
    expect(await fresh.call('bot_schedule_add', { when: { kind: 'cron', expr: '0 9 * *' }, prompt: 'x' })).toMatchObject({ isError: true })
    expect(await fresh.call('bot_schedule_add', { when: { kind: 'interval', minutes: 30 }, prompt: '  ' })).toMatchObject({ isError: true })
    expect(fresh.schedules).toEqual([])
  })

  it('lists and removes the bot\'s schedules', async () => {
    const bots = fakeBots()
    await bots.call('bot_schedule_add', { when: { kind: 'interval', minutes: 30 }, prompt: 'x' })
    expect((await bots.call('bot_schedule_list', {})).value).toEqual([{ scheduleId: 's1', label: 'every 30 minutes', nextAt: '2026-11-09T09:00:00.000Z' }])
    expect((await bots.call('bot_schedule_remove', { scheduleId: 's1' })).value).toEqual({ removed: true })
    expect(await bots.call('bot_schedule_remove', { scheduleId: 's1' })).toMatchObject({ isError: true })
  })

  it('an unattended run can look at its schedules but not change them', async () => {
    const bots = fakeBots('run')
    expect(await bots.call('bot_schedule_add', { when: { kind: 'interval', minutes: 30 }, prompt: 'x' })).toMatchObject({ isError: true, text: expect.stringContaining('owner') })
    expect((await bots.call('bot_schedule_list', {})).value).toEqual([])
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
})

describe('registration', () => {
  it('lists the bot tools in the bots family, and WP6\'s memory tools beside them', () => {
    const { families } = createAppToolRegistry({ host: fakeAppToolHost().host, bots: () => undefined })
    expect(families.bots).toEqual(['escalate', 'consult', 'bot_schedule_add', 'bot_schedule_remove', 'bot_schedule_list', 'mcp_servers', 'set_profile', 'set_depth', 'work_start', 'work_models', 'work_list', 'work_stop', 'work_note', 'remind', 'reminder_list', 'reminder_cancel', 'make_image', 'use_model'])
    // With `botMemory`, WP6's memory tools follow them in the same family.
    const withMemory = createAppToolRegistry({ host: fakeAppToolHost().host, botMemory: { activationOf: () => undefined } })
    expect(withMemory.families.bots.slice(0, families.bots.length)).toEqual(families.bots)
    for (const name of withMemory.families.bots.slice(families.bots.length)) expect(BOT_MEMORY_TOOLS as readonly string[]).toContain(name)
  })

  it('without the engine wired, the bot\'s own tools refuse', async () => {
    const tool = botTools(() => undefined).find((entry) => entry.name === 'bot_schedule_list')!
    expect(tool.available?.({ bot: { activationId: 'a1' } } as unknown as Parameters<NonNullable<MousseTool['available']>>[0])).toBe('Only a bot can use this.')
  })
})
