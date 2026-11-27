import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent
} from 'react'
import type {
  NetEngineDevice,
  NetEngineJoinPreview,
  NetEngineLinkJoin,
  NetEngineStatus,
  NetEngineWay
} from '../../../shared/netEngine/local'
import type { AccessPresetFields } from '../../../shared/net/accessPresets'
import { ROUTE_WORDS, unreachableDetail } from './engineRows'
import { defaultLevel, LevelPicker } from './AllowPrompt'
import { AlsoLet } from './pairingParts'
import { CopyButton } from '../settings/IconButtons'
import { errorText, useDaemonCall } from '../devices/useDaemonCall'

/**
 * What the inviting window shows once the other computer joined: connected, or finishing the other direction until
 * the row's stuck bound (`rowStuckMs`), then why and Retry.
 */
export function JoinedLine({ device }: { device: NetEngineDevice }) {
  const { call, busy, error } = useDaemonCall()
  // Let in one way: done once it is let in.
  if (device.direction === 'in')
    return (
      <p role="status" className="settings-muted">
        {device.name} can use this computer.
      </p>
    )
  if (device.state === 'connected')
    return (
      <p role="status" className="settings-muted">
        {device.name} is connected.
      </p>
    )
  if (!device.stuck)
    return (
      <p role="status" className="settings-muted">
        {device.name} can use this computer; finishing the other direction…
      </p>
    )
  return (
    <div className="engine-link-ended" role="group" aria-label="Pairing did not finish">
      <p role="alert" className="chat-error">
        {error || unreachableDetail(device, 'in')}
      </p>
      <button
        type="button"
        className="settings-btn"
        disabled={busy}
        onClick={() => void call('netEngine.retry', { node: device.node })}
      >
        Retry
      </button>
    </div>
  )
}

/** What Enter link says of a link it cannot read. */
const DAMAGED = 'This link is damaged. Ask for a new one.'

/** `123456` as `123 456`. */
export const spacedCode = (code: string): string =>
  code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code

const triesLeft = (left: number): string => (left === 1 ? '1 try left' : `${left} tries left`)

/**
 * Send link (§5.1): what the device may do here first (there is no Allow on a link: the level is saved with the link,
 * before anyone has it), then a kind-2 invitation's link to copy into a chat, and the code to read out another way,
 * with the tries left. Three wrong codes end it; New link makes another at the same level.
 */
export function SendLinkPanel({
  status,
  way,
  onInvitation
}: {
  status: NetEngineStatus | undefined
  /** The one way the link carries; every way when unset. */
  way?: NetEngineWay
  /** The invitation shown now (the dialog ends it on close), or undefined once it ended or was used. */
  onInvitation: (invitation: string | undefined) => void
}) {
  const { error, call } = useDaemonCall()
  const [fields, setFields] = useState<AccessPresetFields>(defaultLevel)
  // The level the link is made with, once Make link was tapped.
  const [level, setLevel] = useState<AccessPresetFields>()
  const [made, setMade] = useState<{
    invitation: string
    uri: string
    code?: string
    attemptsLeft?: number
  }>()
  const [round, setRound] = useState(0)
  const onInvitationRef = useRef(onInvitation)
  onInvitationRef.current = onInvitation

  useEffect(() => {
    if (!level) return
    let live = true
    setMade(undefined)
    void call<{ invitation: string; uri: string; code?: string; attemptsLeft?: number }>(
      'netEngine.invite',
      { kind: 'link', access: level, ...(way ? { way } : {}) }
    ).then((answer) => {
      if (!answer || !live) return
      setMade(answer.value)
      onInvitationRef.current(answer.value.invitation)
    })
    return () => {
      live = false
    }
  }, [round, call, level, way])

  const shown = made && status?.links?.find((link) => link.invitation === made.invitation)
  const code = shown?.code ?? made?.code ?? ''
  const left = shown?.attemptsLeft ?? made?.attemptsLeft ?? 3
  const joined = shown?.node && status?.devices.find((device) => device.node === shown.node)

  useEffect(() => {
    if (shown?.ended) onInvitationRef.current(undefined)
  }, [shown?.ended])

  if (!level)
    return (
      <div className="engine-allow" role="group" aria-label="Send a link">
        <p className="engine-allow-title">What can it do here?</p>
        <LevelPicker fields={fields} onChange={setFields} busy={false} />
        <div className="devices-dialog-actions">
          <button type="button" className="settings-btn ui-btn-primary" onClick={() => setLevel(fields)}>
            Make link
          </button>
        </div>
      </div>
    )
  if (error)
    return (
      <p role="alert" className="chat-error">
        {error}
      </p>
    )
  if (!made) return <p className="settings-muted">Making a link…</p>
  if (joined) return <JoinedLine device={joined} />
  // The right code was typed: the link is used, and its row comes next.
  if (shown && (shown.node || shown.ended === 'used'))
    return (
      <p role="status" className="settings-muted">
        Adding the other computer…
      </p>
    )
  if (shown?.ended && shown.ended !== 'used')
    return (
      <div className="engine-link-ended" role="group" aria-label="Link ended">
        <p role="status">
          {shown.ended === 'attempts_exhausted'
            ? 'Three wrong codes. This link no longer works.'
            : 'This link no longer works.'}
        </p>
        <button type="button" className="settings-btn" onClick={() => setRound(round + 1)}>
          New link
        </button>
      </div>
    )
  return (
    <div className="engine-link">
      <div className="engine-paste">
        <input className="settings-input" readOnly value={made.uri} aria-label="Link" />
        <CopyButton text={made.uri} label="Copy link" />
      </div>
      <p
        className="engine-link-code"
        aria-label="Code"
        title="The code is not in the link. Whoever has the link still needs it."
      >
        {spacedCode(code)}
      </p>
      <p className="settings-muted" role="status">
        {triesLeft(left)}
      </p>
      <p
        className="settings-muted"
        title="The link works once, for a few minutes. After three wrong codes it stops working."
      >
        Send the link in a chat. Read the code to them another way.
      </p>
    </div>
  )
}

