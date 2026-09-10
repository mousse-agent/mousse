import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import type {
  BrowserActionRequest,
  BrowserActionResult,
  BrowserElement,
  BrowserLifecycle,
  BrowserObservation,
  BrowserSessionRecord,
  BrowserTab,
  BrowserWaitCondition,
  BrowserWorkerRequest
} from '../../shared/browser/types'
import { imagePointToViewport } from '../../shared/browser/geometry'
import { validateBrowserActionRequest, validateBrowserWait } from '../../shared/browser/validation'
import { ScopedArtifactWriter } from '../artifacts'
import { launchManagedChrome, type LaunchedChrome } from '../cdp/launch'
import { fail } from '../errors'
import { WorkspaceLock } from '../lifecycle/lock'
import { ephemeralUserDataDir, workspaceLockPath, workspaceUserDataDir } from '../lifecycle/paths'
import { BrowserReferenceStore, type ReferenceIdentity } from '../observation/ReferenceStore'
import { collectStructuredObservation } from '../observation/collect'
import { captureViewportScreenshot } from '../observation/screenshot'
import { prepareActionableTarget, readControlValue, type ActionableTarget } from '../action/actionability'
import { dispatchAction, waitForLoad } from '../action/dispatch'
import { ScopedActionJournal } from '../action/journal'
import { CdpDisconnectedError } from '../cdp/connection'
import { boundText, nowIso, optionalBoolean, optionalString, requiredId, sanitizeUrl } from '../util'
import { isBrowserWorkerError } from '../errors'

export interface SessionConfig {
  profileId: string
  browserRoot: string
  artifactRoot: string
  executablePath: string
  browserVersion: string
  clock?: () => Date
}

interface TabState {
  publicId: string
  targetId: string
  cdpSessionId: string
  url: string
  title: string
  documentId: string
  loaderId: string
  frameId: string
}

export class ManagedSession {
  readonly id: string
  readonly profileId: string
  readonly persistent: boolean
  readonly workspaceId?: string
  generation = 1
  lifecycle: BrowserLifecycle = 'starting'
  controlLeaseId: string
  controlOwner: 'agent' | 'human' = 'agent'
  createdAt: string
  updatedAt: string
  private chrome: LaunchedChrome | null = null
  private lock: WorkspaceLock | null = null
  private refs: BrowserReferenceStore
  private tabs = new Map<string, TabState>()
  private activeTabId = ''
  private inFlight: { requestId: string; dispatched: boolean; abort: AbortController } | null = null
  private readonly artifacts: ScopedArtifactWriter
  private readonly journal: ScopedActionJournal
  private readonly clock: () => Date
  private closed = false
  private userDataDir = ''

  constructor(private readonly config: SessionConfig, options: { persistent: boolean; workspaceId?: string; runId?: string; threadId?: string }) {
    this.id = 'sess_' + randomUUID()
    this.profileId = config.profileId
    this.persistent = options.persistent
    this.workspaceId = options.workspaceId
    this.controlLeaseId = 'lease_' + randomUUID()
    this.createdAt = nowIso(config.clock)
    this.updatedAt = this.createdAt
    this.clock = config.clock ?? (() => new Date())
    this.refs = new BrowserReferenceStore({ profileId: this.profileId, sessionId: this.id, generation: this.generation })
    this.artifacts = new ScopedArtifactWriter(config.artifactRoot)
    this.journal = new ScopedActionJournal(config.browserRoot)
    this.runId = options.runId
    this.threadId = options.threadId
  }

  readonly runId?: string
  readonly threadId?: string

  record(): BrowserSessionRecord {
    return {
      id: this.id,
      profileId: this.profileId,
      ...(this.runId ? { runId: this.runId } : {}),
      ...(this.threadId ? { threadId: this.threadId } : {}),
      ...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
      persistent: this.persistent,
      backend: 'managed-chromium',
      browserVersion: this.config.browserVersion,
      generation: this.generation,
      lifecycle: this.lifecycle,
      controlLeaseId: this.controlLeaseId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    }
  }

