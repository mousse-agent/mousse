import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { AccessPresetFields } from '../../../shared/net/accessPresets'
import type {
  NetEngineStatus,
  NetEngineWay,
  NetEngineWayReadiness
} from '../../../shared/netEngine/local'
import { Modal } from '../ui/Modal'
import { Select, type SelectOption } from '../ui/Select'
import { DelayedLoader } from '../ui/DelayedLoader'
import { Segmented } from '../settings/SettingsRow'
import { useDaemonCall } from '../devices/useDaemonCall'
import { AllowPrompt } from './AllowPrompt'
import { CloudflareSetup } from './CloudflareSetup'
import { BackButton, ChoiceRow, clock, endInvitation, Preparing, QrCode, toMs, useNow } from './pairingParts'
import { JoinedLine, SendLinkPanel } from './SendLinkParts'
import { hasFeatures, WAY_LABEL, WAY_ORDER, wayFix, wayReason } from './ways'

interface Invite {
  invitation: string
  uri: string
  expiresAt?: number
  ways?: NetEngineWay[]
}

/** What the dialog shows: a code to share, the list of ways (to set one up or turn it on), or the tunnel's setup. */
type View = 'code' | 'ways' | 'tunnel'

/** How the code is shared: shown as a QR code, or sent as a link with a code read out another way. */
type Share = 'qr' | 'link'

/** Where the dialog opens when Reach this computer opens it: the tunnel's setup, or a link over one way. */
export type LetDeviceInStart = { kind: 'tunnel' } | { kind: 'link'; way?: NetEngineWay }

/** The way menu's last entry, which opens the list of ways. */
const OTHER_WAYS = 'other'

/**
 * Let a device in: QR code or Link along the top, the code under it, and the way it connects over as a menu of the
 * ready ways. It opens on a code for the nearest ready way; with none ready, on the list of ways with what fixes
 * each. The device's request is answered here with the access it gets. Closing ends the code it made.
 */
