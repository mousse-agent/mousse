import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { formatCountdown, secondsLeft } from '../../lib/plusSignIn'
import { allowDetail, linkErrorWords, linkRefusal } from '../../lib/netDevices'
import type { NetLinkCheck, NetLinkMade, NetLinkPasted } from '../../../shared/net/local'
import type { PlatformRequestMethod } from '../../../shared/platform'
import { CopyButton } from '../settings/IconButtons'
import { Modal } from '../ui/Modal'
import { useNow } from './AddDeviceDialog'

type Failure = { code?: unknown; details?: unknown; message?: unknown }
const request = <T,>(method: PlatformRequestMethod, params: unknown) => window.mousse.platformRequest.request<T>(method, params)
const reasonOf = (failure?: Failure) => (failure?.details as { reason?: unknown } | undefined)?.reason
/** The keychain refused new keys: the screen asks for a passphrase, once. */
const needsPassphrase = (failure?: Failure) => failure?.code === 'keystore_locked' && reasonOf(failure) === 'passphrase'

/** One call at a time; nothing is set once the dialog is gone. */
function useLinkCall() {
  const alive = useRef(true)
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<Failure>()
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const run = async <T,>(method: PlatformRequestMethod, params: unknown): Promise<T | undefined> => {
    setBusy(true); setFailure(undefined)
    try {
      const value = await request<T>(method, params)
      return alive.current ? value : undefined
    } catch (cause) {
      if (alive.current) setFailure((cause ?? {}) as Failure)
      return undefined
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return { busy, failure, setFailure, run, alive }
}

function PassphraseField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="devices-field">
      <span>Passphrase for this computer</span>
      <input type="password" value={value} autoFocus onChange={(event) => onChange(event.target.value)} autoComplete="new-password" />
    </label>
  )
}

/**
 * Make a connect link: made as the dialog opens, then copied. On a computer with no network identity this creates
 * it, and this computer keeps the others connected. A passphrase is asked only where the keychain refuses.
 */
export function MakeLinkDialog({ name, now: fixedNow, onMade, onClose }: {
  /** This computer's name, for a computer that has no network identity yet. */
  name?: string
  /** For tests: the time to show the countdown at. */
  now?: number
  onMade: () => void
  onClose: () => void
}) {
  const { busy, failure, run } = useLinkCall()
  const [made, setMade] = useState<NetLinkMade>(), [passphrase, setPassphrase] = useState('')
  const asked = useRef(false)
  const make = async (withPassphrase?: string) => {
    const value = await run<NetLinkMade>('net.link.make', { ...(name?.trim() ? { name: name.trim() } : {}), ...(withPassphrase ? { passphrase: withPassphrase } : {}) })
    if (!value) return
    setMade(value); setPassphrase(''); onMade()
  }
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    void make()
    // Made once, as the dialog opens; a new one is asked for with its button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const ticking = useNow(!!made && fixedNow === undefined)
  const left = made ? secondsLeft(made.expiresAt, fixedNow ?? ticking) : undefined
  const expired = left === 0
  const asking = !made && needsPassphrase(failure)
  const linkRef = useRef<HTMLTextAreaElement>(null)
  const submitPassphrase = (event: FormEvent) => {
    event.preventDefault()
    if (passphrase && !busy) void make(passphrase)
  }
  let body: ReactNode
  if (asking) body = (
    <form id="devices-make-link" className="devices-dialog" onSubmit={submitPassphrase}>
      <p className="settings-muted" title="Protects this computer’s network keys instead of the keychain. You enter it after each restart.">The system keychain refused. Choose a passphrase for this computer’s keys.</p>
      <PassphraseField value={passphrase} onChange={setPassphrase} />
    </form>
  )
  else if (!made) body = <p className="settings-muted">{busy ? 'Making a link…' : ''}</p>
  else if (expired) body = <p className="settings-muted">This link expired.</p>
  else body = <>
    {made.created && <p>This computer will keep the others connected. Pick the one that is usually on.</p>}
    <p className="settings-muted">
      {made.add
        ? 'On the other computer, open Settings → Devices → Add device → Paste a link.'
        : <span title="Only the computer that keeps your list can add a computer.">Connects a device already in your list. To add a computer, make the link on {made.keeper ?? 'the computer that keeps your list'}.</span>}
    </p>
    <label className="devices-field">
      <span>Link</span>
      <textarea ref={linkRef} readOnly value={made.link} onFocus={(event) => event.currentTarget.select()} aria-label="Connect link" />
    </label>
    {!made.reachable && (
      <p className="settings-status-warn" role="status">Only this computer can reach this link. Allow Mousse through the firewall, or turn on Tailscale or SSH.</p>
    )}
    <div className="devices-invite-foot">
      {left !== undefined && <span className="settings-muted" title="A new link stops this one.">Expires in {formatCountdown(left)}</span>}
      <CopyButton text={made.link} label="Copy link" announce onFailed={() => { linkRef.current?.focus(); linkRef.current?.select() }} />
    </div>
  </>
  const footer = asking
    ? <button type="submit" form="devices-make-link" className="settings-btn devices-dialog-btn primary" disabled={busy || !passphrase}>Make link</button>
    : (expired || (!made && failure)) && <button type="button" className="settings-btn devices-dialog-btn primary" disabled={busy} onClick={() => void make()}>Make a new link</button>
  return (
    <Modal open title="Make a link" onClose={onClose} footer={footer || undefined}>
      <div className="devices-dialog">
        {body}
        {failure && !asking && <p role="alert" className="chat-error">{linkErrorWords(failure, 'make')}</p>}
      </div>
    </Modal>
  )
}

