import { Archive, Copy, Download, Redo2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkflowBundle, WorkflowDiagnostic, WorkflowEditorDocument, WorkflowManifest, WorkflowNode } from '../../../shared/workflows'
import type { AgentDefinitionsClient } from '../agentDefinitions/client'
import { assetText, upsertAsset } from './assets'
import { createAsyncGate, shouldApplyAsyncResult } from './asyncGate'
import {
  isRevisionConflict,
  isWorkflowClientError,
  type WorkflowDefinitionsClient,
  type WorkflowEditorCatalogs,
  type WorkflowExecutionClient,
  type WorkflowDocument,
  type WorkflowLeaveGuard,
  type WorkflowLeaveReason,
  type WorkflowRunView
} from './client'
import { createWorkflowNode } from './defaultNode'
import { DraftConflictDialog, UnsavedChangesDialog } from './dialogs'
import {
  addEdgeToManifest,
  canvasPositionsToEditor,
  duplicateNodes,
  removeEdgeFromManifest,
  removeNodes,
  replaceNode
} from './graphAdapter'
import { applyLayoutToEditor, autoLayoutPositions, nudgePosition } from './graphLayout'
import { createBoundedHistory, type BoundedHistory } from './history'
import { bundleToExportJson, downloadJson } from './importBundle'
import { newNodeId } from './ids'
import { collectLocalDiagnostics, explainInvalidConnection, mergeDiagnostics } from './localValidation'
import { isVisualOnlyChange, semanticIdentity } from './semanticIdentity'
import { parseManifestSource, stringifyManifest } from './sourceParse'
import { WorkflowCanvas } from './WorkflowCanvas'
import { WorkflowDiagnostics } from './WorkflowDiagnostics'
import { WorkflowHistoryPanel } from './WorkflowHistoryPanel'
import { WorkflowInspector } from './WorkflowInspector'
import { WorkflowOutline } from './WorkflowOutline'
import { WorkflowPalette } from './WorkflowPalette'
import { WorkflowRunPanel } from './WorkflowRunPanel'
import { WorkflowSourceEditor } from './WorkflowSourceEditor'

export interface WorkflowEditorProps {
  profileId: string
  definitionId: string
  client: WorkflowDefinitionsClient
  catalogs: WorkflowEditorCatalogs
  execution?: WorkflowExecutionClient
  agentDefinitions?: AgentDefinitionsClient
  onBack: () => void
  onOpenDefinition?: (id: string) => void
  onRegisterLeaveGuard?: (guard: WorkflowLeaveGuard | null) => void
  active?: boolean
}

interface DraftState {
  manifest: WorkflowManifest
  editor: WorkflowEditorDocument
  assets: WorkflowBundle['assets']
  lock: WorkflowBundle['lock']
}

function bundleFromDraft(draft: DraftState): WorkflowBundle {
  return { manifest: draft.manifest, editor: draft.editor, assets: draft.assets, lock: draft.lock }
}

function draftFromDocument(document: WorkflowDocument): DraftState {
  return {
    manifest: document.bundle.manifest,
    editor: document.bundle.editor ?? { schemaVersion: 1, nodes: {} },
    assets: document.bundle.assets ?? [],
    lock: document.bundle.lock
  }
}