export function LetDeviceInDialog({
  status,
  initial,
  onClose,
  onSetUp,
  onAddPhone
}: {
  status: NetEngineStatus | undefined
  /** Opens at this step instead of a code for the nearest ready way. */
  initial?: LetDeviceInStart
  onClose: () => void
  /** Opens Reach this computer for a way that needs setting up there (the dialog closes). */
  onSetUp: (way: NetEngineWay) => void
  /** Add a phone (the old networking's phones, Mousse ID builds); absent where phones can't be added. */
  onAddPhone?: () => void
}) {
  const engine = status && status.helper.state !== 'not_in_build' ? status : undefined
  const ready = engine?.helper.state === 'running'
  const picker = hasFeatures(status, 'route-readiness', 'invite-way')
  // A code or link names its way only to a helper that takes one.
  const pickWay = hasFeatures(status, 'invite-way')
  const [view, setView] = useState<View | undefined>(
    initial?.kind === 'tunnel' ? 'tunnel' : initial?.kind === 'link' ? 'code' : undefined
  )
  const [share, setShare] = useState<Share>(initial?.kind === 'link' ? 'link' : 'qr')
  const [way, setWay] = useState<NetEngineWay | undefined>(initial?.kind === 'link' ? initial.way : undefined)
  const ways = useWays(picker && ready, status)
  // The tunnel's setup is a step here when this computer can run Cloudflare Tunnel itself.
  const managedTunnel = hasFeatures(status, 'managed-tunnel') && !!engine?.cloudflare
  const setUp = (next: NetEngineWay) => (next === 'tunnel' && managedTunnel ? setView('tunnel') : onSetUp(next))
  // A device asked to come in (or was let in): the dialog shows only that.
  const [answering, setAnswering] = useState(false)
  const { busy, error, setError, call } = useDaemonCall()

  // Once networking runs, open on a code for the nearest ready way, or on the list when none is ready. A helper
  // without the picker makes a code as before.
  const readyWays = (ways.list ?? []).filter((item) => item.state === 'ready').map((item) => item.way)
  const nearest = readyWays[0]
  useEffect(() => {
    if (view || !ready) return
    if (!picker) setView('code')
    else if (ways.list) {
      if (nearest) setWay(nearest)
      setView(nearest ? 'code' : 'ways')
    }
  }, [view, ready, picker, ways.list, nearest])

  // The code this dialog shows, and a Send link it made: closing ends whichever is still open.
  const inviteRef = useRef<string | undefined>(undefined)
  const linkRef = useRef<string | undefined>(undefined)
  useEffect(
    () => () => {
      endInvitation(inviteRef)
      endInvitation(linkRef)
    },
    []
  )

  const pickShare = (next: Share) => {
    // Only the shown one stays open: a QR code nobody sees, or a link nobody sent, is ended.
    endInvitation(next === 'link' ? inviteRef : linkRef)
    setShare(next)
  }
  const endShown = () => {
    endInvitation(inviteRef)
    endInvitation(linkRef)
  }
  const pickWayFromMenu = (next: string) => {
    if (next === way) return
    // A code is valid only while it shows: the list of ways ends it, and coming back makes a new one.
    endShown()
    if (next === OTHER_WAYS) setView('ways')
    else setWay(next as NetEngineWay)
  }
  const makeFor = (next: NetEngineWay) => {
    setWay(next)
    setView('code')
  }

  const back =
    view === 'tunnel' && picker
      ? () => setView('ways')
      : view === 'ways' && nearest
        ? () => setView('code')
        : undefined
  // The way of the code shown stays listed while the helper's next answer says it is ready.
  const listed = way && !readyWays.includes(way) ? [way, ...readyWays] : readyWays
  const wayOptions: SelectOption[] = [
    ...listed.map((item) => ({ value: item, label: WAY_LABEL[item] })),
    { value: OTHER_WAYS, label: 'Set up another way…' }
  ]

  return (
    <Modal
      open
      className="engine-pair-modal"
      title={view === 'tunnel' ? 'Cloudflare Tunnel' : 'Let a device in'}
      headerStart={back ? <BackButton onBack={back} /> : undefined}
      onClose={onClose}
    >
      <div className="engine-dialog" data-step={view ?? 'starting'}>
        {!view &&
          (status ? <Preparing helper={status.helper} ready={ready && !ways.error && !error} /> : null)}
        {view === 'ways' && ways.list && (
          <WayPicker ways={ways} reach={status?.reach} onMake={makeFor} onSetUp={setUp} />
        )}
        {view === 'tunnel' && (
          <CloudflareSetup
            connection={engine?.cloudflare}
            readiness={hasFeatures(status, 'route-readiness')}
            onMake={() => makeFor('tunnel')}
            onOwnTunnel={() => onSetUp('tunnel')}
          />
        )}
        {view === 'code' && engine && (
          <>
            {engine.sendLink && !answering && (
              <Segmented
                ariaLabel="How to share it"
                value={share}
                options={[
                  { value: 'qr', label: 'QR code' },
                  { value: 'link', label: 'Link' }
                ]}
                onChange={pickShare}
              />
            )}
            {share === 'qr' || !engine.sendLink ? (
              <CodeStep
                key={way ?? 'any'}
                status={engine}
                ready={ready}
                way={pickWay ? way : undefined}
                picker={picker}
                inviteRef={inviteRef}
                busy={busy}
                call={call}
                error={error}
                setError={setError}
                onAnswering={setAnswering}
              />
            ) : (
              <SendLinkPanel
                status={status}
                way={pickWay ? way : undefined}
                onInvitation={(invitation) => {
                  linkRef.current = invitation
                }}
              />
            )}
            {picker && !answering && (
              <WayRow way={way} options={wayOptions} onPick={pickWayFromMenu} />
            )}
          </>
        )}
        {onAddPhone && !answering && view !== 'tunnel' && (
          <div className="engine-pair-foot">
            <button type="button" className="engine-quiet-btn" onClick={onAddPhone}>
              Add a phone
            </button>
          </div>
        )}
        {(ways.error || (error && view !== 'code')) && (
          <p role="alert" className="chat-error">
            {ways.error || error}
          </p>
        )}
      </div>
    </Modal>
  )
}

