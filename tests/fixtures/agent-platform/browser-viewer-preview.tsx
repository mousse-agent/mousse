import { createRoot } from 'react-dom/client'
import type { BrowserViewerClient, BrowserViewerHistoryEntry, BrowserViewerSnapshot } from '../../../src/shared/browser/viewer'
import { BrowserAutomationViewer } from '../../../src/renderer/components/browserAutomation/BrowserAutomationViewer'

const style = document.createElement('style')
style.textContent = `
  * { box-sizing: border-box; }
  html, body, #root { height: 100%; margin: 0; }
  body { background: #101216; color: #eff0f6; font-family: 'Segoe UI', sans-serif; }
  .fixture-host { height: 100%; display: flex; flex-direction: column; }
  .fixture-bar { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid #ffffff18; color: #aeb7cc; font-size: 12px; }
  .fixture-main { min-height: 0; flex: 1; display: flex; container-type: inline-size; container-name: browser-panel; }
  .fixture-bar button { border: 1px solid #ffffff2b; border-radius: 6px; padding: 5px 9px; color: #eff0f6; background: #202633; }
  .fixture-bar button:focus-visible { outline: 2px solid #8faef5; outline-offset: 2px; }
`
document.head.appendChild(style)

const now = () => new Date().toISOString()

class FixtureViewerClient implements BrowserViewerClient {
  private listeners = new Set<(snapshot: BrowserViewerSnapshot) => void>()
  private sequence = 0
  private current: BrowserViewerSnapshot = {
    mode: 'managed',
    session: { id: 'fixture-session', profileId: 'profile-a', runId: 'fixture-run', threadId: 'fixture-thread', persistent: false, backend: 'managed-chromium', browserVersion: 'fixture-chrome', generation: 1, lifecycle: 'agent-controlled', createdAt: now(), updatedAt: now() },
    tabs: [{ id: 'fixture-tab', title: 'Fixture form', url: 'http://fixture.local/form.html' }],
    observation: {
      sessionId: 'fixture-session', tabId: 'fixture-tab', generation: 1, observationId: 'fixture-observation-1', documentId: 'fixture-document-1', capturedAt: now(), url: 'http://fixture.local/form.html', title: 'Fixture form', viewport: { cssWidth: 800, cssHeight: 450, deviceScaleFactor: 2, scrollX: 0, scrollY: 0 }, tabs: [{ id: 'fixture-tab', title: 'Fixture form', url: 'http://fixture.local/form.html' }], elements: [], screenshot: { artifactId: 'fixture-image', pixelWidth: 1600, pixelHeight: 900, cssToImageScaleX: 2, cssToImageScaleY: 2 }, truncated: false, warnings: [], provenance: 'untrusted-page'
    },
    connection: 'connected', controlOwner: 'agent', run: { profileId: 'profile-a', runId: 'fixture-run', threadId: 'fixture-thread' }, history: [{ id: 'fixture-open', at: now(), kind: 'opened', message: 'Managed fixture session opened.', runId: 'fixture-run', threadId: 'fixture-thread' }], artifacts: [{ id: 'fixture-image', profileId: 'profile-a', runId: 'fixture-run', mediaType: 'image/png', byteLength: 1024, sha256: 'fixture-image-sha256', displayName: 'observation.png', createdAt: now() }], updatedAt: now()
  }

  private publish() {
    this.current = { ...this.current, updatedAt: now() }
    for (const listener of this.listeners) listener(this.current)
  }

  private addHistory(kind: BrowserViewerHistoryEntry['kind'], message: string, artifactIds?: string[]) {
    this.current = { ...this.current, history: [...this.current.history, { id: `fixture-history-${++this.sequence}`, at: now(), kind, message, runId: 'fixture-run', threadId: 'fixture-thread', ...(artifactIds ? { artifactIds } : {}) }] }
  }

