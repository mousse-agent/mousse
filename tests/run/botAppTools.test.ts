/**
 * Bot Phase 1 §5.5, §5.6, §5.10: the bot's own app tools. They act on the bot the engine says the
 * thread belongs to, never on arguments; schedules are checked and labelled; depth and model
 * changes go through `BotToolHost.setModel`; only the owner's chat changes the bot for good.
 */
import { describe, expect, it } from 'vitest'
import { createBotActivitySink } from '../../src/mms/bots/activity/BotActivitySink'
import type { BotToolHost } from '../../src/mms/bots/seams'
import { createAppToolRegistry } from '../../src/mms/run/mcp/appTools'
import { botTools, type BotAppToolDeps } from '../../src/mms/run/mcp/appTools/bots'
import type { MousseTool, ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import type { BotLane, BotModelChoice, BotSchedule } from '../../src/shared/bots/personal/definition'
import { BOT_MEMORY_TOOLS } from '../../src/shared/bots/personal/memory'
import { botScheduleLabel } from '../../src/shared/scheduleLabel'
import { fakeAppToolHost } from './appToolsFixture'

function fakeBots(lane: BotLane = 'chat') {
  const schedules: Array<{ scheduleId: string; when: BotSchedule['when']; prompt: string; label: string }> = []
  const profiles: Array<{ name?: string; description?: string }> = []
  const models: Array<{ scope: 'now' | 'always'; choice: Partial<BotModelChoice> }> = []
  const host: BotToolHost = {
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
    }
  }
  const activity = createBotActivitySink({ emit: () => {} })
  const deps: BotAppToolDeps = { host, activity, models: { namedAvailable: async (model) => /opus|sonnet/i.test(model) } }
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
  return { schedules, profiles, models, activity, call, ctx }
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

  it('a run may change its depth for now only', async () => {
    const bots = fakeBots('run')
    expect((await bots.call('set_depth', { depth: 'deep', scope: 'now' })).value).toMatchObject({ ok: true })
    expect(await bots.call('set_depth', { depth: 'deep', scope: 'always' })).toMatchObject({ isError: true })
    expect(bots.models).toEqual([{ scope: 'now', choice: { depth: 'deep' } }])
  })

  it('use_model takes a model the owner named when it is there, and says plainly when it is not', async () => {
    const bots = fakeBots()
    expect((await bots.call('use_model', { model: 'Opus', scope: 'always' })).value).toEqual({ ok: true })
    expect(bots.models).toEqual([{ scope: 'always', choice: { mode: 'named', model: 'Opus' } }])
    const missing = await bots.call('use_model', { model: 'grok', scope: 'now' })
    expect(missing.value).toMatchObject({ ok: false, reason: expect.stringContaining('not available') })
    expect(bots.models).toHaveLength(1)
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
    expect(families.bots).toEqual(['escalate', 'consult', 'bot_schedule_add', 'bot_schedule_remove', 'bot_schedule_list', 'set_profile', 'set_depth', 'use_model'])
    // With `botMemory`, WP6's memory tools follow them in the same family.
    const withMemory = createAppToolRegistry({ host: fakeAppToolHost().host, botMemory: { activationOf: () => undefined } })
    expect(withMemory.families.bots.slice(0, 8)).toEqual(families.bots)
    for (const name of withMemory.families.bots.slice(8)) expect(BOT_MEMORY_TOOLS as readonly string[]).toContain(name)
  })

  it('without the engine wired, the bot\'s own tools refuse', async () => {
    const tool = botTools(() => undefined).find((entry) => entry.name === 'bot_schedule_list')!
    expect(tool.available?.({ bot: { activationId: 'a1' } } as unknown as Parameters<NonNullable<MousseTool['available']>>[0])).toBe('Only a bot can use this.')
  })
})