/**
 * Enter link (§5.3): the link, read here before anything is dialled (a decode error says the link is damaged);
 * the consent with the destinations it will contact and "Also let it use this computer", unticked ("Also share"
 * under it once ticked); then the code, typed in six boxes while the join waits for it.
 */
export function EnterLinkPanel({
  status,
  initialLink,
  onJoined
}: {
  status: NetEngineStatus | undefined
  /** A `mousse://pair` link that opened Mousse. */
  initialLink?: string
  onJoined: () => void
}) {
  const { busy, error, setError, call } = useDaemonCall()
  const [text, setText] = useState(initialLink ?? '')
  const [preview, setPreview] = useState<NetEngineJoinPreview & { link: string }>()
  const [share, setShare] = useState<string[]>([])
  const [back, setBack] = useState(false)
  const [joining, setJoining] = useState(false)

  const read = async (link: string) => {
    setError('')
    try {
      const value = await window.mousse.platformRequest.request<NetEngineJoinPreview>(
        'netEngine.join.preview',
        { ticket: link }
      )
      setPreview({ ...value, link })
    } catch {
      setError(DAMAGED)
    }
  }
  // A link that opened Mousse is read at once.
  const readInitial = useRef(initialLink)
  useEffect(() => {
    if (readInitial.current) void read(readInitial.current)
    readInitial.current = undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const connect = async () => {
    if (!preview) return
    setJoining(true)
    const answer = await call('netEngine.join', {
      ticket: preview.link,
      arrival: 'link',
      back,
      ...(back && share.length ? { share } : {})
    })
    setJoining(false)
    if (answer) onJoined()
    else setPreview(undefined)
  }

  const running =
    preview?.invitation !== undefined
      ? status?.joins?.find((join) => join.invitation === preview.invitation)
      : undefined

  if (joining && preview)
    return running?.needsCode ? (
      <CodeEntry join={running} />
    ) : (
      <p role="status" className="settings-muted">
        Connecting…
      </p>
    )

  if (preview) {
    const name = preview.name || 'the other computer'
    return (
      <div className="engine-confirm">
        <p>Use {preview.name || 'the computer in this link'} from here?</p>
        <AlsoLet
          name={name}
          checked={back}
          disabled={busy}
          onChange={(next) => {
            setBack(next)
            if (!next) setShare([])
          }}
        />
        <JoinRoutes
          preview={back ? preview : { ...preview, shareable: [] }}
          share={share}
          onShare={(route, on) =>
            setShare((list) => (on ? [...list, route] : list.filter((item) => item !== route)))
          }
        />
        <div className="devices-dialog-actions">
          <button
            type="button"
            className="settings-btn ui-btn-primary"
            disabled={busy}
            onClick={() => void connect()}
          >
            Connect
          </button>
        </div>
        {error && (
          <p role="alert" className="chat-error">
            {error}
          </p>
        )}
      </div>
    )
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void read(text.trim())
  }
  return (
    <div className="engine-scan">
      <form className="engine-paste" onSubmit={submit}>
        <input
          className="settings-input"
          value={text}
          autoFocus
          placeholder="Paste the link"
          aria-label="Link"
          onChange={(event) => {
            setText(event.target.value)
            setError('')
          }}
        />
        <button type="submit" className="settings-btn ui-btn-primary" disabled={busy || !text.trim()}>
          Continue
        </button>
      </form>
      {error && (
        <p role="alert" className="chat-error">
          {error}
        </p>
      )}
    </div>
  )
}

/** Six boxes for the code the other computer shows; a wrong one says the link may have been swapped (§5.3). */
export function CodeEntry({ join }: { join: NetEngineLinkJoin }) {
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', ''])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const boxes = useRef<Array<HTMLInputElement | null>>([])
  const code = digits.join('')

  // A wrong code clears the boxes for the next try.
  const tries = join.attemptsLeft
  useEffect(() => {
    if (join.wrong) {
      setDigits(['', '', '', '', '', ''])
      boxes.current[0]?.focus()
    }
  }, [join.wrong, tries])

  const put = (at: number, value: string) => {
    const typed = value.replace(/\D/g, '')
    const next = [...digits]
    if (typed.length > 1) {
      for (let i = 0; i < typed.length && at + i < 6; i++) next[at + i] = typed[i]!
      setDigits(next)
      boxes.current[Math.min(5, at + typed.length)]?.focus()
      return
    }
    next[at] = typed
    setDigits(next)
    if (typed && at < 5) boxes.current[at + 1]?.focus()
  }
  const back = (at: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !digits[at] && at > 0) boxes.current[at - 1]?.focus()
  }
  const paste = (at: number, event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault()
    put(at, event.clipboardData.getData('text'))
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await window.mousse.platformRequest.request('netEngine.join.code', {
        invitation: join.invitation,
        code
      })
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="engine-code-entry" onSubmit={(event) => void submit(event)}>
      <p>Type the code shown on the other computer.</p>
      <div className="engine-code-boxes" role="group" aria-label="Code">
        {digits.map((digit, at) => (
          <input
            key={at}
            ref={(element) => {
              boxes.current[at] = element
            }}
            className="settings-input engine-code-box"
            value={digit}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus={at === 0}
            aria-label={`Digit ${at + 1}`}
            onChange={(event) => put(at, event.target.value)}
            onKeyDown={(event) => back(at, event)}
            onPaste={(event) => paste(at, event)}
          />
        ))}
      </div>
      {join.wrong && (
        <p role="alert" className="chat-error">
          That code didn&apos;t work. If you typed it exactly, the link may have been swapped; get a
          new one another way.
        </p>
      )}
      {typeof join.attemptsLeft === 'number' && (
        <p className="settings-muted">{triesLeft(join.attemptsLeft)}</p>
      )}
      {error && (
        <p role="alert" className="chat-error">
          {error}
        </p>
      )}
      <div className="devices-dialog-actions">
        <button type="submit" className="settings-btn ui-btn-primary" disabled={busy || code.length !== 6}>
          Confirm
        </button>
      </div>
    </form>
  )
}

/**
 * The Connect dialog's routes (1b §1.3): every destination the ticket names, with its class (Connect approves
 * them), and this computer's tailnet, internet and tunnel routes as unticked boxes under "Also share".
 */
export function JoinRoutes({
  preview,
  share,
  onShare
}: {
  preview: NetEngineJoinPreview
  share: string[]
  onShare: (route: string, on: boolean) => void
}) {
  return (
    <>
      {!!preview.destinations?.length && (
        <p
          className="settings-muted engine-destinations"
          title="Connect lets this computer dial these addresses."
        >
          {preview.destinations
            .map((item) =>
              item.cls === 'relay' ? `Through relay ${item.label}` : `${item.label} (${ROUTE_WORDS[item.cls]})`
            )
            .join(', ')}
        </p>
      )}
      {!!preview.shareable?.length && (
        <fieldset className="engine-share">
          <legend title="It can reach this computer at the ticked addresses too.">
            Also share
          </legend>
          {preview.shareable.map((item) => (
            <label key={item.route} className="engine-share-item">
              <input
                type="checkbox"
                checked={share.includes(item.route)}
                onChange={(event) => onShare(item.route, event.target.checked)}
              />
              {ROUTE_WORDS[item.cls]} {item.label}
            </label>
          ))}
        </fieldset>
      )}
    </>
  )
}
