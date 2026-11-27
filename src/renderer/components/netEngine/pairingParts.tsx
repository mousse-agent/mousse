import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import jsQR from 'jsqr'
import type { NetEngineStatus } from '../../../shared/netEngine/local'
import { ArrowLeft, CircleAlert, CircleCheck } from '../../lib/icons'
import { qrSvgPath } from '../../lib/plusQr'
import { DelayedLoader } from '../ui/DelayedLoader'
import { Switch } from '../settings/SettingsRow'

/** An expiry in seconds (the helper's) or milliseconds, as milliseconds. */
export const toMs = (at: number): number => (at < 1e12 ? at * 1000 : at)

/** Time left as `m:ss`, never below zero. */
export const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Now, each second while `until` is set: a code's time left. */
export function useNow(until: number | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [until])
  return now
}

/** Ends an invitation that is still open (a code or link nobody used), and forgets it. */
export function endInvitation(ref: { current: string | undefined }): void {
  const open = ref.current
  ref.current = undefined
  if (open)
    void window.mousse.platformRequest.request('netEngine.invite.cancel', { invitation: open }).catch(() => undefined)
}

/** "Also let <name> use this computer": off, this computer only uses the other one. */
export function AlsoLet({
  name,
  checked,
  disabled,
  onChange
}: {
  name: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  const labelId = useId()
  return (
    <div className="engine-switch-row" title="Without it, this computer only uses it.">
      <span id={labelId}>Also let {name} use this computer</span>
      <Switch checked={checked} disabled={disabled} labelledBy={labelId} onChange={onChange} />
    </div>
  )
}

/** Back, at the start of a dialog's title row. */
export function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="settings-icon-btn engine-back" aria-label="Back" title="Back" onClick={onBack}>
      <ArrowLeft size={16} aria-hidden="true" />
    </button>
  )
}

/**
 * The other computer's link under its label, then what to do on the other computer and Continue at the bottom.
 * Text that is not a Mousse link says so.
 */
export function LinkForm({ onText, hint }: { onText: (text: string) => boolean; hint?: ReactNode }) {
  const fieldId = useId()
  const [pasted, setPasted] = useState('')
  const [notLink, setNotLink] = useState(false)
  const paste = (event: FormEvent) => {
    event.preventDefault()
    setNotLink(!onText(pasted))
  }
  return (
    <form className="engine-pair-form" onSubmit={paste}>
      <label className="engine-field-label" htmlFor={fieldId}>
        Link
      </label>
      <input
        id={fieldId}
        className="settings-input"
        value={pasted}
        placeholder="Paste its link"
        aria-label="Pairing link"
        onChange={(event) => {
          setPasted(event.target.value)
          setNotLink(false)
        }}
      />
      {notLink && (
        <p role="alert" className="chat-error">
          This isn’t a link from Mousse.
        </p>
      )}
      <div className="engine-pair-foot">
        {hint && <span className="engine-hint">{hint}</span>}
        <button type="submit" className="settings-btn ui-btn-primary" disabled={!pasted.trim()}>
          Continue
        </button>
      </div>
    </form>
  )
}

/**
 * One row of a list to pick one from (a way, an access level, a profile): its name, the detail under it in muted
 * text, and an action at the end when one fixes it. The picked row has a background, nothing else.
 */
export function ChoiceRow({
  selected,
  disabled = false,
  dim = false,
  label,
  detail,
  title,
  onPick,
  children
}: {
  selected: boolean
  disabled?: boolean
  /** A choice that can't be picked now: its name muted too. */
  dim?: boolean
  label: ReactNode
  detail?: ReactNode
  title?: string
  onPick: () => void
  children?: ReactNode
}) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      className={`engine-choice-row${selected ? ' selected' : ''}${dim ? ' engine-way-off' : ''}`}
      title={title}
      onClick={() => !disabled && onPick()}
      onKeyDown={(event) => {
        if (!disabled && (event.key === ' ' || event.key === 'Enter')) {
          event.preventDefault()
          onPick()
        }
      }}
    >
      <span className="engine-choice-text">
        <span className="engine-choice-label">{label}</span>
        {detail !== undefined && <span className="engine-choice-hint">{detail}</span>}
      </span>
      {children}
    </div>
  )
}

