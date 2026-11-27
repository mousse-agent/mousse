import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SCAN_INTERVAL_MS,
  type NetEngineJoinCheck,
  type NetEngineJoinPreview,
  type NetEngineJoinProbe,
  type NetEngineStatus
} from '../../../shared/netEngine/local'
import { Modal } from '../ui/Modal'
import { DelayedLoader } from '../ui/DelayedLoader'
import { useDaemonCall } from '../devices/useDaemonCall'
import { readPairingLink } from './engineRows'
import { Segmented } from '../settings/SettingsRow'
import { AlsoLet, BackButton, CheckIcon, defaultCamera, LinkForm, Scanner } from './pairingParts'
import { EnterLinkPanel, JoinRoutes } from './SendLinkParts'
import { SshAddSteps } from './SshAddSteps'
import { cannotUse, hasFeatures, linkWays, waysText } from './ways'

/** How the other computer is reached: its link pasted, its QR code scanned, or SSH. */
type Tab = 'link' | 'scan' | 'ssh'

type Step =
  | { kind: 'choose' }
  | { kind: 'check'; ticket: string; host?: string }
  | { kind: 'enter'; link?: string }

/** The other computer, before it says its own name. */
const UNNAMED_HOST = 'the other computer'

/** Where the link or code comes from. */
const OTHER_SIDE = 'On the other computer, choose Let a device in.'

/**
 * Use another computer from here: Link, Scan or SSH along the top. A link is read and, where networking can,
 * checked from here before anything is sent; this computer only uses it unless "Also let" is on.
 */
export function UseComputerDialog({
  status,
  onClose,
  initialLink,
  camera = defaultCamera
}: {
  status: NetEngineStatus | undefined
  onClose: () => void
  /** A `mousse://pair` link that opened Mousse: it is read at once. */
  initialLink?: string
  /** Opens a camera stream; tests and computers without one answer undefined. */
  camera?: () => Promise<MediaStream | undefined>
}) {
  const [step, setStep] = useState<Step>({ kind: 'choose' })
  const [tab, setTab] = useState<Tab>('link')
  const [notRead, setNotRead] = useState('')

  // One reader for pasted and scanned links: a sent link (kind 2) goes on to its code, a shown one to the check.
  const read = useCallback(
    (text: string): boolean => {
      const link = readPairingLink(text)
      if (!link) return false
      setNotRead('')
      const check = () => setStep({ kind: 'check', ticket: link.ticket, ...(link.host ? { host: link.host } : {}) })
      if (!status?.sendLink) {
        check()
        return true
      }
      void window.mousse.platformRequest
        .request<NetEngineJoinPreview>('netEngine.join.preview', { ticket: link.ticket })
        .then((value) => (value?.kind === 2 ? setStep({ kind: 'enter', link: link.ticket }) : check()), check)
      return true
    },
    [status?.sendLink]
  )
  const readInitial = useRef(initialLink)
  useEffect(() => {
    const link = readInitial.current
    readInitial.current = undefined
    if (link && !read(link)) setNotRead('This isn’t a link from Mousse.')
  }, [read])

  // SSH needs a helper that speaks protocol 1.1, which reports Reach.
  const ssh = !!(status?.on && status.reach)
  const tabs: Array<{ value: Tab; label: string; title: string }> = [
    { value: 'link', label: 'Link', title: 'Paste the link the other computer shows or sent' },
    { value: 'scan', label: 'Scan', title: 'Scan its QR code with this computer’s camera' },
    ...(ssh ? [{ value: 'ssh' as const, label: 'SSH', title: 'No code needed. Uses your SSH keys or agent.' }] : [])
  ]
  const choosing = step.kind === 'choose'
  return (
    <Modal
      open
      className="engine-pair-modal"
      title="Use another computer"
      headerStart={choosing ? undefined : <BackButton onBack={() => setStep({ kind: 'choose' })} />}
      onClose={onClose}
    >
      <div className="engine-dialog" data-step={choosing ? tab : step.kind}>
        {choosing && (
          <>
            <Segmented
              ariaLabel="How to connect"
              value={tab}
              options={tabs}
              onChange={(next) => {
                setNotRead('')
                setTab(next)
              }}
            />
            {tab === 'link' && <LinkForm onText={read} hint={OTHER_SIDE} />}
            {tab === 'scan' && (
              <>
                <Scanner camera={camera} everyMs={status?.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS} onText={read} />
                <p className="engine-hint">{OTHER_SIDE}</p>
              </>
            )}
            {tab === 'ssh' && <SshAddSteps onDone={onClose} />}
          </>
        )}
        {step.kind === 'enter' && (
          <EnterLinkPanel status={status} initialLink={step.link} onJoined={onClose} />
        )}
        {step.kind === 'check' && (
          <CheckStep status={status} ticket={step.ticket} host={step.host} onJoined={onClose} />
        )}
        {notRead && (
          <p role="alert" className="chat-error">
            {notRead}
          </p>
        )}
      </div>
    </Modal>
  )
}

/**
 * "Use <name> from here": the ways its link names and whether it answered from here, or why it can't work and what
 * to do (with Check again) before anything is sent. "Also let <name> use this computer", unticked, then Connect.
 */