  async start(initialUrl?: string): Promise<BrowserSessionRecord> {
    if (this.persistent) {
      if (!this.workspaceId) fail('invalid_action', 'Persistent sessions require a workspaceId')
      this.lock = new WorkspaceLock(workspaceLockPath(this.config.browserRoot, this.profileId, this.workspaceId))
      this.lock.acquire(this.id, this.generation)
      this.userDataDir = workspaceUserDataDir(this.config.browserRoot, this.profileId, this.workspaceId)
    } else {
      this.userDataDir = ephemeralUserDataDir(this.config.browserRoot, this.profileId, this.id)
    }
    this.chrome = await launchManagedChrome({
      executablePath: this.config.executablePath,
      userDataDir: this.userDataDir,
      headless: true
    })
    this.chrome.cdp.on('disconnect', () => {
      if (!this.closed) this.lifecycle = 'disconnected'
    })
    await this.chrome.cdp.send('Target.setDiscoverTargets', { discover: true })
    await this.chrome.cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    })
    const created = await this.chrome.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
    const attached = await this.chrome.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: created.targetId, flatten: true })
    const tabId = 'tab_' + randomUUID()
    const tab: TabState = {
      publicId: tabId,
      targetId: created.targetId,
      cdpSessionId: attached.sessionId,
      url: 'about:blank',
      title: '',
      documentId: 'doc_' + randomUUID(),
      loaderId: '',
      frameId: ''
    }
    this.tabs.set(tabId, tab)
    this.activeTabId = tabId
    await this.enableTab(tab)
    this.chrome.cdp.on('Page.frameNavigated', (params: unknown, sessionId?: string) => {
      const frame = (params as { frame?: { id?: string; parentId?: string; loaderId?: string; url?: string } })?.frame
      if (!frame || frame.parentId) return
      const navigated = [...this.tabs.values()].find((entry) => entry.cdpSessionId === sessionId)
      if (!navigated) return
      navigated.loaderId = frame.loaderId ?? navigated.loaderId
      navigated.frameId = frame.id ?? navigated.frameId
      navigated.url = sanitizeUrl(frame.url ?? navigated.url)
      navigated.documentId = 'doc_' + randomUUID()
      this.refs.invalidateTab(navigated.publicId)
      this.touch()
    })
    this.chrome.cdp.on('Target.detachedFromTarget', (params: unknown) => {
      const sessionId = (params as { sessionId?: string })?.sessionId
      const detached = [...this.tabs.values()].find((entry) => entry.cdpSessionId === sessionId)
      if (detached) {
        this.refs.invalidateTab(detached.publicId)
        this.tabs.delete(detached.publicId)
        if (this.activeTabId === detached.publicId) this.activeTabId = this.tabs.keys().next().value ?? ''
      }
    })
    if (initialUrl) {
      await this.chrome.cdp.send('Page.navigate', { url: initialUrl }, { sessionId: tab.cdpSessionId })
      await waitForLoad(this.chrome.cdp, tab.cdpSessionId, 15_000)
    }
    this.lifecycle = 'agent-controlled'
    this.touch()
    return this.record()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifecycle = 'closed'
    this.fenceInFlight('cancelled')
    this.refs.clear()
    try { await this.chrome?.stop() } catch { /* already gone */ }
    this.chrome = null
    this.lock?.release()
    this.lock = null
    if (!this.persistent && this.userDataDir) {
      try { rmSync(this.userDataDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
    this.touch()
  }

  listTabs(): BrowserTab[] {
    return [...this.tabs.values()].map((tab) => ({ id: tab.publicId, title: tab.title, url: tab.url }))
  }

  async newTab(url?: string): Promise<BrowserTab> {
    const chrome = this.requireChrome()
    const created = await chrome.cdp.send<{ targetId: string }>('Target.createTarget', { url: url ?? 'about:blank' })
    const attached = await chrome.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: created.targetId, flatten: true })
    const tabId = 'tab_' + randomUUID()
    const tab: TabState = {
      publicId: tabId,
      targetId: created.targetId,
      cdpSessionId: attached.sessionId,
      url: url ?? 'about:blank',
      title: '',
      documentId: 'doc_' + randomUUID(),
      loaderId: '',
      frameId: ''
    }
    this.tabs.set(tabId, tab)
    await this.enableTab(tab)
    this.activeTabId = tabId
    this.touch()
    return { id: tabId, title: tab.title, url: tab.url }
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.requireTab(tabId)
    const chrome = this.requireChrome()
    this.refs.invalidateTab(tabId)
    await chrome.cdp.send('Target.closeTarget', { targetId: tab.targetId })
    this.tabs.delete(tabId)
    if (this.activeTabId === tabId) this.activeTabId = this.tabs.keys().next().value ?? ''
    this.touch()
  }

  switchTab(tabId: string): BrowserTab {
    const tab = this.requireTab(tabId)
    this.activeTabId = tabId
    this.touch()
    return { id: tab.publicId, title: tab.title, url: tab.url }
  }

  async observe(params: Record<string, unknown>): Promise<BrowserObservation> {
    const tab = this.requireTab(typeof params.tabId === 'string' ? params.tabId : this.activeTabId)
    const includeScreenshot = optionalBoolean(params.includeScreenshot) === true
    if (typeof params.deviceScaleFactor === 'number' && params.deviceScaleFactor > 0) {
      await this.requireChrome().cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 720,
        deviceScaleFactor: params.deviceScaleFactor,
        mobile: false
      }, { sessionId: tab.cdpSessionId })
    }
    const collected = await collectStructuredObservation(this.requireChrome().cdp, tab.cdpSessionId, {
      visibleOnly: optionalBoolean(params.visibleOnly),
      continuation: optionalString(params.continuation, 64),
      maxElements: typeof params.maxElements === 'number' ? params.maxElements : undefined
    })
    tab.url = collected.url
    tab.title = collected.title
    tab.documentId = collected.documentId
    tab.loaderId = collected.loaderId
    tab.frameId = collected.frameId
    const observationId = 'obs_' + randomUUID()
    const identity: ReferenceIdentity = {
      profileId: this.profileId,
      sessionId: this.id,
      generation: this.generation,
      tabId: tab.publicId,
      documentId: collected.documentId,
      observationId
    }
    const refs = this.refs.observe(identity, collected.nodes)
    const elements: BrowserElement[] = collected.elements.map((element, index) => ({ ...element, ref: refs[index] }))
    let screenshot: BrowserObservation['screenshot']
    if (includeScreenshot) {
      const clip = params.clip && typeof params.clip === 'object' ? params.clip as { x: number; y: number; width: number; height: number } : undefined
      const captured = await captureViewportScreenshot(this.requireChrome().cdp, tab.cdpSessionId, collected.viewport, clip)
      const written = this.artifacts.write(this.profileId, this.id, captured.bytes, 'image/png', 'png')
      screenshot = { artifactId: written.artifactId, ...captured.screenshot }
    }
    this.touch()
    return {
      sessionId: this.id,
      tabId: tab.publicId,
      generation: this.generation,
      observationId,
      documentId: collected.documentId,
      capturedAt: nowIso(this.clock),
      url: collected.url,
      title: boundText(collected.title, 512),
      viewport: collected.viewport,
      tabs: this.listTabs(),
      elements,
      ...(screenshot ? { screenshot } : {}),
      truncated: collected.truncated,
      ...(collected.continuation ? { continuation: collected.continuation } : {}),
      warnings: collected.warnings,
      provenance: 'untrusted-page'
    }
  }

  async find(params: Record<string, unknown>): Promise<{ observationId: string; elements: BrowserElement[]; truncated: boolean }> {
    const observation = await this.observe({ ...params, includeScreenshot: false })
    const role = optionalString(params.role, 64)?.toLowerCase()
    const name = optionalString(params.name, 240)?.toLowerCase()
    const text = optionalString(params.text, 240)?.toLowerCase()
    const maxResults = Math.min(50, typeof params.maxResults === 'number' ? params.maxResults : 20)
    const elements = observation.elements.filter((element) => {
      if (role && (element.role ?? '').toLowerCase() !== role) return false
      if (name && !(element.name ?? '').toLowerCase().includes(name)) return false
      if (text && !(`${element.name ?? ''} ${element.text ?? ''}`).toLowerCase().includes(text)) return false
      return true
    }).slice(0, maxResults)
    return { observationId: observation.observationId, elements, truncated: elements.length === maxResults }
  }

  async extract(params: Record<string, unknown>): Promise<{ provenance: 'untrusted-page'; text: string; truncated: boolean }> {
    const observation = await this.observe({ ...params, includeScreenshot: false })
    const ref = optionalString(params.ref, 160)
    const selected = ref ? observation.elements.filter((element) => element.ref === ref) : observation.elements
    const text = boundText(selected.map((element) => [element.role, element.name, element.text].filter(Boolean).join(' ')).join('\n'), 8_000)
    return { provenance: 'untrusted-page', text, truncated: text.length >= 8_000 }
  }

  async wait(params: Record<string, unknown>, signal?: AbortSignal): Promise<BrowserObservation> {
    const condition = validateBrowserWait(params.condition ?? params)
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 5_000
    const deadline = Date.now() + Math.min(timeoutMs, 30_000)
    let observation = await this.observe(params)
    while (Date.now() < deadline) {
      if (signal?.aborted) fail('cancelled', 'Wait cancelled')
      if (this.matchWait(observation, condition)) return observation
      await new Promise((resolve) => setTimeout(resolve, 100))
      observation = await this.observe(params)
    }
    fail('timeout', 'Wait condition was not met')
  }

  takeControl(owner: 'human' | 'agent'): { controlLeaseId: string; generation: number; lifecycle: BrowserLifecycle } {
    this.fenceInFlight('human_controlled')
    this.generation += 1
    this.refs = new BrowserReferenceStore({ profileId: this.profileId, sessionId: this.id, generation: this.generation })
    this.controlLeaseId = 'lease_' + randomUUID()
    this.controlOwner = owner
    this.lifecycle = owner === 'human' ? 'human-controlled' : 'agent-controlled'
    this.touch()
    return { controlLeaseId: this.controlLeaseId, generation: this.generation, lifecycle: this.lifecycle }
  }

  releaseControl(controlLeaseId: string): void {
    if (controlLeaseId !== this.controlLeaseId) fail('stale_generation', 'Control lease does not match')
    this.controlOwner = 'agent'
    this.lifecycle = 'agent-controlled'
    this.touch()
  }

  async act(params: Record<string, unknown>, signal?: AbortSignal): Promise<BrowserActionResult> {
    if (this.lifecycle === 'human-controlled') fail('human_controlled', 'A human control lease is active')
    const request = validateBrowserActionRequest({
      requestId: params.requestId ?? 'req_' + randomUUID(),
      sessionId: params.sessionId ?? this.id,
      tabId: params.tabId ?? this.activeTabId,
      generation: params.generation ?? this.generation,
      observationId: params.observationId,
      controlLeaseId: params.controlLeaseId ?? this.controlLeaseId,
      action: params.action,
      timeoutMs: params.timeoutMs ?? 8_000,
      ...(params.expected === undefined ? {} : { expected: params.expected })
    })
    if (request.sessionId !== this.id) fail('session_closed', 'Action session does not match')
    if (request.generation !== this.generation) fail('stale_generation', 'Action generation is stale')
    if (request.controlLeaseId !== this.controlLeaseId) fail('human_controlled', 'Control lease was replaced')
    if (this.inFlight) fail('not_actionable', 'Another action is already in flight for this session')
    const tab = this.requireTab(request.tabId)
    const abort = new AbortController()
    const onAbort = () => abort.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) fail('cancelled', 'Action cancelled before dispatch')
      signal.addEventListener('abort', onAbort, { once: true })
    }
    this.inFlight = { requestId: request.requestId, dispatched: false, abort }
    const at = nowIso(this.clock)
    this.journal.append({
      at, profileId: this.profileId, sessionId: this.id, requestId: request.requestId,
      generation: this.generation, phase: 'intent', actionType: request.action.type, dispatched: false
    })
    let dispatched = false
    try {
      if (abort.signal.aborted) fail('cancelled', 'Action cancelled before dispatch')
      const target = await this.resolveActionTarget(request, tab)
      if (abort.signal.aborted) fail('cancelled', 'Action cancelled before dispatch')
      this.inFlight.dispatched = true
      dispatched = true
      this.journal.append({
        at: nowIso(this.clock), profileId: this.profileId, sessionId: this.id, requestId: request.requestId,
        generation: this.generation, phase: 'dispatched', actionType: request.action.type, dispatched: true
      })
      await dispatchAction(this.requireChrome().cdp, tab.cdpSessionId, request.action, target)
      if (request.action.type === 'navigate' || request.action.type === 'reload' || request.action.type === 'back' || request.action.type === 'forward') {
        await waitForLoad(this.requireChrome().cdp, tab.cdpSessionId, request.timeoutMs, abort.signal)
        this.refs.invalidateTab(tab.publicId)
      }
      if (request.action.type === 'fill' && target && !target.secret) {
        const value = await readControlValue(this.requireChrome().cdp, tab.cdpSessionId, target.objectId)
        if (value.value !== request.action.text) fail('not_actionable', 'Fill did not stick')
      }
      const observation = await this.observe({ tabId: tab.publicId })
      if (request.expected && !this.matchWait(observation, request.expected)) {
        const result: BrowserActionResult = {
          requestId: request.requestId, outcome: 'unverified', dispatched: true, observation, artifactIds: [],
          code: 'timeout', message: 'Expected state was not observed'
        }
        this.journal.append({
          at: nowIso(this.clock), profileId: this.profileId, sessionId: this.id, requestId: request.requestId,
          generation: this.generation, phase: 'outcome', actionType: request.action.type, dispatched: true, outcome: 'unverified'
        })
        return result
      }
      const result: BrowserActionResult = {
        requestId: request.requestId, outcome: 'verified', dispatched: true, observation, artifactIds: observation.screenshot ? [observation.screenshot.artifactId] : []
      }
      this.journal.append({
        at: nowIso(this.clock), profileId: this.profileId, sessionId: this.id, requestId: request.requestId,
        generation: this.generation, phase: 'outcome', actionType: request.action.type, dispatched: true, outcome: 'verified'
      })
      return result
    } catch (error) {
      const outcome = this.classifyActError(error, dispatched)
      this.journal.append({
        at: nowIso(this.clock), profileId: this.profileId, sessionId: this.id, requestId: request.requestId,
        generation: this.generation, phase: 'outcome', actionType: request.action.type, dispatched, outcome
      })
      if (outcome === 'unknown-effect') {
        return { requestId: request.requestId, outcome, dispatched: true, artifactIds: [], code: 'worker_disconnected', message: error instanceof Error ? error.message : String(error) }
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (this.inFlight?.requestId === request.requestId) this.inFlight = null
    }
  }

  handle(method: BrowserWorkerRequest['method'], params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> | unknown {
    switch (method) {
      case 'session.close': return this.close()
      case 'tabs.list': return { tabs: this.listTabs(), activeTabId: this.activeTabId }
      case 'tabs.new': return this.newTab(optionalString(params.url, 8192))
      case 'tabs.close': return this.closeTab(requiredId(params.tabId))
      case 'tabs.switch': return this.switchTab(requiredId(params.tabId))
      case 'observe': return this.observe(params)
      case 'find': return this.find(params)
      case 'extract': return this.extract(params)
      case 'wait': return this.wait(params, signal)
      case 'act': return this.act(params, signal)
      case 'control.take': return this.takeControl(params.owner === 'human' ? 'human' : 'agent')
      case 'control.release':
        this.releaseControl(requiredId(params.controlLeaseId))
        return { ok: true, lifecycle: this.lifecycle }
      default:
        fail('unsupported', 'Unsupported method')
    }
  }

  private async enableTab(tab: TabState): Promise<void> {
    const cdp = this.requireChrome().cdp
    await Promise.all([
      cdp.send('Page.enable', {}, { sessionId: tab.cdpSessionId }),
      cdp.send('DOM.enable', {}, { sessionId: tab.cdpSessionId }),
      cdp.send('Runtime.enable', {}, { sessionId: tab.cdpSessionId }),
      cdp.send('Accessibility.enable', {}, { sessionId: tab.cdpSessionId }),
      cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, { sessionId: tab.cdpSessionId })
    ])
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false
    }, { sessionId: tab.cdpSessionId })
  }

  private async resolveActionTarget(request: BrowserActionRequest, tab: TabState): Promise<ActionableTarget | undefined> {
    const action = request.action
    const target = 'target' in action ? action.target : undefined
    if (!target) return undefined
    if (target.kind === 'image-point') {
      fail('unsupported', 'Coordinate actions require a screenshot-bound image-point path that is not certified in this worker revision; use a semantic ref')
    }
    if (!this.refs.hasObservation(request.observationId)) fail('stale_observation', 'Observation is not in the reference store')
    const identity: ReferenceIdentity = {
      profileId: this.profileId,
      sessionId: this.id,
      generation: this.generation,
      tabId: tab.publicId,
      documentId: tab.documentId,
      observationId: request.observationId
    }
    let stored
    try {
      stored = this.refs.resolve({ ...identity, documentId: tab.documentId }, target.kind === 'ref' ? target.ref : '')
    } catch (error) {
      if (error instanceof Error && error.message === 'stale_observation') fail('stale_observation', 'Observation is not in the reference store')
      throw error
    }
    if (stored.identity.documentId !== tab.documentId) fail('stale_ref', 'Reference belongs to a previous document')
    if (stored.cdpSessionId && stored.cdpSessionId !== tab.cdpSessionId) fail('unsupported', 'Out-of-process frame refs are not certified')
    return prepareActionableTarget(this.requireChrome().cdp, tab.cdpSessionId, stored, this.inFlight?.abort.signal)
  }

  private requireObservationIdentity(request: BrowserActionRequest, tab: TabState): ReferenceIdentity {
    if (!this.refs.hasObservation(request.observationId)) fail('stale_observation', 'Observation is not in the reference store')
    return {
      profileId: this.profileId,
      sessionId: this.id,
      generation: this.generation,
      tabId: tab.publicId,
      documentId: tab.documentId,
      observationId: request.observationId
    }
  }

  private matchWait(observation: BrowserObservation, condition: BrowserWaitCondition): boolean {
    switch (condition.type) {
      case 'url':
        if (condition.equals) return observation.url === condition.equals
        return observation.url.includes(condition.includes ?? '')
      case 'text': {
        const haystack = `${observation.title} ${observation.elements.map((element) => `${element.name ?? ''} ${element.text ?? ''}`).join(' ')}`
        return condition.present === haystack.includes(condition.text)
      }
      case 'element': {
        const element = observation.elements.find((entry) => entry.ref === condition.ref)
        if (!element) return condition.state === 'hidden'
        if (condition.state === 'visible') return element.states.includes('visible')
        if (condition.state === 'hidden') return element.states.includes('hidden')
        if (condition.state === 'enabled') return element.states.includes('enabled')
        return element.states.includes('disabled')
      }
      case 'document-ready':
        return true
    }
  }

  private classifyActError(error: unknown, dispatched: boolean): BrowserActionResult['outcome'] {
    if (error instanceof CdpDisconnectedError) return dispatched ? 'unknown-effect' : 'failed'
    if (isBrowserWorkerError(error) && error.code === 'cancelled') return dispatched ? 'unknown-effect' : 'failed'
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'cancelled') return dispatched ? 'unknown-effect' : 'failed'
    return 'failed'
  }

  private fenceInFlight(reason: 'cancelled' | 'human_controlled'): void {
    if (!this.inFlight) return
    this.inFlight.abort.abort(reason)
  }

  private requireChrome(): LaunchedChrome {
    if (!this.chrome || this.closed || this.lifecycle === 'closed') fail('session_closed', 'Browser session is closed')
    if (this.lifecycle === 'disconnected') fail('worker_disconnected', 'Chromium disconnected')
    return this.chrome
  }

  private requireTab(tabId: string): TabState {
    const tab = this.tabs.get(tabId)
    if (!tab) fail('stale_ref', 'Unknown tab')
    return tab
  }

  private touch(): void {
    this.updatedAt = nowIso(this.clock)
  }
}

export function mapImagePoint(observation: BrowserObservation, point: { x: number; y: number }): { x: number; y: number } {
  if (!observation.screenshot) fail('invalid_geometry', 'Coordinate action requires a screenshot observation')
  return imagePointToViewport(point, observation.screenshot, observation.viewport)
}
