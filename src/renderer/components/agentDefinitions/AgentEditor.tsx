import { Star } from '../../lib/icons'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArchiveDefinitionDialog, FixIssuesLink, PublishImpactDialog, SaveFailed, SaveStateLabel, useAutosave, type PublishUser } from '../automations/EditorParts'
import { definitionSaveState, publishBlockReason } from '../automations/editorState'
import { RowMenu } from '../integrations/RowMenu'
import { Switch } from '../settings/SettingsRow'
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

/**
 * Null when never published; otherwise whether the saved draft is the published revision. A
 * revision is named by its content hashes, and a draft saved for an older CLI kind is republished
 * as Mousse's, so it counts as changed.
 */
export function matchesPublished(record: Pick<AgentDefinitionRecord, 'published' | 'semanticHash' | 'visualHash' | 'runtimeKind'>): boolean | null {
  if (!record.published) return null
  return record.runtimeKind === 'mousse' && record.published.revision === record.semanticHash && record.published.visualRevision === record.visualHash
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
  /** The last save failed: its message, shown with Retry. */
  const [saveError, setSaveError] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  /** Automations that use this agent, asked about before Publish. */
  const [publishUsers, setPublishUsers] = useState<PublishUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conflictMessage, setConflictMessage] = useState<string | null>(null)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const publishReasonId = useId()
  const pendingLeave = useRef<(() => void) | null>(null)
  const navigationDecision = useRef<((allow: boolean) => void) | null>(null)
  // Set only once the archive succeeded: the confirmed edits went with the definition, so leaving
  // for the library does not ask about them again. A failed archive leaves it unset and keeps them.
  const archived = useRef(false)
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
    const unregister = registerNavigationGuard(() => archived.current ? true : new Promise<boolean>((resolve) => {
      onRequestAttention?.()
      navigationDecision.current?.(false)
      navigationDecision.current = resolve
      pendingLeave.current = () => {
        navigationDecision.current?.(true)
        navigationDecision.current = null
      }
      setLeaveOpen(true)
    }))
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (archived.current) return
      event.preventDefault()
      event.returnValue = ''
    }
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
  const saveState = definitionSaveState({ dirty, matchesPublished: record ? matchesPublished(record) : null })
  const publishReason = publishBlockReason({ busy: saving, dirty, saveFailed: Boolean(saveError), blocking, checking: !runtimeChecked })
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

  const saveDraft = async (): Promise<boolean> => {
    if (!record || !draft) return false
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
      if (!shouldApplyAsyncResult(started, gate.current.current())) return false
      // Edits made while it saved stay on screen; the next autosave takes them.
      const sent = draft
      setRecord(next)
      const snap = snapshotFromRecord(next)
      setBaseline(snap)
      setDraft((current) => (current === sent ? snap : current))
      setSaveError(null)
      return true
    } catch (caught) {
      if (!shouldApplyAsyncResult(started, gate.current.current())) return false
      if (isAgentDefinitionClientError(caught) && caught.code === 'REVISION_CONFLICT') {
        setConflictMessage(caught.message)
      } else {
        setSaveError(isAgentDefinitionClientError(caught) ? caught.message : String(caught))
      }
      return false
    } finally {
      if (shouldApplyAsyncResult(started, gate.current.current())) setSaving(false)
    }
  }

  // Edits save themselves; a failed save waits for Retry or the next edit.
  useAutosave(draft, { dirty, canSave: Boolean(record && draft) && !saving && !archiving && !conflictMessage, save: saveDraft })

  /** The automations whose Who is this agent: they get what is published on their next run. */
  const usersOf = async (): Promise<PublishUser[]> => {
    if (!record) return []
    try {
      const jobs = await window.mousse?.scheduled?.list?.() ?? []
      return jobs.filter((job) => job.agent?.definitionId === record.id).map((job) => ({ id: job.id, name: job.name }))
    } catch {
      return []
    }
  }

  const publish = async (confirmed = false) => {
    if (!record || !canPublish) return
    if (!confirmed) {
      const users = await usersOf()
      if (users.length) {
        setPublishUsers(users)
        return
      }
    }
    setPublishUsers(null)
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
    // An issue in a setting behind More opens More first.
    if (document.getElementById(fieldId)?.closest('[data-agent-more]')?.hasAttribute('hidden')) {
      setMoreOpen(true)
      requestAnimationFrame(() => focusIssue(fieldId))
      return
    }
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

  // The draft, unsaved edits included, stays until the archive succeeds; a failure keeps it as it was.
  const archive = async () => {
    if (!record) return
    const started = gate.current.current()
    setArchiving(true)
    setError(null)
    try {
      await client.archive({ profileId, id: record.id })
      if (!shouldApplyAsyncResult(started, gate.current.current())) return
      archived.current = true
      onBack()
    } catch (caught) {
      if (shouldApplyAsyncResult(started, gate.current.current())) {
        setError(`Couldn't archive: ${isAgentDefinitionClientError(caught) ? caught.message : String(caught)}`)
      }
    } finally {
      if (shouldApplyAsyncResult(started, gate.current.current())) setArchiving(false)
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
        <SaveStateLabel state={saveState} extra={saving ? 'Saving…' : runsOn ? `Runs on ${runsOn}` : null} />
        {!dirty ? <FixIssuesLink issues={blocking} onShow={() => focusIssue(blocking[0].fieldId)} /> : null}
        <div className="agent-defs__actions">
          <button
            type="button"
            className="settings-icon-btn automation-icon-toggle"
            data-action="favorite"
            aria-pressed={draft.flags.favorite}
            aria-label="Favorite"
            title={draft.flags.favorite ? 'Remove from favorites' : 'Add to favorites'}
            onClick={() => setDraft({ ...draft, flags: { ...draft.flags, favorite: !draft.flags.favorite } })}
          >
            <Star size={14} fill={draft.flags.favorite ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-action="publish"
            disabled={saving || archiving || !canPublish}
            title={publishReason ?? undefined}
            aria-describedby={publishReason ? publishReasonId : undefined}
            onClick={() => void publish()}
          >
            Publish
          </button>
          {publishReason ? <span id={publishReasonId} className="sr-only">{publishReason}</span> : null}
          <RowMenu
            label="Agent actions"
            disabled={saving || archiving}
            items={[
              { label: 'Duplicate', action: 'duplicate', onSelect: () => requestLeave(() => void duplicate()) },
              {
                label: 'Export',
                action: 'export',
                disabled: dirty,
                title: dirty ? 'Save or discard your edits to export the saved draft.' : undefined,
                onSelect: () => {
                  void client.exportBundle({ profileId, id: record.id }).then(
                    (bundle) => downloadJson(`${draft.settings.identity.slug || 'agent'}.mousse-agent.json`, bundle),
                    (caught: unknown) => setError(isAgentDefinitionClientError(caught) ? caught.message : String(caught))
                  )
                }
              },
              { label: 'Archive', action: 'archive', danger: true, onSelect: () => setArchiveOpen(true) }
            ]}
          />
        </div>
      </header>
      {saveError ? <SaveFailed message={saveError} busy={saving} onRetry={() => void saveDraft()} /> : null}
      {publishUsers ? <PublishImpactDialog users={publishUsers} onCancel={() => setPublishUsers(null)} onPublish={() => void publish(true)} /> : null}
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
            moreOpen={moreOpen}
            onMoreOpenChange={setMoreOpen}
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
      <ArchiveDefinitionDialog
        open={archiveOpen}
        kind="agent"
        name={record.settings.identity.name || 'Untitled agent'}
        dirty={dirty}
        onCancel={() => setArchiveOpen(false)}
        onConfirm={() => {
          setArchiveOpen(false)
          void archive()
        }}
      />
    </div>
  )
}

function CheckEnabled({ enabled, onChange }: { enabled: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="agent-check-row agent-switch-row">
      <span id="agent-enabled-label">Enabled</span>
      <Switch id="agent-enabled" checked={enabled} onChange={onChange} label="Enabled" />
    </div>
  )
}

export function focusEditorField(pointer: string): void {
  document.getElementById(fieldIdForPointer(pointer))?.scrollIntoView({ block: 'center' })
}
