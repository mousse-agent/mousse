import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { ArchiveRestore, RotateCcw, Trash2 } from '../../lib/icons'
import { createTrashController, deleteElsewhere, trashRows, type TrashController, type TrashState } from '../../lib/trashInventory'
import { PermanentDeleteDialog } from './PermanentDeleteDialog'
import { skippedLine } from '../../lib/threadSearchSkipped'

/** While the section is open the list is re-read this often, so the countdown and the daemon's own sweeps show up. */
const OPEN_REFRESH_MS = 15_000

export interface RecentlyDeletedActions {
  onToggle: () => void
  onRestore: (taskId: string) => void
  onDelete: (taskId: string) => void
  onRetry: (taskId: string) => void
}

/** Trashed threads, restorable or permanently deletable, under the Settled block. */
export function RecentlyDeletedSection({ hidden = false }: { hidden?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  /** Set when an action started from a row's button; the row may vanish, and keyboard focus must not fall to the page. */
  const refocus = useRef<{ index: number; action: string } | null>(null)
  const controller = useMemo<TrashController>(() => createTrashController({
    inventory: () => window.mousse.threads.inventory(undefined, { includeComputers: true }),
    restore: (threadId) => window.mousse.threads.restore(threadId),
    purge: (threadId, options) => window.mousse.threads.purge(threadId, options)
  }), [])
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)

  useEffect(() => {
    const off = window.mousse.threads.onUpdated((threads) => controller.threadsChanged(threads.map((thread) => thread.id)))
    return () => { off(); controller.dispose() }
  }, [controller])
  useEffect(() => {
    if (hidden) return
    const refresh = () => { if (!document.hidden) void controller.refresh() }
    refresh()
    document.addEventListener('visibilitychange', refresh)
    // Only an open list needs to keep up; the count in the heading follows thread updates.
    const timer = expanded ? window.setInterval(refresh, OPEN_REFRESH_MS) : undefined
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [controller, hidden, expanded])

  // After a row's action, focus the next row (or the previous one, or the heading) if the focused button went away.
  useEffect(() => {
    const pending = refocus.current
    const root = rootRef.current
    if (!pending || !root || state.busyTaskId || state.confirmation) return
    refocus.current = null
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    const rows = [...root.querySelectorAll<HTMLElement>('[data-testid="sidebar-trash-row"]')]
    const row = rows[pending.index]
    // The same button when the row is still there, else the first button of whichever row slid into its place.
    const target = row?.querySelector<HTMLElement>(`button[data-action="${pending.action}"]:not(:disabled)`)
      ?? (row ?? rows[pending.index - 1])?.querySelector<HTMLElement>('button[data-action]:not(:disabled)')
      ?? root.querySelector<HTMLElement>('.threads-sidebar-heading-toggle')
    target?.focus()
  })

  const fromRow = (taskId: string, action: string, fromDialog = false): void => {
    const rows = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-testid="sidebar-trash-row"]') ?? [])]
    const index = rows.findIndex((row) => row.dataset.taskId === taskId)
    refocus.current = index !== -1 && (fromDialog || rows[index]!.contains(document.activeElement)) ? { index, action } : null
  }
  const confirmation = state.confirmation
  return <>
    <RecentlyDeletedView
      state={state}
      expanded={expanded}
      hidden={hidden}
      rootRef={rootRef}
      actions={{
        onToggle: () => setExpanded((open) => !open),
        onRestore: (taskId) => { fromRow(taskId, 'restore'); void controller.restore(taskId) },
        onDelete: (taskId) => { fromRow(taskId, 'delete'); void controller.requestPurge(taskId) },
        onRetry: (taskId) => { fromRow(taskId, 'retry'); void controller.retryPurge(taskId) }
      }}
    />
    {confirmation && createPortal(
      <PermanentDeleteDialog
        confirmation={confirmation}
        onDiscardChange={controller.setDiscard}
        onConfirm={() => { fromRow(confirmation.taskId, 'delete', true); void controller.confirmPurge() }}
        onCancel={controller.cancelPurge}
      />,
      document.body
    )}
  </>
}

