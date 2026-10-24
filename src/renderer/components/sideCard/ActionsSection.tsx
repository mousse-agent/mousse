import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Loader2, MessageSquare, MessageSquarePlus, Pencil, Plus, Terminal } from '../../lib/icons'
import { executeQuickAction } from '../../lib/executeQuickAction'
import { quickActionKindLabel, type QuickAction, type QuickActionKind } from '../../lib/quickActions'
import { startQuickActionsSync, useQuickActions, useQuickActionsStore } from '../../stores/quickActionsStore'
import { QuickActionEditor } from '../QuickActionEditor'
import { SideCardSection, type SideCardSectionContext } from './SideCardSection'
import './actionsSection.css'

/** How long the done check stays, and how long an error stays, after a run. */
const DONE_FEEDBACK_MS = 1600
const ERROR_FEEDBACK_MS = 8000

type RunFeedback = { id: string; phase: 'running' | 'done' } | { id: string; phase: 'error'; message: string }

/** The editor target: a new action, or the action being edited. */
type EditorTarget = { mode: 'add' } | { mode: 'edit'; action: QuickAction }

export function QuickActionKindIcon({ kind }: { kind: QuickActionKind }) {
  if (kind === 'bash') return <Terminal size={13} strokeWidth={2} aria-hidden="true" />
  if (kind === 'send-new-chat') return <MessageSquarePlus size={13} strokeWidth={2} aria-hidden="true" />
  return <MessageSquare size={13} strokeWidth={2} aria-hidden="true" />
}

/** One click runs an action. Edit, delete and add open the shared editor. */
export function ActionsSection({ threadId }: SideCardSectionContext) {
  const { profileId, actions } = useQuickActions()
  const [feedback, setFeedback] = useState<RunFeedback | null>(null)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    startQuickActionsSync()
    useQuickActionsStore.getState().syncProfile()
  }, [profileId])

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])
  useEffect(() => clearTimer, [clearTimer])

  // A list from another profile's run says nothing about this one.
  useEffect(() => {
    clearTimer()
    setFeedback(null)
  }, [profileId, clearTimer])

  const running = feedback?.phase === 'running'

  const handleRun = useCallback(
    async (action: QuickAction) => {
      if (running) return
      clearTimer()
      setFeedback({ id: action.id, phase: 'running' })
      let next: RunFeedback
      try {
        await executeQuickAction(action, profileId)
        next = { id: action.id, phase: 'done' }
      } catch (error) {
        next = { id: action.id, phase: 'error', message: error instanceof Error ? error.message : 'Action failed.' }
      }
      setFeedback(next)
      timerRef.current = setTimeout(
        () => setFeedback(null),
        next.phase === 'error' ? ERROR_FEEDBACK_MS : DONE_FEEDBACK_MS
      )
    },
    [clearTimer, profileId, running]
  )

  const closeEditor = useCallback(() => setEditor(null), [])
  const editing = editor?.mode === 'edit' ? editor.action : null

  return (
    <SideCardSection title="Actions" threadId={threadId}>
      <div className="side-card-actions" role="list">
        {actions.map((action) => {
          const own = feedback?.id === action.id ? feedback : null
          return (
            <div key={action.id} role="listitem">
              <div className="side-card-action-row">
                <button
                  type="button"
                  className="side-card-action-run"
                  title={`${action.label} — ${quickActionKindLabel(action.kind)}`}
                  disabled={running}
                  onClick={() => void handleRun(action)}
                >
                  <span className="side-card-action-kind">
                    <QuickActionKindIcon kind={action.kind} />
                  </span>
                  <span className="side-card-action-label">{action.label}</span>
                  {own?.phase === 'running' && (
                    <Loader2 size={13} strokeWidth={2} className="side-card-action-spin" aria-label="Running" />
                  )}
                  {own?.phase === 'done' && (
                    <Check size={13} strokeWidth={2} className="side-card-action-done" aria-label="Done" />
                  )}
                </button>
                <button
                  type="button"
                  className="side-card-action-edit"
                  title={`Edit ${action.label}`}
                  aria-label={`Edit ${action.label}`}
                  disabled={running}
                  onClick={() => setEditor({ mode: 'edit', action })}
                >
                  <Pencil size={12} strokeWidth={2} />
                </button>
              </div>
              {own?.phase === 'error' && (
                <p className="side-card-action-error" role="alert">
                  {own.message}
                </p>
              )}
            </div>
          )
        })}
        <button type="button" className="side-card-action-add" onClick={() => setEditor({ mode: 'add' })}>
          <Plus size={13} strokeWidth={2} aria-hidden="true" />
          <span>Add action</span>
        </button>
      </div>

      {editor && (
        <QuickActionEditor
          key={editing?.id ?? 'new'}
          action={editing}
          onSave={(input) => {
            const store = useQuickActionsStore.getState()
            if (editing) store.update(editing.id, input)
            else store.add(input)
          }}
          onDelete={editing ? () => useQuickActionsStore.getState().remove(editing.id) : undefined}
          onClose={closeEditor}
        />
      )}
    </SideCardSection>
  )
}
