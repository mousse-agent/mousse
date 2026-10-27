import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { getCommand, type CommandId, type CommandScope, type ShortcutOverrides } from '../../../shared/commands'
import type { MousseSettings, MousseSettingsUpdate } from '../../../shared/settings'
import { setRecording } from '../../commands/commandRegistry'
import {
  applyPatch,
  interpretRecorderKey,
  proposeBinding,
  resetAllPatch,
  resetPatch,
  shortcutGroups,
  type BindingProposal,
  type RecorderAction,
  type ShortcutRow
} from '../../commands/shortcutEditing'
import { RotateCcw } from '../../lib/icons'
import { useAppStore } from '../../stores/appStore'
import { SettingsGroup, SettingsRow } from './SettingsRow'
import { SettingsSearch } from './SettingsSearch'

const SCOPE_NOTES: Record<CommandScope, string | null> = {
  global: null,
  'surface-picker': 'Works while the Open menu is showing',
  'model-picker': 'Works while the model picker is open',
  'workflow-editor': 'Works in the workflow editor'
}

const title = (id: CommandId): string => getCommand(id).title

/** A row waiting for the user: a refused binding, or one that needs a choice before it is saved. */
type Pending = { id: CommandId; refused: string } | { id: CommandId; proposal: Extract<BindingProposal, { kind: 'confirm' }> }

/**
 * Listens for one chord. While it is mounted the keyboard dispatcher and the menu run nothing, so
 * the chord reaches this button instead of the command that owns it.
 */
function ShortcutRecorder({
  platform,
  onDone,
  onBlur
}: {
  platform: string
  onDone: (action: RecorderAction) => void
  onBlur: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    setRecording(true)
    ref.current?.focus()
    return () => setRecording(false)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const action = interpretRecorderKey(
      {
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing
      },
      platform
    )
    if (action.type === 'ignore') return
    event.preventDefault()
    event.stopPropagation()
    onDone(action)
  }

  return (
    <button
      ref={ref}
      type="button"
      className="shortcut-recorder"
      aria-label="Press the new shortcut. Escape cancels, Backspace clears it."
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      Press keys…
    </button>
  )
}

function ConfirmNotice({ proposal, onChoose }: { proposal: Extract<BindingProposal, { kind: 'confirm' }>; onChoose: (choice: 'replace' | 'keep' | 'cancel') => void }) {
  const { others, winner, losers, reasons } = proposal
  return (
    <div className="shortcut-notice" role="alert">
      {others.length > 0 && (
        <p>
          Also used by {others.map(title).join(', ')}.
          {winner && losers.length > 0 && ` ${title(winner)} will run and ${losers.map(title).join(', ')} will not.`}
        </p>
      )}
      {reasons.map((reason) => (
        <p key={reason}>{reason}.</p>
      ))}
      <div className="shortcut-notice-actions">
        {others.length > 0 ? (
          <>
            <button type="button" className="settings-btn" onClick={() => onChoose('replace')}>Replace</button>
            <button type="button" className="settings-btn" onClick={() => onChoose('keep')}>Keep both</button>
          </>
        ) : (
          <button type="button" className="settings-btn" onClick={() => onChoose('keep')}>Use anyway</button>
        )}
        <button type="button" className="settings-btn" onClick={() => onChoose('cancel')}>Cancel</button>
      </div>
    </div>
  )
}

