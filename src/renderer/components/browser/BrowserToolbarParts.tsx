import { Bot, CircleAlert, CircleCheck, User, X } from '../../lib/icons'
import type { InAppBrowserState } from '../../../shared/browser/inApp'
import { MousseLogoOutline } from '../MousseLogoOutline'
import { Switch } from '../settings/SettingsRow'
import { Modal } from '../ui/Modal'
import { Select } from '../ui/Select'

export const DEVICE_PRESETS = [
  { id: 'responsive', label: 'Responsive', width: null },
  { id: 'iphone-14', label: 'iPhone 14', width: 390 },
  { id: 'pixel-7', label: 'Pixel 7', width: 412 },
  { id: 'ipad', label: 'iPad', width: 768 },
  { id: 'desktop', label: 'Desktop', width: 1280 }
] as const

/** The viewport width beside the device select: "390 px", or "Auto" when the page fills the panel. */
export function deviceWidthLabel(presetId: string): string {
  const width = DEVICE_PRESETS.find((preset) => preset.id === presetId)?.width
  return width ? `${width} px` : 'Auto'
}

/** Off: agents may not use the browser. Allowed: they may. Agent / human: who drives this tab now. */
export type BrowserAgentState = 'off' | 'allowed' | 'agent' | 'human'

export function browserAgentState(allowed: boolean, owner: InAppBrowserState['owner'] | undefined): BrowserAgentState {
  if (owner === 'agent') return 'agent'
  if (owner === 'human') return 'human'
  return allowed ? 'allowed' : 'off'
}

const AGENT_STATE_TEXT: Record<BrowserAgentState, string> = {
  off: 'Agents can’t use browser tabs',
  allowed: 'Agents can use all browser tabs',
  agent: 'An agent is using this tab',
  human: 'You have control of this tab'
}

/** Compact agent-access status and switch for the browser toolbar. */
export function BrowserAccessControl({
  state,
  allowed,
  busy,
  onChange
}: {
  state: BrowserAgentState
  allowed: boolean
  busy: boolean
  onChange: (allowed: boolean) => void
}) {
  const Icon = state === 'human' ? User : Bot
  return (
    <div className={`browser-access browser-access-${state}`} title={AGENT_STATE_TEXT[state]} data-state={state}>
      <Icon size={14} className="browser-access-icon" aria-hidden="true" />
      <span className="browser-access-label">Agents</span>
      <span className="sr-only" role="status">{AGENT_STATE_TEXT[state]}</span>
      <Switch checked={allowed} disabled={busy} label="Agent access to all browser tabs" onChange={onChange} />
    </div>
  )
}

export interface BrowserNoticeState {
  kind: 'done' | 'error'
  text: string
  /** The raw error, shown as the tooltip. */
  detail?: string
}

/** The result of the last browser action (cleared cookies, a failed request), shown under the toolbar. */
export function BrowserNotice({ notice, onDismiss }: { notice: BrowserNoticeState; onDismiss: () => void }) {
  const error = notice.kind === 'error'
  return (
    <div className={`browser-notice browser-notice-${notice.kind}`} role={error ? 'alert' : 'status'}>
      {error ? <CircleAlert size={14} aria-hidden="true" /> : <CircleCheck size={14} aria-hidden="true" />}
      <span className="browser-notice-text" title={notice.detail}>{notice.text}</span>
      <button type="button" className="browser-toolbar-btn" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
        <X size={14} />
      </button>
    </div>
  )
}

export function BrowserDeviceToolbar({ presetId, onChange }: { presetId: string; onChange: (presetId: string) => void }) {
  return (
    <div className="browser-device-toolbar">
      <Select
        size="small"
        ariaLabel="Device"
        value={presetId}
        onChange={onChange}
        options={DEVICE_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
      />
      <span>{deviceWidthLabel(presetId)}</span>
    </div>
  )
}

/**
 * The app-owned page a new tab shows. It sits over the hidden blank webview and uses the app
 * theme; visited sites keep their own appearance.
 */
export function BrowserStartPage() {
  return (
    <div className="browser-blank">
      <MousseLogoOutline className="browser-blank-logo" />
      <p className="browser-blank-copy">Enter an address above</p>
    </div>
  )
}

export function ClearCookiesDialog({ open, onCancel, onConfirm }: { open: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal
      open={open}
      title="Clear browser cookies?"
      onClose={onCancel}
      footer={<>
        <button type="button" className="settings-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="settings-btn danger" onClick={onConfirm}>Clear cookies</button>
      </>}
    >
      <p className="settings-muted">You’ll be signed out of every site.</p>
    </Modal>
  )
}
