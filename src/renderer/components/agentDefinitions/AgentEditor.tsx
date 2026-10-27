import { Archive, Copy, Download, Star } from '../../lib/icons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentDefinitionRecord,
  AgentDefinitionSettings,
  AgentLibraryFlags,
  AgentVisualMetadata
} from '../../../shared/agents/types'
import { OrbAppearanceEditor } from '../orb/OrbAppearanceEditor'
import type { OrbAppearance } from '../orb/orbAppearance'
import { AgentSettingsForm } from './AgentSettingsForm'
import { TryRunPanel } from './TryRunPanel'
import { createAsyncGate, shouldApplyAsyncResult } from './asyncGate'
import type { AgentDefinitionIssue } from '../../../shared/agents/errors'
import {
  isAgentDefinitionClientError,
  type AgentDefinitionsClient,
  type AgentEditorCatalogs
} from './client'
import { DraftConflictDialog, UnsavedChangesDialog } from './dialogs'
import { collectEditorIssues, editorRuntimeIssues, fieldIdForPointer, runsOnLabel } from './editorIssues'
import { downloadJson } from './importBundle'
import { registerNavigationGuard } from '../../services/navigationGuards'

export interface AgentEditorProps {
  profileId: string
  definitionId: string
  client: AgentDefinitionsClient
  catalogs: AgentEditorCatalogs
  onBack: () => void
  onOpenDefinition?: (id: string) => void
  active?: boolean
  onRequestAttention?: () => void
}

/** What the editor changes. The stored `runtimeKind` is not one of them: a save writes `mousse`. */
interface DraftSnapshot {
  settings: AgentDefinitionSettings
  systemPrompt: string
  visual: AgentVisualMetadata
  flags: AgentLibraryFlags
}

function snapshotFromRecord(record: AgentDefinitionRecord): DraftSnapshot {
  return {
    settings: record.settings,
    systemPrompt: record.systemPrompt,
    visual: record.visual,
    flags: record.flags
  }
}

