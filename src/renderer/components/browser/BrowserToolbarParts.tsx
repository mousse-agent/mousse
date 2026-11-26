import { Bot, CircleAlert, CircleCheck, User, X } from '../../lib/icons'
import type { AttachedTabActivity } from '../../../shared/browser/attached'
import type { InAppBrowserState } from '../../../shared/browser/inApp'
import { MousseLogoOutline } from '../MousseLogoOutline'
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

/** Who is using the active tab, for the toolbar: idle shows nothing. */
export function browserTabActivity(state: Pick<InAppBrowserState, 'activity' | 'owner'> | undefined): AttachedTabActivity {
  if (state?.owner === 'disconnected') return 'idle'
  return state?.activity ?? 'idle'
}

const ACTIVITY_TEXT: Record<Exclude<AttachedTabActivity, 'idle'>, string> = {
  'agent-busy': 'Agent is acting in this tab — click the page to take over',
  'agent-waiting': 'Agent waiting to use this tab',
  'user-active': 'You’re using this tab',
  'waiting-human': 'The agent handed this tab to you'
}

/**
 * Who is using the active tab, beside the address bar: the agent while one of its steps runs (or waits for the person
 * to finish), the person while they use it. Nothing when the tab is idle. A tab the agent handed over offers it back.
 */
export function BrowserActivityIndicator({ activity, busy, onResume }: {
  activity: AttachedTabActivity
  busy: boolean
  onResume: () => void
}) {
  if (activity === 'idle') return null
  const agent = activity === 'agent-busy' || activity === 'agent-waiting'
  const Icon = agent ? Bot : User
  const text = ACTIVITY_TEXT[activity]
  return (
    <div className={`browser-activity browser-activity-${activity}`} title={text} data-state={activity}>
      <Icon size={14} className="browser-activity-icon" aria-hidden="true" />
      <span className="sr-only" role="status">{text}</span>
      {activity === 'waiting-human' && (
        <button type="button" className="browser-activity-resume" disabled={busy} onClick={onResume}>Resume agent</button>
      )}
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