/** Allow or Not now for the computer this one just joined through a link; Not now leaves it waiting. */
function AllowStep({ pasted, busy, onAllow, onNotNow }: { pasted: NetLinkPasted; busy: boolean; onAllow: () => void; onNotNow: () => void }) {
  const name = pasted.name ?? 'The other computer'
  return (
    <div className="devices-dialog">
      <p>Joined {name}.</p>
      <p className="settings-muted" title={allowDetail(name, 'joiner')}>Allow it to work on threads here?</p>
      <div className="devices-dialog-actions">
        <button type="button" className="settings-btn" disabled={busy} onClick={onNotNow}>Not now</button>
        <button type="button" className="settings-btn primary" data-mousse-decision="" disabled={busy} title={allowDetail(name, 'joiner')} onClick={onAllow}>Allow</button>
      </div>
    </div>
  )
}

const ROW_LINE: Record<Exclude<NetLinkCheck['row'], 'refused'>, string> = {
  join: 'This computer joins the computer that made the link.',
  connect: 'Connects this computer to a device in your list.',
  start_over: 'This computer is set up alone, so it starts over first.'
}
const ROW_ACTION: Record<Exclude<NetLinkCheck['row'], 'refused'>, string> = {
  join: 'Join',
  connect: 'Connect',
  start_over: 'Start over and join'
}

/**
 * Paste a connect link: what it does here is read from the link with no network call, then Join, Connect, or Start
 * over and join. A join through a link ends on Allow or Not now for the computer that made it.
 */