export function RecentlyDeletedView({ state, expanded, hidden, actions, now, rootRef }: {
  state: TrashState
  expanded: boolean
  hidden: boolean
  actions: RecentlyDeletedActions
  now?: number
  rootRef?: React.Ref<HTMLDivElement>
}) {
  const listId = useId()
  const rows = trashRows(state.records, state.taskNames, state.policy, { paused: state.paused, ...(now === undefined ? {} : { now }) })
  const busy = state.busyTaskId !== undefined
  const listed = new Set(rows.map((row) => row.taskId))
  // A failure on a thread that left the list (purged, restored) still has to be seen.
  const strayNotice = state.notice && !listed.has(state.notice.taskId) ? state.notice.message : undefined
  return (
    <div
      ref={rootRef}
      className={`threads-sidebar-section threads-sidebar-section-settled threads-sidebar-section-trash${expanded ? '' : ' collapsed'}`}
      data-testid="sidebar-trash-section"
      hidden={hidden}
    >
      <div className="threads-sidebar-heading">
        <button
          type="button"
          className="threads-sidebar-heading-toggle"
          onClick={actions.onToggle}
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={expanded ? 'Collapse recently deleted threads' : 'Expand recently deleted threads'}
        >
          <Trash2 size={14} strokeWidth={2} className="threads-sidebar-settled-icon" aria-hidden="true" />
          <span>Recently deleted</span>
          <span className="threads-sidebar-settled-count" data-testid="sidebar-trash-count">{rows.length}</span>
        </button>
      </div>
      {expanded && (
        <div id={listId} className="threads-sidebar-tree threads-sidebar-trash-list">
          {state.refreshError && <p className="threads-sidebar-trash-error" role="alert">{state.refreshError}</p>}
          {strayNotice && <p className="threads-sidebar-trash-error" role="alert">{strayNotice}</p>}
          {skippedLine(state.skipped, 'Not listed') && <p className="threads-sidebar-trash-meta" data-testid="sidebar-trash-skipped">{skippedLine(state.skipped, 'Not listed')}</p>}
          {rows.length === 0
            ? <div className="threads-sidebar-empty">{state.loaded ? 'No recently deleted threads' : 'Loading…'}</div>
            : <ul className="threads-sidebar-trash-rows" aria-label="Recently deleted threads">
                {rows.map((row) => {
                  const notice = state.notice?.taskId === row.taskId ? state.notice.message : undefined
                  return (
                    <li key={row.taskId} className="threads-sidebar-trash-row" data-testid="sidebar-trash-row" data-task-id={row.taskId} data-state={row.state}>
                      <div className="threads-sidebar-trash-text">
                        <span className="threads-sidebar-trash-name" title={row.name}>{row.name}</span>
                        {row.computer && <span className="threads-sidebar-trash-meta" data-testid="sidebar-trash-computer">On {row.computer}</span>}
                        {row.meta && <span className="threads-sidebar-trash-meta" data-testid="sidebar-trash-meta">{row.meta}</span>}
                        {row.note && <span className="threads-sidebar-trash-meta threads-sidebar-trash-note">{row.note}</span>}
                        {notice && <span className="threads-sidebar-trash-error" role="alert" data-testid="sidebar-trash-notice">{notice}</span>}
                      </div>
                      <span className="threads-sidebar-trash-actions">
                        {row.canRestore && <button type="button" className="threads-sidebar-icon-btn" data-action="restore" title="Restore" aria-label={`Restore ${row.name}`} disabled={busy} onClick={() => actions.onRestore(row.taskId)}><ArchiveRestore size={14} aria-hidden="true" /></button>}
                        {row.computer && row.state === 'trashed' && <button type="button" className="threads-sidebar-icon-btn danger" data-action="delete" title={deleteElsewhere(row.computer)} aria-label={`${deleteElsewhere(row.computer)}: ${row.name}`} disabled><Trash2 size={14} aria-hidden="true" /></button>}
                        {row.canDelete && <button type="button" className="threads-sidebar-icon-btn danger" data-action="delete" title="Delete permanently…" aria-label={`Delete ${row.name} permanently…`} disabled={busy} onClick={() => actions.onDelete(row.taskId)}><Trash2 size={14} aria-hidden="true" /></button>}
                        {row.canRetry && <button type="button" className="threads-sidebar-icon-btn" data-action="retry" title="Retry deletion" aria-label={`Retry deleting ${row.name}`} disabled={busy} onClick={() => actions.onRetry(row.taskId)}><RotateCcw size={14} aria-hidden="true" /></button>}
                      </span>
                    </li>
                  )
                })}
              </ul>}
        </div>
      )}
    </div>
  )
}
