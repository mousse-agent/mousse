/**
 * `question_ask`'s `wait` argument and `question_withdraw` at the tool (issue #1372): a call that does not wait hands the
 * question to the host's open-question call and returns its id at once; one that waits keeps the blocking call. The
 * path from the host into the Run Engine is covered end to end in `openQuestions.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import { askUserTools } from '../../src/mms/run/mcp/appTools/askUser'
import type { AppToolHost } from '../../src/mms/run/mcp/appTools/host'
import type { ToolCallContext } from '../../src/mms/run/mcp/appTools/types'

const QUESTIONS = [{ id: 'colour', prompt: 'Which colour?', options: [{ id: 'blue', label: 'Blue' }, { id: 'green', label: 'Green' }] }]

function tools() {
  const host = {
    askUser: vi.fn(async () => ({ colour: 'blue' })),
    askWithoutWaiting: vi.fn(() => 'q_1'),
    withdrawQuestion: vi.fn((threadId: string, id: string) => threadId === 'thread-1' && id === 'q_1')
  }
  const [ask, withdraw] = askUserTools(host as unknown as AppToolHost)
  const ctx = { transport: 'mcp', caller: { threadId: 'thread-1', runId: 'run-1', provider: 'test', modeCeiling: 'default', accessLevel: 'manage' }, signal: new AbortController().signal } as unknown as ToolCallContext
  return { host, ask: (args: Record<string, unknown>) => ask!.handler(args, ctx), withdraw: (args: Record<string, unknown>) => withdraw!.handler(args, ctx), names: [ask!.name, withdraw!.name] }
}

describe('question_ask without waiting', () => {
  it('returns the open question\'s id at once and never waits for the answer', async () => {
    const t = tools()
    const result = await t.ask({ questions: QUESTIONS, wait: false })
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.text)).toMatchObject({ questionId: 'q_1', status: 'open' })
    expect(t.host.askWithoutWaiting).toHaveBeenCalledWith('thread-1', [expect.objectContaining({ id: 'colour' })], 'run-1')
    expect(t.host.askUser).not.toHaveBeenCalled()
  })

  it('waits by default, as before', async () => {
    const t = tools()
    const result = await t.ask({ questions: QUESTIONS })
    expect(JSON.parse(result.text)).toEqual({ colour: 'blue' })
    expect(t.host.askWithoutWaiting).not.toHaveBeenCalled()
  })

  it('question_withdraw takes back an open question of the caller\'s thread, and says when there is none', async () => {
    const t = tools()
    expect(t.names).toEqual(['question_ask', 'question_withdraw'])
    expect(await t.withdraw({ questionId: 'q_1' })).toMatchObject({ isError: false })
    expect(await t.withdraw({ questionId: 'q_2' })).toMatchObject({ isError: true, text: expect.stringContaining('not open in this thread') })
    expect(await t.withdraw({})).toMatchObject({ isError: true })
  })
})
