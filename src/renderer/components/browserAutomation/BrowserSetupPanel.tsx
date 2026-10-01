import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BROWSER_SETUP_IN_APP_NOTE,
  BrowserSetupStatusPoller,
  DEFAULT_BROWSER_SETUP_POLL_MS,
  type BrowserSetupRequestApi,
  type BrowserSetupStatus
} from '../../../shared/browser/setup'
import './browserSetup.css'

export interface BrowserSetupPanelProps {
  /** Typed setup request function. Do not pass model tool dispatch. */
  request: BrowserSetupRequestApi['request']
  pollMs?: number
  className?: string
}

function percent(status: BrowserSetupStatus): number | undefined {
  const fraction = status.operation?.progress.fraction
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return undefined
  return Math.max(0, Math.min(100, Math.round(fraction * 100)))
}

function progressLabel(status: BrowserSetupStatus): string {
  const progress = status.operation?.progress
  if (!progress) return status.message
  const received = progress.receivedBytes
  const total = progress.totalBytes
  const pct = percent(status)
  const bytes =
    total !== undefined
      ? `${received} / ${total} bytes`
      : received
        ? `${received} bytes`
        : ''
  return [progress.phase, pct !== undefined ? `${pct}%` : undefined, bytes].filter(Boolean).join(' · ')
}

export function BrowserSetupPanel({
  request,
  pollMs = DEFAULT_BROWSER_SETUP_POLL_MS,
  className = ''
}: BrowserSetupPanelProps) {
  const [status, setStatus] = useState<BrowserSetupStatus>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const scope = useRef(0)
  const requestRef = useRef(request)
  requestRef.current = request

  useEffect(() => {
    const generation = ++scope.current
    setMessage('')
    const poller = new BrowserSetupStatusPoller(request, pollMs)
    const stop = poller.start({
      onStatus(next) {
        if (scope.current !== generation) return
        setStatus(next)
      },
      onError(error) {
        if (scope.current !== generation) return
        setMessage(error.message)
      }
    })
    return () => {
      stop()
      poller.dispose()
    }
  }, [request, pollMs])

  const run = useCallback(async (operation: () => Promise<unknown>, success: string) => {
    const generation = scope.current
    setBusy(true)
    setMessage('')
    try {
      await operation()
      const next = await requestRef.current<BrowserSetupStatus>('browser.setup.status', {})
      if (scope.current === generation) {
        setStatus(next)
        setMessage(success)
      }
    } catch (error) {
      if (scope.current === generation) setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      if (scope.current === generation) setBusy(false)
    }
  }, [])

  const operation = status?.operation
  const running = operation?.state === 'running' || operation?.state === 'cancelling'
  const canInstall = Boolean(status?.canInstall) && !busy && !running
  const canCancel = Boolean(operation && running && operation.state === 'running') && !busy
  const pct = status ? percent(status) : undefined

  return (
    <section className={`browser-setup-panel ${className}`.trim()} aria-label="Managed browser setup">
      <div className="browser-setup-header">
        <span className="browser-setup-title">Managed browser</span>
        <span className="browser-setup-muted">{status?.availability ?? 'loading'}</span>
        {status?.version ? <span className="browser-setup-muted">Chrome for Testing {status.version}</span> : null}
        {status?.platform ? (
          <span className="browser-setup-muted">
            {status.platform.id}
            {status.platform.supported ? '' : ' (unsupported)'}
          </span>
        ) : null}
      </div>
      <p className="browser-setup-note">{BROWSER_SETUP_IN_APP_NOTE}</p>
      {status ? <p>{status.message}</p> : <p className="browser-setup-muted">Checking managed Chrome…</p>}
      {running && status ? (
        <div className="browser-setup-progress">
          <span>{progressLabel(status)}</span>
          {pct !== undefined ? <progress max={100} value={pct} /> : <progress />}
        </div>
      ) : null}
      {operation?.error ? <p className="browser-setup-error">{operation.error.message}</p> : null}
      {message ? <p className={operation?.error ? 'browser-setup-muted' : undefined}>{message}</p> : null}
      <div className="browser-setup-actions">
        <button
          type="button"
          disabled={!canInstall}
          onClick={() => {
            void run(() => requestRef.current('browser.setup.install', {}), 'Managed browser install started.')
          }}
        >
          Install managed browser
        </button>
        <button
          type="button"
          disabled={!canCancel || !operation}
          onClick={() => {
            if (!operation) return
            void run(
              () => requestRef.current('browser.setup.cancel', { operationId: operation.id }),
              'Cancellation requested.'
            )
          }}
        >
          Cancel
        </button>
      </div>
    </section>
  )
}
