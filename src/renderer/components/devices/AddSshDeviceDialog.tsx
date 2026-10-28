import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Modal } from '../ui/Modal'
import { PAIRING_DISCLOSURE } from '../../lib/netDevices'
import { CommandLine, SetupSteps, UndoReport } from './SshParts'
import { HostKeyConfirm, canTrustHostKey } from './HostKeyConfirm'
import { errorText, useDaemonCall } from './useDaemonCall'
import type { SshBeginResult, SshCheckResult, SshInstalledView, SshOwner, SshPlan, SshSetupStatus, SshTrustResult, SshUndoResult } from '../../../shared/net/local'

/** The host or alias part of `[user@]host[:port]`, as a first device name. */
export function suggestedDeviceName(host: string): string {
  const bare = host.trim().replace(/^[^@]*@/u, '')
  const close = bare.indexOf(']')
  return (bare.startsWith('[') && close > 0 ? bare.slice(1, close) : bare.replace(/:\d+$/u, '')).slice(0, 64)
}

/** Why a device name cannot be used, if it cannot. */
export function deviceNameProblem(name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return 'Enter a name for this device.'
  if (trimmed.length > 64) return 'Use 64 characters or fewer.'
  if (/[\\\u0000-\u001f\u007f]/u.test(trimmed)) return 'Remove backslashes and control characters.'
  return undefined
}

const RETRYABLE = new Set(['host_key_failed', 'unreachable', 'invalid_host'])

function ownerLine(what: string, owner: SshOwner, extra = ''): string {
  if (owner === 'none') return `${what}: not installed`
  return `${what}: ${owner === 'managed' ? 'installed by this computer' : 'installed separately'}${extra}`
}

function installedLines(installed: SshInstalledView): string[] {
  const { cli, service } = installed
  return [
    ownerLine('Mousse', cli.owner, cli.version ? ` · ${cli.version}` : ''),
    ownerLine('Background service', service.owner, service.state ? ` · ${service.state}` : '')
  ]
}

