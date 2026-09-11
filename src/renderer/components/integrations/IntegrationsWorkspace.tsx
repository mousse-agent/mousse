import { Link2, Plus, RefreshCw, Search, Shield, Sparkles, Upload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { IntegrationPlatformClient, IntegrationPlatformSnapshot } from '../../../shared/integrationPlatform'
import type { McpServerConfig, SkillDescriptor } from '../../../shared/integrations'
import { asError, isManagedSource, scopeLabel, snapshotItems } from './integrationUi'
import { AddSkillDialog, SkillEditorDialog, type TestSkill } from './SkillDialogs'
import { McpConnectionDialog } from './McpConnectionDialog'
import './integrations.css'

export interface IntegrationsWorkspaceProps {
  client: IntegrationPlatformClient
  profileId: string
  projectId?: string
  projects?: Array<{ id: string; name: string }>
  initialTab?: 'skills' | 'mcp'
  onTestSkill?: TestSkill
}
type Dialog = { kind: 'skill-create' | 'skill-upload' | 'mcp-create' } | { kind: 'skill-edit' | 'mcp-edit'; id: string } | null

/** Key personal data before rendering so profile switches never show stale rows. */
export function IntegrationsWorkspace(props: IntegrationsWorkspaceProps) {
  return <ScopedWorkspace key={`${props.profileId}:${props.projectId ?? ''}:${props.initialTab ?? 'skills'}`} {...props} />
}

function ScopedWorkspace({ client, profileId, projectId, projects = [], initialTab = 'skills', onTestSkill }: IntegrationsWorkspaceProps) {
  const [tab, setTab] = useState(initialTab)
  const [snapshot, setSnapshot] = useState<IntegrationPlatformSnapshot | null>(null)
  const [loading, setLoading] = useState(true), [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null), [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)
  const generation = useRef(0)
  const scope = projectId ? 'project' : 'global'
  const load = useCallback(async (refresh = false) => {
    const current = ++generation.current
    setLoading(!refresh); setRefreshing(refresh); setError(null)
    try {
      const result = await client.snapshot({ profileId, projectId, refresh })
      if (current === generation.current) setSnapshot(result)
    } catch (cause) { if (current === generation.current) setError(asError(cause)) }
    finally { if (current === generation.current) { setLoading(false); setRefreshing(false) } }
  }, [client, profileId, projectId])
  useEffect(() => { void load(); return () => { generation.current += 1 } }, [load])
  const items = snapshotItems(snapshot), normalized = query.trim().toLowerCase()
  const skills = items.skills.filter((skill) => !normalized || `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(normalized))
  const servers = items.servers.filter((server) => !normalized || `${server.name} ${server.transport} ${server.source}`.toLowerCase().includes(normalized))
  const selectedSkill = dialog?.kind === 'skill-edit' ? items.skills.find((skill) => (skill.installationId ?? skill.id) === dialog.id) : undefined
  const selectedMcp = dialog?.kind === 'mcp-edit' ? items.servers.find((server) => (server.installationId ?? server.id) === dialog.id) : undefined
  const close = () => setDialog(null)
  const saved = () => { close(); void load(true) }
  const common = { client, profileId, projectId, onClose: close, onSaved: saved }
  return <div className="integrations-root" data-integrations-workspace="" data-profile-id={profileId} data-project-id={projectId ?? ''}>
    <header className="integrations-header">
      <div><h1>Integrations</h1><p>Skills and MCP connections for {projectId ? 'this project in this profile' : 'this profile'}.</p></div>
      <div className="integrations-header__actions">
        <button type="button" className="btn btn-sm" data-action="refresh-integrations" disabled={loading || refreshing || Boolean(dialog)} onClick={() => void load(true)}><RefreshCw size={14} /> Refresh</button>
        {tab === 'skills' ? <>
          <button type="button" className="btn" data-action="upload-skill" onClick={() => setDialog({ kind: 'skill-upload' })}><Upload size={14} /> Upload</button>
          <button type="button" className="btn btn-primary" data-action="add-skill" onClick={() => setDialog({ kind: 'skill-create' })}><Plus size={14} /> Add skill</button>
        </> : <button type="button" className="btn btn-primary" data-action="add-mcp" onClick={() => setDialog({ kind: 'mcp-create' })}><Plus size={14} /> Add MCP connection</button>}
      </div>
    </header>
    <nav className="integrations-tabs" role="tablist" aria-label="Integration type">
      {(['skills', 'mcp'] as const).map((value) => <button type="button" role="tab" key={value} id={`integration-tab-${value}`} aria-controls={`integration-panel-${tab}`} tabIndex={value === tab ? 0 : -1} className={value === tab ? 'active' : ''} aria-selected={value === tab} onClick={() => { setTab(value); setQuery('') }} onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const next = event.key === 'Home' ? 'skills' : event.key === 'End' ? 'mcp' : tab === 'skills' ? 'mcp' : 'skills'
        setTab(next); setQuery('')
        document.getElementById(`integration-tab-${next}`)?.focus()
      }}>{value === 'skills' ? 'Skills' : 'MCP connections'} <span>{value === 'skills' ? items.skills.length : items.servers.length}</span></button>)}
    </nav>
    <div className="integrations-toolbar"><label className="integrations-search"><Search size={15} /><input aria-label={`Search ${tab}`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${tab === 'skills' ? 'skills' : 'connections'}`} /></label><span className="integrations-scope"><Shield size={14} /> {scopeLabel(scope, projects.find((item) => item.id === projectId)?.name)}</span></div>
    {error ? <div className="integrations-banner integrations-banner--error" role="alert">{error}<button type="button" className="btn btn-sm" onClick={() => void load(true)}>Try again</button></div> : null}
    <div role="tabpanel" id={`integration-panel-${tab}`} aria-labelledby={`integration-tab-${tab}`}>
      {loading ? <div className="integrations-state" role="status">Loading integrations…</div> : normalized && !(tab === 'skills' ? skills : servers).length ? <div className="integrations-state">No matches for “{query}”.</div> : tab === 'skills'
        ? <SkillList skills={skills} onAdd={() => setDialog({ kind: 'skill-create' })} onUpload={() => setDialog({ kind: 'skill-upload' })} onEdit={(id) => setDialog({ kind: 'skill-edit', id })} />
        : <McpList servers={servers} onAdd={() => setDialog({ kind: 'mcp-create' })} onEdit={(id) => setDialog({ kind: 'mcp-edit', id })} />}
    </div>
    {dialog?.kind === 'skill-create' || dialog?.kind === 'skill-upload' ? <AddSkillDialog {...common} scope={scope} initialMode={dialog.kind === 'skill-upload' ? 'upload' : 'create'} /> : null}
    {selectedSkill ? <SkillEditorDialog key={selectedSkill.installationId ?? selectedSkill.id} {...common} skill={selectedSkill} onTestSkill={onTestSkill} /> : null}
    {dialog?.kind === 'mcp-create' || selectedMcp ? <McpConnectionDialog key={selectedMcp?.installationId ?? 'new'} {...common} scope={scope} server={selectedMcp} /> : null}
  </div>
}

function SkillList({ skills, onAdd, onUpload, onEdit }: { skills: SkillDescriptor[]; onAdd: () => void; onUpload: () => void; onEdit: (id: string) => void }) {
  if (!skills.length) return <div className="integrations-empty"><h2>No skills yet</h2><p>Create a skill or upload a package to give agents reusable instructions.</p><div className="integrations-empty__actions"><button type="button" className="btn btn-primary" data-action="empty-add-skill" onClick={onAdd}>Add skill</button><button type="button" className="btn" onClick={onUpload}>Upload SKILL.md</button></div></div>
  return <div className="integration-cards" data-skill-list="">{skills.map((skill) => {
    const id = skill.installationId ?? skill.id, managed = isManagedSource(skill.source)
    return <article className="integration-card" key={id} data-skill-card={id}>
      <div className="integration-card__icon"><Sparkles size={19} /></div>
      <div className="integration-card__main"><div className="integration-card__title"><h2>{skill.name}</h2><span className={`integration-badge ${skill.enabled === false || skill.archived ? 'muted' : 'ok'}`}>{skill.archived ? 'Archived' : skill.enabled === false ? 'Disabled' : 'Enabled'}</span></div>
        <p>{skill.description || 'No description provided.'}</p><div className="integration-meta"><span>{scopeLabel(skill.scope)}</span><span>{managed ? 'Managed' : `External · ${skill.source}`}</span>{skill.revision ? <span>Revision {skill.revision.slice(0, 10)}</span> : null}{skill.hasScripts ? <span>Scripts</span> : null}{skill.hasAssets ? <span>Assets</span> : null}</div>
        {skill.diagnostics?.length ? <p className="integration-diagnostic">{skill.diagnostics[0].message}</p> : null}
      </div><div className="integration-card__actions">{managed ? <button type="button" className="btn btn-sm" onClick={() => onEdit(id)}>Edit</button> : <span className="integration-readonly">External discovery</span>}</div>
    </article>
  })}</div>
}

function McpList({ servers, onAdd, onEdit }: { servers: McpServerConfig[]; onAdd: () => void; onEdit: (id: string) => void }) {
  if (!servers.length) return <div className="integrations-empty"><h2>No MCP connections yet</h2><p>Connect a local stdio server or a remote Streamable HTTP/SSE endpoint.</p><button type="button" className="btn btn-primary" data-action="empty-add-mcp" onClick={onAdd}>Add MCP connection</button></div>
  return <div className="integration-cards" data-mcp-list="">{servers.map((server) => {
    const id = server.installationId ?? server.id, managed = isManagedSource(server.source)
    return <article className="integration-card" key={id} data-mcp-card={id}>
      <div className="integration-card__icon"><Link2 size={19} /></div>
      <div className="integration-card__main"><div className="integration-card__title"><h2>{server.name}</h2><span className={`integration-badge ${server.status === 'connected' ? 'ok' : server.status === 'error' || server.status === 'failed' ? 'bad' : 'muted'}`}>{server.status}</span></div>
        <p>{server.transport === 'stdio' ? server.command ?? 'Executable' : server.url ?? 'No endpoint'}</p><div className="integration-meta"><span>{scopeLabel(server.scope)}</span><span>{managed ? 'Managed' : `External · ${server.source}`}</span>{server.enabled === false ? <span>Disabled</span> : null}{server.authMode && server.authMode !== 'anonymous' ? <span>{server.authMode === 'oauth' ? 'OAuth' : 'Secret-backed auth'}</span> : null}</div>
        {server.diagnostics?.length ? <p className="integration-diagnostic">{server.diagnostics[0].message}</p> : null}
      </div><div className="integration-card__actions">{managed ? <button type="button" className="btn btn-sm" onClick={() => onEdit(id)}>Edit</button> : <span className="integration-readonly">Read-only discovery</span>}</div>
    </article>
  })}</div>
}
