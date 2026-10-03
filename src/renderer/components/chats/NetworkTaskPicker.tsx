import { useEffect, useState } from 'react'
import type { ChatTaskDispatchResult, ChatTaskSelection, ChatTaskSelectionInput } from '../../../shared/chatsNetwork'
import { newId, type NodeId } from '../../../shared/net'

export function NetworkTaskPicker({ chatId, readonly }: { chatId: string; readonly: boolean }) {
  const [devices, setDevices] = useState<Array<{ node: NodeId; name: string; self: boolean; revoked: boolean; caps: string[]; state: string }>>([])
  const [device, setDevice] = useState<NodeId>(), [repo, setRepo] = useState(''), [commit, setCommit] = useState(''), [agent, setAgent] = useState(''), [prompt, setPrompt] = useState('')
  const [prepared, setPrepared] = useState<ChatTaskSelectionInput>(), [selection, setSelection] = useState<ChatTaskSelection>(), [result, setResult] = useState<ChatTaskDispatchResult>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.mousse.platformRequest.request<{ nodes: typeof devices }>('bridge.nodes', {}).then(value => {
      if (active) setDevices(value.nodes.filter(node => !node.self && !node.revoked && node.caps.includes('write')))
    }, cause => { if (active) setError(String(cause?.message ?? cause)) })
    return () => { active = false }
  }, [chatId])
  const prepare = async () => {
    if (!device) return
    const input = prepared ?? { chatId, taskId: newId('rpc'), deviceId: device, input: { repoId: repo.trim(), baseCommit: commit.trim(), agent: agent.trim(), prompt, limits: { maxTurns: 4, maxToolCalls: 16, maxElapsedMs: 300000 } } }
    setPrepared(input); setBusy(true); setError('')
    try { setSelection(await window.mousse.platformRequest.request<ChatTaskSelection>('chats.assignDevice', input)) }
    catch (cause) { setError(String((cause as Error)?.message ?? cause)) }
    finally { setBusy(false) }
  }
  const dispatch = async () => {
    if (!prepared) return
    setBusy(true); setError('')
    try {
      const value = await window.mousse.platformRequest.request<ChatTaskDispatchResult>('chats.dispatch', { chatId, taskId: prepared.taskId })
      setSelection(value.selection); setResult(value)
    } catch (cause) { setError(String((cause as Error)?.message ?? cause)) }
    finally { setBusy(false) }
  }
  return <details className="chat-network-task"><summary>Run a task on my device</summary>
    <p>The selected device checks its repository and agent before starting. Limits: 4 turns, 16 tool calls, 5 minutes.</p>
    <fieldset disabled={busy || readonly || !!prepared}>
      <label>Device<select aria-label="Task device" value={device ?? ''} onChange={e => setDevice(e.target.value as NodeId)}><option value="">Select a device</option>{devices.map(node => <option key={node.node} value={node.node}>{node.name} · {node.state === 'open' ? 'Online' : 'Offline'}</option>)}</select></label>
      <label>Authorized repository ID<input value={repo} onChange={e => setRepo(e.target.value)} /></label>
      <label>Base commit<input value={commit} onChange={e => setCommit(e.target.value)} /></label>
      <label>Published agent ID on that device<input value={agent} onChange={e => setAgent(e.target.value)} /></label>
      <label>Task<textarea value={prompt} onChange={e => setPrompt(e.target.value)} /></label>
    </fieldset>
    {error && <p role="alert" className="chat-error">{error}</p>}
    {selection && <p role="status">{selection.validation === 'authorized' ? 'Verified result' : selection.validation === 'rejected' ? 'Rejected' : 'Awaiting target validation'} · {selection.status.state}</p>}
    {!result && <button type="button" disabled={busy || readonly || !device || !repo.trim() || !commit.trim() || !agent.trim() || !prompt.trim()} onClick={() => void prepare()}>{prepared ? 'Check original selection' : 'Prepare task'}</button>}
    {selection && selection.status.state !== 'failed' && <button type="button" disabled={busy || readonly || !!result} onClick={() => void dispatch()}>{selection.status.state === 'prepared' ? 'Start task on selected device' : 'Retrieve original result'}</button>}
    {result && <p>Completed on {devices.find(node => node.node === result.selection.target)?.name ?? result.selection.target} · commit <code>{result.result.headCommit}</code><span>Thread {result.result.threadId}</span></p>}
    {prepared && <p className="chat-network-delivery">Task {prepared.taskId}. Keep this selection while its outcome is being checked.</p>}
  </details>
}