export function CheckStep({
  status,
  ticket,
  host,
  onJoined
}: {
  status: NetEngineStatus | undefined
  ticket: string
  host?: string
  onJoined: () => void
}) {
  // Checking and connecting each have their own call, so a slow check never holds the checkbox.
  const checker = useDaemonCall()
  const checkCall = checker.call
  const { busy, error, call } = useDaemonCall()
  const [preview, setPreview] = useState<NetEngineJoinPreview>()
  const [damaged, setDamaged] = useState(false)
  const [check, setCheck] = useState<NetEngineJoinCheck>()
  const [probe, setProbe] = useState<NetEngineJoinProbe>()
  const [probing, setProbing] = useState(false)
  const [round, setRound] = useState(0)
  const [back, setBack] = useState(false)
  const [share, setShare] = useState<string[]>([])
  const [joining, setJoining] = useState(false)
  const checks = hasFeatures(status, 'route-readiness')
  const probes = hasFeatures(status, 'join-probe')

  useEffect(() => {
    let live = true
    void window.mousse.platformRequest
      .request<NetEngineJoinPreview>('netEngine.join.preview', { ticket })
      .then(
        (value) => {
          if (live) setPreview(value)
        },
        // The daemon refuses a ticket it cannot decode.
        () => {
          if (live) setDamaged(true)
        }
      )
    return () => {
      live = false
    }
  }, [ticket])

  // Read what the link names, then try it from here; Check again does both once more. Nothing is sent to it.
  useEffect(() => {
    if (!checks) return
    let live = true
    setCheck(undefined)
    setProbe(undefined)
    void (async () => {
      const read = await checkCall<NetEngineJoinCheck>('netEngine.join.check', { ticket })
      if (!live || !read) return
      setCheck(read.value)
      if (!probes || cannotUse(UNNAMED_HOST, read.value, undefined)) return
      setProbing(true)
      const tried = await checkCall<NetEngineJoinProbe>('netEngine.join.probe', { ticket })
      if (!live) return
      setProbing(false)
      if (tried) setProbe(tried.value)
    })()
    return () => {
      live = false
      setProbing(false)
      void window.mousse.platformRequest
        .request('netEngine.join.probe.cancel', { ticket })
        .catch(() => undefined)
    }
  }, [ticket, checks, probes, round, checkCall])

  const name = preview?.name || check?.name || host || UNNAMED_HOST
  const blocked = check ? cannotUse(name, check, probe) : undefined
  const ways = check ? linkWays(check) : []

  const connect = async () => {
    setJoining(true)
    const answer = await call('netEngine.join', {
      ticket,
      back,
      ...(back && share.length ? { share } : {})
    })
    setJoining(false)
    if (answer) onJoined()
  }

  if (joining)
    return (
      <p role="status" className="settings-muted">
        Waiting for {name} to say yes…
      </p>
    )
  if (damaged)
    return (
      <p role="alert" className="chat-error">
        This link is damaged. Ask for a new one.
      </p>
    )
  return (
    <div className="engine-check">
      <p className="engine-check-title">Use {name} from here</p>
      {ways.length > 0 && (
        <p className="settings-muted" title={probe?.reachable === true ? probe.route : undefined}>
          Connects over {waysText(ways)}
        </p>
      )}
      {preview?.expired && (
        <p role="alert" className="chat-error">
          This code has expired. Make a new one on {name}.
        </p>
      )}
      {blocked ? (
        <div className="engine-check-blocked" role="group" aria-label="Can’t connect">
          <p role="alert" className="engine-check-line">
            <CheckIcon ok={false} />
            <span className="chat-error">{blocked.why}</span>
          </p>
          <p className="settings-muted engine-check-todo">{blocked.todo}</p>
          <button
            type="button"
            className="settings-btn"
            disabled={checker.busy}
            onClick={() => setRound(round + 1)}
          >
            Check again
          </button>
        </div>
      ) : probing ? (
        <DelayedLoader label={`Checking ${name} from here`} />
      ) : probe?.reachable === true ? (
        <p className="engine-check-line" role="status">
          <CheckIcon ok />
          {name} can be reached from this computer
        </p>
      ) : (
        <p className="settings-muted" role="status">
          {!checks || !probes
            ? 'Connect tries each way it names.'
            : probe
              ? 'Couldn’t check from here. Connect still tries.'
              : check
                ? 'Connect tries each way it names.'
                : 'Reading the code…'}
        </p>
      )}
      <AlsoLet
        name={name}
        checked={back}
        disabled={busy}
        onChange={(next) => {
          setBack(next)
          if (!next) setShare([])
        }}
      />
      {preview && (
        <JoinRoutes
          preview={back ? preview : { ...preview, shareable: [] }}
          share={share}
          onShare={(route, on) =>
            setShare((list) => (on ? [...list, route] : list.filter((item) => item !== route)))
          }
        />
      )}
      {(error || checker.error) && (
        <p role="alert" className="chat-error">
          {error || checker.error}
        </p>
      )}
      <div className="devices-dialog-actions">
        <button
          type="button"
          className="settings-btn ui-btn-primary"
          disabled={busy || !!blocked || !!preview?.expired}
          onClick={() => void connect()}
        >
          Connect
        </button>
      </div>
    </div>
  )
}
