import { useCallback } from 'react'
import { Check, Loader2, MessageSquare, MessageSquarePlus, Pencil, Plus, Terminal } from '../../lib/icons'
import { quickActionKindLabel, type QuickAction, type QuickActionKind } from '../../lib/quickActions'
import {
  useQuickActions,
  useQuickActionsStore,
  useRunFeedback,
  type QuickActionEditorTarget
} from '../../stores/quickActionsStore'
import { ACTIONS_FOCUS_ANCHOR } from './actionsRunLogic'
import { SideCardSection, type SideCardSectionContext } from './SideCardSection'
import './actionsSection.css'

export function QuickActionKindIcon({ kind }: { kind: QuickActionKind }) {
  if (kind === 'bash') return <Terminal size={13} strokeWidth={2} aria-hidden="true" />
  if (kind === 'send-new-chat') return <MessageSquarePlus size={13} strokeWidth={2} aria-hidden="true" />
  return <MessageSquare size={13} strokeWidth={2} aria-hidden="true" />
}

/**
 * One click runs an action. Edit and add open the shared editor, which the app renders
 * once (`QuickActionEditorHost`). Run feedback and the open editor live in the quick
 * actions store, so they survive this card unmounting and never carry into another profile.
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
  const feedback = useRunFeedback(profileId)
  const running = feedback?.phase === 'running'

  const handleRun = useCallback(
    (action: QuickAction) => {
      if (!running) void useQuickActionsStore.getState().runAction(action, profileId)
    },
    [profileId, running]
  )

  const openEditor = useCallback(
    (target: QuickActionEditorTarget) => {
      useQuickActionsStore.getState().openEditor(target, profileId)
    },
    [profileId]
  )

  return (
    <SideCardSection title="Actions" threadId={threadId}>
      <div className="side-card-actions">
        {actions.length > 0 && (
          <div className="side-card-action-list" role="list">
            {actions.map((action) => {
              const own = feedback?.id === action.id ? feedback : null
              // A row blocked by another run stays focusable: aria-disabled, with clicks ignored.
              const blocked = running && own?.phase !== 'running'
              return (
                <div key={action.id} role="listitem">
                  <div className="side-card-action-row">
                    <button
                      type="button"
                      className="side-card-action-run"
                      title={blocked ? 'An action is running' : `${action.label} — ${quickActionKindLabel(action.kind)}`}
                      aria-disabled={running || undefined}
                      data-blocked={blocked || undefined}
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
                      title={running ? 'An action is running' : `Edit ${action.label}`}
                      aria-label={`Edit ${action.label}`}
                      aria-disabled={running || undefined}
                      onClick={() => {
                        if (!running) openEditor({ mode: 'edit', action })
                      }}
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
          </div>
        )}
        <button
          type="button"
          className="side-card-action-add"
          {...{ [ACTIONS_FOCUS_ANCHOR]: '' }}
          onClick={() => openEditor({ mode: 'add' })}
        >
          <Plus size={13} strokeWidth={2} aria-hidden="true" />
          <span>Add action</span>
        </button>
      </div>
    </SideCardSection>
  )
}
