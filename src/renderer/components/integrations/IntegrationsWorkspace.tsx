import { FileText, Link2, Pencil, Plus, RefreshCw, Search, Shield, Upload } from 'lucide-react'
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
  const [pendingToggle, setPendingToggle] = useState<string | null>(null)
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
  const toggleSkill = async (skill: SkillDescriptor) => {
    const installationId = skill.installationId ?? skill.id
    setPendingToggle(installationId)
    try { await client.enableSkill({ profileId, projectId, installationId, enabled: skill.enabled === false }); await load(true) }
    catch (cause) { setError(asError(cause)) }
    finally { setPendingToggle(null) }
  }
  const toggleMcp = async (server: McpServerConfig) => {
    const installationId = server.installationId ?? server.id
    setPendingToggle(installationId)
    try { await client.enableMcp({ profileId, projectId, installationId, enabled: server.enabled === false }); await load(true) }
    catch (cause) { setError(asError(cause)) }
    finally { setPendingToggle(null) }
  }
  return <div className="integrations-root" data-integrations-workspace="" data-profile-id={profileId} data-project-id={projectId ?? ''}>
    <header className="integrations-header">
      <div><h1>Integrations</h1><p>Skills and MCP connections for {projectId ? 'this project in this profile' : 'this profile'}.</p></div>
      <div className="integrations-header__actions">
        <button type="button" className="btn btn-sm" data-action="refresh-integrations" disabled={loading || refreshing || Boolean(dialog)} onClick={() => void load(true)}><RefreshCw size={14} /> Refresh</button>
        {tab === 'skills' ? <>
          <button type="button" className="btn integration-header-icon" data-action="upload-skill" aria-label="Upload skill" title="Upload skill" onClick={() => setDialog({ kind: 'skill-upload' })}><Upload size={15} /></button>
          <button type="button" className="btn btn-primary" data-action="add-skill" onClick={() => setDialog({ kind: 'skill-create' })}><Plus size={14} /> Add skill</button>
        </> : <button type="button" className="btn btn-primary integration-header-icon" data-action="add-mcp" aria-label="Add MCP connection" title="Add MCP connection" onClick={() => setDialog({ kind: 'mcp-create' })}><Plus size={16} /></button>}
      </div>
    </header>
    <nav className="integrations-tabs" role="tablist" aria-label="Integration type">
      {(['skills', 'mcp'] as const).map((value) => <button type="button" role="tab" key={value} id={`integration-tab-${value}`} aria-controls={`integration-panel-${value}`} tabIndex={value === tab ? 0 : -1} className={value === tab ? 'active' : ''} aria-selected={value === tab} onClick={() => { setTab(value); setQuery('') }} onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const next = event.key === 'Home' ? 'skills' : event.key === 'End' ? 'mcp' : tab === 'skills' ? 'mcp' : 'skills'
        setTab(next); setQuery('')
        document.getElementById(`integration-tab-${next}`)?.focus()
      }}>{value === 'skills' ? 'Skills' : 'MCP'} <span>{value === 'skills' ? items.skills.length : items.servers.length}</span></button>)}
    </nav>
    <div className="integrations-toolbar"><label className="integrations-search"><Search size={15} /><input aria-label={`Search ${tab}`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${tab === 'skills' ? 'skills' : 'MCP connections'}`} /></label><span className="integrations-scope"><Shield size={14} /> {scopeLabel(scope, projects.find((item) => item.id === projectId)?.name)}</span></div>
    {error ? <div className="integrations-banner integrations-banner--error" role="alert">{error}<button type="button" className="btn btn-sm" onClick={() => void load(true)}>Try again</button></div> : null}
    <div className="integrations-catalog" role="tabpanel" id={`integration-panel-${tab}`} aria-labelledby={`integration-tab-${tab}`}>
      {loading ? <div className="integrations-state" role="status">Loading integrations…</div> : normalized && !(tab === 'skills' ? skills : servers).length ? <div className="integrations-state">No matches for “{query}”.</div>
        : tab === 'skills' && !skills.length ? <div className="integrations-empty"><h2>No skills yet</h2><p>Add or upload a reusable skill.</p></div>
          : tab === 'mcp' && !servers.length ? <div className="integrations-empty"><h2>No MCP connections yet</h2><p>Connect an MCP server.</p></div>
            : <IntegrationList skills={tab === 'skills' ? skills : []} servers={tab === 'mcp' ? servers : []} pendingToggle={pendingToggle} onEditSkill={(id) => setDialog({ kind: 'skill-edit', id })} onEditMcp={(id) => setDialog({ kind: 'mcp-edit', id })} onToggleSkill={toggleSkill} onToggleMcp={toggleMcp} />}
    </div>
    {dialog?.kind === 'skill-create' || dialog?.kind === 'skill-upload' ? <AddSkillDialog {...common} scope={scope} initialMode={dialog.kind === 'skill-upload' ? 'upload' : 'create'} /> : null}
    {selectedSkill ? <SkillEditorDialog key={selectedSkill.installationId ?? selectedSkill.id} {...common} skill={selectedSkill} onTestSkill={onTestSkill} /> : null}
    {dialog?.kind === 'mcp-create' || selectedMcp ? <McpConnectionDialog key={selectedMcp?.installationId ?? 'new'} {...common} scope={scope} server={selectedMcp} /> : null}
  </div>
}

function IntegrationList({ skills, servers, pendingToggle, onEditSkill, onEditMcp, onToggleSkill, onToggleMcp }: {
  skills: SkillDescriptor[]; servers: McpServerConfig[]; pendingToggle: string | null
  onEditSkill: (id: string) => void; onEditMcp: (id: string) => void
  onToggleSkill: (skill: SkillDescriptor) => void; onToggleMcp: (server: McpServerConfig) => void
}) {
  const rows = [
    ...skills.map((value) => ({ kind: 'skill' as const, value, name: value.name })),
    ...servers.map((value) => ({ kind: 'mcp' as const, value, name: value.name }))
  ].sort((a, b) => a.name.localeCompare(b.name))
  return <div className="integration-list" aria-label="Integrations">{rows.map((row) => {
    const item = row.value
    const id = item.installationId ?? item.id
    const managed = isManagedSource(item.source, item.managed)
    const enabled = row.kind === 'skill' ? row.value.enabled !== false && !row.value.archived : row.value.enabled !== false
    const description = row.kind === 'skill' ? row.value.description || 'No description provided.' : row.value.transport === 'stdio' ? row.value.command ?? 'Executable' : row.value.url ?? 'No endpoint'
    return <article className={`integration-row${enabled ? '' : ' is-disabled'}`} key={`${row.kind}:${id}`} {...(row.kind === 'skill' ? { 'data-skill-card': id } : { 'data-mcp-card': id })}>
      <div className="integration-row__icon" title={row.kind === 'skill' ? 'Skill' : 'MCP connection'}>{row.kind === 'skill' ? <FileText size={17} /> : <Link2 size={17} />}</div>
      <div className="integration-row__main"><h2>{item.name}</h2><p>{description}</p>{item.diagnostics?.length ? <p className="integration-diagnostic">{item.diagnostics[0].message}</p> : null}</div>
      <div className="integration-row__actions">
        {managed ? <button type="button" className="integration-icon-button" aria-label={`Edit ${item.name}`} title="Edit" onClick={() => row.kind === 'skill' ? onEditSkill(id) : onEditMcp(id)}><Pencil size={15} /></button> : null}
        <button type="button" role="switch" aria-checked={enabled} aria-label={`${enabled ? 'Disable' : 'Enable'} ${item.name}`} title={managed ? (enabled ? 'Disable' : 'Enable') : 'Read-only'} className={`integration-switch${enabled ? ' is-on' : ''}`} disabled={!managed || pendingToggle === id} onClick={() => row.kind === 'skill' ? onToggleSkill(row.value) : onToggleMcp(row.value)}><span /></button>
      </div>
    </article>
  })}</div>
}