/** What the probe found on the remote machine, once its host key is trusted. */
function ProbeSummary({ check }: { check: SshCheckResult }) {
  const where = check.resolved ? `${check.resolved.user}@${check.resolved.hostname}, port ${check.resolved.port}` : check.host
  return (
    <>
      <p className="settings-muted">{[where, [check.os, check.arch].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}</p>
      {check.installed && installedLines(check.installed).map((line) => <p key={line} className="settings-muted">{line}</p>)}
      {check.prerequisites.length > 0 && (
        <ul className="devices-steps" aria-label="What the remote machine needs">
          {check.prerequisites.map((item) => (
            <li key={item.name}>
              <span>{item.name}{!item.ok && !item.indeterminate && item.remedy && <span className="settings-muted"> · {item.remedy}</span>}</span>
              {item.indeterminate ? <span className="settings-muted">Couldn’t tell</span>
                : item.ok ? <span className="settings-status-ok">Ready</span>
                  : <span className="settings-status-bad">Missing</span>}
            </li>
          ))}
        </ul>
      )}
      {check.auth === 'denied' && (
        <>
          <p role="alert">The remote machine did not accept this computer’s SSH key. Run this in a terminal on this computer, then check again:</p>
          {check.copyId && <CommandLine command={check.copyId} />}
        </>
      )}
      {check.auth === 'unreachable' && <p role="alert" className="chat-error">{check.detail || 'Could not sign in to the remote machine.'}</p>}
      {check.enrolled && <p role="alert">This machine already belongs to a device set. Revoke it there first.</p>}
      {!check.ok && !check.problem && check.auth !== 'unreachable' && check.detail && <p role="alert" className="chat-error">{check.detail}</p>}
    </>
  )
}

/**
 * Settings → Devices → Add device → Remote machine over SSH. Checks the host, asks before trusting
 * its host key, shows the plan, runs it and offers undo. `setupId` opens an existing setup instead.
 */
export function AddSshDeviceDialog({ open, onClose, onDone, setupId }: {
  open: boolean
  onClose: () => void
  /** Reload devices: a setup finished or was undone. */
  onDone: () => void
  setupId?: string
}) {
  const id = useId()
  const { busy, error, setError, call } = useDaemonCall()
  const [host, setHost] = useState(''), [name, setName] = useState(''), nameEdited = useRef(false)
  const [check, setCheck] = useState<SshCheckResult>(), [plan, setPlan] = useState<SshPlan>()
  const [setup, setSetup] = useState<string | undefined>(setupId), [status, setStatus] = useState<SshSetupStatus>(), [polling, setPolling] = useState(!!setupId)
  const [undo, setUndo] = useState<SshUndoResult>()
  const done = useRef(onDone)
  done.current = onDone

  useEffect(() => {
    if (!setup || !polling) return
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const next = await window.mousse.platformRequest.request<SshSetupStatus>('net.ssh.setup.status', { id: setup })
        if (!active) return
        setStatus(next)
        if (next.phase !== 'running') { setPolling(false); if (next.phase === 'done') done.current(); return }
      } catch (cause) {
        if (active) { setError(errorText(cause)); setPolling(false) }
        return
      }
      timer = setTimeout(() => void tick(), 1000)
    }
    void tick()
    return () => { active = false; clearTimeout(timer) }
  }, [setup, polling, setError])

  const nameProblem = deviceNameProblem(name)
  const target = host.trim()

  const loadPlan = async () => {
    setPlan(undefined)
    const result = await call<SshPlan>('net.ssh.plan', { host: target, name: name.trim() })
    if (result) setPlan(result.value)
  }
  const runCheck = async () => {
    setCheck(undefined); setPlan(undefined)
    const result = await call<SshCheckResult>('net.ssh.check', { host: target })
    if (!result) return
    const value = result.value
    setCheck(value)
    if (value.phase === 'probed' && value.ok && !value.enrolled && value.auth !== 'denied' && !nameProblem) await loadPlan()
  }
  const trust = async (fingerprint: string, acknowledgeChanged: boolean) => {
    const result = await call<SshTrustResult>('net.ssh.trust', { host: target, fingerprint, ...(acknowledgeChanged ? { acknowledgeChanged: true } : {}) })
    if (!result) return
    if (!result.value.ok) { setError(result.value.detail || 'The host key was not trusted.'); return }
    await runCheck()
  }
  const begin = async () => {
    const result = await call<SshBeginResult>('net.ssh.setup.begin', { host: target, name: name.trim() })
    if (!result) return
    const started = result.value.id
    if (!started) { setError(result.value.error || 'Setup did not start.'); return }
    setStatus(undefined); setSetup(started); setPolling(true)
  }
  const retry = async () => {
    if (setup && await call('net.ssh.setup.retry', { id: setup })) setPolling(true)
  }
  const cancel = () => { if (setup) void call('net.ssh.setup.cancel', { id: setup }) }
  const undoSetup = async () => {
    if (!setup) return
    const result = await call<SshUndoResult>('net.ssh.undo', { id: setup })
    if (result) { setUndo(result.value); onDone() }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (target && !nameProblem && !busy) void runCheck()
  }
  const editHost = (value: string) => {
    setHost(value); setCheck(undefined); setPlan(undefined); setError('')
    if (!nameEdited.current) setName(suggestedDeviceName(value))
  }
  const editName = (value: string) => { nameEdited.current = true; setName(value); setPlan(undefined) }

  const problem = check?.problem
  const hostKey = check?.hostKey
  const stopped = problem === 'host_key_revoked' || hostKey?.state === 'revoked'
  const confirming = check?.phase === 'untrusted' && !!hostKey && canTrustHostKey(hostKey) && !problem
  const probedOk = check?.phase === 'probed' && check.ok && !check.enrolled && check.auth !== 'denied'
  const blocked = !!plan?.blocked?.length

  const phase = status?.phase
  const failed = phase === 'failed' || phase === 'cancelled' || phase === 'interrupted'
  const btn = 'settings-btn devices-dialog-btn'
  const footer = undo ? <button type="button" className={`${btn} primary`} onClick={onClose}>Close</button>
    : setup ? (
      phase === 'done' ? <button type="button" className={`${btn} primary`} onClick={onClose}>Done</button>
        : failed && status?.recoverable ? <>
          <button type="button" className={btn} disabled={busy} onClick={() => void undoSetup()}>Undo changes</button>
          <button type="button" className={`${btn} primary`} disabled={busy} onClick={() => void retry()}>Retry</button>
        </>
          : failed ? <button type="button" className={btn} onClick={onClose}>Close</button>
            : !polling && error ? <button type="button" className={btn} onClick={() => { setError(''); setPolling(true) }}>Refresh</button>
              : <button type="button" className={btn} disabled={busy || phase !== 'running'} onClick={cancel}>Cancel setup</button>
    )
      : probedOk ? (
        plan ? <button type="button" className={`${btn} primary`} disabled={busy || blocked} onClick={() => void begin()}>Run setup</button>
          : <button type="button" className={`${btn} primary`} disabled={busy || !!nameProblem} onClick={() => void loadPlan()}>Show plan</button>
      )
        : confirming || stopped || (problem && RETRYABLE.has(problem)) ? undefined
          : <button type="submit" form={`${id}-host`} className={`${btn} primary`} disabled={busy || !target || !!nameProblem}>{check ? 'Check again' : 'Check'}</button>

  return (
    <Modal open={open} title="Add a remote machine" onClose={onClose} footer={footer}>
      <div className="devices-dialog">
        {!setup && (
          <form id={`${id}-host`} className="devices-dialog" onSubmit={submit}>
            <p className="settings-muted">Mousse connects over SSH, shows what it will install, and sets it up after you agree. It never asks for a password.</p>
            <p className="settings-muted">{PAIRING_DISCLOSURE}</p>
            <label className="devices-field">
              <span>Host or SSH config alias</span>
              <input value={host} autoFocus spellCheck={false} placeholder="me@build-box" disabled={busy} onChange={(event) => editHost(event.target.value)} />
            </label>
            <label className="devices-field">
              <span>Device name</span>
              <input value={name} maxLength={64} disabled={busy} onChange={(event) => editName(event.target.value)} />
            </label>
            {name && nameProblem && <p className="chat-error">{nameProblem}</p>}
          </form>
        )}

        {!setup && busy && !check && <p role="status" className="settings-muted">Checking the remote machine…</p>}

        {!setup && check && problem && problem !== 'host_key_revoked' && (
          <div className="devices-dialog">
            <p role="alert" className="chat-error">{check.detail || 'Could not check the remote machine.'}</p>
            {problem === 'proxy_refused' && <p className="settings-muted">Mousse can’t use a ProxyJump or ProxyCommand yet. Use a host entry that reaches the machine directly.</p>}
            {RETRYABLE.has(problem) && (
              <div className="devices-dialog-actions">
                <button type="button" className="settings-btn devices-dialog-btn" disabled={busy || !target} onClick={() => void runCheck()}>Retry</button>
              </div>
            )}
          </div>
        )}
        {!setup && problem === 'host_key_revoked' && !hostKey && <p role="alert" className="chat-error">{check?.detail || 'This host key was revoked. Mousse will not connect to this machine.'}</p>}

        {!setup && hostKey && (
          <HostKeyConfirm key={`${hostKey.fingerprint}-${hostKey.state}`} hostKey={hostKey} busy={busy} onConfirm={(fingerprint, acknowledgeChanged) => void trust(fingerprint, acknowledgeChanged)} />
        )}

        {!setup && check?.phase === 'probed' && <ProbeSummary check={check} />}

        {!setup && plan && (
          <div className="devices-dialog">
            <p><strong>What setup will do</strong></p>
            <p className="settings-muted">{PAIRING_DISCLOSURE}</p>
            <ol className="devices-plan" aria-label="Setup plan">
              {plan.steps.map((step) => (
                <li key={step.id}>
                  <span>{step.title}</span>
                  {step.detail && <span className="settings-muted">{step.detail}</span>}
                  {step.command && <code className="devices-code">{step.command}</code>}
                </li>
              ))}
            </ol>
            {plan.blocked?.map((item) => (
              <p key={item.name} role="alert" className="chat-error">{item.name}: {item.remedy}</p>
            ))}
          </div>
        )}

        {setup && !status && !error && <p role="status" className="settings-muted">Starting setup…</p>}
        {setup && status && !undo && (
          <>
            {phase === 'running' && <p role="status">{status.progress || 'Setting up the remote machine…'}</p>}
            {phase === 'done' && <p role="status" className="settings-status-ok">Setup finished.</p>}
            {phase === 'done' && status.lingerCommand && (
              <>
                <p>The daemon will not start after a reboot until you run this on the machine:</p>
                <CommandLine command={status.lingerCommand} />
              </>
            )}
            {failed && <p role="alert" className="chat-error">{status.error || (phase === 'cancelled' ? 'Setup was cancelled.' : phase === 'interrupted' ? 'Setup was interrupted.' : 'Setup failed.')}</p>}
            <SetupSteps status={status} plan={plan} />
          </>
        )}
        {undo && <UndoReport result={undo} />}

        {error && <p role="alert" className="chat-error">{error}</p>}
      </div>
    </Modal>
  )
}