  snapshot(): Promise<BrowserViewerSnapshot> { return Promise.resolve(this.current) }
  subscribe(listener: (snapshot: BrowserViewerSnapshot) => void) { this.listeners.add(listener); listener(this.current); return () => this.listeners.delete(listener) }
  observe(): Promise<BrowserViewerSnapshot> { this.addHistory('observed', 'Reconnected and observed the managed page.'); this.current = { ...this.current, connection: 'connected' }; this.publish(); return Promise.resolve(this.current) }
  disconnect() { this.current = { ...this.current, connection: 'disconnected' }; this.addHistory('connection', 'Managed worker disconnected; waiting to reconnect.'); this.publish() }
  takeControl(): Promise<BrowserViewerSnapshot> { this.current = { ...this.current, session: { ...this.current.session!, lifecycle: 'human-controlled', generation: this.current.session!.generation + 1 }, controlOwner: 'human' }; this.addHistory('control', 'Human control acquired; agent actions paused.'); this.publish(); return Promise.resolve(this.current) }
  resumeAgent(): Promise<BrowserViewerSnapshot> { const generation = this.current.session!.generation + 1; this.current = { ...this.current, session: { ...this.current.session!, lifecycle: 'agent-controlled', generation }, controlOwner: 'agent', observation: { ...this.current.observation!, generation, observationId: `fixture-observation-${generation}` } }; this.addHistory('control', 'Agent control resumed with a fresh observation.'); this.addHistory('observed', 'Fresh observation captured after agent resume.', ['fixture-image']); this.publish(); return Promise.resolve(this.current) }
  close(): Promise<BrowserViewerSnapshot> { this.current = { ...this.current, session: { ...this.current.session!, lifecycle: 'closed' }, connection: 'disconnected' }; this.addHistory('closed', 'Managed browser session closed.'); this.publish(); return Promise.resolve(this.current) }
  history(): Promise<BrowserViewerHistoryEntry[]> { return Promise.resolve(this.current.history) }
  artifactUrl(artifactId: string) { return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="100%" height="100%" fill="#1b2230"/><rect x="26" y="26" width="748" height="52" rx="8" fill="#2a3852"/><text x="48" y="59" fill="#eff0f6" font-family="sans-serif" font-size="22">Managed browser fixture · ${artifactId}</text><rect x="48" y="126" width="320" height="42" rx="6" fill="#101216" stroke="#8095c8"/><text x="64" y="153" fill="#aeb7cc" font-family="sans-serif" font-size="16">Human takeover surface</text><circle cx="692" cy="316" r="74" fill="#405d9e"/><text x="642" y="322" fill="#fff" font-family="sans-serif" font-size="16">click</text></svg>`)}` }

  humanAction(input: Parameters<BrowserViewerClient['humanAction']>[0]): Promise<BrowserViewerSnapshot> {
    if (this.current.controlOwner !== 'human') return Promise.reject(new Error('human_controlled'))
    const action = input.action
    if (action.type === 'navigate') {
      const tab = { ...this.current.tabs[0], url: action.url, title: 'Navigated fixture' }
      this.current = { ...this.current, tabs: [tab], observation: { ...this.current.observation!, url: action.url, title: tab.title, tabs: [tab] } }
    }
    this.addHistory('action', `Human ${action.type} action applied.`)
    this.publish()
    return Promise.resolve(this.current)
  }
}

const client = new FixtureViewerClient()
;(window as Window & { fixtureViewer?: FixtureViewerClient }).fixtureViewer = client

function Preview() {
  return <div className="fixture-host"><div className="fixture-bar"><strong>Managed browser viewer fixture</strong><span id="fixture-profile">profile-a</span><button type="button" data-fixture-disconnect onClick={() => { void client.observe() }}>Reconnect fixture</button></div><div className="fixture-main"><BrowserAutomationViewer client={client} /></div></div>
}

createRoot(document.getElementById('root')!).render(<Preview />)

