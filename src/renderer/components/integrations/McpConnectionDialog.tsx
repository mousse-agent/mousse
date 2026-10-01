import { useEffect, useRef, useState } from 'react'
import type { IntegrationPlatformClient } from '../../../shared/integrationPlatform'
import type { McpAuthMode, McpServerConfig, McpTransport } from '../../../shared/integrations'
import type { ManagedMcpRecord } from '../../../shared/integrations/lifecycle'
import { asError, errorCode } from './integrationUi'
import { createMcpPayload, draftFromMcp, updateMcpPayload, type McpDraft } from './mcpDraft'
import { IntegrationField as Field, IntegrationModal as Modal, useIntegrationBoundary, useIntegrationDirtyGuard } from './dialogSupport'

interface Props {
  client: IntegrationPlatformClient; profileId: string; projectId?: string; scope: 'global' | 'project'
  server?: McpServerConfig; onClose: () => void; onSaved: () => void
}
interface Feedback { kind: 'success' | 'failure' | 'info'; title: string; message: string; category?: string }

export function McpConnectionDialog({ client, profileId, projectId, scope, server, onClose, onSaved }: Props) {
  const [saved, setSaved] = useState<ManagedMcpRecord | null>(null)
  const [draft, setDraft] = useState<McpDraft>(() => draftFromMcp(server))
  const [baseline, setBaseline] = useState(() => JSON.stringify(draftFromMcp(server)))
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
  const mayLeave = useIntegrationDirtyGuard(dirty, 'Discard unsaved MCP connection changes?')
  const identity = { profileId, projectId }
  const installationId = saved?.installationId ?? server?.installationId

  useEffect(() => {
    if (!server?.installationId) return
    let current = true
    setLoading(true); setError(null)
    void client.readMcp({ profileId, projectId, installationId: server.installationId }).then((record) => {
      if (!current) return
      setSaved(record)
      const next = draftFromMcp(record.server)
      setDraft(next); setBaseline(JSON.stringify(next))
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
        if (!saved) throw new Error('Load the saved connection before editing it.')
        await client.updateMcp(updateMcpPayload(draft, identity, saved.installationId, saved.revision))
      } else {
        await client.createMcp(createMcpPayload(draft, identity, scope))
      }
      if (boundary.current(ticket)) onSaved()
    } catch (cause) {
      if (boundary.current(ticket)) setError(errorCode(cause) === 'revision_conflict'
        ? 'This connection changed elsewhere. Your edits are retained. Reload the saved connection to compare before saving again.'
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
  const changeState = async (action: 'toggle' | 'delete') => {
    if (!installationId || !mayLeave()) return
    if (action === 'delete' && !window.confirm('Delete this MCP connection?')) return
    const ticket = boundary.capture(); setBusy(true); setError(null)
    try {
      if (action === 'delete') await client.deleteMcp({ ...identity, installationId })
      else await client.enableMcp({ ...identity, installationId, enabled: saved?.enabled === false })
      if (boundary.current(ticket)) onSaved()
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
        setFeedback(result.success
          ? { kind: 'success', title: 'Signed in', message: 'Authorization completed. Test the connection to refresh its tool count.' }
          : { kind: 'failure', title: 'Sign-in failed', message: result.error ?? 'Authorization was not completed.' })
      } else if (action === 'cancel') {
        await client.cancelMcpAuth({ ...identity, installationId })
        if (boundary.current(ticket) && authTicket === authGeneration.current) setFeedback({ kind: 'info', title: 'Sign-in cancelled', message: 'The pending authorization attempt was cancelled.' })
      } else {
        setBusy(true)
        await client.revokeMcpAuth({ ...identity, installationId })
        if (boundary.current(ticket) && authTicket === authGeneration.current) setFeedback({ kind: 'info', title: 'Authorization revoked', message: 'Saved authorization was removed.' })
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

  return <Modal title={editing ? `Edit ${server?.name ?? 'connection'}` : 'Add MCP connection'} onClose={close} wide>
    <form className="integration-form" data-mcp-form="" onSubmit={(event) => { event.preventDefault(); if (!busy && !authRunning) void save() }}>
      {loading ? <p role="status">Loading saved connection…</p> : null}
      <fieldset disabled={busy || loading || authRunning} className="integration-fields">
        <div className="integration-form-grid">
          <Field label="Name"><input value={draft.name} onChange={(event) => set('name', event.target.value)} /></Field>
          <Field label="Transport"><select value={draft.transport} onChange={(event) => set('transport', event.target.value as McpTransport)}>
            <option value="stdio">Local stdio</option><option value="http">Streamable HTTP</option><option value="sse">Legacy SSE</option>
          </select></Field>
        </div>
        {draft.transport === 'stdio' ? <>
          <div className="integration-form-grid">
            <Field label="Executable"><input value={draft.command} onChange={(event) => set('command', event.target.value)} placeholder="node" /></Field>
            <Field label="Working directory"><input value={draft.cwd} onChange={(event) => set('cwd', event.target.value)} placeholder="Optional" /></Field>
          </div>
          <Field label="Arguments (JSON array or one per line)"><textarea value={draft.args} onChange={(event) => set('args', event.target.value)} rows={4} placeholder={'["server.mjs", "--option", "value with spaces"]'} /></Field>
        </> : <Field label="Remote URL"><input type="url" value={draft.url} onChange={(event) => set('url', event.target.value)} placeholder="https://example.com/mcp" /></Field>}
        <div className="integration-form-grid">
          <Field label="Allowed tools (one per line)"><textarea value={draft.enabledTools} onChange={(event) => set('enabledTools', event.target.value)} rows={3} placeholder="Leave empty for server defaults" /></Field>
          <Field label="Denied tools (one per line)"><textarea value={draft.deniedTools} onChange={(event) => set('deniedTools', event.target.value)} rows={3} /></Field>
        </div>
        <Field label="Authentication"><select value={draft.authMode} onChange={(event) => set('authMode', event.target.value as McpAuthMode)}><option value="anonymous">None / anonymous</option><option value="static">Secret-backed headers</option><option value="oauth">OAuth</option></select></Field>
        {draft.authMode === 'static' ? <>
          <label className="integration-check"><input type="checkbox" checked={draft.replaceHeaders} onChange={(event) => set('replaceHeaders', event.target.checked)} /> Replace complete headers object</label>
          {draft.replaceHeaders ? <Field label="Headers JSON"><textarea value={draft.headers} onChange={(event) => set('headers', event.target.value)} rows={4} autoComplete="off" /></Field> : <p className="integration-help">Existing headers are preserved. Choose replacement to enter a complete new set.</p>}
        </> : null}
        {draft.authMode === 'oauth' ? <>
          {editing ? <label className="integration-check"><input type="checkbox" checked={draft.replaceAuth} onChange={(event) => set('replaceAuth', event.target.checked)} /> Replace OAuth client settings</label> : null}
          <fieldset className="integration-fields" disabled={!draft.replaceAuth}>
            <div className="integration-form-grid">
              <Field label="Client ID"><input value={draft.clientId} onChange={(event) => set('clientId', event.target.value)} /></Field>
              <Field label="Client secret"><input type="password" autoComplete="new-password" value={draft.clientSecret} onChange={(event) => set('clientSecret', event.target.value)} /></Field>
              <Field label="Scopes"><input value={draft.scopes} onChange={(event) => set('scopes', event.target.value)} placeholder="space separated" /></Field>
            </div>
          </fieldset>
          <p className="integration-help">{draft.replaceAuth ? 'Replacement includes all client settings; an empty secret removes the previous client secret.' : 'Saved OAuth settings are preserved and omitted from this update.'}</p>
        </> : null}
        <details><summary>Environment references</summary>
          <label className="integration-check"><input type="checkbox" checked={draft.replaceEnv} onChange={(event) => set('replaceEnv', event.target.checked)} /> Replace complete environment object</label>
          {draft.replaceEnv ? <Field label="Environment JSON"><textarea value={draft.env} onChange={(event) => set('env', event.target.value)} rows={4} autoComplete="off" /></Field> : <p className="integration-help">Saved environment values are preserved and omitted from this update.</p>}
        </details>
        <label className="integration-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => set('enabled', event.target.checked)} /> Enable after save</label>
      </fieldset>
      {error ? <p className="integration-error" role="alert">{error}</p> : null}
      {feedback ? <div className={`integration-test ${feedback.kind}`} role="status"><strong>{feedback.title}</strong><span>{feedback.message}</span>{feedback.category ? <small>Error category: {feedback.category}</small> : null}</div> : null}
      <div className="integration-dialog-actions">
        <button type="button" className="btn" onClick={close}>Cancel</button>
        {editing ? <>
          <button type="button" className="btn" disabled={busy || loading || authRunning} onClick={() => { if (mayLeave()) setReload((value) => value + 1) }}>Reload saved</button>
          <button type="button" className="btn" disabled={busy || loading || dirty || authRunning || !saved} title={dirty ? 'Save changes before testing' : undefined} onClick={() => void test()}>Test connection</button>
          {draft.authMode === 'oauth' ? <>
            <button type="button" className="btn" disabled={busy || loading || dirty || authRunning || !saved} onClick={() => void authenticate('begin')}>Sign in</button>
            <button type="button" className="btn" disabled={!authRunning} onClick={() => void authenticate('cancel')}>Cancel login</button>
            <button type="button" className="btn" disabled={busy || loading || authRunning || !saved} onClick={() => void authenticate('revoke')}>Revoke</button>
          </> : null}
          <button type="button" className="btn" disabled={busy || loading || authRunning || !saved} onClick={() => void changeState('toggle')}>{saved?.enabled === false ? 'Enable' : 'Disable'}</button>
          <button type="button" className="btn btn-danger" disabled={busy || loading || authRunning || !saved} onClick={() => void changeState('delete')}>Delete</button>
        </> : null}
        <button type="submit" className="btn btn-primary" disabled={busy || loading || authRunning || (editing && (!saved || !dirty))}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Save connection'}</button>
      </div>
    </form>
  </Modal>
}
