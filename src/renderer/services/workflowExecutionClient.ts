import type { WorkflowRunListPage, WorkflowRunMethod, WorkflowRunRequester, WorkflowRunView } from '../../shared/workflowRunPlatform'
import type { WorkflowExecutionClient } from '../components/workflows/client'

/** The desktop request bridge has no event subscription API; poll without overlapping requests. */
export function createWorkflowExecutionClient(transport: WorkflowRunRequester): WorkflowExecutionClient {
  const latest = new Map<string, WorkflowRunView>()
  const call = async <T extends { profileId: string; runId?: string }>(method: WorkflowRunMethod, query: T): Promise<WorkflowRunView> => {
    const value = await transport.request<WorkflowRunView>(method, query)
    if (value.profileId !== query.profileId || (query.runId && value.runId !== query.runId) || value.origin !== 'host') throw new Error('Workflow response does not match this profile and run')
    const key = value.profileId + '/' + value.runId
    const previous = latest.get(key)
    if (previous && ((value.journalSequence ?? 0) < (previous.journalSequence ?? 0) || ((value.journalSequence ?? 0) === (previous.journalSequence ?? 0) && (value.updatedAt ?? '') < (previous.updatedAt ?? '')))) return previous
    latest.delete(key); latest.set(key, value)
    if (latest.size > 64) latest.delete(latest.keys().next().value!)
    return value
  }
  return {
    start: (query) => call('workflowRuns.start', query),
    get: (query) => call('workflowRuns.get', query),
    list: async (query) => {
      const page = await transport.request<WorkflowRunListPage>('workflowRuns.list', query)
      if (page.runs.some((run) => run.profileId !== query.profileId || run.origin !== 'host')) throw new Error('Workflow history belongs to a different profile')
      return page.runs
    },
    pause: (query) => call('workflowRuns.pause', query), resume: (query) => call('workflowRuns.resume', query),
    cancel: (query) => call('workflowRuns.cancel', query), approve: (query) => call('workflowRuns.approve', query),
    answer: (query) => call('workflowRuns.answer', query), reconcile: (query) => call('workflowRuns.reconcile', query),
    subscribe(query, listener, onError) {
      let closed = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const poll = async (): Promise<void> => {
        try {
          const snapshot = await call('workflowRuns.get', query)
          if (closed) return
          listener(snapshot)
          if (['succeeded', 'failed', 'cancelled'].includes(snapshot.state)) { closed = true; return }
        } catch (error) {
          if (closed) return
          onError?.(error)
        }
        if (!closed) timer = setTimeout(() => { void poll() }, 1000)
      }
      void poll()
      return { unsubscribe() { closed = true; if (timer) clearTimeout(timer) } }
    }
  }
}
