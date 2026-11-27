/**
 * `task_create` keeps a receipt per request key (docs/plans/tool-api.md §1.1, Retry): a retry gets the first answer, other
 * arguments under the same key are refused, and the key is scoped by the caller's run.
 */
import { describe, expect, it } from 'vitest'
import { taskTools } from '../../src/mms/run/mcp/appTools/tasks'
import type { AppToolHost } from '../../src/mms/run/mcp/appTools/host'
import type { ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'

function setup() {
  const queue = new TaskQueue()
  const create = taskTools({ tasks: () => queue } as unknown as AppToolHost).find((tool) => tool.name === 'task_create')!
  const call = (args: Record<string, unknown>, at: { runId: string; toolCallId: string }) =>
    Promise.resolve(create.handler(args, { caller: { threadId: 'thread-a', runId: at.runId }, turn: { threadId: 'thread-a' }, toolCallId: at.toolCallId, transport: 'mcp' } as unknown as ToolCallContext))
  return { queue, call }
}

describe('task_create under a request key', () => {
  it('refuses other arguments under the same key', async () => {
    const { queue, call } = setup()
    await call({ description: 'Check the build' }, { runId: 'run-1', toolCallId: 'mcp:retry-1' })
    await expect(call({ description: 'Write the notes' }, { runId: 'run-1', toolCallId: 'mcp:retry-1' })).rejects.toMatchObject({ details: { conflict: 'client_request_id_conflict' } })
    expect(queue.list().map((task) => task.description)).toEqual(['Check the build'])
  })

  it('replays the first answer after the task has changed', async () => {
    const { queue, call } = setup()
    const first = await call({ description: 'Check the build' }, { runId: 'run-1', toolCallId: 'mcp:retry-1' })
    queue.update(queue.list()[0].id, { status: 'completed' })
    const retried = await call({ description: 'Check the build' }, { runId: 'run-1', toolCallId: 'mcp:retry-1' })
    expect(retried).toEqual(first)
    expect(JSON.parse(retried.text).status).toBe('pending')
  })

  it('makes a new task when another run reuses a provider call id', async () => {
    const { queue, call } = setup()
    await call({ description: 'Check the build' }, { runId: 'run-1', toolCallId: 'mcp:call_0' })
    await call({ description: 'Check the build' }, { runId: 'run-2', toolCallId: 'mcp:call_0' })
    expect(queue.list()).toHaveLength(2)
  })
})
