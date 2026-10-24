import { useEffect, useRef, useState } from 'react'
import type { IntegrationPlatformClient } from '../../../shared/integrationPlatform'
import type { McpAuthMode, McpServerConfig } from '../../../shared/integrations'
import type { ManagedMcpRecord } from '../../../shared/integrations/lifecycle'
import { Segmented, SettingsRow, Switch } from '../settings/SettingsRow'
import { RotateCcw } from '../../lib/icons'
import { Select, type SelectOption } from '../ui/Select'
import { asError, errorCode } from './integrationUi'
import { createMcpPayload, draftFromMcp, updateMcpPayload, type McpDraft } from './mcpDraft'
import { IntegrationDisclosure as Disclosure, IntegrationField as Field, IntegrationModal as Modal, useIntegrationBoundary, useIntegrationDirtyGuard } from './dialogSupport'

const MCP_AUTH_OPTIONS: SelectOption<McpAuthMode>[] = [
  { value: 'anonymous', label: 'None' },
  { value: 'static', label: 'Headers from secrets' },
  { value: 'oauth', label: 'Sign in with OAuth' }
]

interface Props {
  client: IntegrationPlatformClient; profileId: string; projectId?: string; scope: 'global' | 'project'
  server?: McpServerConfig; onClose: () => void; onSaved: () => void; onConnectionChanged?: () => void
}
interface Feedback { kind: 'success' | 'failure' | 'info'; title: string; message: string; category?: string }

/** Switch ids; one MCP dialog is open at a time. */
const SWITCH_ID = { enable: 'mcp-enable', sse: 'mcp-sse', headers: 'mcp-replace-headers', auth: 'mcp-replace-auth', env: 'mcp-replace-env' } as const

/** A dialog switch row: title left, the shared switch right. Off/on choices only, never a checkbox. */
function SwitchRow({ id, title, description, checked, onChange }: { id: string; title: string; description?: string; checked: boolean; onChange: (next: boolean) => void }) {
  return <SettingsRow title={title} description={description} htmlFor={id} control={<Switch id={id} checked={checked} onChange={onChange} />} />
}

/** Fields that need the Advanced disclosure open to be reviewed. */
const needsAdvanced = (draft: McpDraft) => draft.transport === 'sse' || draft.authMode === 'static'

