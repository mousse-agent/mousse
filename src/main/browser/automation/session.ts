import { randomUUID } from 'node:crypto'
import type { GuestKeyboardFocusScope } from './guestHandle'
import type {
  BrowserAction,
  BrowserActionRequest,
  BrowserActionResult,
  BrowserElement,
  BrowserLifecycle,
  BrowserObservation,
  BrowserSessionRecord,
  BrowserTab,
  BrowserTarget,
  BrowserWaitCondition,
  BrowserWorkerRequest
} from '../../../shared/browser/types'
import { imagePointToViewport } from '../../../shared/browser/geometry'
import { browserNavigationUrl, validateBrowserActionRequest, validateBrowserWait } from '../../../shared/browser/validation'
import type { BrowserArtifactPort, BrowserJournalPort } from '../../../mms/browser/ports'
import { CdpDisconnectedError } from '../../../browser-worker/cdp/connection'
import type { CdpTransport } from '../../../browser-worker/cdp/transport'
import { fail, isBrowserWorkerError } from '../../../browser-worker/errors'
import { prepareActionableTarget, readControlValue, type ActionableTarget } from '../../../browser-worker/action/actionability'
import { dispatchAction, waitForLoad } from '../../../browser-worker/action/dispatch'
import { collectStructuredObservation, MAX_OBSERVATION_ELEMENTS } from '../../../browser-worker/observation/collect'
import { captureViewportScreenshot } from '../../../browser-worker/observation/screenshot'
import { BrowserReferenceStore, type ReferenceIdentity } from '../../../browser-worker/observation/ReferenceStore'
import { boundText, nowIso, optionalBoolean, optionalString, requiredId, sanitizeUrl } from '../../../browser-worker/util'
import type { AttachedControlState, AttachedUiTabId } from '../../../shared/browser/attached'
import { ElectronDebuggerTransport, type DebuggerTransportOptions } from './debuggerTransport'
import type { TrustedGuestRecord } from './registry'
import { TrustedGuestRegistry } from './registry'

export interface AttachedPageSessionConfig {
  profileId: string
  profileEpoch: string
  uiTabId: AttachedUiTabId
  threadId: string
  runId?: string
  journal: BrowserJournalPort
  artifacts?: BrowserArtifactPort
  browserVersion?: string
  clock?: () => Date
  interceptCommand?: DebuggerTransportOptions['interceptCommand']
  onControlStateChange?: (state: AttachedControlState) => void
}

interface TabState {
  publicId: string
  url: string
  title: string
  documentId: string
  loaderId: string
  frameId: string
}

const ATTACHED_CDP_SESSION = ''

export class AttachedPageSession {
  readonly id: string
  readonly profileId: string
  readonly uiTabId: AttachedUiTabId
  readonly threadId: string
  readonly runId?: string
  readonly persistent = false
  generation = 1
  lifecycle: BrowserLifecycle = 'starting'
  controlLeaseId: string
  controlOwner: 'agent' | 'human' = 'agent'
  createdAt: string
  updatedAt: string
  private refs: BrowserReferenceStore
  private tab: TabState
  private transport: ElectronDebuggerTransport | null = null
  private keyboardFocus: GuestKeyboardFocusScope | null = null
  private inFlight: { requestId: string; actionType: BrowserAction['type']; dispatched: boolean; abort: AbortController } | null = null
  private readonly journal: BrowserJournalPort
  private readonly artifacts?: BrowserArtifactPort
  private readonly clock: () => Date
  private closed = false
  private disconnected = false
  private observations = new Map<string, {
    tabId: string
    generation: number
    documentId: string
    viewport: BrowserObservation['viewport']
    screenshot?: BrowserObservation['screenshot']
  }>()
  private lastActionFingerprint = ''
  private repeatedActionCount = 0
  private stopNav: (() => void) | null = null
  private readonly onControlStateChange?: (state: AttachedControlState) => void
  private readonly interceptCommand?: DebuggerTransportOptions['interceptCommand']
  private readonly browserVersion: string
  private readonly profileEpoch: string

