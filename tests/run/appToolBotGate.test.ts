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
    turns.register(appTurn({ threadId: 'thread-a', runId: run.runId, bot: bot(['create_task']) }))
    const ctx = () => request({ threadId: 'thread-a', runId: run.runId })
    expect(await registry.call('ask_user', { questions: [] }, ctx())).toEqual({ text: 'This bot is not allowed to use ask_user.', isError: true })
    expect(fake.host.askUser).not.toHaveBeenCalled()
    expect((await registry.call('create_task', { description: 'fine' }, ctx())).isError).toBe(false)
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
    expect(await registry.call('bot_schedule_add', { when: { kind: 'interval', minutes: 30 }, prompt: 'x' }, ctx())).toEqual({ text: 'This bot is not allowed to use bot_schedule_add.', isError: true })
    expect(host.schedules.add).not.toHaveBeenCalled()
    turns.register(appTurn({ threadId: 'thread-a', runId: run.runId, bot: bot([...BOT_DEFAULT_APP_TOOLS]) }))
    expect(await registry.call('bot_schedule_add', { when: { kind: 'interval', minutes: 30 }, prompt: 'x' }, ctx())).toEqual({ text: JSON.stringify({ scheduleId: 's1', label: 'every 30 minutes' }) })
    expect(host.schedules.add).toHaveBeenCalledWith('b1', { when: { kind: 'interval', minutes: 30 }, prompt: 'x' })
  })
})
