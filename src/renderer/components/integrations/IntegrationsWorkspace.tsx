import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { IntegrationPlatformClient, IntegrationPlatformSnapshot } from '../../../shared/integrationPlatform'
import type { McpServerConfig, SkillDescriptor } from '../../../shared/integrations'
import { AlertTriangle, CircleAlert, CircleCheck, Plug, Plus, RotateCcw, Sparkles, X } from '../../lib/icons'
import { SettingsGroup, SettingsRow, Switch } from '../settings/SettingsRow'
import { asError, downloadPackage, snapshotItems } from './integrationUi'
import { AddSkillDialog, SkillEditorDialog, type TestSkill } from './SkillDialogs'
import { McpConnectionDialog } from './McpConnectionDialog'
import { RowMenu } from './RowMenu'
import type { SkillModelBinding } from './SkillModelPicker'
import { useMcpConnectionChecks, type McpConnectionCheck } from './useMcpConnectionChecks'
import { isIntegrationItemOn, itemId, type IntegrationGates, type IntegrationKind as Kind } from './itemState'
import { groupMcpServers, groupSkills, mcpEndpoint, OtherAppsGroup } from './otherAppsGroup'
import './integrations.css'

/**
 * Settings-side state that decides whether an installed item is actually on:
 * the hidden category gate (`enabled`) and the selection list. Rows show on only
 * when all of them agree, so no switch reads "on" while a hidden gate is off.
 * Turning an item on also turns its gate on; the daemon does that in `select`.
 */
export interface IntegrationPolicy {
  integrations: IntegrationGates
  /** Re-reads settings after the daemon changed the selection. */
  refresh: () => void | Promise<void>
}

export interface IntegrationsWorkspaceProps {
  client: IntegrationPlatformClient
  profileId: string
  projectId?: string
  onTestSkill?: TestSkill
  policy?: IntegrationPolicy
  skillModel?: SkillModelBinding
}
type Dialog = { kind: 'skill-create' | 'mcp-create' } | { kind: 'skill-edit' | 'mcp-edit'; id: string } | null

/** Key personal data before rendering so profile switches never show stale rows. */
export function IntegrationsWorkspace(props: IntegrationsWorkspaceProps) {
  return <ScopedWorkspace key={`${props.profileId}:${props.projectId ?? ''}`} {...props} />
}