  constructor(
    private readonly registry: TrustedGuestRegistry,
    private guest: TrustedGuestRecord,
    config: AttachedPageSessionConfig
  ) {
    this.id = 'sess_' + randomUUID()
    this.profileId = config.profileId
    this.profileEpoch = config.profileEpoch
    this.uiTabId = config.uiTabId
    this.threadId = config.threadId
    this.runId = config.runId
    this.controlLeaseId = 'lease_' + randomUUID()
    this.clock = config.clock ?? (() => new Date())
    this.createdAt = nowIso(this.clock)
    this.updatedAt = this.createdAt
    this.journal = config.journal
    this.artifacts = config.artifacts
    this.browserVersion = config.browserVersion ?? 'electron-attached'
    this.onControlStateChange = config.onControlStateChange
    this.interceptCommand = config.interceptCommand
    this.refs = new BrowserReferenceStore({ profileId: this.profileId, sessionId: this.id, generation: this.generation })
    this.tab = {
      publicId: 'tab_' + randomUUID(),
      url: sanitizeUrl(guest.guest.getURL()),
      title: guest.guest.getTitle(),
      documentId: 'doc_' + randomUUID(),
      loaderId: '',
      frameId: ''
    }
  }

  record(): BrowserSessionRecord {
    return {
      id: this.id,
      profileId: this.profileId,
      ...(this.runId ? { runId: this.runId } : {}),
      threadId: this.threadId,
      persistent: false,
      backend: 'electron-attached',
      browserVersion: this.browserVersion,
      generation: this.generation,
      lifecycle: this.lifecycle,
      controlLeaseId: this.controlLeaseId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    }
  }

  controlState(): AttachedControlState {
    return {
      sessionId: this.id,
      uiTabId: this.uiTabId,
      profileId: this.profileId,
      owner: this.disconnected || this.closed ? 'disconnected' : this.controlOwner,
      controlLeaseId: this.controlLeaseId,
      generation: this.generation,
      lifecycle: this.lifecycle
    }
  }

  async start(initialUrl?: string): Promise<BrowserSessionRecord> {
    await this.assertBinding()
    const transport = new ElectronDebuggerTransport(this.guest.guest.debugger, {
      interceptCommand: this.interceptCommand,
      beforeKeyboardDispatch: async () => {
        if (!this.keyboardFocus) fail('invalid_action', 'Keyboard input requires an owned focus scope')
        await this.keyboardFocus.focus()
      }
    })
    transport.attach()
    this.transport = transport
    transport.on('disconnect', () => this.handleDisconnect())
    transport.on('Page.frameNavigated', (params) => this.handleFrameNavigated(params))
    this.stopNav = this.guest.guest.onNavigated((url) => {
      this.tab.url = sanitizeUrl(url)
      this.invalidateDocument('navigation')
    })
    await this.enablePage()
    if (initialUrl) {
      await this.requireCdp().send('Page.navigate', { url: browserNavigationUrl(initialUrl) }, { sessionId: ATTACHED_CDP_SESSION })
      await waitForLoad(this.requireCdp(), ATTACHED_CDP_SESSION, 15_000)
    }
    this.lifecycle = 'agent-controlled'
    this.touch()
    this.emitControl()
    return this.record()
  }

  /** Opening the same owned tab again must not attach a second debugger. */
  async reopen(url?: string): Promise<BrowserSessionRecord> {
    await this.assertBinding()
    if (this.controlOwner !== 'agent') fail('human_controlled', 'You have control of this tab; resume the agent to continue')
    if (this.inFlight) fail('invalid_action', 'A browser action is still running; wait before opening this tab again')
    if (url) {
      await this.requireCdp().send('Page.navigate', { url: browserNavigationUrl(url) }, { sessionId: ATTACHED_CDP_SESSION })
      await waitForLoad(this.requireCdp(), ATTACHED_CDP_SESSION, 15_000)
    }
    return this.record()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifecycle = 'closed'
    this.fenceInFlight('cancelled')
    this.refs.clear()
    this.stopNav?.()
    this.stopNav = null
    try { await this.transport?.close() } catch { /* already gone */ }
    this.transport = null
    this.touch()
    this.emitControl()
  }

