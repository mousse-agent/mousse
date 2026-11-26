import { useEffect, useRef, useState } from 'react'
import {
  isFinishedPhase,
  parseRemoteUpdateStatus,
  remoteUpdateLimits,
  type RemoteUpdateError,
  type RemoteUpdateStatus
} from '../../../shared/remoteUpdates'
import { Modal } from '../ui/Modal'
import { errorText } from './useDaemonCall'

const btn = 'settings-btn'

/** Why an update of `name` stopped, in one line. */
export function remoteUpdateErrorText(error: RemoteUpdateError | undefined, name: string, version: string): string {
  switch (error) {
    case 'not_accepting':
      return `Mousse isn't open on ${name}.`
    case 'busy':
      return `${name} is already updating.`
    case 'version_unavailable':
      return `${name} can't get ${version} from its update feed.`
    case 'download_failed':
      return `The download failed on ${name}.`
    case 'install_failed':
      return `The install failed on ${name}.`
    case 'expired':
      return 'The update timed out. Try again.'
    case 'forbidden':
      return `Needs Full control on ${name}.`
    case 'cancelled':
      return `Cancelled on ${name}.`
    default:
      return `${name} stopped the update. Try again.`
  }
}

/** The running-turns line of the confirmation. */
export function runningTurnsText(turns: number, name: string): string {
  if (turns === 0) return `No turns are running on ${name}.`
  return turns === 1 ? `1 running turn on ${name} will stop.` : `${turns} running turns on ${name} will stop.`
}

type View =
  | { step: 'asking' }
  | { step: 'status'; status: RemoteUpdateStatus }
  | { step: 'returning'; since: number }
  | { step: 'done' }
  | { step: 'late' }
  | { step: 'error'; text: string }

async function ask(params: Record<string, unknown>): Promise<RemoteUpdateStatus> {
  const answer = await window.mousse.platformRequest.request<unknown>('net.update.there', params)
  const status = parseRemoteUpdateStatus(answer)
  if (!status) throw new Error('No answer from that computer.')
  return status
}

/**
 * Updates another of the user's computers to `version` (this computer's): it downloads there first, then the
 * confirmation shows the turns running there, and Install starts the 10-second countdown on its screen. Closing
 * before Install cancels; the dialog then follows it until it runs the new version.
 */
export function RemoteUpdateDialog({
  node,
  name,
  version,
  runs,
  onClose
}: {
  node: string
  name: string
  version: string
  /** The version that computer reports now (from the device list), to see it come back updated. */
  runs?: string
  onClose: () => void
}) {
  const [view, setView] = useState<View>({ step: 'asking' })
  const [busy, setBusy] = useState(false)
  const job = useRef('')
  const alive = useRef(true)
  const limits = useRef(remoteUpdateLimits({}))

  useEffect(() => {
    alive.current = true
    void (async () => {
      try {
        const status = await ask({ node, step: 'prepare', version })
        if (!alive.current) return
        job.current = status.job
        setView(status.phase === 'failed' ? { step: 'error', text: remoteUpdateErrorText(status.error, name, version) } : { step: 'status', status })
      } catch (cause) {
        if (alive.current) setView({ step: 'error', text: errorText(cause) })
      }
    })()
    return () => {
      alive.current = false
    }
  }, [node, name, version])

  // While it downloads or waits for Install, read its status (and its running turns) about once a second.
  const phase = view.step === 'status' ? view.status.phase : undefined
  useEffect(() => {
    if (!phase || isFinishedPhase(phase) || phase === 'installing') return
    const timer = setInterval(() => {
      void ask({ node, step: 'status', job: job.current }).then(
        (status) => {
          if (!alive.current) return
          if (status.phase === 'failed' || status.phase === 'cancelled')
            setView({ step: 'error', text: remoteUpdateErrorText(status.error, name, version) })
          else if (status.phase === 'installing') setView({ step: 'returning', since: Date.now() })
          else setView({ step: 'status', status })
        },
        // Unreachable once it counts down: its service stops for the installer.
        () => {
          if (alive.current && (phase === 'countdown' || phase === 'waiting')) setView({ step: 'returning', since: Date.now() })
        }
      )
    }, limits.current.pollMs)
    return () => clearInterval(timer)
  }, [phase, node, name, version])

  // After the install: it comes back on the new version, or says it has not yet.
  const returning = view.step === 'returning' ? view.since : undefined
  useEffect(() => {
    if (returning === undefined) return
    if (runs === version) {
      setView({ step: 'done' })
      return
    }
    const timer = setInterval(() => {
      if (Date.now() - returning > limits.current.returnMs) setView({ step: 'late' })
      else void window.mousse.platformRequest.request('net.update.there', { node, step: 'refresh' }).catch(() => undefined)
    }, Math.max(limits.current.pollMs, 5_000))
    return () => clearInterval(timer)
  }, [returning, runs, version, node])

  const close = () => {
    // Nothing installed yet: the other computer drops the download request.
    if (view.step === 'status' && (view.status.phase === 'preparing' || view.status.phase === 'ready'))
      void window.mousse.platformRequest.request('net.update.there', { node, step: 'cancel', job: job.current }).catch(() => undefined)
    onClose()
  }

  const install = async (turns: number) => {
    setBusy(true)
    try {
      const status = await ask({ node, step: 'install', job: job.current, runningTurns: turns })
      if (!alive.current) return
      setView(status.phase === 'failed' || status.phase === 'cancelled' ? { step: 'error', text: remoteUpdateErrorText(status.error, name, version) } : { step: 'status', status })
    } catch (cause) {
      if (alive.current) setView({ step: 'error', text: errorText(cause) })
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const ready = view.step === 'status' && view.status.phase === 'ready' ? view.status : undefined
  return (
    <Modal
      open
      title={`Update ${name} to ${version}?`}
      onClose={close}
      footer={
        ready ? (
          <button type="button" className={`${btn} primary`} disabled={busy} onClick={() => void install(ready.runningTurns)}>
            Install
          </button>
        ) : view.step === 'done' || view.step === 'late' || view.step === 'error' ? (
          <button type="button" className={btn} onClick={onClose}>
            Close
          </button>
        ) : undefined
      }
    >
      <div className="devices-dialog">
        {view.step === 'asking' && <p role="status" className="settings-muted">Asking {name}…</p>}
        {view.step === 'status' && view.status.phase === 'preparing' && (
          <p role="status" className="settings-muted">
            Downloading on {name}…{view.status.percent !== undefined ? ` ${view.status.percent}%` : ''}
          </p>
        )}
        {ready && (
          <>
            <p>{runningTurnsText(ready.runningTurns, name)}</p>
            <p className="settings-muted" title="Every Mousse home that runs from the same install there stops while it updates.">
              Other Mousse homes sharing its install stop too.
            </p>
          </>
        )}
        {view.step === 'status' && (view.status.phase === 'countdown' || view.status.phase === 'waiting') && (
          <p role="status" className="settings-muted">
            {view.status.phase === 'waiting' ? `Waiting for turns on ${name} to finish…` : `Updating ${name} in a few seconds. It can cancel there.`}
          </p>
        )}
        {view.step === 'returning' && <p role="status" className="settings-muted">Installing on {name}…</p>}
        {view.step === 'done' && <p role="status" className="settings-status-ok">{name} now runs {version}.</p>}
        {view.step === 'late' && <p role="alert" className="chat-error">{name} hasn't come back yet. Check it there.</p>}
        {view.step === 'error' && <p role="alert" className="chat-error">{view.text}</p>}
      </div>
    </Modal>
  )
}
