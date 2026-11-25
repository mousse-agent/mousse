import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccessPresetFields } from '../../../shared/net/accessPresets'
import type {
  NetEngineStatus,
  NetEngineWay,
  NetEngineWayReadiness
} from '../../../shared/netEngine/local'
import { CopyButton } from '../settings/IconButtons'
import { Modal } from '../ui/Modal'
import { DelayedLoader } from '../ui/DelayedLoader'
import { useDaemonCall } from '../devices/useDaemonCall'
import { AllowPrompt } from './AllowPrompt'
import { ChoiceRow, clock, Preparing, QrCode, toMs, useNow } from './pairingParts'
import { JoinedLine, SendLinkPanel } from './SendLinkParts'
import { hasFeatures, WAY_LABEL, WAY_ORDER, wayFix, wayReason } from './ways'

interface Invite {
  invitation: string
  uri: string
  expiresAt?: number
  ways?: NetEngineWay[]
}

type Step = { kind: 'pick' } | { kind: 'code'; way?: NetEngineWay } | { kind: 'link' }

const SSH_HINT = 'Can you SSH into this computer? Add it from the other computer instead. No code needed.'

/**
 * Let a device in: how it will connect (the ways this computer has, ready or why not, with the setting that fixes
 * one), then a code for that way with its link and time left. The device's request is answered here with the
 * access it gets. A helper without the way picker makes a code as before. Closing ends the code it made.
 */