  markDisconnected(reason: 'debugger' | 'guest' | 'owner' | 'epoch' | 'gui'): void {
    if (this.closed) return
    this.disconnected = true
    this.lifecycle = 'disconnected'
    this.fenceInFlight('cancelled')
    this.refs.clear()
    this.observations.clear()
    if (reason !== 'debugger') {
      try { this.transport?.releaseAttachment() } catch { /* already gone */ }
    }
    this.transport = null
    this.touch()
    this.emitControl()
    void reason
  }

  listTabs(): BrowserTab[] {
    return [{ id: this.tab.publicId, title: this.tab.title, url: this.tab.url }]
  }

  switchTab(tabId: string): BrowserTab {
    if (tabId !== this.tab.publicId) fail('unsupported', 'Attached sessions cannot switch to a different in-app tab')
    return { id: this.tab.publicId, title: this.tab.title, url: this.tab.url }
  }

  async observe(params: Record<string, unknown>): Promise<BrowserObservation> {
    await this.assertBinding()
    const tab = this.requireTab(typeof params.tabId === 'string' ? params.tabId : this.tab.publicId)
    const includeScreenshot = optionalBoolean(params.includeScreenshot) === true
    const requestedMax = Math.min(MAX_OBSERVATION_ELEMENTS, Math.max(1,
      Math.floor(typeof params.maxElements === 'number' ? params.maxElements : MAX_OBSERVATION_ELEMENTS)))
    const collected = await collectStructuredObservation(this.requireCdp(), ATTACHED_CDP_SESSION, {
      visibleOnly: optionalBoolean(params.visibleOnly),
      continuation: optionalString(params.continuation, 64),
      maxElements: requestedMax
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
    const warnings = [...collected.warnings]
    if (includeScreenshot) {
      if (!this.artifacts) {
        warnings.push('screenshot-unavailable')
      } else {
        const clip = params.clip && typeof params.clip === 'object' ? params.clip as { x: number; y: number; width: number; height: number } : undefined
        let captured
        try {
          captured = await captureViewportScreenshot(this.requireCdp(), ATTACHED_CDP_SESSION, collected.viewport, clip, { timeoutMs: 8_000 })
        } catch {
          try {
            captured = await captureViewportScreenshot(this.requireCdp(), ATTACHED_CDP_SESSION, collected.viewport, clip, { fromSurface: false, timeoutMs: 8_000 })
          } catch {
            warnings.push('screenshot-unavailable')
          }
        }
        if (captured) {
          const written = await this.artifacts.write({
            profileId: this.profileId,
            sessionId: this.id,
            mediaType: 'image/png',
            bytes: captured.bytes,
            displayName: 'screenshot.png'
          })
          screenshot = { artifactId: written.artifactId, ...captured.screenshot }
        }
      }
    }
    this.observations.set(observationId, {
      tabId: tab.publicId,
      generation: this.generation,
      documentId: collected.documentId,
      viewport: collected.viewport,
      ...(screenshot ? { screenshot } : {})
    })
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
      warnings: [...new Set([...warnings, 'oopif-unsupported'])],
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
    this.observations.clear()
    this.controlLeaseId = 'lease_' + randomUUID()
    this.controlOwner = owner
    this.lifecycle = owner === 'human' ? 'human-controlled' : 'agent-controlled'
    this.touch()
    this.emitControl()
    return { controlLeaseId: this.controlLeaseId, generation: this.generation, lifecycle: this.lifecycle }
  }

  releaseControl(controlLeaseId: string): { ok: true; lifecycle: BrowserLifecycle; generation: number } {
    if (controlLeaseId !== this.controlLeaseId) fail('stale_generation', 'Control lease does not match')
    this.controlOwner = 'agent'
    this.lifecycle = 'agent-controlled'
    this.touch()
    this.emitControl()
    return { ok: true, lifecycle: this.lifecycle, generation: this.generation }
  }

  async act(params: Record<string, unknown>, signal?: AbortSignal, humanLease = false): Promise<BrowserActionResult> {
    await this.assertBinding()
    if (this.lifecycle === 'human-controlled' && !humanLease) fail('human_controlled', 'A human control lease is active')
    const request = validateBrowserActionRequest({
      requestId: params.requestId ?? 'req_' + randomUUID(),
      sessionId: params.sessionId ?? this.id,
      tabId: params.tabId ?? this.tab.publicId,
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
    this.rejectUnsupportedAction(request.action)
    const tab = this.requireTab(request.tabId)
    const abort = new AbortController()
    const onAbort = () => abort.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) fail('cancelled', 'Action cancelled before dispatch')
      signal.addEventListener('abort', onAbort, { once: true })
    }
    this.inFlight = { requestId: request.requestId, actionType: request.action.type, dispatched: false, abort }
    await this.journal.append({
      at: nowIso(this.clock),
      profileId: this.profileId,
      sessionId: this.id,
      requestId: request.requestId,
      generation: this.generation,
      phase: 'intent',
      actionType: request.action.type,
      dispatched: false
    })
    let dispatched = false
    try {
      if (abort.signal.aborted) fail('cancelled', 'Action cancelled before dispatch')
      const target = await this.resolveActionTarget(request, tab)
      if (abort.signal.aborted) fail('cancelled', 'Action cancelled before dispatch')
      this.inFlight.dispatched = true
      dispatched = true
      await this.journal.append({
        at: nowIso(this.clock),
        profileId: this.profileId,
        sessionId: this.id,
        requestId: request.requestId,
        generation: this.generation,
        phase: 'dispatched',
        actionType: request.action.type,
        dispatched: true
      })
      const actionSessionId = target && 'from' in target
        ? target.from.cdpSessionId === target.to.cdpSessionId
          ? target.from.cdpSessionId
          : (fail('unsupported', 'Cross-frame drag is not certified'), ATTACHED_CDP_SESSION)
        : target?.cdpSessionId ?? ATTACHED_CDP_SESSION
      const cdp = this.requireCdp()
      const transport = this.transport!
      const keyboardInput = ['fill', 'type', 'key'].includes(request.action.type)
      let keyboardFocus: GuestKeyboardFocusScope | undefined
      try {
        if (keyboardInput) {
          keyboardFocus = await this.guest.guest.acquireKeyboardFocus(abort.signal)
          await this.assertBinding()
          if (abort.signal.aborted || request.controlLeaseId !== this.controlLeaseId) fail('cancelled', 'Keyboard ownership changed while awaiting focus')
          this.keyboardFocus = keyboardFocus
        }
        // DOM.focus selects an element but does not focus a hidden Linux guest's
        // renderer widget. Chromium otherwise acknowledges insertText without
        // inserting anything. Scope emulation to this one owned keyboard action.
        if (keyboardInput) await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, { sessionId: actionSessionId, signal: abort.signal })
        await dispatchAction(cdp, actionSessionId, request.action, target, abort.signal)
      } finally {
        try {
          if (keyboardInput && cdp.connected) {
            try {
              // Cancellation still has to restore the human tab's real focus state.
              await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }, { sessionId: actionSessionId, timeoutMs: 1_000 })
            } catch (error) {
              transport.releaseAttachment() // Detach clears emulation; never destroy the human tab.
              throw error
            }
          }
        } finally {
          this.keyboardFocus = null
          await keyboardFocus?.release(request.controlLeaseId === this.controlLeaseId)
        }
      }
      if (request.action.type === 'navigate' || request.action.type === 'reload' || request.action.type === 'back' || request.action.type === 'forward') {
        await waitForLoad(this.requireCdp(), ATTACHED_CDP_SESSION, request.timeoutMs, abort.signal)
        this.refs.invalidateTab(tab.publicId)
      }
      if (request.action.type === 'drag') await new Promise((resolve) => setTimeout(resolve, 100))
      if (request.action.type === 'fill' && target && !('from' in target) && !target.secret) {
        const value = await readControlValue(this.requireCdp(), target.cdpSessionId, target.objectId, abort.signal)
        if (value.value !== request.action.text) fail('not_actionable', 'Fill did not stick')
      }
      const observation = await this.observe({ tabId: tab.publicId })
      const fingerprint = JSON.stringify({
        action: request.action.type,
        target: 'target' in request.action ? request.action.target : 'from' in request.action ? [request.action.from, request.action.to] : undefined
      })
      this.repeatedActionCount = fingerprint === this.lastActionFingerprint ? this.repeatedActionCount + 1 : 1
      this.lastActionFingerprint = fingerprint
      if (this.repeatedActionCount > 3 && !request.expected) fail('no_progress', 'Repeated browser action made no observable progress; refresh or request human takeover')
      if (request.expected && !this.matchWait(observation, request.expected)) {
        const result: BrowserActionResult = {
          requestId: request.requestId, outcome: 'unverified', dispatched: true, observation, artifactIds: [],
          code: 'timeout', message: 'Expected state was not observed'
        }
        await this.journal.append({
          at: nowIso(this.clock), profileId: this.profileId, sessionId: this.id, requestId: request.requestId,
          generation: this.generation, phase: 'outcome', actionType: request.action.type, dispatched: true, outcome: 'unverified'
        })
        return result
      }
      const result: BrowserActionResult = {
        requestId: request.requestId, outcome: 'verified', dispatched: true, observation,
        artifactIds: observation.screenshot ? [observation.screenshot.artifactId] : []
      }
      await this.journal.append({
        at: nowIso(this.clock), profileId: this.profileId, sessionId: this.id, requestId: request.requestId,
        generation: this.generation, phase: 'outcome', actionType: request.action.type, dispatched: true, outcome: 'verified'
      })
      return result
    } catch (error) {
      const outcome = this.classifyActError(error, dispatched)
      await this.journal.append({
        at: nowIso(this.clock), profileId: this.profileId, sessionId: this.id, requestId: request.requestId,
        generation: this.generation, phase: 'outcome', actionType: request.action.type, dispatched, outcome
      })
      if (outcome === 'unknown-effect') {
        return {
          requestId: request.requestId,
          outcome,
          dispatched: true,
          artifactIds: [],
          code: 'worker_disconnected',
          message: error instanceof Error ? error.message : String(error)
        }
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (this.inFlight?.requestId === request.requestId) this.inFlight = null
    }
  }

