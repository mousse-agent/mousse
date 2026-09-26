import { createRoot } from 'react-dom/client'
import { ThreadChangeControls } from '../../src/renderer/components/ThreadChangeControls'

const threadId = new URLSearchParams(location.search).get('threadId')!
async function rpc(method: string, params: Record<string, unknown>) {
  const response = await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  return result
}
// Browser-only transport bridge to a real authenticated LocalMmsClient. No action/status responses are mocked.
window.mousse = {
  actions: {
    list: (id: string) => rpc('actions.list', { threadId: id }),
    undoLatest: (id: string, expectedJournalRevision: number) => rpc('actions.undoLatest', { threadId: id, expectedJournalRevision }),
    redo: (id: string, expectedJournalRevision: number) => rpc('actions.redo', { threadId: id, expectedJournalRevision })
  },
  workspace: { getStatus: (id: string) => rpc('workspace.getStatus', { threadId: id }) }
} as unknown as typeof window.mousse

createRoot(document.getElementById('root')!).render(<ThreadChangeControls threadId={threadId} busy={false} revision={0} />)