/** The mark before a check's result: a tick when it passed, a warning when it found a problem. */
export function CheckIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <CircleCheck size={16} className="engine-check-icon ok" aria-hidden="true" />
  ) : (
    <CircleAlert size={16} className="engine-check-icon warn" aria-hidden="true" />
  )
}

/** How far the code is, by the steps it really goes through: the helper starts, says hello, then makes the code. */
function preparingPercent(helper: NetEngineStatus['helper'], ready: boolean): number | undefined {
  if (ready) return 75
  if (helper.state !== 'starting') return undefined
  return helper.step === 'hello' ? 50 : 25
}

/** Where the code will show, while it is being made: a spinner, plain words and how far along it is. */
export function Preparing({ helper, ready }: { helper: NetEngineStatus['helper']; ready: boolean }) {
  const waiting = ready || helper.state === 'starting' || helper.state === 'restarting'
  const percent = preparingPercent(helper, ready)
  const words = ready
    ? 'Making a code'
    : helper.state === 'restarting'
      ? 'Trying again'
      : waiting
        ? 'Getting ready to connect'
        : helper.text || 'Networking is off'
  return (
    <div className="engine-qr engine-preparing">
      {waiting && <DelayedLoader label={words} delayMs={0} />}
      <p className="settings-muted" role="status">
        {waiting ? `${words}…` : words}
        {percent !== undefined && <span className="engine-preparing-percent"> {percent}%</span>}
      </p>
      {helper.state === 'restarting' && helper.text && (
        <p className="settings-muted" title={helper.text}>
          {helper.text}
        </p>
      )}
    </div>
  )
}

export function QrCode({ text }: { text: string }) {
  const { size, path } = useMemo(() => qrSvgPath(text), [text])
  // Dark on white with a quiet zone, so a camera reads it in either theme.
  return (
    <svg
      className="net-plus-qr engine-qr-code"
      viewBox={`0 0 ${size} ${size}`}
      width={208}
      height={208}
      role="img"
      aria-label="Pairing QR code"
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}

export async function defaultCamera(): Promise<MediaStream | undefined> {
  const media = navigator.mediaDevices
  if (!media?.getUserMedia) return undefined
  try {
    const devices = await media.enumerateDevices?.()
    if (devices && !devices.some((device) => device.kind === 'videoinput')) return undefined
    return await media.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
  } catch {
    return undefined
  }
}

/** Scan: the camera's frames are read for a pairing code; without a camera, the other computer scans instead. */
export function Scanner({
  camera,
  everyMs,
  onText
}: {
  camera: () => Promise<MediaStream | undefined>
  /** How often a camera frame is read for a code (the engine limit `scanIntervalMs`). */
  everyMs: number
  onText: (text: string) => boolean
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<'opening' | 'live' | 'none'>('opening')
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  useEffect(() => {
    let stream: MediaStream | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    let stopped = false
    void camera().then((opened) => {
      if (stopped) {
        opened?.getTracks().forEach((track) => track.stop())
        return
      }
      if (!opened || !video.current) {
        setState('none')
        return
      }
      stream = opened
      video.current.srcObject = opened
      void video.current.play().catch(() => undefined)
      setState('live')
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d', { willReadFrequently: true })
      timer = setInterval(() => {
        const element = video.current
        if (!context || !element || element.readyState < 2 || !element.videoWidth) return
        canvas.width = element.videoWidth
        canvas.height = element.videoHeight
        context.drawImage(element, 0, 0)
        const frame = context.getImageData(0, 0, canvas.width, canvas.height)
        const code = jsQR(frame.data, frame.width, frame.height, {
          inversionAttempts: 'dontInvert'
        })
        if (code?.data && onTextRef.current(code.data) && timer) clearInterval(timer)
      }, everyMs)
    })
    return () => {
      stopped = true
      if (timer) clearInterval(timer)
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [camera, everyMs])

  return (
    <div className="engine-scan">
      {state === 'none' ? (
        <p className="settings-muted">Scan from the other computer instead.</p>
      ) : (
        <video ref={video} className="engine-scan-video" muted playsInline aria-label="Camera" />
      )}
    </div>
  )
}