  async handle(method: BrowserWorkerRequest['method'], params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (method !== 'session.close') await this.assertBinding()
    switch (method) {
      case 'session.close': return this.close()
      case 'tabs.list': return { tabs: this.listTabs(), activeTabId: this.tab.publicId }
      case 'tabs.switch': return this.switchTab(requiredId(params.tabId))
      case 'tabs.new':
      case 'tabs.close':
        fail('unsupported', `${method} is not supported on an attached in-app tab`)
        break
      case 'observe': return this.observe(params)
      case 'find': return this.find(params)
      case 'extract': return this.extract(params)
      case 'wait': return this.wait(params, signal)
      case 'act': return this.act(params, signal)
      case 'human.act':
        if (this.lifecycle !== 'human-controlled') fail('human_controlled', 'A human control lease is not active')
        return this.act(params, signal, true)
      case 'control.take': return this.takeControl(params.owner === 'human' ? 'human' : 'agent')
      case 'control.release':
        return this.releaseControl(requiredId(params.controlLeaseId))
      default:
        fail('unsupported', 'Unsupported method')
    }
  }

  private rejectUnsupportedAction(action: BrowserAction): void {
    if (action.type === 'upload') fail('unsupported', 'Attached backend does not certify file uploads')
  }

  private async enablePage(): Promise<void> {
    const cdp = this.requireCdp()
    await Promise.all([
      cdp.send('Page.enable', {}, { sessionId: ATTACHED_CDP_SESSION }),
      cdp.send('DOM.enable', {}, { sessionId: ATTACHED_CDP_SESSION }),
      cdp.send('Runtime.enable', {}, { sessionId: ATTACHED_CDP_SESSION }),
      cdp.send('Accessibility.enable', {}, { sessionId: ATTACHED_CDP_SESSION }),
      cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, { sessionId: ATTACHED_CDP_SESSION })
    ])
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
      if (!observation || !observation.screenshot || observation.tabId !== tab.publicId || observation.generation !== this.generation || observation.documentId !== tab.documentId) {
        fail('stale_observation', 'Image point geometry is stale')
      }
      const mapped = imagePointToViewport(target.point, observation.screenshot, observation.viewport)
      const located = await this.requireCdp().send<{ backendNodeId?: number }>('DOM.getNodeForLocation', {
        x: mapped.x, y: mapped.y, includeUserAgentShadowDOM: false
      }, { sessionId: ATTACHED_CDP_SESSION, signal: this.inFlight?.abort.signal })
      if (!located.backendNodeId) fail('not_actionable', 'No DOM target exists at the image point')
      const prepared = await prepareActionableTarget(this.requireCdp(), ATTACHED_CDP_SESSION, {
        backendNodeId: located.backendNodeId, frameRef: 'frame_' + tab.frameId, cdpSessionId: ATTACHED_CDP_SESSION, frameId: tab.frameId, fingerprint: 'image-point'
      }, this.inFlight?.abort.signal)
      const hit = await this.requireCdp().send<{ result?: { value?: { ok?: boolean } } }>('Runtime.callFunctionOn', {
        objectId: prepared.objectId,
        functionDeclaration: 'function(x, y) { const hit = document.elementFromPoint(x, y); return { ok: this === hit || this.contains(hit) }; }',
        arguments: [{ value: mapped.x }, { value: mapped.y }],
        returnByValue: true
      }, { sessionId: ATTACHED_CDP_SESSION, signal: this.inFlight?.abort.signal })
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
      if (error instanceof Error && error.message === 'stale_ref') fail('stale_ref', 'Element reference is stale')
      throw error
    }
    if (stored.identity.documentId !== tab.documentId) fail('stale_ref', 'Reference belongs to a previous document')
    return prepareActionableTarget(this.requireCdp(), stored.cdpSessionId ?? ATTACHED_CDP_SESSION, stored, this.inFlight?.abort.signal)
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
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'timeout') return dispatched ? 'unknown-effect' : 'failed'
    if (isBrowserWorkerError(error) && error.code === 'human_controlled') return dispatched ? 'unknown-effect' : 'failed'
    return 'failed'
  }

  private fenceInFlight(reason: 'cancelled' | 'human_controlled'): void {
    if (!this.inFlight) return
    this.inFlight.abort.abort(reason)
  }

  private handleDisconnect(): void {
    if (this.closed) return
    this.markDisconnected('debugger')
  }

  private handleFrameNavigated(params: unknown): void {
    const frame = (params as { frame?: { id?: string; parentId?: string; loaderId?: string; url?: string } })?.frame
    if (!frame || frame.parentId) return
    this.tab.loaderId = frame.loaderId ?? this.tab.loaderId
    this.tab.frameId = frame.id ?? this.tab.frameId
    this.tab.url = sanitizeUrl(frame.url ?? this.tab.url)
    this.invalidateDocument('navigation')
  }

  private invalidateDocument(_reason: string): void {
    const ownNavigation = this.inFlight?.dispatched === true &&
      ['navigate', 'reload', 'back', 'forward'].includes(this.inFlight.actionType)
    if (this.inFlight && !ownNavigation) this.fenceInFlight('cancelled')
    this.tab.documentId = 'doc_' + randomUUID()
    this.generation += 1
    this.controlLeaseId = 'lease_' + randomUUID()
    this.refs = new BrowserReferenceStore({ profileId: this.profileId, sessionId: this.id, generation: this.generation })
    this.observations.clear()
    this.touch()
    this.emitControl()
  }

  private async assertBinding(): Promise<void> {
    if (this.closed) fail('session_closed', 'Attached browser session is closed')
    if (this.disconnected || this.lifecycle === 'disconnected') fail('worker_disconnected', 'Attached debugger is disconnected')
    const record = await this.registry.assertDispatchAllowed({
      uiTabId: this.uiTabId,
      profileId: this.profileId,
      profileEpoch: this.profileEpoch,
      threadId: this.threadId
    })
    this.guest = record
  }

  private requireCdp(): CdpTransport {
    if (!this.transport || this.closed) fail('session_closed', 'Attached browser session is closed')
    if (this.disconnected || !this.transport.connected) fail('worker_disconnected', 'Attached debugger is disconnected')
    return this.transport
  }

  private requireTab(tabId: string): TabState {
    if (tabId !== this.tab.publicId) fail('stale_ref', 'Unknown attached tab')
    return this.tab
  }

  private touch(): void {
    this.updatedAt = nowIso(this.clock)
  }

  private emitControl(): void {
    this.onControlStateChange?.(this.controlState())
  }
}
