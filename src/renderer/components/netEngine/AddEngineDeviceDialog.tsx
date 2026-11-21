import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import jsQR from 'jsqr'
import {
  DEFAULT_SCAN_INTERVAL_MS,
  type NetEngineJoinPreview,
  type NetEngineStatus
} from '../../../shared/netEngine/local'
import { ChevronRight } from '../../lib/icons'
import { qrSvgPath } from '../../lib/plusQr'
import { CopyButton } from '../settings/IconButtons'
import { Modal } from '../ui/Modal'
import { useDaemonCall } from '../devices/useDaemonCall'
import { readPairingLink } from './engineRows'
import { EnterLinkPanel, JoinedLine, JoinRoutes, SendLinkPanel } from './SendLinkParts'
import { CloudflareSetup } from './CloudflareSetup'
import { SshAddSteps } from './SshAddSteps'

type Step =
  | { kind: 'choose' }
  | { kind: 'scan' }
  | { kind: 'ssh' }
  | { kind: 'confirm'; ticket: string; host: string }
  | { kind: 'joining'; host: string }
  | { kind: 'link' }
  | { kind: 'cloudflare' }
  | { kind: 'enter'; link?: string }

/** The other computer, before it says its own name. */
const UNNAMED_HOST = 'the other computer'

/**
 * Add device (design §5.1, §7), all in one: this computer's code shows at once with the time it has left (a new
 * one follows when it runs out) and its link to copy under it; the other computer's request is answered here.
 * Under that, a field takes the other computer's link (a sent link goes on to its code, a shown one to Connect).
 * More ways holds Scan their code, Send a link, Over SSH and, where the build has phones, Add a phone. Closing it
 * ends the invitations it made; a window that closes or switches profile ends them on the daemon's side.
 */
