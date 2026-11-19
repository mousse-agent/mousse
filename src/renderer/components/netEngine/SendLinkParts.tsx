import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent
} from 'react'
import type {
  NetEngineJoinPreview,
  NetEngineLinkJoin,
  NetEngineStatus
} from '../../../shared/netEngine/local'
import { ROUTE_CLASS_LABEL } from '../../../shared/netEngine/routes'
import { CopyButton } from '../settings/IconButtons'
import { errorText, useDaemonCall } from '../devices/useDaemonCall'

/** What Enter link says of a link it cannot read. */
const DAMAGED = 'This link is damaged. Ask for a new one.'

/** `123456` as `123 456`. */
export const spacedCode = (code: string): string =>
  code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code

const triesLeft = (left: number): string => (left === 1 ? '1 try left' : `${left} tries left`)

/**
 * Send link (§5.1): a kind-2 invitation's link to copy into a chat, and the code to read out another way, with
 * the tries left. Three wrong codes end it; New link makes another.
 */
export function SendLinkPanel({
  status,
  onInvitation
}: {
  status: NetEngineStatus | undefined
  /** The invitation shown now (the dialog ends it on close), or undefined once it ended or was used. */
  onInvitation: (invitation: string | undefined) => void
}) {
  const { error, call } = useDaemonCall()
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
    let live = true
    setMade(undefined)
    void call<{ invitation: string; uri: string; code?: string; attemptsLeft?: number }>(
      'netEngine.invite',
      { kind: 'link' }
    ).then((answer) => {
      if (!answer || !live) return
      setMade(answer.value)
      onInvitationRef.current(answer.value.invitation)
    })
    return () => {
      live = false
    }
  }, [round, call])

  const shown = made && status?.links?.find((link) => link.invitation === made.invitation)
  const code = shown?.code ?? made?.code ?? ''
  const left = shown?.attemptsLeft ?? made?.attemptsLeft ?? 3
  const joined = shown?.node && status?.devices.find((device) => device.node === shown.node)

  useEffect(() => {
    if (shown?.ended) onInvitationRef.current(undefined)
  }, [shown?.ended])

  if (error)
    return (
      <p role="alert" className="chat-error">
        {error}
      </p>
    )
  if (!made) return <p className="settings-muted">Making a link…</p>
  if (joined)
    return (
      <p role="status" className="settings-muted">
        {joined.state === 'connected'
          ? `${joined.name} is connected.`
          : `${joined.name} can use this computer; finishing the other direction…`}
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
 * the consent with the destinations it will contact and "Also share", unticked; then the code, typed in six boxes
 * while the join waits for it.
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
      ...(share.length ? { share } : {})
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

  if (preview)
    return (
      <div className="engine-confirm">
        <p>Connect to the computer in this link? It will also be able to use this computer.</p>
        <JoinRoutes
          preview={preview}
          share={share}
          onShare={(route, on) =>
            setShare((list) => (on ? [...list, route] : list.filter((item) => item !== route)))
          }
        />
        <div className="devices-dialog-actions">
          <button
            type="button"
            className="settings-btn primary"
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
        <button type="submit" className="settings-btn" disabled={busy || !text.trim()}>
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
        <button type="submit" className="settings-btn primary" disabled={busy || code.length !== 6}>
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
            .map((item) => `${item.label} (${ROUTE_CLASS_LABEL[item.cls]})`)
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
              {ROUTE_CLASS_LABEL[item.cls]} {item.label}
            </label>
          ))}
        </fieldset>
      )}
    </>
  )
}