/** "Connects over" and the way, as a menu of the ready ways; its last entry opens the list of every way. */
function WayRow({
  way,
  options,
  onPick
}: {
  way: NetEngineWay | undefined
  options: SelectOption[]
  onPick: (value: string) => void
}) {
  const labelId = useId()
  return (
    <div className="engine-pair-row">
      <span id={labelId}>Connects over</span>
      <Select
        size="small"
        value={way}
        options={options}
        placeholder="Any ready way"
        ariaLabelledBy={labelId}
        onChange={onPick}
      />
    </div>
  )
}

interface Ways {
  /** Every way, nearest first, once the helper said; undefined before. */
  list: NetEngineWayReadiness[] | undefined
  busy: boolean
  error: string
  /** Turns a way's switch on in Reach and reads the ways again. */
  turnOn: (way: NetEngineWay) => Promise<void>
}

/**
 * The ways this computer has and whether each is ready, read again when Reach or the Cloudflare connection changes,
 * here or elsewhere.
 */
function useWays(enabled: boolean, status: NetEngineStatus | undefined): Ways {
  const { busy, error, call } = useDaemonCall()
  const [list, setList] = useState<NetEngineWayReadiness[]>()
  const [round, setRound] = useState(0)
  const reachKey = JSON.stringify([status?.reach ?? null, status?.cloudflare?.state ?? null])

  const load = useCallback(async () => {
    const answer = await call<{ ways: NetEngineWayReadiness[] }>('netEngine.routes.available', {})
    if (!answer) return
    setList([...answer.value.ways].sort((a, b) => WAY_ORDER.indexOf(a.way) - WAY_ORDER.indexOf(b.way)))
  }, [call])
  useEffect(() => {
    if (enabled) void load()
  }, [enabled, load, round, reachKey])

  const turnOn = async (way: NetEngineWay) => {
    if (await call('netEngine.routes.config', way === 'lan' ? { lan: true } : { tailnet: true }))
      setRound((value) => value + 1)
  }
  return { list, busy, error, turnOn }
}

/** "How will it connect?": each way and whether it is ready; ready ones are picked, the others say why. */
function WayPicker({
  ways,
  reach,
  onMake,
  onSetUp
}: {
  ways: Ways
  reach: NetEngineStatus['reach'] | undefined
  onMake: (way: NetEngineWay) => void
  onSetUp: (way: NetEngineWay) => void
}) {
  const list = ways.list ?? []
  const [picked, setPicked] = useState<NetEngineWay>()
  // The picked way stays while it is ready; otherwise the nearest ready one is picked.
  const chosen =
    picked && list.some((item) => item.way === picked && item.state === 'ready')
      ? picked
      : list.find((item) => item.state === 'ready')?.way

  return (
    <div className="engine-choices">
      <p id="engine-ways-title" className="engine-choices-title">
        How will it connect?
      </p>
      <div className="engine-choice-list" role="radiogroup" aria-labelledby="engine-ways-title">
        {list.map((item) => {
          const on = item.state === 'ready'
          const fix = wayFix(item, reach)
          return (
            <ChoiceRow
              key={item.way}
              selected={chosen === item.way}
              disabled={!on}
              dim={!on}
              title={on ? item.routes.join(', ') : undefined}
              label={WAY_LABEL[item.way]}
              detail={
                on ? (
                  <>
                    <span className="engine-ready-dot" aria-hidden="true" />
                    Ready
                  </>
                ) : (
                  wayReason(item.way, item.reason)
                )
              }
              onPick={() => setPicked(item.way)}
            >
              {fix === 'turn-on' && (
                <button
                  type="button"
                  className="settings-btn engine-way-fix"
                  disabled={ways.busy}
                  onClick={(event) => {
                    event.stopPropagation()
                    void ways.turnOn(item.way)
                  }}
                >
                  Turn on
                </button>
              )}
              {fix === 'set-up' && (
                <button
                  type="button"
                  className="settings-btn engine-way-fix"
                  title="In Reach this computer"
                  onClick={(event) => {
                    event.stopPropagation()
                    onSetUp(item.way)
                  }}
                >
                  Set up
                </button>
              )}
            </ChoiceRow>
          )
        })}
      </div>
      <div className="devices-dialog-actions">
        <button
          type="button"
          className="settings-btn ui-btn-primary"
          disabled={!chosen || ways.busy}
          onClick={() => chosen && onMake(chosen)}
        >
          Make code
        </button>
      </div>
    </div>
  )
}

