import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageSquare, MessageSquarePlus, Pencil, Plus, Terminal, X, Zap } from 'lucide-react'
import { IconButton } from './IconButton'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import {
  createQuickAction,
  loadQuickActions,
  quickActionKindLabel,
  sanitizeQuickAction,
  saveQuickActions,
  validateQuickAction,
  type QuickAction,
  type QuickActionKind
} from '../lib/quickActions'
import { executeQuickAction } from '../lib/executeQuickAction'

function KindIcon({ kind }: { kind: QuickActionKind }) {
  if (kind === 'bash') return <Terminal size={13} strokeWidth={2} />
  if (kind === 'send-new-chat') return <MessageSquarePlus size={13} strokeWidth={2} />
  return <MessageSquare size={13} strokeWidth={2} />
}

const KIND_OPTIONS: { value: QuickActionKind; label: string; hint: string }[] = [
  { value: 'send-current', label: 'Send in current chat', hint: 'Message to send' },
  { value: 'send-new-chat', label: 'Create new chat and send there', hint: 'Message to send' },
  { value: 'bash', label: 'Run bash command', hint: 'Shell command' }
]

export function QuickActionsButton() {
  const [actions, setActions] = useState<QuickAction[]>(() => loadQuickActions())
  const [menuOpen, setMenuOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftLabel, setDraftLabel] = useState('')
  const [draftKind, setDraftKind] = useState<QuickActionKind>('send-current')
  const [draftPayload, setDraftPayload] = useState('')
  const [editorError, setEditorError] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [menuError, setMenuError] = useState<string | null>(null)

  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const menuStyle = useFloatingPosition({
    open: menuOpen,
    anchorRef: buttonRef,
    contentRef: menuRef,
    placement: 'below-start',
    deps: [actions.length]
  })

  // Outside-click + Escape dismiss (mirrors ComposerFooter menu handling).
  useEffect(() => {
    if (!menuOpen || editorOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen, editorOpen])

  const persist = useCallback((next: QuickAction[]) => {
    setActions(next)
    saveQuickActions(next)
  }, [])

  // Agent-created actions: the daemon publishes approved actions over
  // `quickActions:created` (see QuickActionTools). Append anything unseen.
  // Guarded for stale preloads that predate the bridge.
  useEffect(() => {
    const subscribe = window.mousse?.quickActions?.onCreated
    if (typeof subscribe !== 'function') return
    return subscribe((raw: unknown) => {
      const action = sanitizeQuickAction(raw)
      if (!action) return
      setActions((current) => {
        if (current.some((entry) => entry.id === action.id)) return current
        const next = [...current, action]
        saveQuickActions(next)
        return next
      })
    })
  }, [])

  const handleDelete = useCallback(
    (id: string) => {
      persist(actions.filter((action) => action.id !== id))
    },
    [actions, persist]
  )

  const handleRun = useCallback(
    async (action: QuickAction) => {
      if (runningId) return
      setMenuError(null)
      setRunningId(action.id)
      try {
        await executeQuickAction(action)
        setMenuOpen(false)
      } catch (error) {
        setMenuError(error instanceof Error ? error.message : 'Action failed.')
      } finally {
        setRunningId(null)
      }
    },
    [runningId]
  )

  const openEditor = useCallback(() => {
    setEditingId(null)
    setDraftLabel('')
    setDraftKind('send-current')
    setDraftPayload('')
    setEditorError(null)
    setEditorOpen(true)
  }, [])

  const openEdit = useCallback((action: QuickAction) => {
    setEditingId(action.id)
    setDraftLabel(action.label)
    setDraftKind(action.kind)
    setDraftPayload(action.payload)
    setEditorError(null)
    setEditorOpen(true)
  }, [])

  const closeEditor = useCallback(() => {
    setEditorOpen(false)
    setEditingId(null)
  }, [])

  const handleSave = useCallback(() => {
    const error = validateQuickAction({ label: draftLabel, kind: draftKind, payload: draftPayload })
    if (error) {
      setEditorError(error)
      return
    }
    if (editingId) {
      persist(
        actions.map((action) =>
          action.id === editingId
            ? {
                ...action,
                label: draftLabel.trim(),
                kind: draftKind,
                payload: draftPayload,
                updatedAt: new Date().toISOString()
              }
            : action
        )
      )
    } else {
      const action = createQuickAction({ label: draftLabel, kind: draftKind, payload: draftPayload })
      persist([...actions, action])
    }
    closeEditor()
  }, [actions, draftKind, draftLabel, draftPayload, editingId, persist, closeEditor])

  const draftHint = KIND_OPTIONS.find((option) => option.value === draftKind)?.hint ?? 'Content'

  return (
    <>
      <IconButton
        ref={buttonRef}
        icon={Zap}
        label="Quick actions"
        onClick={() => {
          setMenuError(null)
          setMenuOpen((open) => !open)
        }}
      />

      {menuOpen && (
        <FloatingPortal>
          <div
            ref={menuRef}
            className="composer-mode-menu composer-mode-menu-floating quick-actions-menu"
            role="menu"
            aria-label="Quick actions"
            style={menuStyle}
          >
            {actions.length === 0 && (
              <div className="quick-actions-empty">No quick actions yet.</div>
            )}
            {actions.map((action) => (
              <div key={action.id} className="quick-actions-row" role="menuitem">
                <button
                  type="button"
                  className="quick-actions-run"
                  title={`${action.label} — ${quickActionKindLabel(action.kind)}`}
                  onClick={() => void handleRun(action)}
                  disabled={runningId !== null}
                >
                  <span className="quick-actions-kind">
                    <KindIcon kind={action.kind} />
                  </span>
                  <span className="quick-actions-label">{action.label}</span>
                  {runningId === action.id && <span className="quick-actions-running">…</span>}
                </button>
                <button
                  type="button"
                  className="quick-actions-delete"
                  title={`Edit ${action.label}`}
                  aria-label={`Edit ${action.label}`}
                  onClick={() => openEdit(action)}
                  disabled={runningId !== null}
                >
                  <Pencil size={13} strokeWidth={2} />
                </button>
                <button
                  type="button"
                  className="quick-actions-delete"
                  title={`Delete ${action.label}`}
                  aria-label={`Delete ${action.label}`}
                  onClick={() => handleDelete(action.id)}
                  disabled={runningId !== null}
                >
                  <X size={13} strokeWidth={2} />
                </button>
              </div>
            ))}
            {menuError && <div className="quick-actions-error">{menuError}</div>}
            <div className="quick-actions-separator" role="separator" />
            <button type="button" className="quick-actions-create" onClick={openEditor}>
              <Plus size={13} strokeWidth={2} />
              <span>Create action</span>
            </button>
          </div>
        </FloatingPortal>
      )}

      {editorOpen && (
        <FloatingPortal>
          <div className="quick-actions-backdrop" onMouseDown={closeEditor}>
            <div
              className="quick-actions-dialog"
              role="dialog"
              aria-label={editingId ? 'Edit action' : 'Create action'}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="quick-actions-dialog-heading">
                <h2>{editingId ? 'Edit action' : 'Create action'}</h2>
                <button
                  type="button"
                  className="quick-actions-delete"
                  aria-label="Close"
                  onClick={closeEditor}
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
              <label className="quick-actions-field">
                <span>Name</span>
                <input
                  type="text"
                  value={draftLabel}
                  maxLength={60}
                  placeholder="e.g. Commit and push"
                  onChange={(event) => setDraftLabel(event.target.value)}
                />
              </label>
              <label className="quick-actions-field">
                <span>Type</span>
                <select
                  value={draftKind}
                  onChange={(event) => setDraftKind(event.target.value as QuickActionKind)}
                >
                  {KIND_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="quick-actions-field">
                <span>{draftHint}</span>
                <textarea
                  value={draftPayload}
                  rows={4}
                  placeholder={
                    draftKind === 'bash'
                      ? 'e.g. git status --short'
                      : 'e.g. Commit and push your changes feature wise'
                  }
                  onChange={(event) => setDraftPayload(event.target.value)}
                />
              </label>
              {editorError && <div className="quick-actions-error">{editorError}</div>}
              <div className="quick-actions-dialog-actions">
                <button
                  type="button"
                  className="quick-actions-secondary-btn"
                  onClick={closeEditor}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="quick-actions-primary-btn"
                  onClick={handleSave}
                >
                  {editingId ? 'Save changes' : 'Save action'}
                </button>
              </div>
            </div>
          </div>
        </FloatingPortal>
      )}

    </>
  )
}
