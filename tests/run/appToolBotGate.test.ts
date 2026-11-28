/**
 * PR 6 6c-1: a bot turn's authority over its app-tool calls over MCP (the Mousse registry's
 * `tools/call`): checked on every call, so a list cached before a narrower revision cannot reach a
 * removed tool. Nobody is asked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import type { BotToolHost } from '../../src/mms/bots/seams'
import { RunCounters } from '../../src/mms/harness/budget'
import { BOT_DEFAULT_APP_TOOLS } from '../../src/shared/bots/personal/manifest'
import { botTurnOffers } from '../../src/shared/bots/personal/walls'
import { refused } from '../../src/mms/run/mcp/appTools/refusal'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

let fx: DelegationFixture | undefined
afterEach(() => {
  fx?.dispose()
  fx = undefined
})

const bot = (appTools: string[]) => createBotAuthority({
  activationId: 'act-1',
  role: 'activation',
  permissions: { tools: [], appTools, mcp: [], skills: [], workspace: null },
  waiting: () => false,
  counters: new RunCounters(),
  time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal },
  spend: null
})

describe('app tools under a bot’s authority (MCP)', () => {
  it('a tool outside the grant never reaches its handler; a granted one runs', async () => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const fake = fakeAppToolHost()
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'thread-a', runId: run.runId, bot: bot(['task_create']) }))
    const ctx = () => request({ threadId: 'thread-a', runId: run.runId })
    // A call that names a thread is the thread tool's own, never one of the bot's (its subagents' `subagent_wait`).
    const handler = vi.spyOn(registry.list().find((tool) => tool.name === 'thread_wait')!, 'handler')
    expect(await registry.call('thread_wait', { threadId: 'thread-b' }, ctx())).toEqual(refused('not_granted', 'This bot is not allowed to use thread_wait.'))
    expect(handler).not.toHaveBeenCalled()
    expect((await registry.call('task_create', { description: 'fine' }, ctx())).isError).toBe(false)
  })

  it('each call that reaches its handler is one run of the bot\'s call (`callRuns`); a refused one is none', async () => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const fake = fakeAppToolHost()
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    const callRuns = vi.fn()
    turns.register(appTurn({ threadId: 'thread-a', runId: run.runId, bot: { ...bot(['task_create']), callRuns } }))
    const ctx = () => request({ threadId: 'thread-a', runId: run.runId })
    expect((await registry.call('thread_wait', { threadId: 'thread-b' }, ctx())).isError).toBe(true)
    expect(callRuns).not.toHaveBeenCalled()
    // The same call twice is two calls.
    expect((await registry.call('task_create', { description: 'fine' }, ctx())).isError).toBe(false)
    expect((await registry.call('task_create', { description: 'fine' }, ctx())).isError).toBe(false)
    expect(callRuns).toHaveBeenCalledTimes(2)
  })

  it('a bot turn is told only its granted app tools are usable; a thread\'s turn every one', () => {
    const granted = bot([...BOT_DEFAULT_APP_TOOLS])
    expect(botTurnOffers(granted, 'permission_ask')).toBe(true)
    expect(botTurnOffers(granted, 'memory_save')).toBe(true)
    expect(botTurnOffers(granted, 'delegate_task')).toBe(false)
    expect(botTurnOffers(granted, 'thread_read')).toBe(false)
    expect(botTurnOffers(undefined, 'delegate_task')).toBe(true)
  })
})

describe('the bot\'s own tools under its authority (Bot Phase 1 §5.10)', () => {
  const host: BotToolHost = {
    activationOf: (threadId) => (threadId === 'thread-a' ? { botId: 'b1', activationId: 'act-1', lane: 'chat' } : undefined),
    schedules: { add: vi.fn(() => ({ scheduleId: 's1', label: 'every 30 minutes' })), remove: vi.fn(() => true), list: vi.fn(() => []) },
    setProfile: vi.fn(),
    setModel: vi.fn()
  }

  it('the default app tools reach their handlers; a grant without them never does', async () => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const { registry, turns, request } = appToolRegistry(fx.engine, fakeAppToolHost().host, { bots: () => ({ host }) })
    const ctx = () => request({ threadId: 'thread-a', runId: run.runId })
    turns.register(appTurn({ threadId: 'thread-a', runId: run.runId, bot: bot(['web_search']) }))
    expect(await registry.call('bot_schedule_add', { when: { kind: 'interval', minutes: 30 }, prompt: 'x' }, ctx())).toEqual(refused('not_granted', 'This bot is not allowed to use bot_schedule_add.'))
    expect(host.schedules.add).not.toHaveBeenCalled()
    turns.register(appTurn({ threadId: 'thread-a', runId: run.runId, bot: bot([...BOT_DEFAULT_APP_TOOLS]) }))
    expect(await registry.call('bot_schedule_add', { when: { kind: 'interval', minutes: 30 }, prompt: 'x' }, ctx())).toEqual({ text: JSON.stringify({ scheduleId: 's1', label: 'every 30 minutes' }) })
    // The turn that adds it goes with it: its reply shows the automation as a card.
    expect(host.schedules.add).toHaveBeenCalledWith('b1', { when: { kind: 'interval', minutes: 30 }, prompt: 'x' }, 'act-1')
  })
})