function snapshotsEqual(a: DraftSnapshot, b: DraftSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function AgentEditor({
  profileId,
  definitionId,
  client,
  catalogs,
  onBack,
  onOpenDefinition,
  active = true,
  onRequestAttention
}: AgentEditorProps) {
  const gate = useRef(createAsyncGate())
  const [record, setRecord] = useState<AgentDefinitionRecord | null>(null)
  const [draft, setDraft] = useState<DraftSnapshot | null>(null)
  const [baseline, setBaseline] = useState<DraftSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string>('Loading')
  const [error, setError] = useState<string | null>(null)
  const [conflictMessage, setConflictMessage] = useState<string | null>(null)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const pendingLeave = useRef<(() => void) | null>(null)
  const navigationDecision = useRef<((allow: boolean) => void) | null>(null)
  const [desktop, setDesktop] = useState(
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 1100px)').matches
  )

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1100px)')
    const update = () => setDesktop(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  const load = useCallback(async () => {
    const started = gate.current.bump()
    setLoading(true)
    setSaving(false)
    setError(null)
    setRecord(null)
    setDraft(null)
    setBaseline(null)
    try {
      const next = await client.get({ profileId, id: definitionId })
      if (!shouldApplyAsyncResult(started, gate.current.current())) return
      setRecord(next)
      const snap = snapshotFromRecord(next)
      setDraft(snap)
      setBaseline(snap)
      setStatus(next.published ? 'Published revision pinned' : 'Draft')
    } catch (caught) {
      if (!shouldApplyAsyncResult(started, gate.current.current())) return
      setRecord(null)
      setDraft(null)
      setError(isAgentDefinitionClientError(caught) ? caught.message : String(caught))
    } finally {
      if (shouldApplyAsyncResult(started, gate.current.current())) setLoading(false)
    }
  }, [client, definitionId, profileId])

  useEffect(() => {
    void load()
    return () => {
      gate.current.bump()
    }
  }, [load])

  const dirty = Boolean(draft && baseline && !snapshotsEqual(draft, baseline))
  useEffect(() => {
    if (!dirty) return
    const unregister = registerNavigationGuard(() => new Promise<boolean>((resolve) => {
      onRequestAttention?.()
      navigationDecision.current?.(false)
      navigationDecision.current = resolve
      pendingLeave.current = () => {
        navigationDecision.current?.(true)
        navigationDecision.current = null
      }
      setLeaveOpen(true)
    }))
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      unregister()
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [dirty, onRequestAttention])
  useEffect(() => () => { navigationDecision.current?.(false) }, [])
  // Where the saved draft would run (the gateway's check of its models' instances), read again for
  // every saved draft. It answers for the saved settings only, so it is hidden while the settings
  // have unsaved edits (a model picked but not saved would contradict it), and Publish waits for it.
  const [runtimeIssues, setRuntimeIssues] = useState<{ draftHash: string; issues: AgentDefinitionIssue[] } | null>(null)
  const recordId = record?.id
  const recordDraftHash = record?.draftHash
  useEffect(() => {
    if (!recordId || !recordDraftHash) return
    let current = true
    client.validate({ profileId, id: recordId, expectedDraftHash: recordDraftHash, runtimeOnly: true })
      .then((result) => { if (current) setRuntimeIssues({ draftHash: recordDraftHash, issues: result.issues }) })
      // Unanswered, the check does not hold Publish: the daemon checks again when it publishes or runs.
      .catch(() => { if (current) setRuntimeIssues({ draftHash: recordDraftHash, issues: [] }) })
    return () => { current = false }
  }, [client, profileId, recordId, recordDraftHash])
  const { checked: runtimeChecked, serverIssues } = editorRuntimeIssues({ answer: runtimeIssues, draftHash: recordDraftHash, settings: draft?.settings, savedSettings: baseline?.settings })
  const issues = useMemo(
    () =>
      draft
        ? collectEditorIssues({ settings: draft.settings, catalogs, ...(serverIssues ? { serverIssues } : {}) })
        : [],
    [catalogs, draft, serverIssues]
  )
  const blocking = issues.filter((issue) => issue.blocking)
  const canPublish = Boolean(record && draft && !dirty && runtimeChecked && blocking.length === 0)
  const canRun = Boolean(record && draft && !dirty && blocking.length === 0)

  const requestLeave = (action: () => void) => {
    if (!dirty) {
      action()
      return
    }
    pendingLeave.current = action
    setLeaveOpen(true)
  }

  const applyRecord = (next: AgentDefinitionRecord, keepLocal?: DraftSnapshot) => {
    setRecord(next)
    const snap = snapshotFromRecord(next)
    setBaseline(snap)
    setDraft(keepLocal ?? snap)
  }

  const saveDraft = async () => {
    if (!record || !draft) return
    setSaving(true)
    setError(null)
    const started = gate.current.current()
    try {
      const next = await client.saveDraft({
        profileId,
        id: record.id,
        expectedDraftHash: record.draftHash,
        // New and resaved definitions are Mousse's; an older CLI kind changes only here, by a save.
        runtimeKind: 'mousse',
        settings: draft.settings,
        systemPrompt: draft.systemPrompt,
        visual: draft.visual,
        flags: { enabled: draft.flags.enabled, favorite: draft.flags.favorite }
      })
      if (!shouldApplyAsyncResult(started, gate.current.current())) return
      applyRecord(next)
      setStatus('Draft saved')
    } catch (caught) {
      if (!shouldApplyAsyncResult(started, gate.current.current())) return
      if (isAgentDefinitionClientError(caught) && caught.code === 'REVISION_CONFLICT') {
        setConflictMessage(caught.message)
      } else {
        setError(isAgentDefinitionClientError(caught) ? caught.message : String(caught))
      }
    } finally {
      if (shouldApplyAsyncResult(started, gate.current.current())) setSaving(false)
    }
  }

  const publish = async () => {
    if (!record || !canPublish) return
    setSaving(true)
    setError(null)
    const started = gate.current.current()
    try {
      let expectedDraftHash = record.draftHash
      // Republishing a definition saved for an older CLI kind saves it for Mousse first.
      if (record.runtimeKind !== 'mousse') {
        const saved = await client.saveDraft({ profileId, id: record.id, expectedDraftHash, runtimeKind: 'mousse' })
        if (!shouldApplyAsyncResult(started, gate.current.current())) return
        expectedDraftHash = saved.draftHash
      }
      await client.publish({ profileId, id: record.id, expectedDraftHash })
      if (!shouldApplyAsyncResult(started, gate.current.current())) return
      await load()
    } catch (caught) {
      if (!shouldApplyAsyncResult(started, gate.current.current())) return
      if (isAgentDefinitionClientError(caught) && caught.code === 'REVISION_CONFLICT') {
        setConflictMessage(caught.message)
      } else {
        setError(isAgentDefinitionClientError(caught) ? caught.message : String(caught))
      }
      setSaving(false)
    }
  }

  const focusIssue = (fieldId: string) => {
    document.getElementById(fieldId)?.scrollIntoView({ block: 'center' })
    const focusable = document.getElementById(fieldId)?.querySelector<HTMLElement>('input, textarea, select, button')
    focusable?.focus()
  }

  const duplicate = async () => {
    if (!record) return
    const started = gate.current.current()
    setSaving(true)
    setError(null)
    try {
      const copy = await client.duplicate({ profileId, id: record.id })
      if (!shouldApplyAsyncResult(started, gate.current.current())) return
      if (onOpenDefinition) onOpenDefinition(copy.id)
      else onBack()
    } catch (caught) {
      if (shouldApplyAsyncResult(started, gate.current.current())) {
        setError(isAgentDefinitionClientError(caught) ? caught.message : String(caught))
      }
    } finally {
      if (shouldApplyAsyncResult(started, gate.current.current())) setSaving(false)
    }
  }

  const archive = async () => {
    if (!record) return
    const started = gate.current.current()
    setSaving(true)
    setError(null)
    try {
      await client.archive({ profileId, id: record.id })
      if (shouldApplyAsyncResult(started, gate.current.current())) onBack()
    } catch (caught) {
      if (shouldApplyAsyncResult(started, gate.current.current())) {
        setError(isAgentDefinitionClientError(caught) ? caught.message : String(caught))
      }
    } finally {
      if (shouldApplyAsyncResult(started, gate.current.current())) setSaving(false)
    }
  }

  if (loading && !draft) {
    return (
      <div className="agent-defs agent-defs--loading" role="status">
        Loading agent…
      </div>
    )
  }
  if (error && !draft) {
    return (
      <div className="agent-defs agent-defs--error" role="alert">
        <button type="button" className="agent-defs__crumb" onClick={onBack}>
          ← Agents
        </button>
        <p>{error}</p>
      </div>
    )
  }
  if (!record || !draft) return null
  const runsOn = runsOnLabel(catalogs, draft.settings.primaryModel.ref)

  return (
    <div
      className="agent-defs agent-editor"
      data-agent-editor=""
      data-dirty={dirty ? 'true' : 'false'}
      data-layout={desktop ? 'desktop' : 'narrow'}
      data-profile-id={profileId}
      data-definition-id={definitionId}
    >
      <header className="agent-defs__header">
        <button type="button" className="agent-defs__crumb" data-action="back" onClick={() => requestLeave(onBack)}>
          ← Agents
        </button>
        <span className="agent-defs__title">{draft.settings.identity.name || 'Untitled agent'}</span>
        <span className="agent-defs__status" data-editor-status="">
          {status}
          {dirty ? ' · Unsaved' : ''}
          {runsOn ? ` · Runs on ${runsOn}` : ''}
        </span>
        <div className="agent-defs__actions">
          <button
            type="button"
            className="btn btn-sm"
            aria-pressed={draft.flags.favorite}
            onClick={() => setDraft({ ...draft, flags: { ...draft.flags, favorite: !draft.flags.favorite } })}
          >
            <Star size={14} /> {draft.flags.favorite ? 'Favorited' : 'Favorite'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            data-action="save-draft"
            disabled={saving || !dirty}
            onClick={() => void saveDraft()}
          >
            {saving ? 'Saving…' : 'Save draft'}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-action="publish"
            disabled={saving || !canPublish}
            title={blocking[0]?.message}
            onClick={() => void publish()}
          >
            Publish
          </button>
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Duplicate agent"
            disabled={saving}
            onClick={() => requestLeave(() => void duplicate())}
          >
            <Copy size={14} /> Duplicate
          </button>
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Export agent"
            disabled={saving || dirty}
            title={dirty ? 'Save or discard local edits before exporting the registry draft.' : undefined}
            onClick={() =>
              void client.exportBundle({ profileId, id: record.id }).then((bundle) => {
                downloadJson(`${draft.settings.identity.slug || 'agent'}.mousse-agent.json`, bundle)
              })
            }
          >
            <Download size={14} /> Export
          </button>
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Archive agent"
            disabled={saving}
            onClick={() => requestLeave(() => void archive())}
          >
            <Archive size={14} /> Archive
          </button>
        </div>
      </header>
      {error ? (
        <div className="agent-banner agent-banner--error" role="alert">
          {error}
        </div>
      ) : null}
      {issues.length > 0 ? (
        <div className="agent-banner agent-validation" aria-label="Validation">
          <strong>Needs attention</strong>
          <ul>
            {issues.map((issue) => (
              <li key={`${issue.pointer}:${issue.message}`}>
                <a
                  href={`#${issue.fieldId}`}
                  onClick={(event) => {
                    event.preventDefault()
                    focusIssue(issue.fieldId)
                  }}
                >
                  {issue.message}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="agent-editor__body">
        <div className="agent-editor__identity">
          <OrbAppearanceEditor
            value={draft.visual}
            name={draft.settings.identity.name}
            description={draft.settings.identity.purpose || 'A little personality. A world of possibility.'}
            active={active}
            onChange={(appearance: OrbAppearance) =>
              setDraft({ ...draft, visual: { ...appearance } })
            }
          />
        </div>
        <div className="agent-editor__settings">
          <CheckEnabled
            enabled={draft.flags.enabled}
            onChange={(enabled) => setDraft({ ...draft, flags: { ...draft.flags, enabled } })}
          />
          <AgentSettingsForm
            definitionId={record.id}
            savedRuntimeKind={record.runtimeKind}
            settings={draft.settings}
            systemPrompt={draft.systemPrompt}
            catalogs={catalogs}
            onSettingsChange={(settings) => setDraft({ ...draft, settings })}
            onSystemPromptChange={(systemPrompt) => setDraft({ ...draft, systemPrompt })}
            onSave={() => void saveDraft()}
          />
          <TryRunPanel
            profileId={profileId}
            id={record.id}
            expectedDraftHash={record.draftHash}
            client={client}
            disabled={!canRun}
            disabledReason={
              dirty
                ? 'Save the draft before a try-run so the injected runtime sees a real revision.'
                : blocking[0]?.message
            }
          />
          <output id="appearance-value" hidden>
            {JSON.stringify(draft.visual)}
          </output>
          <output id="prompt-value" hidden>
            {draft.systemPrompt}
          </output>
          <output id="draft-hash" hidden>
            {record.draftHash}
          </output>
        </div>
      </div>
      <UnsavedChangesDialog
        open={leaveOpen}
        onStay={() => {
          setLeaveOpen(false)
          pendingLeave.current = null
          navigationDecision.current?.(false)
          navigationDecision.current = null
        }}
        onDiscard={() => {
          const action = pendingLeave.current
          pendingLeave.current = null
          setLeaveOpen(false)
          setDraft(baseline)
          action?.()
        }}
      />
      <DraftConflictDialog
        open={Boolean(conflictMessage)}
        message={conflictMessage ?? ''}
        onKeep={() => setConflictMessage(null)}
        onReload={() => {
          setConflictMessage(null)
          void load()
        }}
      />
    </div>
  )
}

function CheckEnabled({ enabled, onChange }: { enabled: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="agent-check-row" htmlFor="agent-enabled">
      <input
        id="agent-enabled"
        type="checkbox"
        checked={enabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      Enabled
    </label>
  )
}

export function focusEditorField(pointer: string): void {
  document.getElementById(fieldIdForPointer(pointer))?.scrollIntoView({ block: 'center' })
}
