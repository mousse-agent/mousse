import { useCallback, useEffect, useRef, useState } from 'react'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import { VENDOR_SETTINGS_CHANGED, type VendorSettingEntry, type VendorSettingsView } from '../../../shared/harness/vendorSettings'
import { X } from '../../lib/icons'
import { SettingsRow } from '../settings/SettingsRow'
import { Modal } from '../ui/Modal'
import { Select } from '../ui/Select'
import { EditorSection, errorText, useAsyncAction } from './parts'

/**
 * The provider's own settings (Claude Code's `settings.json`): the API base URL, key or token,
 * default model and `CLAUDE_CODE_*` flags found in the file, editable in place, plus "Add setting"
 * for the common ones. Secrets arrive masked and are only ever replaced or removed. A file the
 * terminal shares is changed only after the user agrees, once per file; the service keeps that
 * answer (`confirmed`) and refuses an edit without it. An edit made on a file that changed on disk
 * since it was read is refused too, and the section offers to read it again.
 */

/** What the page refuses before asking the service (which checks again). */
export function settingInputProblem(key: string, value: string): string | undefined {
  if (!value.trim()) return "Can't be empty."
  if (key === 'env.ANTHROPIC_BASE_URL') {
    try {
      const url = new URL(value.trim())
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Use an http:// or https:// URL.'
    } catch {
      return 'Enter a full URL, like https://api.example.com.'
    }
  }
  return undefined
}

type Save = (key: string, value: string | null) => Promise<void>

function blurOnEnter(event: React.KeyboardEvent<HTMLInputElement>) {
  if (event.key === 'Enter') event.currentTarget.blur()
}

function RemoveSetting({ entry, disabled, onRemove }: { entry: Pick<VendorSettingEntry, 'label'>; disabled: boolean; onRemove: () => void }) {
  return (
    <button type="button" className="settings-icon-btn danger" title="Remove" aria-label={`Remove ${entry.label}`} disabled={disabled} onClick={onRemove}>
      <X size={14} />
    </button>
  )
}

function TextSettingRow({ entry, save, autoFocus, onDiscard }: { entry: VendorSettingEntry; save: Save; autoFocus?: boolean; onDiscard?: () => void }) {
  const { busy, error, run } = useAsyncAction()
  const saved = entry.value ?? ''
  const [draft, setDraft] = useState(saved)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => setDraft(saved), [saved])
  const commit = () => {
    const next = draft.trim()
    if (next === saved) return
    if (!next && onDiscard) return onDiscard()
    const invalid = settingInputProblem(entry.key, next)
    setProblem(invalid ?? null)
    if (!invalid) void run('save', () => save(entry.key, next))
  }
  const message = problem ?? error
  return (
    <SettingsRow
      title={entry.label}
      description={message ? <span className="prov-error">{message}</span> : undefined}
      control={
        <span className="settings-icon-actions">
          <input
            className="settings-input prov-mono prov-wide"
            value={draft}
            aria-label={entry.label}
            aria-invalid={message ? true : undefined}
            disabled={busy !== null}
            spellCheck={false}
            autoFocus={autoFocus}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={blurOnEnter}
          />
          <RemoveSetting entry={entry} disabled={busy !== null} onRemove={() => (onDiscard ? onDiscard() : void run('remove', () => save(entry.key, null)))} />
        </span>
      }
    />
  )
}

function SecretSettingRow({ entry, save, startEditing, onDiscard }: { entry: VendorSettingEntry; save: Save; startEditing?: boolean; onDiscard?: () => void }) {
  const { busy, error, run } = useAsyncAction()
  const [editing, setEditing] = useState(Boolean(startEditing))
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const cancel = () => {
    setEditing(false)
    setDraft('')
    setProblem(null)
    onDiscard?.()
  }
  const submit = () => {
    const invalid = settingInputProblem(entry.key, draft)
    setProblem(invalid ?? null)
    if (invalid) return
    void run('save', async () => {
      await save(entry.key, draft.trim())
      setEditing(false)
      setDraft('')
    })
  }
  const message = problem ?? error
  return (
    <SettingsRow
      title={entry.label}
      description={message ? <span className="prov-error">{message}</span> : !editing && entry.masked ? <code className="prov-secret-mask">{entry.masked}</code> : undefined}
      control={editing ? (
        <span className="settings-icon-actions">
          <input
            type="password"
            className="settings-input prov-mono prov-wide"
            value={draft}
            placeholder="Paste the new value"
            aria-label={`New ${entry.label}`}
            aria-invalid={message ? true : undefined}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            disabled={busy !== null}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
              if (event.key === 'Escape') cancel()
            }}
          />
          <button type="button" className="settings-btn" disabled={busy !== null || !draft.trim()} onClick={submit}>Save</button>
          <button type="button" className="settings-btn" disabled={busy !== null} onClick={cancel}>Cancel</button>
        </span>
      ) : (
        <span className="settings-icon-actions">
          <button type="button" className="settings-btn" disabled={busy !== null} onClick={() => setEditing(true)}>Change</button>
          <RemoveSetting entry={entry} disabled={busy !== null} onRemove={() => void run('remove', () => save(entry.key, null))} />
        </span>
      )}
    />
  )
}