export function PasteLinkDialog({ name, onPasted, onMakeInstead, onNotNow, onClose }: {
  /** This computer's name, for a computer that has no network identity yet. */
  name?: string
  onPasted: () => void
  /** Close this and make a link on this computer instead. */
  onMakeInstead: () => void
  /** Not now for the computer just joined: the page puts its own Allow notice for it away too; it stays held. */
  onNotNow: (node: string) => void
  onClose: () => void
}) {
  const { busy, failure, setFailure, run } = useLinkCall()
  const [text, setText] = useState(''), [check, setCheck] = useState<NetLinkCheck>(), [notLink, setNotLink] = useState(false)
  const [passphrase, setPassphrase] = useState(''), [asking, setAsking] = useState(false), [pasted, setPasted] = useState<NetLinkPasted>()
  const checked = useRef(0)
  const read = async (value: string) => {
    setText(value); setFailure(undefined); setAsking(false)
    const link = value.trim(), ticket = ++checked.current
    if (!link) { setCheck(undefined); setNotLink(false); return }
    try {
      const result = await request<NetLinkCheck>('net.link.check', { link })
      if (ticket === checked.current) { setCheck(result); setNotLink(false) }
    } catch {
      if (ticket === checked.current) { setCheck(undefined); setNotLink(true) }
    }
  }
  const paste = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!check || check.row === 'refused' || busy || (asking && !passphrase)) return
    const value = await run<NetLinkPasted>('net.link.paste', {
      link: text.trim(),
      ...(name?.trim() ? { name: name.trim() } : {}),
      ...(check.row === 'start_over' ? { startOver: true } : {}),
      ...(asking ? { passphrase } : {})
    })
    setPassphrase('')
    if (!value) return
    onPasted()
    if (value.row === 'join' && value.connection === 'held') setPasted(value)
    else onClose()
  }
  useEffect(() => { if (needsPassphrase(failure)) setAsking(true) }, [failure])
  const allow = async () => {
    if (!pasted || !(await run('bridge.allow', { node: pasted.node }))) return
    onPasted(); onClose()
  }
  if (pasted) return (
    <Modal open title="Paste a link" onClose={onClose}>
      <AllowStep pasted={pasted} busy={busy} onAllow={() => void allow()} onNotNow={() => { onNotNow(pasted.node); onClose() }} />
      {failure && <p role="alert" className="chat-error">{linkErrorWords(failure, 'paste')}</p>}
    </Modal>
  )
  const refusal = check && linkRefusal(check)
  const row = check && check.row !== 'refused' ? check.row : undefined
  // With no route to the maker, the way round is offered only where the topology allows it: between two devices of
  // one list (either makes a link), or on a computer set up alone (its footer offers a link made here). A computer
  // joining one that keeps other devices can't, so the words name the fix on that computer instead.
  const reverse = reasonOf(failure) === 'link_unreachable' && row === 'connect'
  return (
    <Modal
      open
      title="Paste a link"
      onClose={onClose}
      footer={row && <>
        {row === 'start_over' && <button type="button" className="settings-btn devices-dialog-btn" disabled={busy} onClick={onMakeInstead}>Make a link here instead</button>}
        <button type="submit" form="devices-paste-link" className={`settings-btn devices-dialog-btn ${row === 'start_over' ? 'danger-fill' : 'primary'}`} disabled={busy || (asking && !passphrase)}>{ROW_ACTION[row]}</button>
      </>}
    >
      <form id="devices-paste-link" className="devices-dialog" onSubmit={(event) => void paste(event)}>
        <label className="devices-field">
          <span>Link</span>
          <textarea value={text} autoFocus onChange={(event) => void read(event.target.value)} aria-label="Connect link to paste" />
        </label>
        {notLink && <p role="alert" className="chat-error">This isn’t a Mousse link.</p>}
        {row && (
          <p className="settings-muted" title={row === 'start_over' ? 'It leaves its own setup and gets new keys, only once the other computer answers. Threads, bots and work stay.' : undefined}>{ROW_LINE[row]}</p>
        )}
        {refusal && <p role="alert" className="chat-error">{refusal}</p>}
        {asking && <PassphraseField value={passphrase} onChange={setPassphrase} />}
        {failure && !needsPassphrase(failure) && <p role="alert" className="chat-error">{linkErrorWords(failure, 'paste')}</p>}
        {reverse && (
          <div className="devices-dialog-actions">
            <button type="button" className="settings-btn" disabled={busy} title="Make a link on this computer and paste it on the other one." onClick={onMakeInstead}>Start from this computer instead</button>
          </div>
        )}
      </form>
    </Modal>
  )
}
