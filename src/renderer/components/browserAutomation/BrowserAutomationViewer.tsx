import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { BrowserViewerClient, BrowserViewerSnapshot } from '../../../shared/browser/viewer'
import { viewerPointToCss } from '../../../shared/browser/viewer'
import './browserAutomation.css'

export interface BrowserAutomationViewerProps {
  client?: BrowserViewerClient
  sessionId?: string
  className?: string
}

export function BrowserAutomationViewer({ client, sessionId, className = '' }: BrowserAutomationViewerProps) {
  const [snapshot, setSnapshot] = useState<BrowserViewerSnapshot>({ mode: 'managed', tabs: [], connection: 'disconnected', history: [], artifacts: [], updatedAt: new Date().toISOString(), message: 'Managed automation is unavailable.' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [mappedPoint, setMappedPoint] = useState<{ x: number; y: number }>()
  const [humanUrl, setHumanUrl] = useState('')
  const [humanKey, setHumanKey] = useState('')
  const scope = useRef(0)

  useEffect(() => {
    const generation = ++scope.current
    setBusy(false)
    setMessage('')
    setMappedPoint(undefined)
    if (!client) {
      setSnapshot({ mode: 'managed', tabs: [], connection: 'disconnected', history: [], artifacts: [], updatedAt: new Date().toISOString(), message: 'Managed automation is unavailable.' })
      return
    }
    let active = true
    let refreshing = false
    const current = () => active && scope.current === generation
    const apply = (next: BrowserViewerSnapshot) => {
      if (current() && (!sessionId || !next.session || next.session.id === sessionId)) setSnapshot(next)
    }
    const refresh = async () => {
      if (refreshing) return
      refreshing = true
      try { apply(await client.snapshot({ sessionId })) }
      catch (error) { if (current()) setMessage(error instanceof Error ? error.message : String(error)) }
      finally { refreshing = false }
    }
    const unsubscribe = client.subscribe(apply)
    void refresh()
    const timer = setInterval(() => { void refresh() }, 1_000)
    return () => { active = false; unsubscribe(); clearInterval(timer) }
  }, [client, sessionId])

  const run = useCallback(async (operation: () => Promise<BrowserViewerSnapshot>, success: string) => {
    const generation = scope.current
    setBusy(true)
    setMessage('')
    try {
      const next = await operation()
      if (scope.current === generation) { setSnapshot(next); setMessage(success) }
    } catch (error) {
      if (scope.current === generation) setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      if (scope.current === generation) setBusy(false)
    }
  }, [])

  const activeTab = snapshot.observation?.tabs.find((tab) => tab.id === snapshot.observation?.tabId) ?? snapshot.observation?.tabs[0]
  const screenshot = snapshot.observation?.screenshot
  const imageSrc = screenshot && client?.artifactUrl ? client.artifactUrl(screenshot.artifactId) : undefined
  const runLabel = useMemo(() => snapshot.run?.runId ? `Run ${snapshot.run.runId}` : snapshot.run?.threadId ? `Thread ${snapshot.run.threadId}` : undefined, [snapshot.run])

  const onScreenshotClick = (event: MouseEvent<HTMLImageElement>) => {
    if (!screenshot || !snapshot.observation) return
    const image = event.currentTarget
    const scaleX = image.naturalWidth ? image.naturalWidth / image.clientWidth : 1
    const scaleY = image.naturalHeight ? image.naturalHeight / image.clientHeight : 1
    const imagePoint = { x: event.nativeEvent.offsetX * scaleX, y: event.nativeEvent.offsetY * scaleY }
    try {
      const mapped = viewerPointToCss(imagePoint, screenshot, snapshot.observation.viewport)
      setMappedPoint(mapped)
      if (snapshot.controlOwner === 'human' && snapshot.session) {
        void run(() => client!.humanAction({
          sessionId: snapshot.session!.id,
          tabId: snapshot.observation!.tabId,
          generation: snapshot.observation!.generation,
          observationId: snapshot.observation!.observationId,
          action: { type: 'click', target: { kind: 'image-point', point: imagePoint } }
        }), 'Human click dispatched with the current observation.')
      }
    } catch { setMappedPoint(undefined) }
  }

  const sendHumanAction = (action: Parameters<BrowserViewerClient['humanAction']>[0]['action'], success: string) => {
    if (snapshot.controlOwner !== 'human' || !snapshot.session || !snapshot.observation) {
      setMessage('Take control before sending browser input.')
      return
    }
    void run(() => client!.humanAction({
      sessionId: snapshot.session!.id,
      tabId: snapshot.observation!.tabId,
      generation: snapshot.observation!.generation,
      observationId: snapshot.observation!.observationId,
      action
    }), success)
  }

  if (!client) return <section className={`browser-automation-viewer ${className}`} aria-label="Managed browser automation"><p role="status">Managed automation is unavailable.</p></section>

  return (
    <section className={`browser-automation-viewer ${className}`} aria-label="Managed browser automation">
      <header className="browser-automation-viewer-header">
        <div>
          <strong>Managed automation</strong>
          <span className={`browser-automation-connection browser-automation-connection-${snapshot.connection}`} role="status">{snapshot.connection.replace('-', ' ')}</span>
        </div>
        {runLabel && snapshot.run && <a href={`#${snapshot.run.runId ? `run/${snapshot.run.runId}` : `thread/${snapshot.run.threadId}`}`}>{runLabel}</a>}
      </header>
      {snapshot.session ? (
        <>
          <div className="browser-automation-session-bar">
            <span>{activeTab?.title || snapshot.session.id}</span>
            <span>{snapshot.controlOwner === 'human' ? 'Human control' : 'Agent control'}</span>
            <button type="button" disabled={busy || snapshot.session.lifecycle === 'closed'} onClick={() => snapshot.controlOwner === 'human'
              ? void run(() => client.resumeAgent({ sessionId: snapshot.session!.id }), 'Fresh observation captured; agent resumed.')
              : void run(() => client.takeControl({ sessionId: snapshot.session!.id }), 'Human control acquired; agent actions paused.')}>{snapshot.controlOwner === 'human' ? 'Resume agent' : 'Take control'}</button>
            <button type="button" disabled={busy || snapshot.session.lifecycle === 'closed'} onClick={() => void run(() => client.observe({ sessionId: snapshot.session!.id }), 'Reconnected and reobserved.')}>Reconnect</button>
            <button type="button" disabled={busy || snapshot.session.lifecycle === 'closed'} onClick={() => void run(() => client.close({ sessionId: snapshot.session!.id }), 'Session closed.')}>Close</button>
          </div>
          {snapshot.session.humanHandoff?.state === 'waiting-human' && <p role="status">Agent needs your help: {snapshot.session.humanHandoff.reason}</p>}
          {activeTab && <p className="browser-automation-url" title={activeTab.url}>{activeTab.url}</p>}
          {snapshot.controlOwner === 'human' && snapshot.observation && <div className="browser-automation-human-controls" aria-label="Human browser controls">
            <label>Navigate <input aria-label="Human navigation URL" value={humanUrl} onChange={(event) => setHumanUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && humanUrl) sendHumanAction({ type: 'navigate', url: humanUrl }, 'Human navigation dispatched.') }} /></label>
            <button type="button" disabled={busy || !humanUrl} onClick={() => sendHumanAction({ type: 'navigate', url: humanUrl }, 'Human navigation dispatched.')}>Go</button>
            <label>Key <input aria-label="Human browser key" value={humanKey} onChange={(event) => setHumanKey(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && humanKey) sendHumanAction({ type: 'key', key: humanKey }, 'Human key dispatched.') }} /></label>
            <button type="button" disabled={busy || !humanKey} onClick={() => sendHumanAction({ type: 'key', key: humanKey }, 'Human key dispatched.')}>Send key</button>
          </div>}
          {imageSrc && screenshot && <figure className="browser-automation-screenshot"><img src={imageSrc} alt={`Managed browser observation of ${activeTab?.title || activeTab?.url || 'current page'}`} onClick={onScreenshotClick} /><figcaption>{mappedPoint ? `Mapped CSS point ${Math.round(mappedPoint.x)}, ${Math.round(mappedPoint.y)} (high-DPI safe)` : 'Click the screenshot to map a CSS point.'}</figcaption></figure>}
          {snapshot.observation && <div className="browser-automation-observation" aria-label="Current observation"><span>{snapshot.observation.elements.length} observed elements</span><span>Generation {snapshot.observation.generation}</span><span>{snapshot.observation.warnings.length ? snapshot.observation.warnings.join(', ') : 'No warnings'}</span></div>}
          <div className="browser-automation-history"><h3>History</h3>{snapshot.history.length ? <ol>{snapshot.history.slice().reverse().map((entry) => <li key={entry.id}><time dateTime={entry.at}>{entry.at}</time> <span>{entry.message}</span>{entry.artifactIds?.map((id) => { const artifact = snapshot.artifacts.find((item) => item.id === id); return <a key={id} aria-label={`Open artifact ${artifact?.displayName ?? 'managed observation'}`} href={client.artifactUrl?.(id) ?? `#artifact/${id}`}>Artifact</a> })}</li>)}</ol> : <p>No managed activity yet.</p>}</div>
        </>
      ) : <p role="status">{snapshot.message ?? 'No managed browser session is open.'}</p>}
      {message && <p className="browser-automation-message" role="status">{message}</p>}
    </section>
  )
}