/** The settings section for an entry whose settings file Mousse edits; nothing for the others. */
export function VendorSettingsSection({ snapshot }: { snapshot: InstanceSnapshot }) {
  const instances = typeof window === 'undefined' ? undefined : window.mousse?.providers?.instances
  const supported = Boolean(snapshot.settingsFile && instances?.vendorSettings)
  const [view, setView] = useState<VendorSettingsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [ask, setAsk] = useState<{ resolve: () => void; reject: (error: Error) => void } | null>(null)
  const [stale, setStale] = useState(false)
  const [reloads, setReloads] = useState(0)
  const viewRef = useRef(view)
  viewRef.current = view
  const { instanceId } = snapshot
  const revision = snapshot.settingsFile?.revision
  useEffect(() => {
    if (!supported) return
    let cancelled = false
    instances!.vendorSettings(instanceId).then(
      (next) => { if (!cancelled) { setView(next); setLoadError(null); setStale(false) } },
      (error: unknown) => { if (!cancelled) setLoadError(errorText(error)) }
    )
    return () => { cancelled = true }
  }, [supported, instances, instanceId, revision, reloads])

  /** A shared file asks once before its first change; the service refuses one without the say-so. */
  const save = useCallback<Save>(async (key, value) => {
    const current = viewRef.current
    if (!current?.revision) return
    const needsAgreement = current.shared && !current.confirmed
    if (needsAgreement) await new Promise<void>((resolve, reject) => setAsk({ resolve, reject }))
    try {
      const next = await instances!.setVendorSetting({ instanceId, key, value, expectedRevision: current.revision, ...(needsAgreement ? { confirmShared: true } : {}) })
      setView(next)
      setAdding(null)
    } catch (error) {
      // Changed on disk since it was read (by the terminal, an editor, another window): nothing was
      // written, and the rows wait for a reload rather than guess.
      if (errorText(error).includes(VENDOR_SETTINGS_CHANGED)) {
        setStale(true)
        throw new Error(VENDOR_SETTINGS_CHANGED)
      }
      throw error
    }
  }, [instances, instanceId])

  if (!supported || (!view && !loadError)) return null
  const draftEntry = adding ? view?.addable.find((option) => option.key === adding) : undefined
  return (
    <EditorSection
      title="Claude settings"
      action={stale ? (
        <button type="button" className="settings-btn" onClick={() => setReloads((count) => count + 1)}>Reload</button>
      ) : view && !view.error && view.addable.length > 0 ? (
        <Select
          ariaLabel="Add setting"
          size="small"
          value=""
          placeholder="Add setting"
          options={view.addable.map((option) => ({ value: option.key, label: option.label }))}
          onChange={(key) => setAdding(key)}
        />
      ) : undefined}
    >
      {loadError || view?.error ? (
        <SettingsRow title="settings.json" description={<span className="prov-error">{loadError ?? view?.error}</span>} />
      ) : (
        <>
          {/* A reload starts the rows over, clearing their drafts and errors. */}
          {view!.entries.map((entry) => entry.secret
            ? <SecretSettingRow key={`${reloads}:${entry.key}`} entry={entry} save={save} />
            : <TextSettingRow key={`${reloads}:${entry.key}`} entry={entry} save={save} />)}
          {draftEntry && (draftEntry.secret
            ? <SecretSettingRow key={`new:${draftEntry.key}`} entry={draftEntry} save={save} startEditing onDiscard={() => setAdding(null)} />
            : <TextSettingRow key={`new:${draftEntry.key}`} entry={{ ...draftEntry, value: '' }} save={save} autoFocus onDiscard={() => setAdding(null)} />)}
        </>
      )}
      {ask && (
        <Modal
          open
          title="Change Claude in your terminal too?"
          onClose={() => { ask.reject(new Error('Not changed.')); setAsk(null) }}
          footer={
            <>
              <button type="button" className="btn" onClick={() => { ask.reject(new Error('Not changed.')); setAsk(null) }}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={() => { ask.resolve(); setAsk(null) }}>Change it</button>
            </>
          }
        >
          <p className="prov-wizard-panel">This also changes Claude in your terminal.</p>
        </Modal>
      )}
    </EditorSection>
  )
}
