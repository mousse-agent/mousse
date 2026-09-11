import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkflowExecutionClient } from '../src/renderer/services/workflowExecutionClient'
import type { WorkflowRunRequester, WorkflowRunView } from '../src/shared/workflowRunPlatform'

const query = { profileId: 'profile', runId: 'run' }
function view(sequence = 1, state: WorkflowRunView['state'] = 'running'): WorkflowRunView {
  return { ...query, definitionId: 'definition', state, origin: 'host', journalSequence: sequence, events: [], attempts: [], artifacts: [] }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}
afterEach(() => { vi.useRealTimers() })

describe('desktop workflow execution client transport contract', () => {
  it('preserves a caller request identity after transport failure and rejects foreign responses', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValueOnce(view())
    const client = createWorkflowExecutionClient({ request } as WorkflowRunRequester)
    const start = { profileId: query.profileId, definitionId: 'definition', input: {}, requestId: 'same-request' }
    await expect(client.start(start)).rejects.toThrow('Disconnected')
    await client.start(start)
    expect(request.mock.calls.map((call) => call[1].requestId)).toEqual(['same-request', 'same-request'])
    request.mockResolvedValueOnce({ ...view(), profileId: 'other' })
    await expect(client.get(query)).rejects.toThrow('does not match')
    request.mockResolvedValueOnce({ ...view(), origin: 'fixture' })
    await expect(client.get(query)).rejects.toThrow('does not match')
  })

  it('keeps a newer control result when an older poll completes afterwards', async () => {
    const oldPoll = deferred<WorkflowRunView>()
    const request = vi.fn().mockReturnValueOnce(oldPoll.promise).mockResolvedValueOnce(view(9, 'cancelled'))
    const client = createWorkflowExecutionClient({ request } as WorkflowRunRequester)
    const pending = client.get(query)
    expect((await client.cancel(query)).state).toBe('cancelled')
    oldPoll.resolve(view(5))
    expect((await pending).state).toBe('cancelled')
  })

  it('reports a polling failure, retries without overlap, and stops after a terminal result', async () => {
    vi.useFakeTimers()
    const pending = deferred<WorkflowRunView>()
    const request = vi.fn().mockRejectedValueOnce(new Error('Lost connection')).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(view(3, 'succeeded'))
    const client = createWorkflowExecutionClient({ request } as WorkflowRunRequester)
    const listener = vi.fn(), onError = vi.fn()
    const handle = client.subscribe(query, listener, onError)
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Lost connection' }))
    await vi.advanceTimersByTimeAsync(5000)
    expect(request).toHaveBeenCalledTimes(2)
    pending.resolve(view(2))
    await vi.advanceTimersByTimeAsync(1000)
    expect(listener.mock.calls.map((call) => call[0].state)).toEqual(['running', 'succeeded'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(request).toHaveBeenCalledTimes(3)
    handle.unsubscribe()
  })

  it('ignores a late response after unsubscribe', async () => {
    vi.useFakeTimers()
    const pending = deferred<WorkflowRunView>()
    const request = vi.fn().mockReturnValue(pending.promise)
    const client = createWorkflowExecutionClient({ request } as WorkflowRunRequester)
    const listener = vi.fn(), onError = vi.fn()
    const handle = client.subscribe(query, listener, onError)
    handle.unsubscribe(); pending.resolve(view())
    await vi.advanceTimersByTimeAsync(5000)
    expect(listener).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(1)
  })
})
