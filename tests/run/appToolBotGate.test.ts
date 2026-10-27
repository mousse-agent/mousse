/**
 * PR 6 6c-1: a bot turn's authority over its app-tool calls over MCP (the Mousse registry's
 * `tools/call`): checked on every call, so a list cached before a narrower revision cannot reach a
 * removed tool. Nobody is asked.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { RunCounters } from '../../src/mms/harness/budget'
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
