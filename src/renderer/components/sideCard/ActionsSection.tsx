import { useCallback, useEffect, useState } from 'react'
import { Check, Loader2, MessageSquare, MessageSquarePlus, Pencil, Plus, Terminal } from '../../lib/icons'
import { executeQuickAction } from '../../lib/executeQuickAction'
import { quickActionKindLabel, type QuickAction, type QuickActionKind } from '../../lib/quickActions'
import { useQuickActions, useQuickActionsStore } from '../../stores/quickActionsStore'
import { QuickActionEditor } from '../QuickActionEditor'
import { createRunController, type RunFeedback } from './actionsRunLogic'
import { SideCardSection, type SideCardSectionContext } from './SideCardSection'
import './actionsSection.css'

/** The editor target: a new action, or the action being edited. */
type EditorTarget = { mode: 'add' } | { mode: 'edit'; action: QuickAction }

export function QuickActionKindIcon({ kind }: { kind: QuickActionKind }) {
  if (kind === 'bash') return <Terminal size={13} strokeWidth={2} aria-hidden="true" />
  if (kind === 'send-new-chat') return <MessageSquarePlus size={13} strokeWidth={2} aria-hidden="true" />
  return <MessageSquare size={13} strokeWidth={2} aria-hidden="true" />
}

/**
 * One click runs an action. Edit, delete and add open the shared editor. The list is
 * keyed by profile, so an open editor or a running action never carries over into
 * another profile.
 */
export function ActionsSection({ threadId }: SideCardSectionContext) {
  const { profileId, actions } = useQuickActions()
  return <ActionsList key={profileId} threadId={threadId} profileId={profileId} actions={actions} />
}

interface ActionsListProps {
  threadId: string | null
  profileId: string
  actions: QuickAction[]
}

function ActionsList({ threadId, profileId, actions }: ActionsListProps) {
  const [feedback, setFeedback] = useState<RunFeedback | null>(null)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [runs] = useState(() => createRunController({ execute: executeQuickAction, onFeedback: setFeedback }))
  useEffect(() => runs.cancel, [runs])

  const running = feedback?.phase === 'running'

  const handleRun = useCallback(
    (action: QuickAction) => {
      if (!running) void runs.run(action, profileId)
    },
    [profileId, running, runs]
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
                  onClick={() => handleRun(action)}
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
            if (editing) store.update(editing.id, input, profileId)
            else store.add(input, profileId)
          }}
          onDelete={editing ? () => useQuickActionsStore.getState().remove(editing.id, profileId) : undefined}
          onClose={closeEditor}
        />
      )}
    </SideCardSection>
  )
}