export function AddEngineDeviceDialog({
  status,
  onClose,
  initial = 'choose',
  initialLink,
  onAddPhone,
  camera = defaultCamera
}: {
  status: NetEngineStatus | undefined
  onClose: () => void
  initial?: 'choose' | 'show' | 'scan' | 'link' | 'enter' | 'ssh' | 'cloudflare'
  /** A `mousse://pair` link that opened Mousse: Enter link reads it at once. */
  initialLink?: string
  /** Opens Add a phone (the old networking's phones, Mousse ID builds); absent where phones can't be added. */
  onAddPhone?: () => void
  /** Opens a camera stream; tests and computers without one answer undefined. */
  camera?: () => Promise<MediaStream | undefined>
}) {
  const [step, setStep] = useState<Step>({ kind: initial === 'show' ? 'choose' : initial })
  const { busy, error, setError, call } = useDaemonCall()
  const [invite, setInvite] = useState<{ invitation: string; uri: string; expiresAt?: number }>()
  const [approved, setApproved] = useState<string>()
  // The code this dialog shows, and a Send link it made: closing ends whichever is still open.
  const inviteRef = useRef<string | undefined>(undefined)
  const linkRef = useRef<string | undefined>(undefined)
  // A build without the helper offers only what the old networking still does (Add a phone).
  const engine = status && status.helper.state !== 'not_in_build' ? status : undefined
  const hasEngine = !!engine

  useEffect(() => {
    if (step.kind === 'cloudflare' && status?.cloudflare?.state === 'connected')
      setStep({ kind: 'link' })
  }, [step.kind, status?.cloudflare?.state])

  // The code shows at once, one invitation at a time; when it runs out a new one takes its place.
  useEffect(() => {
    if (step.kind !== 'choose' || !hasEngine || invite || approved) return
    void call<{ invitation: string; uri: string; expiresAt?: number }>('netEngine.invite', {}).then(
      (answer) => {
        if (!answer) return
        inviteRef.current = answer.value.invitation
        setInvite(answer.value)
      }
    )
  }, [step.kind, hasEngine, invite, approved, call])

  // The time left, to the second.
  const expiresAt = invite?.expiresAt === undefined ? undefined : toMs(invite.expiresAt)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (expiresAt === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [expiresAt])
  const approvalOpen =
    !!invite && !!status?.approvals.some((item) => item.invitation === invite.invitation)
  useEffect(() => {
    if (expiresAt === undefined || now < expiresAt || approvalOpen || approved) return
    inviteRef.current = undefined
    setInvite(undefined)
  }, [now, expiresAt, approvalOpen, approved])

  // Closing the dialog ends the invitations it made.
  useEffect(
    () => () => {
      for (const invitation of [inviteRef.current, linkRef.current])
        if (invitation)
          void window.mousse.platformRequest
            .request('netEngine.invite.cancel', { invitation })
            .catch(() => undefined)
    },
    []
  )

  const approval = invite && status?.approvals.find((item) => item.invitation === invite.invitation)
  const joined = approved && status?.devices.find((device) => device.name === approved)

  const answer = async (yes: boolean) => {
    if (!approval) return
    if (await call('netEngine.approve', { request: approval.request, yes })) {
      if (yes) {
        setApproved(approval.name)
        // The invitation is used: closing no longer needs to end it.
        inviteRef.current = undefined
      }
    }
  }

  // Confirm: the ticket's destinations and this computer's routes it may also share (1b §1.3).
  const [preview, setPreview] = useState<{ ticket: string; value: NetEngineJoinPreview }>()
  const [share, setShare] = useState<string[]>([])
  const confirmTicket = step.kind === 'confirm' ? step.ticket : undefined
  useEffect(() => {
    if (!confirmTicket) return
    let live = true
    void window.mousse.platformRequest
      .request<NetEngineJoinPreview>('netEngine.join.preview', { ticket: confirmTicket })
      .then((value) => {
        if (live) setPreview({ ticket: confirmTicket, value })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [confirmTicket])

  const join = async (ticket: string, host: string) => {
    setStep({ kind: 'joining', host })
    if (await call('netEngine.join', { ticket, ...(share.length ? { share } : {}) })) onClose()
    else setStep({ kind: 'confirm', ticket, host })
  }

  // One paste field for both kinds: a sent link goes on to its code, a shown one (a QR) to Connect.
  const read = (text: string): boolean => {
    const link = readPairingLink(text)
    if (!link) return false
    setError('')
    const confirm = () =>
      setStep({ kind: 'confirm', ticket: link.ticket, host: link.host ?? UNNAMED_HOST })
    if (!status?.sendLink) {
      confirm()
      return true
    }
    void window.mousse.platformRequest
      .request<NetEngineJoinPreview>('netEngine.join.preview', { ticket: link.ticket })
      .then(
        (value) => (value?.kind === 2 ? setStep({ kind: 'enter', link: link.ticket }) : confirm()),
        confirm
      )
    return true
  }

  const title =
    step.kind === 'cloudflare'
      ? 'Cloudflare Tunnel'
      : step.kind === 'scan'
      ? 'Scan their code'
      : step.kind === 'enter'
        ? 'Paste their link'
        : step.kind === 'link'
          ? 'Send a link'
          : step.kind === 'ssh'
            ? 'Add over SSH'
            : 'Add device'
  return (
    <Modal open title={title} onClose={onClose}>
      <div className="engine-dialog" data-step={step.kind}>
        {step.kind === 'choose' && (
          <div className="engine-dialog-home">
            {engine &&
              (joined ? (
                <JoinedLine device={joined} />
              ) : approved ? (
                <p role="status" className="settings-muted">
                  Adding {approved}…
                </p>
              ) : approval ? (
                <div className="engine-approval" role="group" aria-label="Pairing request">
                  <p>Is {approval.name || 'this computer'} yours?</p>
                  <div className="devices-dialog-actions">
                    <button
                      type="button"
                      className="settings-btn"
                      disabled={busy}
                      onClick={() => void answer(false)}
                    >
                      No
                    </button>
                    <button
                      type="button"
                      className="settings-btn primary"
                      disabled={busy}
                      title={`${approval.name || 'It'} gets the same access as your other computers, and this computer gets the same there.`}
                      onClick={() => void answer(true)}
                    >
                      Yes
                    </button>
                  </div>
                </div>
              ) : invite ? (
                <div className="engine-qr">
                  <QrCode text={invite.uri} />
                  {expiresAt !== undefined && (
                    <p
                      className="settings-muted engine-qr-timer"
                      role="timer"
                      title="The code works once. A new one shows when it runs out."
                    >
                      Expires in {clock(expiresAt - now)}
                    </p>
                  )}
                  <div className="engine-paste">
                    <input
                      className="settings-input"
                      readOnly
                      value={invite.uri}
                      aria-label="Link to share"
                      title="Scan the code on the other computer, or send it this link."
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <CopyButton text={invite.uri} label="Copy link" />
                  </div>
                </div>
              ) : (
                !error && <p className="settings-muted">Making a code…</p>
              ))}
            {engine && !approval && !approved && <PasteField onText={read} />}
            {engine?.cloudflare && !approval && !approved && (
              <Choice
                label="Over the internet"
                hint="Connect Cloudflare Tunnel"
                onClick={() => setStep({ kind: 'cloudflare' })}
              />
            )}
            {(engine || onAddPhone) && (
              <details className="engine-more-ways">
                <summary>
                  <ChevronRight size={14} aria-hidden="true" className="settings-advanced-chevron" />
                  More ways
                </summary>
                {engine && (
                  <Choice
                    label="Scan their code"
                    hint="With this computer's camera"
                    onClick={() => setStep({ kind: 'scan' })}
                  />
                )}
                {engine?.sendLink && (
                  <Choice
                    label="Send a link"
                    hint="With a code to read out, for a computer far away"
                    onClick={() => setStep({ kind: 'link' })}
                  />
                )}
                {status?.on && status.reach && (
                  <Choice
                    label="Over SSH"
                    hint="This computer uses another one you reach over SSH"
                    onClick={() => setStep({ kind: 'ssh' })}
                  />
                )}
                {onAddPhone && (
                  <Choice label="Add a phone" hint="With the Mousse phone app" onClick={onAddPhone} />
                )}
              </details>
            )}
          </div>
        )}

        {step.kind === 'cloudflare' && <CloudflareSetup connection={status?.cloudflare} />}

        {step.kind === 'link' && (
          <SendLinkPanel
            status={status}
            onInvitation={(invitation) => {
              // Closing the dialog ends the link's invitation while it is open.
              linkRef.current = invitation
            }}
          />
        )}

        {step.kind === 'enter' && (
          <EnterLinkPanel
            status={status}
            initialLink={step.link ?? initialLink}
            onJoined={onClose}
          />
        )}

        {step.kind === 'ssh' && <SshAddSteps onDone={onClose} />}

        {step.kind === 'scan' && (
          <Scanner
            camera={camera}
            everyMs={status?.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS}
            onText={read}
          />
        )}

        {step.kind === 'confirm' && (
          <div className="engine-confirm">
            <p>
              Connect to {step.host}? {capitalize(step.host)} will also be able to use this
              computer.
            </p>
            {preview && preview.ticket === step.ticket && (
              <JoinRoutes
                preview={preview.value}
                share={share}
                onShare={(route, on) =>
                  setShare((list) =>
                    on ? [...list, route] : list.filter((item) => item !== route)
                  )
                }
              />
            )}
            <div className="devices-dialog-actions">
              <button
                type="button"
                className="settings-btn primary"
                disabled={busy}
                onClick={() => void join(step.ticket, step.host)}
              >
                Connect
              </button>
            </div>
          </div>
        )}

        {step.kind === 'joining' && (
          <p role="status" className="settings-muted">
            Waiting for {step.host} to say yes…
          </p>
        )}

        {error && (
          <p role="alert" className="chat-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** An expiry in seconds (the helper's) or milliseconds, as milliseconds. */
const toMs = (at: number): number => (at < 1e12 ? at * 1000 : at)

/** Time left as `m:ss`, never below zero. */
export const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** The other computer's link: a sent one goes on to its code, a shown one to Connect. */
function PasteField({ onText }: { onText: (text: string) => boolean }) {
  const [pasted, setPasted] = useState('')
  const [notLink, setNotLink] = useState(false)
  const paste = (event: FormEvent) => {
    event.preventDefault()
    setNotLink(!onText(pasted))
  }
  return (
    <>
      <form className="engine-paste" onSubmit={paste}>
        <input
          className="settings-input"
          value={pasted}
          placeholder="Or paste their link"
          aria-label="Pairing link"
          onChange={(event) => {
            setPasted(event.target.value)
            setNotLink(false)
          }}
        />
        <button type="submit" className="settings-btn" disabled={!pasted.trim()}>
          Continue
        </button>
      </form>
      {notLink && (
        <p role="alert" className="chat-error">
          This isn’t a link from Mousse.
        </p>
      )}
    </>
  )
}

/** One way to add a device: its name, and a one-line hint under it. */
function Choice({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
  return (
    <div className="engine-choice">
      <button type="button" className="settings-btn devices-dialog-btn" onClick={onClick}>
        {label}
      </button>
      <span className="engine-choice-hint">{hint}</span>
    </div>
  )
}

function QrCode({ text }: { text: string }) {
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

async function defaultCamera(): Promise<MediaStream | undefined> {
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
function Scanner({
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
  const [pasted, setPasted] = useState(''),
    [notLink, setNotLink] = useState(false)
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

  const paste = (event: FormEvent) => {
    event.preventDefault()
    setNotLink(!onText(pasted))
  }

  return (
    <div className="engine-scan">
      {state === 'none' ? (
        <p className="settings-muted">Scan from the other computer instead.</p>
      ) : (
        <video ref={video} className="engine-scan-video" muted playsInline aria-label="Camera" />
      )}
      <form className="engine-paste" onSubmit={paste}>
        <input
          className="settings-input"
          value={pasted}
          placeholder="Or paste the link"
          aria-label="Pairing link"
          onChange={(event) => {
            setPasted(event.target.value)
            setNotLink(false)
          }}
        />
        <button type="submit" className="settings-btn" disabled={!pasted.trim()}>
          Continue
        </button>
      </form>
      {notLink && (
        <p role="alert" className="chat-error">
          This isn’t a link from Mousse.
        </p>
      )}
    </div>
  )
}