/** Settings → Shortcuts: every command with its shortcut; press keys to rebind, reset one or all. Saved per profile. */
export function ShortcutsSettings({
  settings,
  onUpdate
}: {
  settings: MousseSettings
  onUpdate: (partial: MousseSettingsUpdate) => Promise<void>
}) {
  const appPlatform = useAppStore((state) => state.appInfo?.platform)
  const platform = appPlatform ?? window.mousse.platform ?? ''
  const overrides = useMemo(() => settings.shortcuts ?? {}, [settings.shortcuts])
  const [query, setQuery] = useState('')
  const [recordingId, setRecordingId] = useState<CommandId | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [confirmingResetAll, setConfirmingResetAll] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const changeButtons = useRef(new Map<CommandId, HTMLButtonElement>())
  const focusAfterRecording = useRef<CommandId | null>(null)

  const groups = useMemo(() => shortcutGroups(query, overrides, platform), [query, overrides, platform])
  const anyCustom = Object.keys(overrides).length > 0

  useEffect(() => {
    if (recordingId !== null || !focusAfterRecording.current) return
    changeButtons.current.get(focusAfterRecording.current)?.focus()
    focusAfterRecording.current = null
  }, [recordingId])

  useEffect(() => {
    if (!confirmingResetAll) return
    const timer = setTimeout(() => setConfirmingResetAll(false), 4000)
    return () => clearTimeout(timer)
  }, [confirmingResetAll])

  /** Saves a patch and rebinds at once: the dispatcher reads the store, not the settings round trip. */
  const save = async (patch: ShortcutOverrides) => {
    const { setShortcuts, shortcuts: before } = useAppStore.getState()
    setSaveError(null)
    setShortcuts(applyPatch(overrides, patch, platform))
    try {
      await onUpdate({ shortcuts: patch })
    } catch {
      setShortcuts(before)
      setSaveError('Could not save the shortcut. Try again.')
    }
  }

  const finishRecording = (id: CommandId, action: RecorderAction) => {
    focusAfterRecording.current = id
    setRecordingId(null)
    if (action.type === 'ignore' || action.type === 'cancel') return
    const proposal = proposeBinding(id, action.type === 'unbind' ? null : action.binding, overrides, platform)
    if (proposal.kind === 'save') void save(proposal.patch)
    else if (proposal.kind === 'refuse') setPending({ id, refused: proposal.reason })
    else if (proposal.kind === 'confirm') setPending({ id, proposal })
  }

  const choose = (choice: 'replace' | 'keep' | 'cancel') => {
    const proposal = pending && 'proposal' in pending ? pending.proposal : null
    setPending(null)
    if (!proposal || choice === 'cancel') return
    void save(choice === 'replace' && proposal.replacePatch ? proposal.replacePatch : proposal.keepPatch)
  }

  const startRecording = (id: CommandId) => {
    setPending(null)
    setConfirmingResetAll(false)
    setRecordingId(id)
  }

  const renderRow = (row: ShortcutRow) => {
    const { command } = row
    const id = command.id
    const recording = recordingId === id
    const notice = pending?.id === id ? pending : null
    const notes = [
      command.fixed ? 'Set by the editor' : SCOPE_NOTES[command.scope],
      row.shadowedBy ? `Not active while ${title(row.shadowedBy)} uses this shortcut` : null
    ].filter(Boolean)
    return (
      <SettingsRow
        key={id}
        title={command.title}
        titleAction={row.custom ? <span className="shortcut-badge">Custom</span> : undefined}
        description={notes.length ? notes.join('. ') : undefined}
        control={
          <>
            {recording ? (
              <ShortcutRecorder
                platform={platform}
                onDone={(action) => finishRecording(id, action)}
                onBlur={() => setRecordingId((current) => (current === id ? null : current))}
              />
            ) : row.label ? (
              <kbd className="shortcut-kbd">{row.label}</kbd>
            ) : (
              <span className="settings-muted">Not set</span>
            )}
            {!command.fixed && !recording && (
              <>
                {row.custom && (
                  <button
                    type="button"
                    className="settings-icon-btn"
                    title="Reset to default"
                    aria-label={`Reset ${command.title} to its default shortcut`}
                    onClick={() => void save(resetPatch(id, overrides, platform))}
                  >
                    <RotateCcw size={14} />
                  </button>
                )}
                <button
                  type="button"
                  className="settings-btn"
                  ref={(node) => {
                    if (node) changeButtons.current.set(id, node)
                    else changeButtons.current.delete(id)
                  }}
                  onClick={() => startRecording(id)}
                >
                  Change
                </button>
              </>
            )}
          </>
        }
      >
        {notice && 'refused' in notice && (
          <div className="shortcut-notice" role="alert">
            <p>That shortcut cannot be used. {notice.refused}.</p>
            <div className="shortcut-notice-actions">
              <button type="button" className="settings-btn" onClick={() => setPending(null)}>OK</button>
            </div>
          </div>
        )}
        {notice && 'proposal' in notice && <ConfirmNotice proposal={notice.proposal} onChoose={choose} />}
      </SettingsRow>
    )
  }

  return (
    <section id="shortcuts" className="settings-section">
      <div className="shortcuts-toolbar">
        <SettingsSearch className="shortcuts-search" value={query} ariaLabel="Search shortcuts" placeholder="Search shortcuts" onChange={setQuery} />
        <button
          type="button"
          className={`settings-btn${confirmingResetAll ? ' danger confirm' : ''}`}
          disabled={!anyCustom}
          onClick={() => {
            if (!confirmingResetAll) {
              setConfirmingResetAll(true)
              return
            }
            setConfirmingResetAll(false)
            void save(resetAllPatch(overrides, platform))
          }}
        >
          {confirmingResetAll ? 'Confirm reset' : 'Reset all'}
        </button>
      </div>
      {saveError && <p className="settings-error" role="alert">{saveError}</p>}
      {groups.map((group) => (
        <SettingsGroup key={group.category} title={group.category}>
          {group.rows.map(renderRow)}
        </SettingsGroup>
      ))}
      {groups.length === 0 && <p className="settings-muted">No matching shortcuts</p>}
    </section>
  )
}
