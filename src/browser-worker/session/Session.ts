import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BrowserActionRequest,
  BrowserAction,
  BrowserTarget,
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
import { readWorkspaceLock, WorkspaceLock } from '../lifecycle/lock'
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

interface AttachedFrameState {
  sessionId: string
  frameId: string
  parentFrameId?: string
  targetId: string
  url: string
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
  private frames = new Map<string, AttachedFrameState>()
  private frameLoaders = new Map<string, string>()
  private activeTabId = ''
  private inFlight: { requestId: string; dispatched: boolean; abort: AbortController } | null = null
  private readonly artifacts: ScopedArtifactWriter
  private readonly journal: ScopedActionJournal
  private readonly clock: () => Date
  private closed = false
  private userDataDir = ''
  private observations = new Map<string, { tabId: string; generation: number; documentId: string; viewport: BrowserObservation['viewport']; screenshot?: BrowserObservation['screenshot'] }>()
  private lastActionFingerprint = ''
  private repeatedActionCount = 0
  private downloadDir = ''
  private downloadNames = new Map<string, string>()
  private downloadStates = new Map<string, 'inProgress' | 'completed' | 'canceled' | 'interrupted'>()

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
      const lockPath = workspaceLockPath(this.config.browserRoot, this.profileId, this.workspaceId)
      const previous = readWorkspaceLock(lockPath)
      if (previous && previous.pid !== process.pid) this.generation = Math.max(this.generation, previous.generation + 1)
      this.refs = new BrowserReferenceStore({ profileId: this.profileId, sessionId: this.id, generation: this.generation })
      this.lock = new WorkspaceLock(lockPath)
      this.lock.acquire(this.id, this.generation)
      this.userDataDir = workspaceUserDataDir(this.config.browserRoot, this.profileId, this.workspaceId)
    } else {
      this.userDataDir = ephemeralUserDataDir(this.config.browserRoot, this.profileId, this.id)
    }
    this.downloadDir = join(this.userDataDir, 'quarantine-downloads')
    mkdirSync(this.downloadDir, { recursive: true })
    this.clearDownloadQuarantine()
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
    this.chrome.cdp.on('Target.attachedToTarget', (params: unknown) => {
      const record = params as { sessionId?: string; targetInfo?: { type?: string; targetId?: string; parentFrameId?: string; url?: string } }
      if (record.targetInfo?.type !== 'iframe' || !record.sessionId || !record.targetInfo.targetId) return
      this.frames.set(record.sessionId, {
        sessionId: record.sessionId,
        frameId: record.targetInfo.targetId,
        parentFrameId: record.targetInfo.parentFrameId,
        targetId: record.targetInfo.targetId,
        url: sanitizeUrl(record.targetInfo.url ?? '')
      })
      void this.enableFrame(record.sessionId)
    })
    await this.chrome.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: this.downloadDir, eventsEnabled: true })
    this.chrome.cdp.on('Browser.downloadWillBegin', (params: unknown) => {
      const record = params as { guid?: string; suggestedFilename?: string }
      if (record.guid) {
        this.downloadNames.set(record.guid, sanitizeDisplayName(record.suggestedFilename ?? 'download.bin'))
        this.downloadStates.set(record.guid, 'inProgress')
      }
    })
    this.chrome.cdp.on('Browser.downloadProgress', (params: unknown) => {
      const record = params as { guid?: string; state?: string }
      if (!record.guid) return
      const state = record.state === 'completed' ? 'completed' : record.state === 'canceled' ? 'canceled' : record.state === 'interrupted' ? 'interrupted' : 'inProgress'
      this.downloadStates.set(record.guid, state)
    })
    const created = await this.chrome.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
    const attached = await this.chrome.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: created.targetId, flatten: true })
    await this.chrome.cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    }, { sessionId: attached.sessionId })
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
      if (!frame) return
      if (sessionId && this.frames.has(sessionId) && frame.parentId) {
        const child = this.frames.get(sessionId)!
        child.frameId = frame.id ?? child.frameId
        child.url = sanitizeUrl(frame.url ?? child.url)
        if (child.frameId) this.refs.invalidateFrame('frame_' + child.frameId)
        this.touch()
        return
      }
      if (frame.parentId) return
      const navigated = [...this.tabs.values()].find((entry) => entry.cdpSessionId === sessionId)
      if (!navigated && sessionId && this.frames.has(sessionId)) {
        const child = this.frames.get(sessionId)!
        child.frameId = frame.id ?? child.frameId
        child.url = sanitizeUrl(frame.url ?? child.url)
        if (child.frameId) this.refs.invalidateFrame('frame_' + child.frameId)
        this.touch()
        return
      }
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
      if (sessionId && this.frames.has(sessionId)) {
        const child = this.frames.get(sessionId)!
        this.frames.delete(sessionId)
        if (child.frameId) this.refs.invalidateFrame('frame_' + child.frameId)
        return
      }
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
    this.frames.clear()
    this.frameLoaders.clear()
    if (this.downloadDir) {
      this.clearDownloadQuarantine()
    }
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
    const childCollections = await Promise.all([...this.frames.values()].map(async (frame) => {
      const offset = await this.frameViewportOffset(tab, frame)
      if (!offset) return null
      try {
        const child = await collectStructuredObservation(this.requireChrome().cdp, frame.sessionId, {
          visibleOnly: optionalBoolean(params.visibleOnly),
          continuation: undefined,
          maxElements: typeof params.maxElements === 'number' ? params.maxElements : undefined,
          viewportOffset: offset
        })
        const previousLoader = this.frameLoaders.get(frame.sessionId)
        if (previousLoader && previousLoader !== child.loaderId) this.refs.invalidateFrame('frame_' + frame.frameId)
        this.frameLoaders.set(frame.sessionId, child.loaderId)
        return child
      } catch (error) {
        if (error instanceof CdpDisconnectedError) return null
        throw error
      }
    }))
    const mergedNodes = [collected, ...childCollections.filter((item): item is NonNullable<typeof item> => item !== null)]
    const mergedElements = mergedNodes.flatMap((item) => item.elements)
    const mergedObservedNodes = mergedNodes.flatMap((item) => item.nodes)
    const observationId = 'obs_' + randomUUID()
    const identity: ReferenceIdentity = {
      profileId: this.profileId,
      sessionId: this.id,
      generation: this.generation,
      tabId: tab.publicId,
      documentId: collected.documentId,
      observationId
    }
    const refs = this.refs.observe(identity, mergedObservedNodes)
    const elements: BrowserElement[] = mergedElements.map((element, index) => ({ ...element, ref: refs[index] }))
    let screenshot: BrowserObservation['screenshot']
    if (includeScreenshot) {
      const clip = params.clip && typeof params.clip === 'object' ? params.clip as { x: number; y: number; width: number; height: number } : undefined
      const captured = await captureViewportScreenshot(this.requireChrome().cdp, tab.cdpSessionId, collected.viewport, clip)
      const written = this.artifacts.write(this.profileId, this.id, captured.bytes, 'image/png', 'png')
      screenshot = { artifactId: written.artifactId, ...captured.screenshot }
    }
    this.observations.set(observationId, { tabId: tab.publicId, generation: this.generation, documentId: collected.documentId, viewport: collected.viewport, ...(screenshot ? { screenshot } : {}) })
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
      warnings: [...new Set([...collected.warnings.filter((warning) => warning !== 'unsupported-oopif' && warning !== 'iframe-observation-limited'), ...childCollections.flatMap((item) => item?.warnings ?? []), ...(this.frames.size ? ['oopif-attached'] : [])])],
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
    this.clearDownloadQuarantine()
    this.downloadNames.clear()
    this.downloadStates.clear()
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
      const actionSessionId = target && 'from' in target
        ? target.from.cdpSessionId === target.to.cdpSessionId
          ? target.from.cdpSessionId
          : (fail('unsupported', 'Cross-frame drag is not certified'), tab.cdpSessionId)
        : target?.cdpSessionId ?? tab.cdpSessionId
      await dispatchAction(this.requireChrome().cdp, actionSessionId, request.action, target, abort.signal)
      const downloads = await this.publishCompletedDownloads(request.timeoutMs, abort.signal)
      if (request.action.type === 'navigate' || request.action.type === 'reload' || request.action.type === 'back' || request.action.type === 'forward') {
        await waitForLoad(this.requireChrome().cdp, tab.cdpSessionId, request.timeoutMs, abort.signal)
        this.refs.invalidateTab(tab.publicId)
      }
      if (request.action.type === 'drag') await new Promise((resolve) => setTimeout(resolve, 100))
      if (request.action.type === 'fill' && target && !('from' in target) && !target.secret) {
        const value = await readControlValue(this.requireChrome().cdp, target.cdpSessionId, target.objectId, abort.signal)
        if (value.value !== request.action.text) fail('not_actionable', 'Fill did not stick')
      }
      const observation = await this.observe({ tabId: tab.publicId })
      const fingerprint = JSON.stringify({ action: request.action.type, target: 'target' in request.action ? request.action.target : 'from' in request.action ? [request.action.from, request.action.to] : undefined })
      this.repeatedActionCount = fingerprint === this.lastActionFingerprint ? this.repeatedActionCount + 1 : 1
      this.lastActionFingerprint = fingerprint
      if (this.repeatedActionCount > 3 && !request.expected) fail('no_progress', 'Repeated browser action made no observable progress; refresh or request human takeover')
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
        requestId: request.requestId, outcome: 'verified', dispatched: true, observation,
        artifactIds: [...(observation.screenshot ? [observation.screenshot.artifactId] : []), ...downloads.map((item) => item.artifactId)],
        ...(downloads.length ? { artifacts: downloads } : {})
      }
      this.journal.append({
        at: nowIso(this.clock), profileId: this.profileId, sessionId: this.id, requestId: request.requestId,
        generation: this.generation, phase: 'outcome', actionType: request.action.type, dispatched: true, outcome: 'verified'
      })
      return result
    } catch (error) {
      if (dispatched) {
        await this.cancelInProgressDownloads()
        await new Promise((resolve) => setTimeout(resolve, 250))
        this.clearDownloadQuarantine()
      }
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

  private async enableFrame(sessionId: string): Promise<void> {
    try {
      await Promise.all([
        this.requireChrome().cdp.send('Page.enable', {}, { sessionId }),
        this.requireChrome().cdp.send('DOM.enable', {}, { sessionId }),
        this.requireChrome().cdp.send('Runtime.enable', {}, { sessionId }),
        this.requireChrome().cdp.send('Accessibility.enable', {}, { sessionId })
      ])
    } catch {
        this.frames.delete(sessionId)
        this.frameLoaders.delete(sessionId)
    }
  }

  private async frameViewportOffset(tab: TabState, frame: AttachedFrameState): Promise<{ x: number; y: number } | null> {
    try {
      if (!frame.frameId) {
        const candidates: Array<{ id?: string; url?: string }> = []
        for (let attempt = 0; attempt < 10 && !candidates.length; attempt += 1) {
          const tree = await this.requireChrome().cdp.send<{ frameTree?: { frame?: { id?: string; url?: string }; childFrames?: unknown[] } }>('Page.getFrameTree', {}, { sessionId: tab.cdpSessionId })
          const visit = (node: { frame?: { id?: string; url?: string }; childFrames?: unknown } | undefined) => {
            for (const child of Array.isArray(node?.childFrames) ? node.childFrames as Array<{ frame?: { id?: string; url?: string }; childFrames?: unknown }> : []) {
              if (child.frame) candidates.push(child.frame)
              visit(child)
            }
          }
          visit(tree.frameTree)
          if (!candidates.length) await new Promise((resolve) => setTimeout(resolve, 50))
        }
        const candidate = candidates.find((entry) => entry.id && ![...this.frames.values()].some((other) => other !== frame && other.frameId === entry.id))
        if (!candidate?.id) return null
        frame.frameId = candidate.id
        frame.url = sanitizeUrl(candidate.url ?? frame.url)
      }
      const parent = frame.parentFrameId ? [...this.frames.values()].find((entry) => entry.frameId === frame.parentFrameId) : undefined
      const parentOffset = parent ? await this.frameViewportOffset(tab, parent) : { x: 0, y: 0 }
      if (!parentOffset) return null
      const parentSessionId = parent?.sessionId ?? tab.cdpSessionId
      const owner = await this.requireChrome().cdp.send<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId: frame.frameId }, { sessionId: parentSessionId })
      if (!owner.backendNodeId) return null
      const quads = await this.requireChrome().cdp.send<{ quads?: number[][] }>('DOM.getContentQuads', { backendNodeId: owner.backendNodeId }, { sessionId: parentSessionId })
      const quad = quads.quads?.[0]
      if (!quad || quad.length < 8) return null
      return { x: parentOffset.x + Math.min(quad[0], quad[2], quad[4], quad[6]), y: parentOffset.y + Math.min(quad[1], quad[3], quad[5], quad[7]) }
    } catch {
      return null
    }
  }

  private async resolveActionTarget(request: BrowserActionRequest, tab: TabState): Promise<ActionableTarget | { from: ActionableTarget; to: ActionableTarget } | undefined> {
    const action = request.action
    if (action.type === 'drag') return { from: await this.resolveOneTarget(request, tab, action.from), to: await this.resolveOneTarget(request, tab, action.to) }
    const target = 'target' in action ? action.target : undefined
    if (!target) return undefined
    return this.resolveOneTarget(request, tab, target)
  }

  private async resolveOneTarget(request: BrowserActionRequest, tab: TabState, target: BrowserTarget): Promise<ActionableTarget> {
    if (target.kind === 'image-point') {
      const observation = this.observations.get(request.observationId)
      if (!observation || !observation.screenshot || observation.tabId !== tab.publicId || observation.generation !== this.generation || observation.documentId !== tab.documentId) fail('stale_observation', 'Image point geometry is stale')
      const mapped = mapImagePoint({ sessionId: this.id, tabId: tab.publicId, generation: this.generation, observationId: request.observationId, documentId: tab.documentId, capturedAt: '', url: tab.url, title: tab.title, viewport: observation.viewport, tabs: [], elements: [], screenshot: observation.screenshot, truncated: false, warnings: [], provenance: 'untrusted-page' }, target.point)
      const located = await this.requireChrome().cdp.send<{ backendNodeId?: number }>('DOM.getNodeForLocation', { x: mapped.x, y: mapped.y, includeUserAgentShadowDOM: false }, { sessionId: tab.cdpSessionId, signal: this.inFlight?.abort.signal })
      if (!located.backendNodeId) fail('not_actionable', 'No DOM target exists at the image point')
      const prepared = await prepareActionableTarget(this.requireChrome().cdp, tab.cdpSessionId, {
        backendNodeId: located.backendNodeId, frameRef: 'frame_' + tab.frameId, cdpSessionId: tab.cdpSessionId, frameId: tab.frameId, fingerprint: 'image-point'
      }, this.inFlight?.abort.signal)
      const hit = await this.requireChrome().cdp.send<{ result?: { value?: { ok?: boolean } } }>('Runtime.callFunctionOn', {
        objectId: prepared.objectId,
        functionDeclaration: 'function(x, y) { const hit = document.elementFromPoint(x, y); return { ok: this === hit || this.contains(hit) }; }',
        arguments: [{ value: mapped.x }, { value: mapped.y }],
        returnByValue: true
      }, { sessionId: tab.cdpSessionId, signal: this.inFlight?.abort.signal })
      if (!hit.result?.value?.ok) fail('not_actionable', 'Image point is intercepted by an overlay')
      return { ...prepared, point: mapped }
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
    const sessionId = stored.cdpSessionId ?? tab.cdpSessionId
    if (sessionId !== tab.cdpSessionId && !this.frames.has(sessionId)) fail('stale_ref', 'Frame session is detached')
    return prepareActionableTarget(this.requireChrome().cdp, sessionId, stored, this.inFlight?.abort.signal)
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

  private async publishCompletedDownloads(timeoutMs: number, signal: AbortSignal): Promise<Array<{ artifactId: string; byteLength: number; sha256: string; mediaType: string; displayName?: string }>> {
    if (!this.downloadDir) return []
    // Chrome may emit downloadWillBegin after the initiating click has returned.
    await waitForDelay(500, signal)
    const deadline = Date.now() + Math.min(timeoutMs, 10_000)
    while ([...this.downloadStates.values()].some((state) => state === 'inProgress') && Date.now() < deadline) {
      await waitForDelay(50, signal)
    }
    if ([...this.downloadStates.values()].some((state) => state === 'inProgress')) {
      await this.cancelInProgressDownloads()
      await new Promise((resolve) => setTimeout(resolve, 250))
      this.clearDownloadQuarantine()
      fail('download_failed', 'Browser download did not complete before the action timeout')
    }
    if ([...this.downloadStates.values()].some((state) => state === 'canceled' || state === 'interrupted')) {
      this.clearDownloadQuarantine()
      fail('download_failed', 'Browser download was canceled or interrupted')
    }
    const out = [] as Array<{ artifactId: string; byteLength: number; sha256: string; mediaType: string; displayName?: string }>
    for (const name of readdirSync(this.downloadDir)) {
      if (name.endsWith('.crdownload') || name.endsWith('.tmp')) continue
      const path = join(this.downloadDir, name)
      let size = 0
      try { size = statSync(path).size } catch { continue }
      if (!size || size > 50 * 1024 * 1024) {
        this.clearDownloadQuarantine()
        fail('download_failed', 'Download exceeds the quarantine size limit')
      }
      const written = this.artifacts.writeFile(this.profileId, this.id, path, mediaTypeForName(name), sanitizeDisplayName(name))
      out.push({ ...written, displayName: sanitizeDisplayName(name) })
      try { rmSync(path, { force: true }) } catch { /* quarantine cleanup is best effort */ }
    }
    if ([...this.downloadStates.values()].some((state) => state === 'completed') && out.length === 0) {
      fail('download_failed', 'Completed browser download was missing from quarantine')
    }
    return out
  }

  private async cancelInProgressDownloads(): Promise<void> {
    const chrome = this.chrome
    if (!chrome) return
    await Promise.allSettled([...this.downloadStates.entries()]
      .filter(([, state]) => state === 'inProgress')
      .map(([guid]) => chrome.cdp.send('Browser.cancelDownload', { guid })))
  }

  private clearDownloadQuarantine(): void {
    if (!this.downloadDir) return
    try {
      for (const name of readdirSync(this.downloadDir)) rmSync(join(this.downloadDir, name), { recursive: true, force: true })
    } catch { /* quarantine cleanup is best effort */ }
  }
}

function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

function sanitizeDisplayName(value: string): string {
  const name = value.replace(/[\\/\0]/g, '_').replace(/[^a-zA-Z0-9._ -]/g, '_').trim().slice(0, 160)
  return name || 'download.bin'
}

function mediaTypeForName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.txt')) return 'text/plain'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  return 'application/octet-stream'
}

export function mapImagePoint(observation: BrowserObservation, point: { x: number; y: number }): { x: number; y: number } {
  if (!observation.screenshot) fail('invalid_geometry', 'Coordinate action requires a screenshot observation')
  return imagePointToViewport(point, observation.screenshot, observation.viewport)
}
