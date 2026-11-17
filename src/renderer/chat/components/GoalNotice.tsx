import { useEffect, useMemo, useState } from 'react'
import { Crosshair } from '../../lib/icons'
import { ipcErrorLine } from '../../lib/errorText'
import { useAppStore } from '../../stores/appStore'
import { useComposerNotice, type ComposerNoticeAction, type ComposerNoticeProps } from '../../components/ComposerNotice'
import { goalDetails, goalReason, goalStateLabel, type ThreadGoal } from '../../../shared/threadGoal'
import type { PlatformRequestApi } from '../../../shared/platform'

/** What the goal marker's buttons do. */
export type GoalAction = 'stop' | 'continue' | 'clear'

export interface GoalClient {
  act(threadId: string, action: GoalAction): Promise<void>
}

export function createGoalClient(api: PlatformRequestApi): GoalClient {
  return {
    async act(threadId, action) { await api.request('threads.goal', { threadId, action }) }
  }
}

export interface GoalNoticeInput {
  goal: ThreadGoal
  /** The press in flight, if any; every button ignores presses until it settles. */
  busy: GoalAction | null
  error: string | null
  onAct: (action: GoalAction) => void
  onDismissError: () => void
}

/**
 * The goal marker, as the composer's notice: one line ("Goal · Working · turn 3/20", then the goal), the full goal
 * and the latest word on it in the tooltip, and the one action its state needs: Stop while working, Continue when
 * stuck or stopped, Clear when met. A goal that is not working can also be cleared with the notice's dismiss.
 */
export function goalNotice({ goal, busy, error, onAct, onDismissError }: GoalNoticeInput): ComposerNoticeProps {
  const blocked = busy !== null
  const action = (kind: GoalAction, label: string, busyLabel: string, extra: Partial<ComposerNoticeAction> = {}): ComposerNoticeAction =>
    ({ label: busy === kind ? busyLabel : label, blocked, busy: busy === kind, onClick: () => onAct(kind), ...extra })
  const actions: ComposerNoticeAction[] = goal.state === 'working'
    ? [action('stop', 'Stop', 'Stopping…', { title: 'Stop working on the goal, and the turn running for it' })]
    : goal.state === 'met'
      ? [action('clear', 'Clear', 'Clearing…', { title: 'Remove the goal from this thread' })]
      : [action('continue', 'Continue', 'Continuing…', { primary: true, title: `Keep working on the goal, up to ${goal.turnLimit} more turns` })]
  const line = `Goal · ${goalStateLabel(goal)}`
  // Stuck: the agent's reason is what the person needs to read first.
  const detail = goal.state === 'stuck' ? goalReason(goal) ?? goal.text : goal.text
  const tooltip = goalDetails(goal)
  return {
    tone: error ? 'error' : goal.state === 'stuck' ? 'warning' : 'info',
    ...(error ? {} : { icon: <Crosshair size={14} strokeWidth={2} aria-hidden="true" /> }),
    label: 'Thread goal',
    title: error ?? line,
    ...(error ? {} : { detail }),
    tooltip: error ? `${line}. ${tooltip}` : tooltip,
    actions,
    ...(error ? { onDismiss: onDismissError } : goal.state !== 'working' && goal.state !== 'met' ? { onDismiss: () => onAct('clear') } : {})
  }
}

/** The goal of `threadId`, from the thread list; undefined when it has none. */
export function useThreadGoal(threadId: string | null | undefined): ThreadGoal | undefined {
  return useAppStore((state) => (threadId ? state.threads.find((thread) => thread.id === threadId)?.goal : undefined))
}

/** The goal marker of a thread with a goal. Shows nothing for one without. */
export function GoalNotice({ threadId, client }: { threadId?: string | null; client?: GoalClient }) {
  const goal = useThreadGoal(threadId)
  const [busy, setBusy] = useState<GoalAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const actions = useMemo(() => client ?? createGoalClient(window.mousse.platformRequest), [client])
  // Another thread, or a goal set again, starts clean.
  useEffect(() => { setBusy(null); setError(null) }, [threadId, goal?.setAt])
  const act = async (action: GoalAction) => {
    if (!threadId || busy) return
    setBusy(action)
    setError(null)
    try { await actions.act(threadId, action) }
    catch (failure) { setError(ipcErrorLine(failure) || 'The goal could not be changed.') }
    finally { setBusy(null) }
  }
  useComposerNotice(goal ? goalNotice({ goal, busy, error, onAct: (action) => void act(action), onDismissError: () => setError(null) }) : null)
  return null
}

/** A line a composer command answered with (`/goal` alone), until dismissed. */
export function CommandInfoNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useComposerNotice({ tone: 'info', title: message.split('\n')[0] ?? message, detail: message.split('\n').slice(1).join(' · ') || undefined, tooltip: message, onDismiss })
  return null
}