export function McpConnectionDialog({ client, profileId, projectId, scope, server, onClose, onSaved, onConnectionChanged }: Props) {
  const [saved, setSaved] = useState<ManagedMcpRecord | null>(null)
  const [draft, setDraft] = useState<McpDraft>(() => draftFromMcp(server))
  const [baseline, setBaseline] = useState(() => JSON.stringify(draftFromMcp(server)))
  const [advancedOpen, setAdvancedOpen] = useState(() => needsAdvanced(draftFromMcp(server)))
  const [loading, setLoading] = useState(Boolean(server))
  const [busy, setBusy] = useState(false)
  const [authRunning, setAuthRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [reload, setReload] = useState(0)
  const authGeneration = useRef(0)
  const pendingAuth = useRef(false)
  const boundary = useIntegrationBoundary(client, profileId, projectId, server?.installationId)
  const editing = Boolean(server)
  const dirty = JSON.stringify(draft) !== baseline
  const mayLeave = useIntegrationDirtyGuard(dirty, 'Discard unsaved MCP server changes?')
  const identity = { profileId, projectId }
  const installationId = saved?.installationId ?? server?.installationId
  const remote = draft.transport !== 'stdio'

  useEffect(() => {
    if (!server?.installationId) return
    let current = true
    setLoading(true); setError(null)
    void client.readMcp({ profileId, projectId, installationId: server.installationId }).then((record) => {
      if (!current) return
      setSaved(record)
      const next = draftFromMcp(record.server)
      setDraft(next); setBaseline(JSON.stringify(next))
      if (needsAdvanced(next)) setAdvancedOpen(true)
    }).catch((cause) => { if (current) setError(asError(cause)) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [client, profileId, projectId, server?.installationId, reload])

  useEffect(() => () => {
    authGeneration.current += 1
    if (pendingAuth.current && server?.installationId) {
      void client.cancelMcpAuth({ profileId, projectId, installationId: server.installationId }).catch(() => {})
    }
  }, [client, profileId, projectId, server?.installationId])

  const close = () => { if (!busy && mayLeave()) onClose() }
  const set = <K extends keyof McpDraft>(key: K, value: McpDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value })); setFeedback(null)
  }
  const save = async () => {
    const ticket = boundary.capture()
    setBusy(true); setError(null); setFeedback(null)
    try {
      if (editing) {
        if (!saved) throw new Error('Load the saved server before editing it.')
        await client.updateMcp(updateMcpPayload(draft, identity, saved.installationId, saved.revision))
      } else {
        await client.createMcp(createMcpPayload(draft, identity, scope))
      }
      if (boundary.current(ticket)) onSaved()
    } catch (cause) {
      if (boundary.current(ticket)) setError(errorCode(cause) === 'revision_conflict'
        ? 'This server changed elsewhere. Your edits are retained. Reload the saved server to compare before saving again.'
        : asError(cause))
    } finally { if (boundary.current(ticket)) setBusy(false) }
  }
  const test = async () => {
    if (!installationId) return
    const ticket = boundary.capture()
    setBusy(true); setError(null); setFeedback(null)
    try {
      const result = await client.testMcp({ ...identity, installationId })
      if (boundary.current(ticket)) setFeedback({
        kind: result.success ? 'success' : 'failure',
        title: result.success ? 'Connection verified' : 'Connection failed',
        message: result.success ? `Connected · ${result.toolCount ?? 0} tools` : result.error ?? 'The connection could not be verified.',
        category: result.errorCategory
      })
    } catch (cause) { if (boundary.current(ticket)) setError(asError(cause)) }
    finally { if (boundary.current(ticket)) setBusy(false) }
  }
  const authenticate = async (action: 'begin' | 'cancel' | 'revoke') => {
    if (!installationId) return
    const ticket = boundary.capture(), authTicket = ++authGeneration.current
    let cancelFailed = false
    setError(null)
    if (action === 'begin') { pendingAuth.current = true; setAuthRunning(true); setFeedback({ kind: 'info', title: 'Signing in', message: 'Complete the sign-in in your browser, or cancel below.' }) }
    try {
      if (action === 'begin') {
        const result = await client.beginMcpAuth({ ...identity, installationId })
        if (!boundary.current(ticket) || authTicket !== authGeneration.current) return
        if (result.success) onConnectionChanged?.()
        setFeedback(result.success
          ? { kind: 'success', title: 'Signed in', message: 'Sign-in completed. The server is being checked again.' }
          : { kind: 'failure', title: 'Sign-in failed', message: result.error ?? 'Sign-in was not completed.' })
      } else if (action === 'cancel') {
        await client.cancelMcpAuth({ ...identity, installationId })
        if (boundary.current(ticket) && authTicket === authGeneration.current) setFeedback({ kind: 'info', title: 'Sign-in cancelled', message: 'The pending sign-in was cancelled.' })
      } else {
        setBusy(true)
        await client.revokeMcpAuth({ ...identity, installationId })
        if (boundary.current(ticket) && authTicket === authGeneration.current) onConnectionChanged?.()
        if (boundary.current(ticket) && authTicket === authGeneration.current) setFeedback({ kind: 'info', title: 'Signed out', message: 'Saved sign-in was removed.' })
      }
    } catch (cause) {
      cancelFailed = action === 'cancel'
      if (boundary.current(ticket) && authTicket === authGeneration.current) setError(asError(cause))
    }
    finally {
      if (boundary.current(ticket) && authTicket === authGeneration.current) {
        pendingAuth.current = cancelFailed; setAuthRunning(cancelFailed); setBusy(false)
      }
    }
  }

  return <Modal title={editing ? `Edit ${server?.name ?? 'server'}` : 'Add MCP server'} onClose={close} wide>
    <form className="integration-form" data-mcp-form="" onSubmit={(event) => { event.preventDefault(); if (!busy && !authRunning) void save() }}>
      {loading ? <p role="status">Loading saved server…</p> : null}
      <fieldset disabled={busy || loading || authRunning} className="integration-fields">
        <div className="integration-form-grid">
          <Field label="Name"><input value={draft.name} onChange={(event) => set('name', event.target.value)} /></Field>
          <div className="integration-field">
            <span id="mcp-transport-label">Runs</span>
            <Segmented
              ariaLabelledBy="mcp-transport-label"
              value={remote ? 'remote' : 'local'}
              disabled={busy || loading || authRunning}
              options={[{ value: 'local', label: 'Local', title: 'A program on this computer (stdio)' }, { value: 'remote', label: 'Remote', title: 'A server reached over HTTP' }]}
              onChange={(next) => set('transport', next === 'local' ? 'stdio' : draft.transport === 'sse' ? 'sse' : 'http')}
            />
          </div>
        </div>
        {remote ? <Field label="Server URL"><input type="url" value={draft.url} onChange={(event) => set('url', event.target.value)} placeholder="https://example.com/mcp" /></Field> : <>
          <div className="integration-form-grid">
            <Field label="Command"><input value={draft.command} onChange={(event) => set('command', event.target.value)} placeholder="node" /></Field>
            <Field label="Working directory"><input value={draft.cwd} onChange={(event) => set('cwd', event.target.value)} placeholder="Optional" /></Field>
          </div>
          <Field label="Arguments (JSON array or one per line)"><textarea value={draft.args} onChange={(event) => set('args', event.target.value)} rows={3} placeholder={'["server.mjs", "--option", "value with spaces"]'} /></Field>
        </>}
        {!editing ? <SwitchRow id={SWITCH_ID.enable} title="Turn on after saving" checked={draft.enabled} onChange={(next) => set('enabled', next)} /> : null}
        <Disclosure label="Advanced" open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <div className="integration-fields">
            {remote ? <SwitchRow id={SWITCH_ID.sse} title="Use legacy SSE transport" checked={draft.transport === 'sse'} onChange={(next) => set('transport', next ? 'sse' : 'http')} /> : null}
            <Field label="Authentication"><Select<McpAuthMode> value={draft.authMode} onChange={(next) => set('authMode', next)} options={MCP_AUTH_OPTIONS} /></Field>
            {draft.authMode === 'static' ? <>
              <SwitchRow id={SWITCH_ID.headers} title={editing ? 'Replace all headers' : 'Set headers'} description={editing && !draft.replaceHeaders ? 'Saved headers are kept.' : undefined} checked={draft.replaceHeaders} onChange={(next) => set('replaceHeaders', next)} />
              {draft.replaceHeaders ? <Field label="Headers JSON"><textarea value={draft.headers} onChange={(event) => set('headers', event.target.value)} rows={4} autoComplete="off" /></Field> : null}
            </> : null}
            {draft.authMode === 'oauth' ? <>
              {editing ? <SwitchRow id={SWITCH_ID.auth} title="Replace OAuth client settings" description={draft.replaceAuth ? 'Sets every client field; an empty secret removes the saved one.' : 'Saved OAuth client settings are kept.'} checked={draft.replaceAuth} onChange={(next) => set('replaceAuth', next)} /> : null}
              <fieldset className="integration-fields" disabled={!draft.replaceAuth}>
                <div className="integration-form-grid">
                  <Field label="Client ID"><input value={draft.clientId} onChange={(event) => set('clientId', event.target.value)} placeholder="Optional" /></Field>
                  <Field label="Client secret"><input type="password" autoComplete="new-password" value={draft.clientSecret} onChange={(event) => set('clientSecret', event.target.value)} placeholder="Optional" /></Field>
                  <Field label="Scopes"><input value={draft.scopes} onChange={(event) => set('scopes', event.target.value)} placeholder="Space separated" /></Field>
                </div>
              </fieldset>
            </> : null}
            <SwitchRow id={SWITCH_ID.env} title={editing ? 'Replace environment variables' : 'Set environment variables'} description={editing && !draft.replaceEnv ? 'Saved environment variables are kept.' : undefined} checked={draft.replaceEnv} onChange={(next) => set('replaceEnv', next)} />
            {draft.replaceEnv ? <Field label="Environment JSON"><textarea value={draft.env} onChange={(event) => set('env', event.target.value)} rows={4} autoComplete="off" /></Field> : null}
            <div className="integration-form-grid">
              <Field label="Allowed tools (one per line)"><textarea value={draft.enabledTools} onChange={(event) => set('enabledTools', event.target.value)} rows={3} placeholder="Empty allows all" /></Field>
              <Field label="Blocked tools (one per line)"><textarea value={draft.deniedTools} onChange={(event) => set('deniedTools', event.target.value)} rows={3} /></Field>
            </div>
          </div>
        </Disclosure>
      </fieldset>
      {error ? <p className="integration-error" role="alert">{error}</p> : null}
      {feedback ? <div className={`integration-test ${feedback.kind}`} role="status"><strong>{feedback.title}</strong><span>{feedback.message}</span>{feedback.category ? <small>Error category: {feedback.category}</small> : null}</div> : null}
      <div className="integration-dialog-actions">
        {editing ? <>
          <button type="button" className="settings-icon-btn" title="Reload saved" aria-label="Reload saved" disabled={busy || loading || authRunning} onClick={() => { if (mayLeave()) setReload((value) => value + 1) }}><RotateCcw size={14} /></button>
          <button type="button" className="settings-btn" disabled={busy || loading || dirty || authRunning || !saved} title={dirty ? 'Save changes before testing' : undefined} onClick={() => void test()}>Test connection</button>
          {draft.authMode === 'oauth' ? <>
            <button type="button" className="settings-btn" disabled={busy || loading || dirty || authRunning || !saved} onClick={() => void authenticate('begin')}>Sign in</button>
            <button type="button" className="settings-btn" disabled={!authRunning} onClick={() => void authenticate('cancel')}>Cancel sign-in</button>
            <button type="button" className="settings-btn" disabled={busy || loading || authRunning || !saved} onClick={() => void authenticate('revoke')}>Sign out</button>
          </> : null}
        </> : null}
        <button type="submit" className="settings-btn" disabled={busy || loading || authRunning || (editing && (!saved || !dirty))}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add server'}</button>
      </div>
    </form>
  </Modal>
}
