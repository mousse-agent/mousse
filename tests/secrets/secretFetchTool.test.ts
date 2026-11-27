import { expect, it, vi } from 'vitest'
import { secretTools } from '../../src/mms/run/mcp/appTools/secrets'
import { appTurn, fakeAppToolHost } from '../run/appToolsFixture'
import type { ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import { BOT_SECRET_TOOLS } from '../../src/shared/bots/personal/manifest'
it('offers a bound read only to work with a ledger and hands it to the home vault', async () => {
  const fetch = vi.fn().mockResolvedValue({ text: 'safe data' }),
    record = vi.fn(async (_args, run) => run())
  const host = {
    ...fakeAppToolHost().host,
    botHomeOf: () => 'home',
    secrets: () => ({
      fetch,
      masker: () => undefined,
      prepareFetch: (input: unknown) => ({ service: 'OpenAI', send: () => fetch(input) })
    })
  }
  const tool = secretTools(host as never).find((t) => t.name === 'secret_fetch')!
  expect(tool).toBeDefined()
  expect(tool.listed!({ readOnly: false })).toBe(false)
  expect(BOT_SECRET_TOOLS).toContain('secret_fetch')
  const turn = appTurn({
    threadId: 'work',
    runId: 'run',
    bot: { secretFetch: record, workspace: { scratch: '/run' } } as never
  })
  expect(tool.available!(turn)).toBe(true)
  const args = { secret: 'KEY', path: '/v1/models' }
  const ctx = {
    turn,
    transport: 'in_process',
    toolCallId: 'call',
    signal: new AbortController().signal
  } as ToolCallContext
  expect(await tool.handler(args, ctx)).toEqual({ text: 'safe data' })
  expect(record).toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: 'home', folder: '/run', args })
  )
  const chat = appTurn({
    threadId: 'work',
    runId: 'run',
    bot: { workspace: { scratch: '/run' } } as never
  })
  expect(tool.available!(chat)).not.toBe(true)
  expect((await tool.handler(args, { ...ctx, turn: chat })).isError).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each(['ordinary thread', 'manual run', 'read only'])(
  'explains why a service read is unavailable in %s',
  async (kind) => {
    const send = vi.fn(async () => ({ text: 'data' }))
    const record = vi.fn(async (_args, run) => run())
    const host = {
      ...fakeAppToolHost().host,
      botHomeOf: () => 'home',
      secrets: () => ({
        masker: () => undefined,
        prepareFetch: () => ({ service: 'OpenAI', send })
      })
    }
    const tool = secretTools(host as never).find((tool) => tool.name === 'secret_fetch')!
    const bot =
      kind === 'ordinary thread'
        ? undefined
        : {
            role: 'activation',
            workspace: { scratch: '/run' },
            ...(kind === 'read only' ? { secretFetch: record } : {})
          }
    const turn = appTurn({
      threadId: 't',
      runId: 'r',
      bot: bot as never,
      ...(kind === 'read only' ? { modeFacts: { readOnly: true, agent: false, build: false } } : {})
    })
    const outcome = await tool.handler({ secret: 'KEY', path: '/v1/models' }, {
      turn,
      transport: 'in_process',
      toolCallId: 'call',
      signal: new AbortController().signal
    } as ToolCallContext)
    expect(outcome.isError).toBe(true)
    if (kind === 'read only') expect(outcome.text).toContain('read-only')
    else {
      expect(outcome.text).toContain('only to bots, in their chat, work and scheduled runs')
      expect(outcome.text).not.toContain('Hand')
    }
    expect(record).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  }
)