function ScopedWorkspace({ client, profileId, projectId, onTestSkill, policy, skillModel }: IntegrationsWorkspaceProps) {
  const [snapshot, setSnapshot] = useState<IntegrationPlatformSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const generation = useRef(0)
  const scope = projectId ? 'project' : 'global'
  const load = useCallback(async (refresh = false) => {
    const current = ++generation.current
    if (!refresh) setLoading(true)
    setError(null)
    try {
      const result = await client.snapshot({ profileId, projectId, refresh })
      if (current === generation.current) setSnapshot(result)
    } catch (cause) { if (current === generation.current) setError(asError(cause)) }
    finally { if (current === generation.current) setLoading(false) }
  }, [client, profileId, projectId])
  useEffect(() => { void load(); return () => { generation.current += 1 } }, [load])

  const integrations = policy?.integrations
  const isOn = (kind: Kind, item: SkillDescriptor | McpServerConfig) => isIntegrationItemOn(kind, item, integrations)
  // Only servers that are on get connection checks (which may start a local process).
  const checkedSnapshot = useMemo(() => snapshot && integrations ? {
    ...snapshot,
    mcp: { ...snapshot.mcp, servers: snapshot.mcp.servers.filter((server) => isIntegrationItemOn('mcp', server, integrations)) }
  } : snapshot, [snapshot, integrations])
  const mcpConnections = useMcpConnectionChecks(client, profileId, projectId, checkedSnapshot)

  const items = snapshotItems(snapshot)
  const byName = <T extends { name: string }>(list: T[]) => [...list].sort((a, b) => a.name.localeCompare(b.name))
  // One row per name: other apps' read-only skills and servers get their own collapsed groups.
  const skillGroups = groupSkills(items.skills)
  const skills = byName(skillGroups.own)
  const serverGroups = groupMcpServers(items.servers)
  const servers = byName(serverGroups.own)
  const selectedSkill = dialog?.kind === 'skill-edit' ? items.skills.find((skill) => itemId(skill) === dialog.id) : undefined
  const selectedMcp = dialog?.kind === 'mcp-edit' ? items.servers.find((server) => itemId(server) === dialog.id) : undefined

  const afterChange = async () => { await Promise.all([load(true), policy?.refresh()]) }
  const close = () => setDialog(null)
  const saved = () => { close(); void afterChange() }
  const common = { client, profileId, projectId, onClose: close, onSaved: saved }

  const run = async (id: string, task: () => Promise<unknown>) => {
    setPending(id); setError(null)
    try { await task(); await afterChange() }
    catch (cause) { setError(asError(cause)) }
    finally { setPending(null) }
  }
  const toggle = (kind: Kind, item: SkillDescriptor | McpServerConfig, next: boolean) => run(itemId(item), async () => {
    const params = { profileId, projectId, installationId: itemId(item), enabled: next }
    if (kind === 'skills') await client.enableSkill(params)
    else await client.enableMcp(params)
  })
  const exportZip = (skill: SkillDescriptor) => run(itemId(skill), async () => {
    const exported = await client.exportSkill({ profileId, projectId, installationId: itemId(skill), format: 'zip' })
    downloadPackage(exported.fileName, exported.base64, exported.contentType)
  })
  const archive = (skill: SkillDescriptor) => {
    if (!window.confirm(`Archive ${skill.name}? It stops being available to agents.`)) return
    void run(itemId(skill), () => client.archiveSkill({ profileId, projectId, installationId: itemId(skill) }))
  }
  const remove = (server: McpServerConfig) => {
    if (!window.confirm(`Delete ${server.name}?`)) return
    void run(itemId(server), () => client.deleteMcp({ profileId, projectId, installationId: itemId(server) }))
  }

  return <div className="skills-mcp-lists" data-integrations-workspace="" data-profile-id={profileId} data-project-id={projectId ?? ''}>
    {error ? <p className="skills-mcp-error" role="alert">{error} <button type="button" className="settings-icon-btn" title="Try again" aria-label="Try again" onClick={() => void load(true)}><RotateCcw size={14} /></button></p> : null}
    <SettingsGroup
      title="Skills"
      icon={Sparkles}
      description="Instructions an agent loads when a task calls for them."
      action={<button type="button" className="settings-btn" data-action="add-skill" onClick={() => setDialog({ kind: 'skill-create' })}><Plus size={14} />Add skill</button>}
    >
      {loading ? <p className="skills-mcp-state" role="status">Loading skills…</p>
        : skills.length === 0 ? <p className="skills-mcp-state">No skills yet.</p>
          : skills.map((skill) => <SkillRow key={itemId(skill)} skill={skill} on={isOn('skills', skill)} busy={pending === itemId(skill)}
            onToggle={(next) => void toggle('skills', skill, next)} onEdit={() => setDialog({ kind: 'skill-edit', id: itemId(skill) })}
            onExport={() => void exportZip(skill)} onArchive={() => archive(skill)} />)}
    </SettingsGroup>
    {loading ? null : <OtherAppsGroup kind="skills" rows={skillGroups.otherApps} />}
    <SettingsGroup
      title="MCP servers"
      icon={Plug}
      description="Servers that give agents extra tools."
      action={<button type="button" className="settings-btn" data-action="add-mcp" onClick={() => setDialog({ kind: 'mcp-create' })}><Plus size={14} />Add server</button>}
    >
      {loading ? <p className="skills-mcp-state" role="status">Loading servers…</p>
        : servers.length === 0 ? <p className="skills-mcp-state">No MCP servers yet.</p>
          : servers.map((server) => <McpRow key={itemId(server)} server={server} on={isOn('mcp', server)} busy={pending === itemId(server)}
            check={mcpConnections.checks[itemId(server)]}
            onToggle={(next) => void toggle('mcp', server, next)} onEdit={() => setDialog({ kind: 'mcp-edit', id: itemId(server) })}
            onSignIn={() => void mcpConnections.authenticate(server)} onCancelSignIn={() => void mcpConnections.cancel(server)}
            onDelete={() => remove(server)} />)}
    </SettingsGroup>
    {loading ? null : <OtherAppsGroup kind="mcp" rows={serverGroups.otherApps} />}
    {dialog?.kind === 'skill-create' ? <AddSkillDialog {...common} scope={scope} initialMode="create" /> : null}
    {selectedSkill ? <SkillEditorDialog key={itemId(selectedSkill)} {...common} skill={selectedSkill} onTestSkill={onTestSkill} skillModel={skillModel} /> : null}
    {dialog?.kind === 'mcp-create' || selectedMcp ? <McpConnectionDialog key={selectedMcp ? itemId(selectedMcp) : 'new'} {...common} scope={scope} server={selectedMcp}
      onConnectionChanged={() => { mcpConnections.reset(); void load(true) }} /> : null}
  </div>
}

