import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEpisode, AgentEpisodeState, AgentWorkspacePolicy, NamedAgentIdentity, NamedAgentIntegrationReview } from '../../shared/agentEpisodes'
import type { LlmProviderOption } from '../../shared/settings'
import { ModelFamilyMenu } from './ModelFamilyMenu'
import { ModelFamilySettingsFields } from './ModelFamilySettingsFields'

const empty: AgentEpisodeState = { schemaVersion: 1, identities: [], episodes: [] }

export function NamedAgents({ threadId }: { threadId: string | null }) {
  const [state, setState] = useState(empty)
  const [selected, setSelected] = useState<string>()
  const [name, setName] = useState('')
  const [task, setTask] = useState('')
  const [workspace, setWorkspace] = useState<AgentWorkspacePolicy['workspace']>('shared')
  const [access, setAccess] = useState<AgentWorkspacePolicy['access']>('read-only')
  const [contextMode, setContextMode] = useState<'continue' | 'fresh'>('continue')
  const [resumeResult, setResumeResult] = useState(false)
  const [providers, setProviders] = useState<LlmProviderOption[]>([])
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [modelMenu, setModelMenu] = useState(false)
  const modelAnchor = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [integration, setIntegration] = useState<{ episode: AgentEpisode; review: NamedAgentIntegrationReview }>()
  const revision = useRef(0)
  const reload = useCallback(async () => {
    if (!threadId) return
    const request = ++revision.current
    const value = await window.mousse.agents.listNamed(threadId)
    if (revision.current === request) setState(value)
  }, [threadId])
  useEffect(() => {
    setState(empty); setSelected(undefined); setIntegration(undefined); setError('')
    void reload().catch((error) => setError(String(error)))
    const off = window.mousse.agents.onUpdated(() => { void reload().catch((error) => setError(String(error))) })
    return () => { revision.current++; off() }
  }, [reload])
  useEffect(() => {
    if (!state.episodes.some((episode) => ['queued', 'running'].includes(episode.state))) return
    const timer = setInterval(() => { void reload().catch((error) => setError(String(error))) }, 3000)
    return () => clearInterval(timer)
  }, [state.episodes, reload])
  useEffect(() => {
    let cancelled = false
    void Promise.all([window.mousse.settings.getOptions(), window.mousse.settings.get()]).then(([options, settings]) => {
      if (!cancelled) { setProviders(options.llmProviders); setProvider(settings.provider.llmProvider); setModel(settings.provider.model) }
    }).catch((error) => { if (!cancelled) setError(String(error)) })
    return () => { cancelled = true }
  }, [])
  const identity = state.identities.find((entry) => entry.id === selected)
  const episodes = state.episodes.filter((entry) => entry.agentId === selected).slice().reverse()
  const choose = (agent?: NamedAgentIdentity) => {
    setSelected(agent?.id); setTask(''); setIntegration(undefined); setError(''); setContextMode('continue'); setResumeResult(false)
    const last = state.episodes.find((entry) => entry.id === agent?.lastEpisodeId)
    setWorkspace(last?.policy.workspace ?? 'shared'); setAccess(last?.policy.access ?? 'read-only')
    if (last?.assignment?.provider) setProvider(last.assignment.provider)
    if (last?.assignment?.model) setModel(last.assignment.model)
  }
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await work(); await reload() } catch (error) { setError(String(error)) } finally { setBusy(false) }
  }
  if (!threadId) return <p className="terminal-empty-hint">Select a project task to create a named agent.</p>
  return <section aria-label="Named agents" style={{ overflow: 'auto', padding: 20, width: '100%', height: '100%' }}>
    <h2>Named agents</h2>
    <p>Recall an agent by name with its saved conversation. Each request records its workspace, access and result separately.</p>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBlock: 12 }}>
      <button className="btn" disabled={busy} onClick={() => choose()}>New agent</button>
      {state.identities.filter((agent) => agent.state !== 'retired').map((agent) => <button className="btn" key={agent.id} aria-pressed={selected === agent.id} disabled={busy} onClick={() => choose(agent)}>{agent.name} · {agent.activeEpisodeId ? 'working' : agent.state}</button>)}
      <button className="btn" disabled={busy} onClick={() => void run(reload)}>Refresh</button>
    </div>
    {error && <p role="alert">{error}</p>}
    <form onSubmit={(event) => {
      event.preventDefault()
      void run(async () => {
        const request = { operationId: crypto.randomUUID(), task: task.trim(), workspace, access, provider: provider || undefined, model: model || undefined }
        const result = identity ? await window.mousse.agents.recallNamed(threadId, { ...request, agent: identity.id, expectedAgentGeneration: identity.contextGeneration, contextMode, resumeResult }) : await window.mousse.agents.createNamed(threadId, { ...request, name: name.trim() })
        setSelected(result.agent.id); setTask('')
      })
    }}>
      <fieldset disabled={busy || Boolean(identity?.activeEpisodeId)} style={{ border: 0, padding: 0, display: 'grid', gap: 12, maxWidth: 760 }}>
        {identity ? <h3>Recall {identity.name}</h3> : <label>Name <input className="input" aria-label="Agent name" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>}
        <label>Request <textarea className="input" aria-label="Agent request" required rows={3} value={task} onChange={(event) => setTask(event.target.value)} style={{ display: 'block', width: '100%' }} /></label>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label>Workspace <select aria-label="Agent workspace" value={workspace} onChange={(event) => { setWorkspace(event.target.value as AgentWorkspacePolicy['workspace']); setResumeResult(false) }}><option value="shared">Shared task workspace</option><option value="isolated">Isolated snapshot</option></select></label>
          <label>Access <select aria-label="Agent access" value={access} onChange={(event) => setAccess(event.target.value as AgentWorkspacePolicy['access'])}><option value="read-only">Read only</option><option value="write">Write</option></select></label>
        </div>
        <small>{workspace === 'shared' ? 'Shared readers observe a moving workspace. A shared writer waits for exclusive task ownership.' : 'An isolated agent starts from a pinned snapshot. Its changes require a separate integration into this task.'}</small>
        <div>
          <button className="btn" type="button" ref={modelAnchor} aria-haspopup="listbox" aria-expanded={modelMenu} onClick={() => setModelMenu(!modelMenu)}>{provider && model ? `${provider} · ${model}` : 'Use configured model'}</button>
          {modelMenu && <ModelFamilyMenu providers={providers} selectedProviderId={provider} selectedModelId={model} anchorRef={modelAnchor} onSelect={(nextProvider, nextModel) => { setProvider(nextProvider); setModel(nextModel); setModelMenu(false) }} />}
          {provider && model && <ModelFamilySettingsFields providerId={provider} modelId={model} models={providers.find((entry) => entry.id === provider)?.models ?? []} onChange={setModel} />}
        </div>
        {identity && <>
          <label>Conversation <select aria-label="Recall context" value={contextMode} onChange={(event) => setContextMode(event.target.value as 'continue' | 'fresh')}><option value="continue">Continue saved context</option><option value="fresh">Start fresh context</option></select></label>
          <small>Choose fresh context when changing to a different model or provider.</small>
          {workspace === 'isolated' && episodes[0]?.policy.workspace === 'isolated' && <label><input type="checkbox" checked={resumeResult} onChange={(event) => setResumeResult(event.target.checked)} /> Resume this agent’s previous isolated result</label>}
        </>}
        <button className="btn btn-primary" type="submit" disabled={!task.trim() || !identity && !name.trim()}>{identity ? 'Recall agent' : 'Create and start agent'}</button>
      </fieldset>
    </form>
    {identity?.activeEpisodeId && <div><p role="status">This agent is working. Its next request becomes available after the current episode settles.</p><button className="btn" disabled={busy} onClick={() => void run(() => window.mousse.agents.stop(identity.id, threadId))}>Stop and retain context</button></div>}
    {episodes.length > 0 && <h3>Request history</h3>}
    {episodes.map((episode) => {
      const integrated = state.integrations?.some((entry) => entry.episodeId === episode.id)
      const canIntegrate = episode.policy.workspace === 'isolated' && episode.policy.access === 'write' && episode.result?.resultSha && ['completed', 'failed', 'interrupted'].includes(episode.state) && !integrated
      return <article key={episode.id} style={{ borderTop: '1px solid var(--border-color)', paddingBlock: 12 }}>
        <strong>{episode.state}</strong> · {episode.policy.workspace} · {episode.policy.access}{integrated && ' · integrated'}
        <p>{episode.task}</p>
        {episode.result?.reason && <p>{episode.result.reason}</p>}
        <small>{episode.assignment?.provider} {episode.assignment?.model}{episode.result?.resultSha && ` · Result ${episode.result.resultSha.slice(0, 12)}`}</small>
        {canIntegrate && <div><button className="btn" disabled={busy || Boolean(identity?.activeEpisodeId)} onClick={() => void run(async () => {
          const review = await window.mousse.agents.reviewNamed(threadId, episode.agentId, episode.id)
          setIntegration({ episode, review })
        })}>Review integration</button></div>}
      </article>
    })}
    {integration && <div role="dialog" aria-label="Integrate isolated result" style={{ border: '1px solid var(--border-color)', padding: 16 }}>
      <h3>Integrate isolated result</h3>
      <p>Apply result {integration.review.resultSha.slice(0, 12)} to task revision {integration.review.destinationSha.slice(0, 12)}. Conflicts retain the result for recovery. Repository Undo does not reverse external actions.</p>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{integration.review.summary || 'No repository changes'}</pre>
      <details><summary>Review changes</summary><pre style={{ overflow: 'auto', maxHeight: 400 }}>{integration.review.diff || 'No changes'}</pre></details>
      <button className="btn" disabled={busy} onClick={() => setIntegration(undefined)}>Cancel</button>{' '}
      <button className="btn btn-primary" disabled={busy} onClick={() => void run(async () => {
        await window.mousse.agents.integrateNamed(threadId, { agent: integration.episode.agentId, episodeId: integration.episode.id, operationId: crypto.randomUUID(), expectedResultSha: integration.review.resultSha, expectedDestinationSha: integration.review.destinationSha })
        setIntegration(undefined)
      })}>Integrate result</button>
    </div>}
  </section>
}
