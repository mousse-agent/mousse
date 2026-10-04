import { useEffect, useId, useRef, useState } from 'react'
import { X } from '../../lib/icons'
import { useChatsStore } from '../../stores/chatsStore'
import { useAppStore } from '../../stores/appStore'
import { ChatAvatar } from './ChatsSidebar'

export function NewChatDialog() {
  const snapshot = useChatsStore((s) => s.snapshot)
  const create = useChatsStore((s) => s.create)
  const loading = useChatsStore((s) => s.loading)
  const error = useChatsStore((s) => s.error)
  const projects = useAppStore((s) => s.projects)
  const initialKind = useChatsStore((s) => s.newChatKind)
  const [kind, setKind] = useState<'direct' | 'group'>(initialKind)
  const [selected, setSelected] = useState<string[]>([])
  const [name, setName] = useState('')
  const [projectId, setProjectId] = useState('')
  const titleId = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const close = () => useChatsStore.setState({ newChatOpen: false })
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLElement>('button')?.focus()
    return () => prior?.focus()
  }, [])
  return <div className="chat-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !loading) close() }}>
    <div ref={dialog} className="chat-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={(event) => {
      if (event.key === 'Escape' && !loading) close()
      if (event.key === 'Tab') {
        const items = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select')
        if (!items?.length) return
        const first = items[0], last = items[items.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }}>
      <div className="chat-dialog-heading"><h2 id={titleId}>New chat</h2><button aria-label="Close new chat" disabled={loading} onClick={close}><X size={16} /></button></div>
      <form onSubmit={(event) => { event.preventDefault(); void create({ kind, agentIds: selected, ...(kind === 'group' ? { name: name.trim() } : {}), ...(kind === 'group' && projectId ? { projectId } : {}) }) }}>
        <div className="chat-kind-switch"><button type="button" aria-pressed={kind === 'direct'} onClick={() => { setKind('direct'); setSelected(selected.slice(0, 1)) }}>Agent DM</button><button type="button" aria-pressed={kind === 'group'} onClick={() => setKind('group')}>Group</button></div>
        {kind === 'group' && <label>Group name<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="billing-launch" /></label>}
        {kind === 'group' && <label>Project (optional)<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">No project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
        <fieldset><legend>{kind === 'direct' ? 'Choose an agent' : 'Choose agents'}</legend>{snapshot.agents.map((agent) => <label key={agent.id} className="chat-agent-choice"><input type={kind === 'direct' ? 'radio' : 'checkbox'} name="agent" checked={selected.includes(agent.id)} disabled={!agent.available} onChange={(event) => setSelected(kind === 'direct' ? [agent.id] : event.target.checked ? [...selected, agent.id] : selected.filter((id) => id !== agent.id))} /><ChatAvatar name={agent.name} small /><span>{agent.name}<small>@{agent.slug} · {snapshot.devices.find((device) => device.id === agent.deviceId)?.name || 'This device'}</small></span></label>)}</fieldset>
        {!snapshot.agents.length && <p>Create and publish an agent in Automations first.</p>}
        {error && <p role="alert" className="chat-error">{error}</p>}
        <button className="chat-primary-button" type="submit" disabled={loading || selected.length < (kind === 'group' ? 2 : 1) || (kind === 'group' && !name.trim())}>{loading ? 'Creating…' : 'Create chat'}</button>
      </form>
    </div>
  </div>
}
