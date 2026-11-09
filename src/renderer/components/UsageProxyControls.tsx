import { useEffect, useId, useRef, useState } from 'react'
import { Settings } from '../lib/icons'
import { FloatingPortal, usePinnedPopover } from '../lib/floatingLayer'
import type { ProviderUsage, UsageProxyKeyResult, UsageProxyState } from '../../shared/providerAuth'

/** Saves a proxy key for a provider's usage; resolves with what the proxy said. */
export type SaveProxyKey = (providerId: string, key: string) => Promise<UsageProxyKeyResult>

/** What a failed save says, in a few words. */
export function proxyKeyError(result: UsageProxyKeyResult | 'failed'): string | undefined {
  if (result !== 'failed' && result.ok) return undefined
  const reason = result === 'failed' ? 'failed' : result.reason
  return reason === 'rejected' ? 'Key rejected' : reason === 'unreachable' ? 'Proxy not reachable' : reason === 'no_proxy' ? 'Proxy not detected' : "Couldn't save key"
}

/** The card's line for a proxy whose limits it cannot read yet: why, in a few words. */
export function proxyStateLine(proxy: UsageProxyState): string {
  if (proxy.problem === 'rejected') return 'Key rejected'
  if (proxy.problem === 'unreachable') return 'Proxy not reachable'
  return 'Detected CLI API proxy'
}

/** A masked key field with Save and Cancel: Enter saves, Escape cancels. Shows the save's error. */
export function ProxyKeyForm({ providerId, onSave, onDone, onCancel }: { providerId: string; onSave: SaveProxyKey; onDone: () => void; onCancel: () => void }) {
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const errorId = useId()
  useEffect(() => inputRef.current?.focus(), [])
  const save = async () => {
    if (!draft.trim() || saving) return
    setSaving(true)
    setError(undefined)
    let result: UsageProxyKeyResult | 'failed'
    try {
      result = await onSave(providerId, draft)
    } catch {
      result = 'failed'
    }
    setSaving(false)
    const problem = proxyKeyError(result)
    if (problem) setError(problem)
    else { setDraft(''); onDone() }
  }
  return <div className="usage-proxy-form" data-testid="usage-proxy-form">
    <input
      ref={inputRef}
      className="settings-input"
      type="password"
      autoComplete="off"
      spellCheck={false}
      placeholder="Proxy key"
      aria-label="Proxy key"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
      disabled={saving}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); void save() }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
      }}
    />
    <button type="button" className="settings-btn" data-testid="usage-proxy-save" disabled={saving || !draft.trim()} aria-busy={saving || undefined} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
    <button type="button" className="settings-btn" disabled={saving} onClick={onCancel}>Cancel</button>
    {error && <span id={errorId} className="usage-proxy-error settings-status-bad" role="alert" data-testid="usage-proxy-error">{error}</span>}
  </div>
}

/**
 * In the card of a provider read through a proxy it cannot read yet: one muted line and the action
 * that fixes it, which opens the key field in place.
 */
export function ProxyKeyNote({ provider, onSave, onSaved }: { provider: ProviderUsage; onSave: SaveProxyKey; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const proxy = provider.proxy!
  // A key from Claude's environment is changed there, not here.
  const canEnter = proxy.key !== 'environment'
  if (editing) return <ProxyKeyForm providerId={provider.id} onSave={onSave} onDone={() => { setEditing(false); onSaved() }} onCancel={() => setEditing(false)} />
  return <p className="usage-message usage-proxy-note settings-muted" data-testid="usage-proxy-note">
    <span>{proxyStateLine(proxy)}</span>
    {canEnter && <button type="button" className="usage-text-btn" data-testid="usage-proxy-enter" onClick={() => setEditing(true)}>
      {proxy.key === 'saved' ? 'Change proxy key' : 'Enter proxy key'}
    </button>}
  </p>
}

/** Whether a provider's card shows the proxy line instead of its usual note. */
export function needsProxyKey(provider: ProviderUsage): boolean {
  return !!provider.proxy && provider.windows.length === 0 && (provider.proxy.key === 'none' || !!provider.proxy.problem)
}

/**
 * The gear beside a proxy-read provider's title: its usage source in a small popover, where the
 * key can be entered, changed or removed. The key itself never comes back to this window.
 */
export function UsageSettingsButton({ provider, onSave, onClear, onSaved }: { provider: ProviderUsage; onSave: SaveProxyKey; onClear: (providerId: string) => Promise<void>; onSaved: () => void }) {
  const proxy = provider.proxy!
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const style = usePinnedPopover({ open, anchorRef, contentRef: panelRef, maxHeight: 280, minHeight: 280 })
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      const target = event.target as Node
      if (!panelRef.current?.contains(target) && !anchorRef.current?.contains(target)) { setOpen(false); setEditing(false) }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !editing) { setOpen(false); anchorRef.current?.focus() }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [open, editing])
  const remove = async () => {
    setRemoving(true)
    try { await onClear(provider.id) } finally { setRemoving(false) }
    onSaved()
  }
  const working = proxy.key !== 'none' && !proxy.problem && provider.windows.length > 0
  return <>
    <button
      ref={anchorRef}
      type="button"
      className="usage-settings-btn"
      data-testid="usage-settings"
      aria-label="Usage settings"
      aria-haspopup="dialog"
      aria-expanded={open}
      title={working ? 'Usage settings · via CLI API proxy' : 'Usage settings'}
      onClick={() => { setOpen((value) => !value); setEditing(false) }}
    >
      <Settings size={14} aria-hidden="true" />
    </button>
    {open && <FloatingPortal>
      <div ref={panelRef} style={style} className="composer-workspace-menu usage-settings-popover settings-scope" role="dialog" aria-label={`${provider.label} usage settings`} data-testid="usage-settings-popover">
        <div className="usage-settings-row">
          <span className="usage-settings-label">Proxy</span>
          <span className="usage-settings-value settings-muted" data-testid="usage-settings-address">{proxy.address}</span>
        </div>
        <div className="usage-settings-row">
          <span className="usage-settings-label">Key</span>
          {proxy.key === 'environment'
            ? <span className="usage-settings-value settings-muted" title="CLIPROXY_MANAGEMENT_KEY">From Claude&apos;s environment</span>
            : proxy.key === 'saved' && !editing
              ? <span className="usage-settings-value">
                  <span className="settings-muted" aria-label="Saved key">••••••••</span>
                  <button type="button" className="usage-text-btn" onClick={() => setEditing(true)}>Change</button>
                  <button type="button" className="usage-text-btn" disabled={removing} onClick={() => void remove()}>Remove</button>
                </span>
              : !editing && <button type="button" className="usage-text-btn" onClick={() => setEditing(true)}>Enter proxy key</button>}
        </div>
        {editing && <ProxyKeyForm providerId={provider.id} onSave={onSave} onDone={() => { setEditing(false); setOpen(false); onSaved() }} onCancel={() => setEditing(false)} />}
      </div>
    </FloatingPortal>}
  </>
}