/**
 * The QR code for one way and "Used once · expires in m:ss" under it; a new one when it runs out. The device's
 * request shows here as Allow; once allowed, its row's state.
 */
function CodeStep({
  status,
  ready,
  way,
  picker,
  inviteRef,
  busy,
  call,
  error,
  setError,
  onAnswering
}: {
  status: NetEngineStatus
  ready: boolean
  way?: NetEngineWay
  picker: boolean
  inviteRef: { current: string | undefined }
  busy: boolean
  call: ReturnType<typeof useDaemonCall>['call']
  error: string
  setError: (text: string) => void
  /** A device's request shows (or it was let in): nothing else goes with it. */
  onAnswering: (answering: boolean) => void
}) {
  const [invite, setInvite] = useState<Invite>()
  const [allowed, setAllowed] = useState<{ name: string }>()

  useEffect(() => {
    if (!ready || invite || allowed) return
    void call<Invite>('netEngine.invite', way ? { way } : {}).then((answer) => {
      if (!answer) return
      inviteRef.current = answer.value.invitation
      setInvite(answer.value)
    })
  }, [ready, invite, allowed, way, call, inviteRef])

  const expiresAt = invite?.expiresAt === undefined ? undefined : toMs(invite.expiresAt)
  const now = useNow(expiresAt)
  const approval = invite && status.approvals.find((item) => item.invitation === invite.invitation)
  const answering = !!approval || !!allowed
  useEffect(() => onAnswering(answering), [answering, onAnswering])
  useEffect(() => () => onAnswering(false), [onAnswering])
  useEffect(() => {
    if (expiresAt === undefined || now < expiresAt || approval || allowed) return
    inviteRef.current = undefined
    setInvite(undefined)
  }, [now, expiresAt, approval, allowed, inviteRef])

  const answer = async (yes: boolean, access?: AccessPresetFields) => {
    if (!approval) return
    setError('')
    if (await call('netEngine.approve', { request: approval.request, yes, ...(yes && access ? { access } : {}) })) {
      // The invitation is used, or refused: closing no longer needs to end it.
      inviteRef.current = undefined
      if (yes) setAllowed({ name: approval.name })
      else setInvite(undefined)
    }
  }

  const joined =
    allowed &&
    status.devices.find((device) => device.name === allowed.name && device.direction !== 'out')
  if (allowed)
    return joined ? (
      <JoinedLine device={joined} />
    ) : (
      <p role="status" className="settings-muted">
        Letting {allowed.name} in…
      </p>
    )
  if (approval) return <AllowPrompt approval={approval} busy={busy} onAnswer={(yes, access) => void answer(yes, access)} />
  return (
    <div className="engine-code">
      {invite ? (
        <div className="engine-qr">
          <QrCode text={invite.uri} />
          <p className="settings-muted engine-code-line" role="timer" title="A new code shows when it runs out.">
            {expiresAt !== undefined ? `Used once · expires in ${clock(expiresAt - now)}` : 'Used once'}
          </p>
          {!picker && (
            <p className="engine-hint" title="This networking version picks the way itself.">
              Update networking to pick how it connects.
            </p>
          )}
        </div>
      ) : error ? null : busy && ready ? (
        <div className="engine-qr engine-preparing">
          <DelayedLoader label="Making a code" delayMs={0} />
        </div>
      ) : (
        <Preparing helper={status.helper} ready={ready} />
      )}
      {error && (
        <p role="alert" className="chat-error">
          {error}
        </p>
      )}
    </div>
  )
}