export function LetDeviceInDialog({
  status,
  onClose,
  onSetUp,
  onAddPhone
}: {
  status: NetEngineStatus | undefined
  onClose: () => void
  /** Opens Reach this computer for a way that needs setting up there (the dialog closes). */
  onSetUp: (way: NetEngineWay) => void
  /** Add a phone (the old networking's phones, Mousse ID builds); absent where phones can't be added. */
  onAddPhone?: () => void
}) {
  const engine = status && status.helper.state !== 'not_in_build' ? status : undefined
  const ready = engine?.helper.state === 'running'
  const picker = hasFeatures(status, 'route-readiness', 'invite-way')
  const [step, setStep] = useState<Step>(() => (picker ? { kind: 'pick' } : { kind: 'code' }))
  // A device asked to come in (or was let in): the dialog shows only that.
  const [answering, setAnswering] = useState(false)
  const { busy, error, setError, call } = useDaemonCall()

  // The code this dialog shows, and a Send link it made: closing ends whichever is still open.
  const inviteRef = useRef<string | undefined>(undefined)
  const linkRef = useRef<string | undefined>(undefined)
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

  return (
    <Modal open title="Use this computer from your phone or another computer" onClose={onClose}>
      <div className="engine-dialog" data-step={step.kind}>
        {step.kind === 'pick' && (
          <WayPicker
            status={status}
            ready={ready}
            onMake={(way) => setStep({ kind: 'code', way })}
            onSetUp={onSetUp}
          />
        )}
        {step.kind === 'code' && engine && (
          <CodeStep
            status={engine}
            ready={ready}
            way={step.way}
            picker={picker}
            inviteRef={inviteRef}
            onBack={picker ? () => setStep({ kind: 'pick' }) : undefined}
            busy={busy}
            call={call}
            error={error}
            setError={setError}
            onAnswering={setAnswering}
          />
        )}
        {step.kind === 'link' && (
          <SendLinkPanel
            status={status}
            onInvitation={(invitation) => {
              linkRef.current = invitation
            }}
          />
        )}
        {step.kind !== 'link' && !(step.kind === 'code' && answering) && (
          <>
            <p className="engine-hint">{SSH_HINT}</p>
            <div className="engine-dialog-more">
              {engine?.sendLink && (
                <button
                  type="button"
                  className="engine-text-btn"
                  title="A link to send in a chat, with a code to read out another way."
                  onClick={() => setStep({ kind: 'link' })}
                >
                  Send a link with a code instead
                </button>
              )}
              {onAddPhone && (
                <button type="button" className="engine-text-btn" onClick={onAddPhone}>
                  Add a phone
                </button>
              )}
            </div>
          </>
        )}
        {error && step.kind !== 'code' && (
          <p role="alert" className="chat-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

/** "How will it connect?": each way and whether it is ready; ready ones are picked, the others say why. */
function WayPicker({
  status,
  ready,
  onMake,
  onSetUp
}: {
  status: NetEngineStatus | undefined
  ready: boolean
  onMake: (way: NetEngineWay) => void
  onSetUp: (way: NetEngineWay) => void
}) {
  const { busy, error, call } = useDaemonCall()
  const [ways, setWays] = useState<NetEngineWayReadiness[]>()
  const [picked, setPicked] = useState<NetEngineWay>()
  const [round, setRound] = useState(0)
  // Read again when Reach changes (a switch turned on here or elsewhere).
  const reachKey = JSON.stringify(status?.reach ?? null)

  const load = useCallback(async () => {
    const answer = await call<{ ways: NetEngineWayReadiness[] }>('netEngine.routes.available', {})
    if (!answer) return
    const sorted = [...answer.value.ways].sort((a, b) => WAY_ORDER.indexOf(a.way) - WAY_ORDER.indexOf(b.way))
    setWays(sorted)
    setPicked((now) =>
      now && sorted.some((item) => item.way === now && item.state === 'ready')
        ? now
        : sorted.find((item) => item.state === 'ready')?.way
    )
  }, [call])
  useEffect(() => {
    if (ready) void load()
  }, [ready, load, round, reachKey])

  const turnOn = async (way: NetEngineWay) => {
    if (await call('netEngine.routes.config', way === 'lan' ? { lan: true } : { tailnet: true }))
      setRound((value) => value + 1)
  }

  if (!ways)
    return status ? <Preparing helper={status.helper} ready={ready && !error} /> : null
  return (
    <div className="engine-choices">
      <p id="engine-ways-title" className="engine-choices-title">
        How will it connect?
      </p>
      <div className="engine-choice-list" role="radiogroup" aria-labelledby="engine-ways-title">
        {ways.map((item) => {
          const on = item.state === 'ready'
          const fix = wayFix(item, status?.reach)
          return (
            <ChoiceRow
              key={item.way}
              selected={picked === item.way}
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
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation()
                    void turnOn(item.way)
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
      {error && (
        <p role="alert" className="chat-error">
          {error}
        </p>
      )}
      <div className="devices-dialog-actions">
        <button
          type="button"
          className="settings-btn ui-btn-primary"
          disabled={!picked || busy}
          onClick={() => picked && onMake(picked)}
        >
          Make code
        </button>
      </div>
    </div>
  )
}

/**
 * The code for one way: QR, link with Copy, and "Works over <way> · used once · expires in m:ss"; a new one when it
 * runs out. The device's request shows here as Allow; once allowed, its row's state.
 */
function CodeStep({
  status,
  ready,
  way,
  picker,
  inviteRef,
  onBack,
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
  onBack?: () => void
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
  const shownWay = invite?.ways?.[0] ?? way
  return (
    <div className="engine-code">
      {invite ? (
        <div className="engine-qr">
          <QrCode text={invite.uri} />
          <div className="engine-paste">
            <input
              className="settings-input"
              readOnly
              value={invite.uri}
              aria-label="Link to share"
              title="Scan the code on the other device, or send it this link."
              onFocus={(event) => event.currentTarget.select()}
            />
            <CopyButton text={invite.uri} label="Copy link" />
          </div>
          <p className="settings-muted engine-code-line" role="timer" title="A new code shows when it runs out.">
            {[
              shownWay ? `Works over ${WAY_LABEL[shownWay]}` : undefined,
              'used once',
              expiresAt !== undefined ? `expires in ${clock(expiresAt - now)}` : undefined
            ]
              .filter(Boolean)
              .join(' · ')}
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
      {onBack && (
        <button
          type="button"
          className="engine-text-btn"
          onClick={() => {
            const open = inviteRef.current
            inviteRef.current = undefined
            if (open)
              void window.mousse.platformRequest
                .request('netEngine.invite.cancel', { invitation: open })
                .catch(() => undefined)
            onBack()
          }}
        >
          Pick another way
        </button>
      )}
    </div>
  )
}