function SkillRow({ skill, on, busy, onToggle, onEdit, onExport, onArchive }: {
  skill: SkillDescriptor; on: boolean; busy: boolean
  onToggle: (next: boolean) => void; onEdit: () => void; onExport: () => void; onArchive: () => void
}) {
  // Only Mousse's own skills come here; other apps' skills are in OtherAppsGroup.
  const shadowed = skill.isActive === false
  const description = skill.diagnostics?.[0]?.message
    ?? (shadowed ? 'Hidden by another skill with the same name.' : null)
    ?? (skill.description || 'No description.')
  return <SettingsRow
    className="skills-mcp-row"
    data-skill-card={itemId(skill)}
    title={skill.name}
    description={<span className="skills-mcp-line" title={description}>{description}</span>}
    control={<>
      <RowMenu label={`More actions for ${skill.name}`} disabled={busy} items={[
        { label: 'Edit', onSelect: onEdit },
        { label: 'Export ZIP', onSelect: onExport },
        { label: 'Archive', onSelect: onArchive, danger: true }
      ]} />
      <Switch checked={on} label={skill.name} disabled={busy || shadowed} onChange={onToggle} />
    </>}
  />
}

type StatusTone = 'ok' | 'warn' | 'bad'

const STATUS_GLYPHS = { ok: CircleCheck, warn: AlertTriangle, bad: CircleAlert } as const

/** Leads a coloured status word; the line's own colour tints it. */
function StatusGlyph({ tone }: { tone: StatusTone }) {
  const Glyph = STATUS_GLYPHS[tone]
  return <Glyph size={14} className="settings-status-glyph" />
}

function mcpStatus(server: McpServerConfig, on: boolean, check: McpConnectionCheck | undefined): { text: string; needsSignIn: boolean; signingIn: boolean; tone?: StatusTone } {
  const signingIn = check?.phase === 'signing-in'
  const category = check?.result?.errorCategory
  const needsSignIn = !signingIn && check?.phase === 'complete' && (category === 'auth-required' || category === 'unauthorized')
  const endpoint = mcpEndpoint(server)
  if (server.diagnostics?.length) return { text: server.diagnostics[0].message, needsSignIn: false, signingIn: false, tone: 'warn' }
  if (!on) return { text: endpoint, needsSignIn: false, signingIn: false }
  if (signingIn) return { text: 'Signing in…', needsSignIn, signingIn }
  if (!check || check.phase === 'checking') return { text: 'Checking…', needsSignIn, signingIn }
  if (check.result?.success) return { text: `Connected · ${check.result.toolCount ?? 0} tools`, needsSignIn, signingIn, tone: 'ok' }
  if (needsSignIn) return { text: 'Needs sign-in', needsSignIn, signingIn, tone: 'warn' }
  return { text: check.result?.error ?? 'Can’t connect', needsSignIn, signingIn, tone: 'bad' }
}

function McpRow({ server, on, busy, check, onToggle, onEdit, onSignIn, onCancelSignIn, onDelete }: {
  server: McpServerConfig; on: boolean; busy: boolean; check: McpConnectionCheck | undefined
  onToggle: (next: boolean) => void; onEdit: () => void; onSignIn: () => void; onCancelSignIn: () => void; onDelete: () => void
}) {
  // Only Mousse's own servers come here; other apps' servers are in OtherAppsGroup.
  const status = mcpStatus(server, on, check)
  return <SettingsRow
    className="skills-mcp-row"
    data-mcp-card={itemId(server)}
    title={server.name}
    description={<span className={`skills-mcp-line${status.tone ? ` settings-status-${status.tone}` : ''}`} role={on ? 'status' : undefined} title={check?.result?.error ?? status.text}>{status.tone ? <StatusGlyph tone={status.tone} /> : null}{status.text}</span>}
    control={<>
      {on && status.needsSignIn ? <button type="button" className="settings-btn" onClick={onSignIn}>Sign in</button> : null}
      {on && status.signingIn ? <button type="button" className="settings-icon-btn" title="Cancel sign-in" aria-label="Cancel sign-in" onClick={onCancelSignIn}><X size={14} /></button> : null}
      <RowMenu label={`More actions for ${server.name}`} disabled={busy || status.signingIn} items={[
        { label: 'Edit', onSelect: onEdit },
        { label: 'Delete', onSelect: onDelete, danger: true }
      ]} />
      <Switch checked={on} label={server.name} disabled={busy || status.signingIn} onChange={onToggle} />
    </>}
  />
}