function draftsEqual(a: DraftState, b: DraftState): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function WorkflowEditor({
  profileId,
  definitionId,
  client,
  catalogs,
  execution,
  agentDefinitions,
  onBack,
  onOpenDefinition,
  onRegisterLeaveGuard,
  active = true
}: WorkflowEditorProps) {
  const gate = useRef(createAsyncGate())
  const requestBoundary = useRef({ client, definitionId, profileId })
  if (
    requestBoundary.current.client !== client ||
    requestBoundary.current.definitionId !== definitionId ||
    requestBoundary.current.profileId !== profileId
  ) {
    gate.current.bump()
    requestBoundary.current = { client, definitionId, profileId }
  }
  const [document, setDocument] = useState<WorkflowDocument | null>(null)
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [baseline, setBaseline] = useState<DraftState | null>(null)
  const [history, setHistory] = useState<BoundedHistory<DraftState>>(() => createBoundedHistory<DraftState>())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('Loading')
  const [error, setError] = useState<string | null>(null)
  const [conflictMessage, setConflictMessage] = useState<string | null>(null)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const pendingLeave = useRef<(() => void) | null>(null)
  const [view, setView] = useState<'canvas' | 'source'>('canvas')
  const [sourceText, setSourceText] = useState('')
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [remoteDiagnostics, setRemoteDiagnostics] = useState<WorkflowDiagnostic[]>([])
  const [revisionView, setRevisionView] = useState<'draft' | 'published'>('draft')
  const [bottom, setBottom] = useState<'diagnostics' | 'run' | 'history' | 'outline'>('diagnostics')
  const [run, setRun] = useState<WorkflowRunView | null>(null)
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

  const applyDocument = (next: WorkflowDocument, keepLocal?: DraftState) => {
    setDocument(next)
    const snap = draftFromDocument(next)
    setBaseline(snap)
    const used = keepLocal ?? snap
    setDraft(used)
    setSourceText(stringifyManifest(used.manifest))
    setSourceError(null)
    setRemoteDiagnostics(next.compiled.diagnostics)
  }

  const load = useCallback(async () => {
    const started = gate.current.bump()
    setLoading(true)
    setSaving(false)
    setError(null)
    setDocument(null)
    setDraft(null)
    setBaseline(null)
    setHistory(createBoundedHistory<DraftState>())
    setRun(null)
    try {
      const next = await client.get({ profileId, id: definitionId })
      if (!shouldApplyAsyncResult(started, gate.current.current())) return
      applyDocument(next)
      setStatus(next.head ? 'Published revision available' : 'Draft')
    } catch (caught) {
      if (!shouldApplyAsyncResult(started, gate.current.current())) return
      setError(isWorkflowClientError(caught) ? caught.message : String(caught))
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

  const readOnly = revisionView === 'published'
  const dirty = Boolean(draft && baseline && (!draftsEqual(draft, baseline) || sourceError))
  const local = useMemo(() => (draft ? collectLocalDiagnostics(draft.manifest) : { diagnostics: [], preventable: [], runnableHint: false }), [draft])
  const diagnostics = useMemo(() => mergeDiagnostics(local.diagnostics, remoteDiagnostics), [local.diagnostics, remoteDiagnostics])
  const blocking = diagnostics.filter((item) => item.severity === 'error')
  const identity = draft ? semanticIdentity(draft.manifest, draft.assets) : ''

  const pushHistory = (previous: DraftState) => setHistory((current) => current.push(previous))

  const updateDraft = (updater: (current: DraftState) => DraftState, recordHistory = true) => {
    setDraft((current) => {
      if (!current || readOnly) return current
      if (recordHistory) pushHistory(current)
      const next = updater(current)
      if (view === 'canvas') setSourceText(stringifyManifest(next.manifest))
      return next
    })
  }

  const requestLeave = (action: () => void) => {
    if (!dirty) {
      action()
      return
    }
    pendingLeave.current = action
    setLeaveOpen(true)
  }

  const leaveGuard = useCallback<WorkflowLeaveGuard>(
    async (_reason: WorkflowLeaveReason) => {
      if (!dirty) return true
      return await new Promise<boolean>((resolve) => {
        pendingLeave.current = () => resolve(true)
        const previousStay = () => resolve(false)
        setLeaveOpen(true)
        pendingStay.current = previousStay
      })
    },
    [dirty]
  )
  const pendingStay = useRef<(() => void) | null>(null)

  useEffect(() => {
    onRegisterLeaveGuard?.(leaveGuard)
    return () => onRegisterLeaveGuard?.(null)
  }, [leaveGuard, onRegisterLeaveGuard])

  const validateRemote = async (bundle: WorkflowBundle) => {
    const started = gate.current.current()
    try {
      const result = await client.validate({ profileId, id: definitionId, bundle, mode: 'draft' })
      if (!shouldApplyAsyncResult(started, gate.current.current())) return
      setRemoteDiagnostics(result.diagnostics)
    } catch (caught) {
      if (!shouldApplyAsyncResult(started, gate.current.current())) return
      setError(isWorkflowClientError(caught) ? caught.message : String(caught))
    }
  }

  useEffect(() => {
    if (!draft || !active) return
    const handle = window.setTimeout(() => void validateRemote(bundleFromDraft(draft)), 250)
    return () => window.clearTimeout(handle)
  }, [active, draft, profileId, definitionId])

  const saveDraft = async () => {
    if (!document || !draft) return
    if (sourceError && view === 'source') {
      setError('Fix invalid source before saving.')
      return
    }
    setSaving(true)
    setError(null)
    const started = gate.current.current()
    const bundle = bundleFromDraft(draft)
    const visualOnly = baseline ? isVisualOnlyChange(bundleFromDraft(baseline), bundle) : false
    try {
      const next = await client.saveDraft({
        profileId,
        id: document.id,
        expectedDraftSemanticHash: document.semanticHash,
        expectedHeadRevisionId: document.head?.revisionId ?? null,
        bundle,
        visualOnly
      })
      if (!shouldApplyAsyncResult(started, gate.current.current())) return
      applyDocument(next)
      setStatus(visualOnly ? 'Visual draft saved' : 'Draft saved')
    } catch (caught) {
      if (!shouldApplyAsyncResult(started, gate.current.current())) return
      if (isRevisionConflict(caught)) setConflictMessage(isWorkflowClientError(caught) ? caught.message : 'Draft changed elsewhere.')
      else setError(isWorkflowClientError(caught) ? caught.message : String(caught))
    } finally {
      if (shouldApplyAsyncResult(started, gate.current.current())) setSaving(false)
    }
  }

  const publish = async () => {
    if (!document || dirty || blocking.length > 0) return
    setSaving(true)
    setError(null)
    const started = gate.current.current()
    try {
      await client.publish({
        profileId,
        id: document.id,
        expectedDraftSemanticHash: document.semanticHash,
        expectedHeadRevisionId: document.head?.revisionId ?? null
      })
      if (!shouldApplyAsyncResult(started, gate.current.current())) return
      await load()
    } catch (caught) {
      if (!shouldApplyAsyncResult(started, gate.current.current())) return
      if (isRevisionConflict(caught)) setConflictMessage(isWorkflowClientError(caught) ? caught.message : 'Draft changed elsewhere.')
      else setError(isWorkflowClientError(caught) ? caught.message : String(caught))
      setSaving(false)
    }
  }

  const addNode = (type: string, extra?: Record<string, unknown>) => {
    updateDraft((current) => {
      const id = newNodeId(current.manifest.nodes.map((node) => node.id), type)
      const node = createWorkflowNode(type, id, extra ? { config: { ...createWorkflowNode(type, id).config, ...extra } } : {})
      const nodes = [...current.manifest.nodes, node]
      const editor = {
        ...current.editor,
        nodes: {
          ...(current.editor.nodes ?? {}),
          [id]: { x: 80 + (nodes.length % 4) * 240, y: 80 + Math.floor(nodes.length / 4) * 140 }
        }
      }
      setSelectedId(id)
      return { ...current, manifest: { ...current.manifest, nodes }, editor }
    })
  }

  const switchView = (next: 'canvas' | 'source') => {
    if (next === view) return
    if (next === 'source' && draft) {
      setSourceText(stringifyManifest(draft.manifest))
      setSourceError(null)
      setView('source')
      return
    }
    const parsed = parseManifestSource(sourceText)
    if (!parsed.ok) {
      setSourceError(parsed.error)
      setStatus('Invalid source retained')
      return
    }
    updateDraft((current) => ({ ...current, manifest: parsed.manifest }), true)
    setSourceError(null)
    setStatus('Source applied')
    setView('canvas')
  }

  const onSourceChange = (text: string) => {
    setSourceText(text)
    const parsed = parseManifestSource(text)
    if (!parsed.ok) {
      setSourceError(parsed.error)
      return
    }
    setSourceError(null)
    setDraft((current) => (current ? { ...current, manifest: parsed.manifest } : current))
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveDraft()
      }
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        setDraft((current) => {
          if (!current) return current
          const result = event.shiftKey ? history.redo(current) : history.undo(current)
          if (!result) return current
          setHistory(result.history)
          setSourceText(stringifyManifest(result.next.manifest))
          return result.next
        })
      }
      if (meta && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        setDraft((current) => {
          if (!current) return current
          const result = history.redo(current)
          if (!result) return current
          setHistory(result.history)
          return result.next
        })
      }
      if (meta && event.key.toLowerCase() === 'd' && selectedId && draft) {
        event.preventDefault()
        updateDraft((current) => {
          const duplicated = duplicateNodes(current.manifest, [selectedId], newNodeId)
          return { ...current, manifest: duplicated.manifest }
        })
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId && view === 'canvas' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
        updateDraft((current) => ({ ...current, manifest: removeNodes(current.manifest, [selectedId]) }))
        setSelectedId(null)
      }
      if (event.shiftKey && selectedId && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault()
        const dx = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
        const dy = event.key === 'ArrowUp' ? -16 : event.key === 'ArrowDown' ? 16 : 0
        updateDraft((current) => ({ ...current, editor: nudgePosition(current.editor, selectedId, dx, dy) }), false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (loading && !draft) {
    return (
      <div className="wf-root wf-loading" role="status">
        Loading workflow…
      </div>
    )
  }
  if (error && !draft) {
    return (
      <div className="wf-root wf-error" role="alert">
        <button type="button" className="wf-crumb" onClick={onBack}>
          ← Workflows
        </button>
        <p>{error}</p>
      </div>
    )
  }
  if (!document || !draft) return null

  const selected = draft.manifest.nodes.find((node) => node.id === selectedId) ?? null
  const instructions = draft.manifest.instructionsFile ? assetText(draft.assets, draft.manifest.instructionsFile) : ''
  const runOutcomes = Object.fromEntries((run?.attempts ?? []).map((attempt) => [attempt.nodeId, attempt.outcome]))
  const canPublish = !dirty && blocking.length === 0 && !sourceError
  const duplicateSupported = Boolean(client.duplicate)
  const archiveSupported = Boolean(client.archive)

  return (
    <div
      className="wf-root wf-editor"
      data-workflow-editor=""
      data-dirty={dirty ? 'true' : 'false'}
      data-layout={desktop ? 'desktop' : 'narrow'}
      data-profile-id={profileId}
      data-definition-id={definitionId}
      data-view={view}
      data-revision-view={revisionView}
    >
      <header className="wf-header">
        <button type="button" className="wf-crumb" data-action="back" onClick={() => requestLeave(onBack)}>
          ← Workflows
        </button>
        <span className="wf-title">{draft.manifest.name || 'Untitled workflow'}</span>
        <span className="wf-status" data-editor-status="">
          {status}
          {dirty ? ' · Unsaved' : ''}
          {sourceError ? ' · Invalid source retained' : ''}
          {readOnly ? ' · Published revision (read-only)' : ''}
        </span>
        <div className="wf-actions">
          {readOnly ? (
            <button type="button" className="btn btn-sm" data-action="view-draft" onClick={() => { setRevisionView('draft'); void load() }}>
              View draft
            </button>
          ) : null}
          <button type="button" className="btn btn-sm" data-action="undo" disabled={!history.canUndo || readOnly} onClick={() => {
            setDraft((current) => {
              if (!current) return current
              const result = history.undo(current)
              if (!result) return current
              setHistory(result.history)
              return result.next
            })
          }}>
            <Undo2 size={14} /> Undo
          </button>
          <button type="button" className="btn btn-sm" data-action="redo" disabled={!history.canRedo || readOnly} onClick={() => {
            setDraft((current) => {
              if (!current) return current
              const result = history.redo(current)
              if (!result) return current
              setHistory(result.history)
              return result.next
            })
          }}>
            <Redo2 size={14} /> Redo
          </button>
          <button
            type="button"
            className="btn btn-sm"
            data-action="view-canvas"
            aria-pressed={view === 'canvas'}
            onClick={() => switchView('canvas')}
          >
            Canvas
          </button>
          <button
            type="button"
            className="btn btn-sm"
            data-action="view-source"
            aria-pressed={view === 'source'}
            onClick={() => switchView('source')}
          >
            Source
          </button>
          <button
            type="button"
            className="btn btn-sm"
            data-action="auto-layout"
            disabled={readOnly}
            onClick={() =>
              updateDraft((current) => ({
                ...current,
                editor: applyLayoutToEditor(
                  current.editor,
                  autoLayoutPositions(current.manifest.nodes, current.manifest.edges, current.manifest.entryNodeId)
                )
              }))
            }
          >
            Auto-layout
          </button>
          <button
            type="button"
            className="btn btn-sm"
            data-action="save-draft"
            disabled={saving || !dirty || readOnly}
            onClick={() => void saveDraft()}
          >
            {saving ? 'Saving…' : 'Save draft'}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-action="publish"
            disabled={saving || !canPublish || readOnly}
            title={blocking[0]?.message}
            onClick={() => void publish()}
          >
            Publish version
          </button>
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Duplicate workflow"
            disabled={saving || !duplicateSupported}
            title={duplicateSupported ? undefined : 'Duplicate is not provided by the host definitions port.'}
            onClick={() =>
              requestLeave(() => {
                if (!client.duplicate) return
                const started = gate.current.current()
                void client.duplicate({ profileId, id: document.id })
                  .then((copy) => {
                    if (!shouldApplyAsyncResult(started, gate.current.current())) return
                    onOpenDefinition?.(copy.id) ?? onBack()
                  })
                  .catch((caught: unknown) => {
                    if (shouldApplyAsyncResult(started, gate.current.current())) {
                      setError(isWorkflowClientError(caught) ? caught.message : String(caught))
                    }
                  })
              })
            }
          >
            <Copy size={14} /> Duplicate
          </button>
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Export workflow"
            disabled={saving || dirty}
            title={dirty ? 'Save or discard local edits before exporting the registry draft.' : undefined}
            onClick={() => {
              const started = gate.current.current()
              void client.exportBundle({ profileId, id: document.id })
                .then((bundle) => {
                  if (!shouldApplyAsyncResult(started, gate.current.current())) return
                  downloadJson(`${draft.manifest.slug || 'workflow'}.mousse-workflow.json`, bundleToExportJson(bundle))
                })
                .catch((caught: unknown) => {
                  if (shouldApplyAsyncResult(started, gate.current.current())) {
                    setError(isWorkflowClientError(caught) ? caught.message : String(caught))
                  }
                })
            }}
          >
            <Download size={14} /> Export
          </button>
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Archive workflow"
            disabled={saving || !archiveSupported}
            title={archiveSupported ? undefined : 'Archive is not provided by the host definitions port.'}
            onClick={() =>
              requestLeave(() => {
                if (!client.archive) return
                const started = gate.current.current()
                void client.archive({ profileId, id: document.id })
                  .then(() => {
                    if (shouldApplyAsyncResult(started, gate.current.current())) onBack()
                  })
                  .catch((caught: unknown) => {
                    if (shouldApplyAsyncResult(started, gate.current.current())) {
                      setError(isWorkflowClientError(caught) ? caught.message : String(caught))
                    }
                  })
              })
            }
          >
            <Archive size={14} /> Archive
          </button>
        </div>
      </header>
      {error ? (
        <div className="wf-banner wf-banner--error" role="alert">
          {error}
        </div>
      ) : null}
      {connectionError ? (
        <div className="wf-banner wf-banner--error" role="alert">
          {connectionError}
        </div>
      ) : null}
      <div className="wf-editor__body">
        <WorkflowPalette catalogs={catalogs} disabled={readOnly || view !== 'canvas'} onAdd={addNode} />
        {view === 'source' ? (
          <WorkflowSourceEditor
            value={sourceText}
            diagnosticsText={sourceError ?? undefined}
            readOnly={readOnly}
            onChange={onSourceChange}
            onSave={() => void saveDraft()}
          />
        ) : (
          <WorkflowCanvas
            manifest={draft.manifest}
            editor={draft.editor}
            selectedId={selectedId ?? undefined}
            runOutcomes={runOutcomes}
            readOnly={readOnly}
            onSelect={setSelectedId}
            onConnect={(edge) => {
              const reason = explainInvalidConnection(draft.manifest, edge)
              if (reason) {
                setConnectionError(reason)
                return
              }
              setConnectionError(null)
              updateDraft((current) => ({ ...current, manifest: addEdgeToManifest(current.manifest, edge) }))
            }}
            onDisconnect={(id) => updateDraft((current) => ({ ...current, manifest: removeEdgeFromManifest(current.manifest, id) }))}
            onDeleteNodes={(ids) => {
              updateDraft((current) => ({ ...current, manifest: removeNodes(current.manifest, ids) }))
              setSelectedId(null)
            }}
            onPositionsChange={(nodes) =>
              updateDraft((current) => ({ ...current, editor: canvasPositionsToEditor(current.editor, nodes, current.editor.viewport) }), false)
            }
            connectionError={connectionError}
            onConnectionError={setConnectionError}
          />
        )}
        <WorkflowInspector
          profileId={profileId}
          manifest={draft.manifest}
          node={selected}
          readOnly={readOnly}
          catalogs={catalogs}
          agentDefinitions={agentDefinitions}
          instructions={instructions}
          onChangeNode={(node: WorkflowNode) => updateDraft((current) => ({ ...current, manifest: replaceNode(current.manifest, node) }))}
          onChangeManifest={(manifest) => updateDraft((current) => ({ ...current, manifest }))}
          onChangeInstructions={(value) =>
            updateDraft((current) => ({
              ...current,
              assets: current.manifest.instructionsFile
                ? upsertAsset(current.assets, current.manifest.instructionsFile, value)
                : current.assets
            }))
          }
        />
        <div className="wf-bottom" data-bottom={bottom}>
          <div className="wf-inline">
            <button type="button" className="btn btn-sm" onClick={() => setBottom('diagnostics')}>
              Validation
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setBottom('outline')}>
              Outline
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setBottom('run')}>
              Run
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setBottom('history')}>
              History
            </button>
          </div>
          {bottom === 'diagnostics' ? <WorkflowDiagnostics diagnostics={diagnostics} onSelectNode={setSelectedId} /> : null}
          {bottom === 'outline' ? (
            <WorkflowOutline
              manifest={draft.manifest}
              selectedId={selectedId}
              readOnly={readOnly}
              onSelect={setSelectedId}
              onConnect={(edge) => {
                const reason = explainInvalidConnection(draft.manifest, edge)
                if (reason) {
                  setConnectionError(reason)
                  return
                }
                setConnectionError(null)
                updateDraft((current) => ({ ...current, manifest: addEdgeToManifest(current.manifest, edge) }))
              }}
              onDelete={(ids) => {
                updateDraft((current) => ({ ...current, manifest: removeNodes(current.manifest, ids) }))
                setSelectedId(null)
              }}
            />
          ) : null}
          {bottom === 'run' ? (
            <WorkflowRunPanel
              profileId={profileId}
              definitionId={definitionId}
              manifest={draft.manifest}
              semanticHash={document.semanticHash}
              revisionId={document.head?.revisionId}
              execution={execution}
              run={run}
              draft={dirty || !document.head || document.semanticHash !== document.head.semanticHash}
              readOnlyReason={dirty ? 'Save the draft before running it.' : undefined}
              onRunChange={setRun}
            />
          ) : null}
          {bottom === 'history' ? (
            <WorkflowHistoryPanel
              profileId={profileId}
              definitionId={definitionId}
              client={client}
              currentSemanticHash={document.semanticHash}
              onViewRevision={async (revisionId) => {
                if (!client.getRevision) return
                const started = gate.current.bump()
                try {
                  const next = await client.getRevision({ profileId, id: definitionId, revisionId })
                  if (!shouldApplyAsyncResult(started, gate.current.current())) return
                  applyDocument(next)
                  setRevisionView('published')
                  setStatus('Published revision (read-only)')
                } catch (caught) {
                  if (shouldApplyAsyncResult(started, gate.current.current())) {
                    setError(isWorkflowClientError(caught) ? caught.message : String(caught))
                  }
                }
              }}
              onRestore={(revisionId) => {
                if (!client.restoreRevision) return
                const started = gate.current.bump()
                void client
                  .restoreRevision({ profileId, id: definitionId, revisionId, expectedDraftSemanticHash: document.semanticHash })
                  .then((next) => {
                    if (!shouldApplyAsyncResult(started, gate.current.current())) return
                    applyDocument(next)
                    setRevisionView('draft')
                  })
                  .catch((caught: unknown) => {
                    if (shouldApplyAsyncResult(started, gate.current.current())) {
                      if (isRevisionConflict(caught)) {
                        setConflictMessage(isWorkflowClientError(caught) ? caught.message : 'Draft changed elsewhere.')
                      } else {
                        setError(isWorkflowClientError(caught) ? caught.message : String(caught))
                      }
                    }
                  })
              }}
            />
          ) : null}
        </div>
      </div>
      <span className="wf-hidden" data-semantic-identity="">
        {identity}
      </span>
      <UnsavedChangesDialog
        open={leaveOpen}
        onStay={() => {
          setLeaveOpen(false)
          pendingLeave.current = null
          pendingStay.current?.()
          pendingStay.current = null
        }}
        onDiscard={() => {
          setLeaveOpen(false)
          setDraft(baseline)
          if (baseline) setSourceText(stringifyManifest(baseline.manifest))
          setSourceError(null)
          setSelectedId(null)
          setHistory(createBoundedHistory<DraftState>())
          const action = pendingLeave.current
          pendingLeave.current = null
          pendingStay.current = null
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
