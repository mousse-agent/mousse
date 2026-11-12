import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensureWindowsBrowserSandboxAccess } from '../../shared/browser/windowsSandboxPermissions.mjs'
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
  BrowserViewerFrame,
  BrowserViewerUpdate,
  BrowserWaitCondition,
  BrowserWorkerRequest
} from '../../shared/browser/types'
import { AGENT_CURSOR_GLIDE_MS, agentCursorFor, agentCursorLive, type BrowserAgentCursor } from '../../shared/browser/agentCursor'
import { imagePointToViewport } from '../../shared/browser/geometry'
import { validateBrowserActionRequest, validateBrowserHumanInput, validateBrowserWait } from '../../shared/browser/validation'
import { ScopedArtifactWriter } from '../artifacts'
import { launchManagedChrome, type LaunchedChrome } from '../cdp/launch'
import { fail } from '../errors'
import { readWorkspaceLock, WorkspaceLock } from '../lifecycle/lock'
import { isProcessAlive } from '../lifecycle/process'
import { ephemeralUserDataDir, workspaceLockPath, workspaceUserDataDir } from '../lifecycle/paths'
import { BrowserReferenceStore, type ReferenceIdentity } from '../observation/ReferenceStore'
import { collectStructuredObservation, MAX_OBSERVATION_ELEMENTS, type CollectedObservation } from '../observation/collect'
import { captureViewportScreenshot } from '../observation/screenshot'
import { MAX_WAIT_MS, SCREENCAST_MAX_HEIGHT, ViewerCaptures, type ViewerTabInfo } from '../observation/screencast'
import { prepareActionableTarget, readControlValue, type ActionableTarget } from '../action/actionability'
import { dispatchAction, dispatchHumanInput, navigateAndWaitForLoad, waitForLoad } from '../action/dispatch'
import { ScopedActionJournal } from '../action/journal'
import { CdpDisconnectedError } from '../cdp/connection'
import { boundText, nowIso, optionalBoolean, optionalString, requiredId, sanitizeUrl, sleep, workerWarning } from '../util'
import { BrowserWorkerError, isBrowserWorkerError } from '../errors'

export interface SessionConfig {
  profileId: string
  browserRoot: string
  artifactRoot: string
  executablePath: string
  browserVersion: string
  chromeExtraArgs?: string[]
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
  /** The session of the page (a tab or a page a site opened) this frame is in: it belongs to that page alone. */
  pageSessionId: string
}

/**
 * A page or frame carrying the automation mark (`navigator.webdriver`), by its CDP session: every one
 * Chromium attached, each held before its first script until its mark was set.
 */
interface MarkedTarget {
  sessionId: string
  targetId: string
  type: 'page' | 'iframe'
  /** The page it is, or the page whose frame it is (through every level of nested frames). */
  pageSessionId: string
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

const MAX_ATTACHED_FRAMES_PER_OBSERVATION = 32
/** How long a new page or frame is held for its mark before it is let go. A page a site opens without an opener has no renderer yet: it answers only once it runs. */
const MARK_BEFORE_RUN_MS = 1_000
/** How long after that its mark may still take before the page is closed: it never runs on unmarked. */
const MARK_AFTER_RUN_MS = 10_000
/** How long Take over and Give back wait for each page or frame to take its mark, per try (a page with an open dialog never answers). */
const MARK_ANSWER_MS = 2_000
/** How long a new tab waits for its page to commit, so a failure carries its real error, before it is handed back still loading. */
const NEW_TAB_COMMIT_MS = 5_000

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
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
  private inFlight: { requestId: string; dispatched: boolean; abort: AbortController; tabSessionId: string } | null = null
  private readonly artifacts: ScopedArtifactWriter
  private readonly journal: ScopedActionJournal
  private readonly clock: () => Date
  private closed = false
  private closing = false
  private closeWork: Promise<void> | null = null
  private readonly sessionAbort = new AbortController()
  private readonly ops = new Set<Promise<unknown>>()
  private readonly frameEnables = new Map<string, Promise<void>>()
  private userDataDir = ''
  private observations = new Map<string, { tabId: string; generation: number; documentId: string; viewport: BrowserObservation['viewport']; screenshot?: BrowserObservation['screenshot'] }>()
  private lastActionFingerprint = ''
  private repeatedActionCount = 0
  private downloadDir = ''
  private downloadNames = new Map<string, string>()
  private downloadStates = new Map<string, 'inProgress' | 'completed' | 'canceled' | 'interrupted'>()
  /** Where the agent last acted (`agentCursor.ts`): held here, drawn by viewers over `frame()`, never in the page. */
  private cursor: BrowserAgentCursor | undefined
  /** The tab last brought to the front (`toFront`), or opened: the one Chromium paints. */
  private frontTargetId = ''
  /** The pictures of the tabs people watch (`frame.next`, `frame`), created on the first one asked for. */
  private viewers: ViewerCaptures | null = null
  /** Each tab's title as its page last set it, by target id, for people watching. */
  private readonly viewerTitles = new Map<string, string>()
  /** Pages and frames carrying the automation mark (`markAutomation`), by CDP session. */
  private readonly marked = new Map<string, MarkedTarget>()
  /**
   * Pages that read as automated whoever holds the browser: a tab the agent was still opening when a
   * person took over, until it closes. Keyed by page session.
   */
  private readonly agentPages = new Set<string>()
  /** Each new page's hold until its mark is set (`holdUntilMarked`), by target id: resolves true when it runs marked. */
  private readonly attachWork = new Map<string, { sessionId: string; work: Promise<boolean> }>()
  private readonly attachWaiters = new Map<string, Array<() => void>>()
  /** Tabs the agent is opening (`newTab`): a person taking over stops and closes them. */
  private readonly openingTabs = new Set<{ abort: AbortController; pageSessionId?: string }>()

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

  async start(initialUrl?: string, signal?: AbortSignal): Promise<BrowserSessionRecord> {
    return this.trackOp(signal, (opSignal) => this.startOwned(initialUrl, opSignal))
  }

  private async startOwned(initialUrl: string | undefined, signal: AbortSignal): Promise<BrowserSessionRecord> {
    this.throwIfUnavailable(signal)
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
    ensureWindowsBrowserSandboxAccess(this.config.browserRoot, dirname(this.config.executablePath))
    this.chrome = await launchManagedChrome({
      executablePath: this.config.executablePath,
      userDataDir: this.userDataDir,
      headless: true,
      browserVersion: this.config.browserVersion,
      automationMarkedPerPage: true,
      extraArgs: this.config.chromeExtraArgs,
      signal
    })
    this.throwIfUnavailable(signal)
    this.chrome.cdp.on('disconnect', () => {
      if (!this.closed && !this.closing) this.lifecycle = 'disconnected'
    })
    // Every target Chromium attaches on its own (the session's tabs too) waits until `onAttached` marks it and lets it run.
    this.chrome.cdp.on('Target.attachedToTarget', (params: unknown, parentSessionId?: string) => { this.onAttached(params, parentSessionId) })
    await this.chrome.cdp.send('Target.setDiscoverTargets', { discover: true }, { signal })
    await this.chrome.cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true
    }, { signal })
    await this.chrome.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: this.downloadDir, eventsEnabled: true }, { signal })
    this.chrome.cdp.on('Browser.downloadWillBegin', (params: unknown) => {
      if (this.closed || this.closing) return
      const record = params as { guid?: string; suggestedFilename?: string }
      if (record.guid) {
        this.downloadNames.set(record.guid, sanitizeDisplayName(record.suggestedFilename ?? 'download.bin'))
        this.downloadStates.set(record.guid, 'inProgress')
      }
    })
    this.chrome.cdp.on('Browser.downloadProgress', (params: unknown) => {
      if (this.closed || this.closing) return
      const record = params as { guid?: string; state?: string }
      if (!record.guid) return
      const state = record.state === 'completed' ? 'completed' : record.state === 'canceled' ? 'canceled' : record.state === 'interrupted' ? 'interrupted' : 'inProgress'
      this.downloadStates.set(record.guid, state)
    })
    const created = await this.openPage(signal)
    const tabId = 'tab_' + randomUUID()
    const tab: TabState = {
      publicId: tabId,
      targetId: created.targetId,
      cdpSessionId: created.sessionId,
      url: 'about:blank',
      title: '',
      documentId: 'doc_' + randomUUID(),
      loaderId: '',
      frameId: ''
    }
    await this.enableTab(tab, signal)
    this.throwIfUnavailable(signal)
    this.tabs.set(tabId, tab)
    this.activeTabId = tabId
    this.frontTargetId = created.targetId
    this.chrome.cdp.on('Page.frameNavigated', (params: unknown, sessionId?: string) => {
      if (this.closed || this.closing) return
      const frame = (params as { frame?: { id?: string; parentId?: string; loaderId?: string; url?: string } })?.frame
      if (!frame) return
      if (sessionId && this.frames.has(sessionId)) {
        const child = this.frames.get(sessionId)!
        const previousFrameId = child.frameId
        if (previousFrameId) this.refs.invalidateFrame('frame_' + previousFrameId)
        child.frameId = frame.id ?? child.frameId
        child.parentFrameId = frame.parentId ?? child.parentFrameId
        child.url = sanitizeUrl(frame.url ?? child.url)
        if (child.frameId && child.frameId !== previousFrameId) this.refs.invalidateFrame('frame_' + child.frameId)
        this.touch()
        return
      }
      if (frame.parentId) return
      const navigated = [...this.tabs.values()].find((entry) => entry.cdpSessionId === sessionId)
      if (!navigated) return
      navigated.loaderId = frame.loaderId ?? navigated.loaderId
      navigated.frameId = frame.id ?? navigated.frameId
      navigated.url = sanitizeUrl(frame.url ?? navigated.url)
      navigated.documentId = 'doc_' + randomUUID()
      // Chromium may send no more screencast pictures once a new page commits: a watched tab's starts again.
      this.viewers?.committed(navigated.cdpSessionId, navigated.url)
      this.refs.invalidateTab(navigated.publicId)
      this.touch()
    })
    // What a person watching sees of a tab: its title as the page sets it (kept apart from what agents are told), and its size.
    this.chrome.cdp.on('Target.targetInfoChanged', (params: unknown) => {
      if (this.closed || this.closing) return
      const info = (params as { targetInfo?: { targetId?: string; title?: string } })?.targetInfo
      const tab = info?.targetId ? [...this.tabs.values()].find((entry) => entry.targetId === info.targetId) : undefined
      if (!tab || typeof info?.title !== 'string') return
      const title = boundText(info.title, 512)
      this.viewerTitles.set(tab.targetId, title)
      this.viewers?.titled(tab.cdpSessionId, title)
    })
    this.chrome.cdp.on('Page.frameResized', (_params: unknown, sessionId?: string) => {
      if (sessionId && !this.closed && !this.closing) this.viewers?.resized(sessionId)
    })
    // Chromium does not always report a page's own title as it changes: a watched page's is read once it has loaded.
    this.chrome.cdp.on('Page.lifecycleEvent', (params: unknown, sessionId?: string) => {
      if (!sessionId || this.closed || this.closing || !this.viewers?.watching(sessionId)) return
      const name = (params as { name?: string } | undefined)?.name
      if (name !== 'DOMContentLoaded' && name !== 'load') return
      const tab = [...this.tabs.values()].find((entry) => entry.cdpSessionId === sessionId)
      if (tab) void this.refreshViewerTitle(tab)
    })
    this.chrome.cdp.on('Target.detachedFromTarget', (params: unknown) => {
      if (this.closed || this.closing) return
      const sessionId = (params as { sessionId?: string })?.sessionId
      if (sessionId) {
        const target = this.marked.get(sessionId)
        this.marked.delete(sessionId)
        this.agentPages.delete(sessionId)
        if (target && this.attachWork.get(target.targetId)?.sessionId === sessionId) this.attachWork.delete(target.targetId)
      }
      if (sessionId && this.frames.has(sessionId)) {
        const child = this.frames.get(sessionId)!
        this.frames.delete(sessionId)
        if (child.frameId) this.refs.invalidateFrame('frame_' + child.frameId)
        return
      }
      const detached = [...this.tabs.values()].find((entry) => entry.cdpSessionId === sessionId)
      if (detached) {
        this.viewers?.forget(detached.cdpSessionId)
        this.refs.invalidateTab(detached.publicId)
        this.tabs.delete(detached.publicId)
        if (this.activeTabId === detached.publicId) this.activeTabId = this.tabs.keys().next().value ?? ''
        this.viewers?.frontChanged()
      }
    })
    if (initialUrl) {
      await navigateAndWaitForLoad(this.chrome.cdp, tab.cdpSessionId, initialUrl, 15_000, signal)
    }
    this.throwIfUnavailable(signal)
    this.lifecycle = 'agent-controlled'
    this.touch()
    return this.record()
  }

  async close(): Promise<void> {
    if (this.closeWork) return this.closeWork
    if (this.closed && !this.chrome && !this.lock) return
    this.closing = true
    this.closeWork = this.closeOwned().finally(() => {
      if (!this.closed) this.closeWork = null
    })
    return this.closeWork
  }

  private async closeOwned(): Promise<void> {
    this.fenceInFlight('cancelled')
    if (!this.sessionAbort.signal.aborted) {
      try { this.sessionAbort.abort('cancelled') } catch { /* already aborted */ }
    }
    await Promise.allSettled([...this.ops])
    await Promise.allSettled([...this.frameEnables.values()])
    this.viewers?.dispose()
    this.viewers = null
    const chrome = this.chrome
    try {
      if (chrome) await chrome.stop()
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error))
    }
    if (chrome && chrome.process.exitCode === null) {
      throw new Error(`Managed Chromium still alive after stop (pid ${chrome.pid})`)
    }
    if (chrome && isProcessAlive(chrome.pid)) {
      throw new Error(`Managed Chromium pid ${chrome.pid} is still alive after stop`)
    }
    this.chrome = null
    this.frames.clear()
    this.marked.clear()
    this.agentPages.clear()
    this.attachWork.clear()
    this.attachWaiters.clear()
    this.frameLoaders.clear()
    this.tabs.clear()
    if (this.downloadDir) this.clearDownloadQuarantine()
    this.lock?.release()
    this.lock = null
    if (!this.persistent && this.userDataDir) {
      await this.removeEphemeralUserData()
    }
    this.refs.clear()
    this.closed = true
    this.lifecycle = 'closed'
    this.touch()
  }

  private async removeEphemeralUserData(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { rmSync(this.userDataDir, { recursive: true, force: true }) } catch { /* Windows handles may release shortly after exit */ }
      if (!existsSync(this.userDataDir)) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Managed Chromium user-data directory is still owned after process exit: ${this.userDataDir}`)
  }

  listTabs(): BrowserTab[] {
    return [...this.tabs.values()].map((tab) => ({ id: tab.publicId, title: tab.title, url: tab.url }))
  }

  /**
   * A tab the agent opens. Nothing the agent opens runs while a person holds the browser: a new tab
   * is refused then, and one still opening when a person takes over is closed (`takeControl`), reading
   * as automated until it is gone.
   */
  async newTab(url?: string, signal?: AbortSignal): Promise<BrowserTab> {
    const chrome = this.requireChrome()
    this.throwIfUnavailable(signal)
    this.refuseWhileHeld()
    const opening: { abort: AbortController; pageSessionId?: string } = { abort: new AbortController() }
    this.openingTabs.add(opening)
    const opSignal = signal ? AbortSignal.any([signal, opening.abort.signal]) : opening.abort.signal
    let targetId: string | undefined
    try {
      // The tab opens blank, held until it is marked, and loads `url` once it is: a page created on a
      // URL is not held, so its first script could run before its mark.
      const created = await this.openPage(opSignal, (page) => {
        targetId = page.targetId
        opening.pageSessionId = page.sessionId
      })
      const tabId = 'tab_' + randomUUID()
      const tab: TabState = {
        publicId: tabId,
        targetId: created.targetId,
        cdpSessionId: created.sessionId,
        url: url ?? 'about:blank',
        title: '',
        documentId: 'doc_' + randomUUID(),
        loaderId: '',
        frameId: ''
      }
      await this.enableTab(tab, opSignal)
      this.throwIfUnavailable(opSignal)
      this.refuseWhileHeld()
      if (url) await this.loadNewTab(tab, url, opSignal)
      this.tabs.set(tabId, tab)
      this.activeTabId = tabId
      // A new tab opens in front.
      this.frontTargetId = created.targetId
      this.viewers?.frontChanged()
      this.touch()
      return { id: tabId, title: tab.title, url: tab.url }
    } catch (error) {
      if (targetId) {
        try { await chrome.cdp.send('Target.closeTarget', { targetId }, { timeoutMs: 5_000 }) } catch { /* compensate failed tab */ }
      }
      if (opening.abort.signal.aborted && !signal?.aborted) fail('human_controlled', 'A person took over the browser while the tab opened; it was closed')
      throw error
    } finally {
      this.openingTabs.delete(opening)
    }
  }

  private refuseWhileHeld(): void {
    if (this.controlOwner === 'human') fail('human_controlled', 'A person holds the browser: nothing new opens until they give it back')
  }

  /**
   * The new tab's first page. Its answer comes once the page commits (or fails to), which carries a
   * failure's real error; a slow page is handed back still loading. The blank page it opened on is
   * then dropped from its history, so Back in a fresh tab has nowhere to go, as for a tab opened on a URL.
   */
  private async loadNewTab(tab: TabState, url: string, signal: AbortSignal): Promise<void> {
    const cdp = this.requireChrome().cdp
    const navigation = cdp.send<{ errorText?: string }>('Page.navigate', { url }, { sessionId: tab.cdpSessionId, signal })
    const waited = new AbortController()
    const answered = await Promise.race([settle(navigation), sleep(NEW_TAB_COMMIT_MS, AbortSignal.any([signal, waited.signal])).then(() => undefined, () => undefined)])
    waited.abort()
    if (signal.aborted) this.throwIfUnavailable(signal)
    if (answered && !answered.ok) throw answered.error
    if (answered?.ok && answered.value.errorText) fail('not_actionable', `The tab could not open ${sanitizeUrl(url)}: ${answered.value.errorText}`)
    const forgetBlankPage = async (): Promise<void> => {
      // Just after the page commits, Chromium may answer "not attached" for a moment.
      let history: { currentIndex: number; entries: Array<{ url: string }> } | undefined
      for (let attempt = 0; !history && attempt < 20; attempt += 1) {
        history = await cdp.send<{ currentIndex: number; entries: Array<{ url: string }> }>('Page.getNavigationHistory', {}, { sessionId: tab.cdpSessionId, timeoutMs: 5_000 })
          .catch(() => sleep(25).then(() => undefined))
      }
      if (!history) return
      // Only the blank page and this one: anything more is history someone made since.
      if (history.entries.length === 2 && history.currentIndex === 1 && history.entries[0]!.url === 'about:blank') {
        await cdp.send('Page.resetNavigationHistory', {}, { sessionId: tab.cdpSessionId, timeoutMs: 5_000 })
      }
    }
    if (answered) {
      await forgetBlankPage().catch(() => undefined)
      return
    }
    void navigation.then((result) => result.errorText ? undefined : forgetBlankPage()).catch(() => undefined)
  }

  async closeTab(tabId: string, signal?: AbortSignal): Promise<void> {
    const tab = this.requireTab(tabId)
    const chrome = this.requireChrome()
    this.throwIfUnavailable(signal)
    this.refs.invalidateTab(tabId)
    await chrome.cdp.send('Target.closeTarget', { targetId: tab.targetId }, { signal })
    this.viewers?.forget(tab.cdpSessionId)
    this.tabs.delete(tabId)
    if (this.activeTabId === tabId) this.activeTabId = this.tabs.keys().next().value ?? ''
    this.viewers?.frontChanged()
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
    const requestedMax = Math.min(MAX_OBSERVATION_ELEMENTS, Math.max(1,
      Math.floor(typeof params.maxElements === 'number' ? params.maxElements : MAX_OBSERVATION_ELEMENTS)))
    const collected = await collectStructuredObservation(this.requireChrome().cdp, tab.cdpSessionId, {
      visibleOnly: optionalBoolean(params.visibleOnly),
      continuation: optionalString(params.continuation, 64),
      maxElements: requestedMax
    })
    tab.url = collected.url
    tab.title = collected.title
    tab.documentId = collected.documentId
    tab.loaderId = collected.loaderId
    tab.frameId = collected.frameId
    // Only this tab's frames: every page attaches its own, and one tab never reads another's.
    const attachedFrames = this.framesOf(tab)
    const childCollections: CollectedObservation[] = []
    let remainingElements = requestedMax - collected.elements.length
    let childObservationTruncated = attachedFrames.length > MAX_ATTACHED_FRAMES_PER_OBSERVATION
    for (const frame of attachedFrames.slice(0, MAX_ATTACHED_FRAMES_PER_OBSERVATION)) {
      if (collected.truncated || remainingElements <= 0) {
        childObservationTruncated ||= attachedFrames.length > 0
        break
      }
      const offset = await this.frameViewportOffset(tab, frame)
      if (!offset) continue
      try {
        const child = await collectStructuredObservation(this.requireChrome().cdp, frame.sessionId, {
          visibleOnly: optionalBoolean(params.visibleOnly),
          continuation: undefined,
          maxElements: remainingElements,
          viewportOffset: offset
        })
        const previousLoader = this.frameLoaders.get(frame.sessionId)
        if (previousLoader && previousLoader !== child.loaderId) this.refs.invalidateFrame('frame_' + frame.frameId)
        this.frameLoaders.set(frame.sessionId, child.loaderId)
        childCollections.push(child)
        remainingElements -= child.elements.length
        if (child.truncated) {
          childObservationTruncated = true
          break
        }
      } catch (error) {
        if (error instanceof CdpDisconnectedError) continue
        throw error
      }
    }
    const mergedNodes = [collected, ...childCollections]
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
      truncated: collected.truncated || childObservationTruncated,
      ...(collected.continuation ? { continuation: collected.continuation } : {}),
      warnings: [...new Set([...collected.warnings.filter((warning) => warning !== 'unsupported-oopif' && warning !== 'iframe-observation-limited'), ...childCollections.flatMap((item) => item.warnings), ...(attachedFrames.length ? ['oopif-attached'] : []), ...(childObservationTruncated ? ['frame-observation-truncated'] : [])])],
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
    // A closing, closed or disconnected session keeps that state; control cannot move on it.
    this.requireChrome()
    if (owner === 'human') {
      // A tab the agent is still opening never becomes the person's: it stays automated until it closes.
      for (const opening of this.openingTabs) {
        if (opening.pageSessionId) this.agentPages.add(opening.pageSessionId)
        opening.abort.abort('human_controlled')
      }
    }
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
    this.requireChrome()
    if (controlLeaseId !== this.controlLeaseId) fail('stale_generation', 'Control lease does not match')
    this.controlOwner = 'agent'
    this.lifecycle = 'agent-controlled'
    this.touch()
  }

  async act(params: Record<string, unknown>, signal?: AbortSignal, humanLease = false): Promise<BrowserActionResult> {
    if (this.lifecycle === 'human-controlled' && !humanLease) fail('human_controlled', 'A human control lease is active')
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
    await this.toFront(tab)
    const abort = new AbortController()
    const onAbort = () => abort.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) fail('cancelled', 'Action cancelled before dispatch')
      signal.addEventListener('abort', onAbort, { once: true })
    }
    this.inFlight = { requestId: request.requestId, dispatched: false, abort, tabSessionId: tab.cdpSessionId }
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
      if (!humanLease) await this.glideCursor(request, tab, target, abort.signal)
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
      if (request.action.type === 'drag') {
        await new Promise((resolve) => setTimeout(resolve, 100))
        // The cursor ends where the drag dropped.
        if (this.cursor && target && 'from' in target) this.cursor = { ...this.cursor, x: target.to.point.x, y: target.to.point.y, at: this.clock().getTime() }
      }
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

  /**
   * The agent cursor moves to the resolved target and glides there for a moment before the input is
   * sent, so a person watching sees where the agent acts. Cancelling meanwhile sends nothing.
   */
  private async glideCursor(request: BrowserActionRequest, tab: TabState, target: ActionableTarget | { from: ActionableTarget; to: ActionableTarget } | undefined, signal: AbortSignal): Promise<void> {
    const point = target ? ('from' in target ? target.from.point : target.point) : undefined
    const viewport = this.observations.get(request.observationId)?.viewport
    const cursor = agentCursorFor(request.action, point, { width: viewport?.cssWidth ?? 1280, height: viewport?.cssHeight ?? 720 }, this.clock().getTime(), tab.publicId)
    if (!cursor) return
    this.cursor = cursor
    // Watchers hear of it now, while it glides: it is drawn over their picture, not painted in the page.
    this.viewers?.cursorMoved(tab.publicId)
    try {
      await sleep(AGENT_CURSOR_GLIDE_MS, signal)
    } catch {
      fail('cancelled', 'Action cancelled before dispatch')
    }
  }

  /**
   * A headless browser paints only its front tab: a tab behind is hidden, runs no animation frames,
   * and its page may never settle for an action. The tab an action acts on comes to the front. A
   * person watching never moves it: their view of a tab behind is a still (`ViewerCaptures`).
   */
  private async toFront(tab: TabState): Promise<void> {
    if (this.frontTargetId === tab.targetId || this.tabs.size < 2) {
      this.frontTargetId = tab.targetId
      return
    }
    await this.requireChrome().cdp.send('Target.activateTarget', { targetId: tab.targetId }, { timeoutMs: 5_000 })
    this.frontTargetId = tab.targetId
    this.viewers?.frontChanged()
  }

  /** Whether a tab is not the one in front, so Chromium does not paint it. */
  private behind(cdpSessionId: string): boolean {
    if (this.tabs.size < 2) return false
    const tabs = [...this.tabs.values()]
    const tab = tabs.find((entry) => entry.cdpSessionId === cdpSessionId)
    const front = tabs.find((entry) => entry.targetId === this.frontTargetId)
    return Boolean(tab && front && front !== tab)
  }

  private viewerCaptures(): ViewerCaptures {
    this.viewers ??= new ViewerCaptures(this.requireChrome().cdp, { behind: (cdpSessionId) => this.behind(cdpSessionId), now: () => this.clock().getTime() })
    return this.viewers
  }

  /** Reads a tab's title as its page set it, for people watching. */
  private async refreshViewerTitle(tab: TabState): Promise<void> {
    try {
      const { targetInfo } = await this.requireChrome().cdp.send<{ targetInfo?: { title?: string } }>('Target.getTargetInfo', { targetId: tab.targetId }, { timeoutMs: 5_000 })
      if (typeof targetInfo?.title !== 'string') return
      const title = boundText(targetInfo.title, 512)
      this.viewerTitles.set(tab.targetId, title)
      this.viewers?.titled(tab.cdpSessionId, title)
    } catch {
      // The tab closed meanwhile: its title no longer matters.
    }
  }

  private viewerTab(tab: TabState): ViewerTabInfo {
    return { cdpSessionId: tab.cdpSessionId, tabId: tab.publicId, url: tab.url, title: this.viewerTitles.get(tab.targetId) ?? boundText(tab.title, 512) }
  }

  private liveCursor(tab: TabState): BrowserAgentCursor | undefined {
    return this.cursor?.tabId === tab.publicId && agentCursorLive(this.cursor, this.clock().getTime()) ? this.cursor : undefined
  }

  /**
   * A watcher's next picture of a tab (`frame.next`, a bot's browser view): a long-poll answered when
   * the page paints (at most `maxFps` a second), when the tab's state or the agent cursor changes, or
   * with `idle` after `waitMs`. Not an observation: no refs, no artifact, nothing a model reads. One
   * capture per tab is shared by its watchers; it never brings the tab to the front.
   */
  async viewerNext(params: Record<string, unknown>, signal: AbortSignal): Promise<BrowserViewerUpdate> {
    const tab = this.requireTab(typeof params.tabId === 'string' ? params.tabId : this.activeTabId)
    const watchKey = requiredId(params.watchKey)
    // A tab watched for the first time: its title as it is now.
    if (!this.viewers?.watching(tab.cdpSessionId)) await this.refreshViewerTitle(tab)
    const count = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback
    const update = await this.viewerCaptures().next(this.viewerTab(tab), {
      watchKey,
      maxWidth: count(params.maxWidth, 160, 1920, 960),
      maxFps: count(params.maxFps, 1, 30, 15),
      afterFrame: count(params.afterFrame, 0, Number.MAX_SAFE_INTEGER, 0),
      afterState: count(params.afterState, 0, Number.MAX_SAFE_INTEGER, 0),
      waitMs: count(params.waitMs, 0, MAX_WAIT_MS, 20_000),
      signal
    })
    const cursor = this.tabs.has(tab.publicId) ? this.liveCursor(tab) : undefined
    return { ...update, ...(cursor ? { cursor } : {}) }
  }

  /** A watcher stops (`frame.stop`): a tab nobody watches stops its screencast. */
  viewerStop(params: Record<string, unknown>): { ok: true } {
    this.viewers?.stop(requiredId(params.watchKey))
    return { ok: true }
  }

  /**
   * A live picture of a tab for a view that asks each time (`frame`, the bot browser view of an
   * older app): a JPEG of the visible viewport, and the agent cursor while it is recent. It is the
   * tab's latest painted picture, from the same capture as `frame.next`, so asking often costs a
   * local read; only before the first one is a picture taken here. It never brings the tab to the front.
   */
  async frame(params: Record<string, unknown>): Promise<BrowserViewerFrame> {
    const tab = this.requireTab(typeof params.tabId === 'string' ? params.tabId : this.activeTabId)
    const cdp = this.requireChrome().cdp
    const maxWidth = typeof params.maxWidth === 'number' && params.maxWidth >= 160 ? Math.min(params.maxWidth, 1920) : 960
    const viewers = this.viewerCaptures()
    const { picture: painted, viewport } = await viewers.latest(this.viewerTab(tab), maxWidth)
    const cursor = this.liveCursor(tab)
    const picture = { tabId: tab.publicId, url: tab.url, title: this.viewerTab(tab).title, mimeType: 'image/jpeg' as const, viewport, ...(cursor ? { cursor } : {}) }
    if (painted) return { ...picture, data: painted.data, width: painted.width, height: painted.height, capturedAt: new Date(painted.at).toISOString() }
    const metrics = await cdp.send<{ cssVisualViewport?: { pageX?: number; pageY?: number } }>('Page.getLayoutMetrics', {}, { sessionId: tab.cdpSessionId, timeoutMs: 5_000 })
    const scale = Math.min(1, maxWidth / viewport.width, SCREENCAST_MAX_HEIGHT / viewport.height)
    // The clip is in page coordinates: the visible viewport starts at the scroll offset.
    const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', {
      format: 'jpeg', quality: 60, fromSurface: true, captureBeyondViewport: false,
      clip: { x: metrics.cssVisualViewport?.pageX ?? 0, y: metrics.cssVisualViewport?.pageY ?? 0, width: viewport.width, height: viewport.height, scale }
    }, { sessionId: tab.cdpSessionId, timeoutMs: 10_000 })
    const taken = { data: shot.data, width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale), at: this.clock().getTime(), sharp: false }
    viewers.keep(tab.cdpSessionId, taken)
    return { ...picture, data: taken.data, width: taken.width, height: taken.height, capturedAt: nowIso(this.clock) }
  }

  /** A person's input while they hold the session (`control.take` as human): trusted input on the tab. */
  async humanInput(params: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: true }> {
    if (this.lifecycle !== 'human-controlled') fail('human_controlled', 'A human control lease is not active')
    if (params.controlLeaseId !== this.controlLeaseId) fail('human_controlled', 'Control lease was replaced')
    const input = validateBrowserHumanInput(params.input)
    const tab = this.requireTab(typeof params.tabId === 'string' ? params.tabId : this.activeTabId)
    const cdp = this.requireChrome().cdp
    if (input.kind === 'navigate') await navigateAndWaitForLoad(cdp, tab.cdpSessionId, input.url, 15_000, signal)
    else if (input.kind === 'back' || input.kind === 'forward' || input.kind === 'reload') {
      await dispatchAction(cdp, tab.cdpSessionId, { type: input.kind }, undefined, signal)
      await waitForLoad(cdp, tab.cdpSessionId, 15_000, signal)
    } else await dispatchHumanInput(cdp, tab.cdpSessionId, input, signal)
    // What the person did may change the page under any ref the agent holds.
    this.refs.invalidateTab(tab.publicId)
    this.touch()
    return { ok: true }
  }

  handle(method: BrowserWorkerRequest['method'], params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> | unknown {
    switch (method) {
      case 'session.close': return this.close()
      case 'tabs.list': return { tabs: this.listTabs(), activeTabId: this.activeTabId }
      case 'tabs.new': return this.trackOp(signal, (opSignal) => this.newTab(optionalString(params.url, 8192), opSignal))
      case 'tabs.close': return this.trackOp(signal, (opSignal) => this.closeTab(requiredId(params.tabId), opSignal))
      case 'tabs.switch': return this.switchTab(requiredId(params.tabId))
      case 'observe': return this.trackOp(signal, () => this.observe(params))
      case 'find': return this.trackOp(signal, () => this.find(params))
      case 'extract': return this.trackOp(signal, () => this.extract(params))
      case 'wait': return this.trackOp(signal, (opSignal) => this.wait(params, opSignal))
      case 'act': return this.trackOp(signal, (opSignal) => this.act(params, opSignal))
      case 'human.act':
        if (this.lifecycle !== 'human-controlled') fail('human_controlled', 'A human control lease is not active')
        return this.trackOp(signal, (opSignal) => this.act(params, opSignal, true))
      case 'frame': return this.trackOp(signal, () => this.frame(params))
      case 'frame.next': return this.trackOp(signal, (opSignal) => this.viewerNext(params, opSignal))
      case 'frame.stop': return this.viewerStop(params)
      case 'human.input': return this.trackOp(signal, (opSignal) => this.humanInput(params, opSignal))
      case 'control.take': {
        const owner = params.owner === 'human' ? 'human' : 'agent'
        // A page the agent's action was still loading never commits for the person.
        const loadingForAgent = owner === 'human' && this.inFlight?.dispatched ? this.inFlight.tabSessionId : undefined
        const taken = this.takeControl(owner)
        return this.afterControlMoved(loadingForAgent).then(() => taken)
      }
      case 'control.release':
        this.releaseControl(requiredId(params.controlLeaseId))
        return this.afterControlMoved().then(() => ({ ok: true, lifecycle: this.lifecycle }))
      default:
        fail('unsupported', 'Unsupported method')
    }
  }

  private async enableTab(tab: TabState, signal?: AbortSignal): Promise<void> {
    const delayMs = process.env.MOUSSE_BROWSER_TEST_DELAY_TAB_ENABLE_MS
      ? Math.min(30_000, Math.max(0, Number(process.env.MOUSSE_BROWSER_TEST_DELAY_TAB_ENABLE_MS) || 0))
      : 0
    if (delayMs) await sleep(delayMs, signal ?? this.sessionAbort.signal)
    this.throwIfUnavailable(signal)
    const cdp = this.requireChrome().cdp
    // Its mark, and the hold on frames from other sites inside it, were set when it attached (`onAttached`).
    await Promise.all([
      cdp.send('Page.enable', {}, { sessionId: tab.cdpSessionId, signal }),
      cdp.send('DOM.enable', {}, { sessionId: tab.cdpSessionId, signal }),
      cdp.send('Runtime.enable', {}, { sessionId: tab.cdpSessionId, signal }),
      cdp.send('Accessibility.enable', {}, { sessionId: tab.cdpSessionId, signal }),
      cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, { sessionId: tab.cdpSessionId, signal })
    ])
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false
    }, { sessionId: tab.cdpSessionId, signal })
  }

  /**
   * What `navigator.webdriver` reads on a page or frame: true while the agent holds the browser,
   * false only while a person holds it (`control.take` as human), except on a page the agent was
   * still opening then (`agentPages`). Frames follow the page they are in.
   */
  private automated(target: MarkedTarget): boolean {
    return this.controlOwner !== 'human' || this.agentPages.has(target.pageSessionId)
  }

  private async markAutomation(target: MarkedTarget, timeoutMs: number): Promise<boolean> {
    const enabled = this.automated(target)
    await this.requireChrome().cdp.send('Emulation.setAutomationOverride', { enabled }, { sessionId: target.sessionId, timeoutMs })
    return enabled
  }

  /**
   * After Take over or Give back, every page and frame takes the mark for who now holds the browser.
   * Each has a short time to answer (a page with an open dialog cannot), so neither waits long on one.
   * One that should read as automated and did not take it is asked once more, then its page is
   * closed: no page is left reading false under the agent. One that should read false and did not
   * keeps reading true, the safe side.
   */
  private async afterControlMoved(loadingForAgent?: string): Promise<void> {
    const cdp = this.chrome?.cdp
    if (!cdp) return
    if (loadingForAgent) await cdp.send('Page.stopLoading', {}, { sessionId: loadingForAgent, timeoutMs: MARK_ANSWER_MS }).catch(() => undefined)
    const unmarked = await this.markEach([...this.marked.values()])
    if (!unmarked.length) return
    const still = await this.markEach(unmarked)
    await Promise.all(still.map((target) => this.closePageOf(target, 'its page did not take the automation mark when the agent got the browser back')))
  }

  /** Marks each target, answering with those that should read as automated and did not confirm it. */
  private async markEach(targets: MarkedTarget[]): Promise<MarkedTarget[]> {
    const results = await Promise.all(targets.map(async (target) => {
      const marked = await settle(this.markAutomation(target, MARK_ANSWER_MS))
      if (marked.ok || !this.marked.has(target.sessionId)) return undefined
      if (!this.automated(target)) {
        workerWarning('a page kept reading as automated after a person took over', { session: this.id, type: target.type })
        return undefined
      }
      return target
    }))
    return results.filter((target): target is MarkedTarget => target !== undefined)
  }

  /** Closes the page (a tab, or a page a site opened) a target is or is in: the way it fails closed. */
  private async closePageOf(target: MarkedTarget, reason: string): Promise<void> {
    if (!this.marked.has(target.sessionId) || !this.automated(target)) return
    const page = this.marked.get(target.pageSessionId)
    workerWarning(`closed a page: ${reason}`, { session: this.id, type: target.type })
    await this.chrome?.cdp.send('Target.closeTarget', { targetId: page?.targetId ?? target.targetId }, { timeoutMs: 5_000 }).catch(() => undefined)
  }

  /**
   * A target Chromium attached on its own, held before its first script: a page (one of this
   * session's tabs, or a page a site opened, with or without an opener), a frame from another site at
   * any depth, a worker. A page or frame belongs to the page it is or is in (its parent session, as
   * Chromium attached it), takes that page's mark, and holds the frames inside it the same way,
   * before it runs. A worker has no `navigator.webdriver` and runs at once.
   */
  private onAttached(params: unknown, parentSessionId?: string): void {
    const record = params as { sessionId?: string; waitingForDebugger?: boolean; targetInfo?: { type?: string; targetId?: string; parentFrameId?: string; url?: string } }
    const sessionId = record.sessionId
    const info = record.targetInfo
    const cdp = this.chrome?.cdp
    if (!sessionId || !cdp) return
    const run = (): Promise<void> => record.waitingForDebugger
      ? cdp.send('Runtime.runIfWaitingForDebugger', {}, { sessionId }).then(() => undefined, () => undefined)
      : Promise.resolve()
    const type = info?.type
    if (this.closed || this.closing || (type !== 'page' && type !== 'iframe') || !info?.targetId) {
      void run()
      return
    }
    const parent = parentSessionId ? this.marked.get(parentSessionId) : undefined
    const target: MarkedTarget = {
      sessionId,
      targetId: info.targetId,
      type,
      pageSessionId: type === 'page' ? sessionId : parent?.pageSessionId ?? parentSessionId ?? sessionId
    }
    this.marked.set(sessionId, target)
    if (type === 'iframe') {
      this.frames.set(sessionId, {
        sessionId,
        frameId: info.targetId,
        parentFrameId: info.parentFrameId,
        targetId: info.targetId,
        url: sanitizeUrl(info.url ?? ''),
        pageSessionId: target.pageSessionId
      })
      const work = this.enableFrame(sessionId)
      this.frameEnables.set(sessionId, work)
      void work.finally(() => {
        if (this.frameEnables.get(sessionId) === work) this.frameEnables.delete(sessionId)
      })
    }
    const work = this.holdUntilMarked(target, run).catch(() => false)
    this.attachWork.set(info.targetId, { sessionId, work })
    for (const wake of this.attachWaiters.get(info.targetId) ?? []) wake()
    this.attachWaiters.delete(info.targetId)
  }

  /**
   * Sets a held target's mark and the hold on frames inside it, then lets it run. A page a site
   * opened without an opener has no renderer until it runs, so its mark is answered only after: it
   * still lands before the page's first script, and if it never does, the page is closed. A target
   * whose mark fails is never let run unmarked: a frame stays held (it never loads), a page is closed.
   * Answers whether it runs marked.
   */
  private async holdUntilMarked(target: MarkedTarget, run: () => Promise<void>): Promise<boolean> {
    let cdp: LaunchedChrome['cdp']
    try {
      cdp = this.requireChrome().cdp
    } catch {
      await run()
      return false
    }
    const mark = settle(this.markAutomation(target, MARK_BEFORE_RUN_MS + MARK_AFTER_RUN_MS))
    const nested = await settle(cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, { sessionId: target.sessionId, timeoutMs: MARK_AFTER_RUN_MS }))
    const waited = new AbortController()
    const early = await Promise.race([mark, sleep(MARK_BEFORE_RUN_MS, waited.signal).then(() => undefined, () => undefined)])
    waited.abort()
    const failed = async (released: boolean): Promise<false> => {
      if (!this.marked.has(target.sessionId) || this.closed || this.closing) return false
      // Unmarked reads false: harmless only while a person holds the browser and the frames inside are held.
      if (nested.ok && !this.automated(target)) {
        if (!released) await run()
        return false
      }
      if (target.type === 'iframe' && !released) {
        workerWarning('a frame stays held: it could not be marked as automated', { session: this.id })
        return false
      }
      await this.closePageOf(target, 'it could not be marked as automated before it ran')
      return false
    }
    if (!nested.ok || (early && !early.ok)) return failed(false)
    await run()
    const answered = early ?? await mark
    if (!answered.ok) return failed(true)
    return true
  }

  /**
   * Opens a blank page for a tab, held until it is marked (`onAttached`), and answers its session:
   * the session's tabs are the very sessions Chromium attached, so each page has one session and its
   * frames attach once.
   */
  private async openPage(signal: AbortSignal, created?: (page: { targetId: string; sessionId?: string }) => void): Promise<{ targetId: string; sessionId: string }> {
    const cdp = this.requireChrome().cdp
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' }, { signal })
    created?.({ targetId })
    if (!this.attachWork.has(targetId)) {
      await new Promise<void>((resolve, reject) => {
        const waiters = this.attachWaiters.get(targetId) ?? []
        const done = (error?: Error) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          const left = (this.attachWaiters.get(targetId) ?? []).filter((entry) => entry !== wake)
          if (left.length) this.attachWaiters.set(targetId, left)
          else this.attachWaiters.delete(targetId)
          if (error) reject(error)
          else resolve()
        }
        const wake = () => done()
        const onAbort = () => done(new BrowserWorkerError('cancelled', 'Opening the tab was cancelled'))
        const timer = setTimeout(() => done(new BrowserWorkerError('worker_disconnected', 'The new tab never attached')), MARK_AFTER_RUN_MS)
        waiters.push(wake)
        this.attachWaiters.set(targetId, waiters)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
    }
    const attached = this.attachWork.get(targetId)
    if (!attached) fail('worker_disconnected', 'The new tab closed while it opened')
    created?.({ targetId, sessionId: attached.sessionId })
    if (!await attached.work) fail('worker_disconnected', 'The new tab could not be marked as automated and was closed')
    this.throwIfUnavailable(signal)
    return { targetId, sessionId: attached.sessionId }
  }

  private async enableFrame(sessionId: string): Promise<void> {
    try {
      if (this.closed || this.closing) return
      const delayMs = process.env.MOUSSE_BROWSER_TEST_DELAY_OOPIF_ENABLE_MS
        ? Math.min(30_000, Math.max(0, Number(process.env.MOUSSE_BROWSER_TEST_DELAY_OOPIF_ENABLE_MS) || 0))
        : 0
      if (delayMs) await sleep(delayMs, this.sessionAbort.signal)
      if (this.closed || this.closing) return
      await Promise.all([
        this.requireChrome().cdp.send('Page.enable', {}, { sessionId, signal: this.sessionAbort.signal }),
        this.requireChrome().cdp.send('DOM.enable', {}, { sessionId, signal: this.sessionAbort.signal }),
        this.requireChrome().cdp.send('Runtime.enable', {}, { sessionId, signal: this.sessionAbort.signal }),
        this.requireChrome().cdp.send('Accessibility.enable', {}, { sessionId, signal: this.sessionAbort.signal })
      ])
    } catch {
        this.frames.delete(sessionId)
        this.frameLoaders.delete(sessionId)
    }
  }

  private trackOp<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
    if (this.closed || this.closing) fail('session_closed', 'Browser session is closed')
    const combined = signal ? AbortSignal.any([this.sessionAbort.signal, signal]) : this.sessionAbort.signal
    if (combined.aborted) fail('cancelled', 'Browser session work cancelled')
    const promise = Promise.resolve().then(() => work(combined))
    this.ops.add(promise)
    return promise.finally(() => this.ops.delete(promise))
  }

  private throwIfUnavailable(signal?: AbortSignal): void {
    if (this.closed || this.closing) fail('session_closed', 'Browser session is closed')
    if (signal?.aborted || this.sessionAbort.signal.aborted) fail('cancelled', 'Browser session work cancelled')
  }

  /** The frames from other sites in one tab, nested ones included. */
  private framesOf(tab: TabState): AttachedFrameState[] {
    return [...this.frames.values()].filter((frame) => frame.pageSessionId === tab.cdpSessionId)
  }

  private async frameViewportOffset(tab: TabState, frame: AttachedFrameState, visited = new Set<string>()): Promise<{ x: number; y: number } | null> {
    try {
      if (frame.pageSessionId !== tab.cdpSessionId) return null
      if (visited.has(frame.sessionId)) return null
      visited.add(frame.sessionId)
      const siblings = this.framesOf(tab)
      const candidates: Array<{ id?: string; parentId?: string; url?: string }> = []
      const tree = await this.requireChrome().cdp.send<{ frameTree?: { frame?: { id?: string; parentId?: string; url?: string }; childFrames?: unknown[] } }>('Page.getFrameTree', {}, { sessionId: tab.cdpSessionId })
      const visit = (node: { frame?: { id?: string; parentId?: string; url?: string }; childFrames?: unknown } | undefined) => {
        for (const child of Array.isArray(node?.childFrames) ? node.childFrames as Array<{ frame?: { id?: string; parentId?: string; url?: string }; childFrames?: unknown }> : []) {
          if (child.frame) candidates.push(child.frame)
          visit(child)
        }
      }
      visit(tree.frameTree)
      const candidate = candidates.find((entry) => entry.id === frame.frameId)
        ?? candidates.find((entry) => entry.id && !siblings.some((other) => other !== frame && other.frameId === entry.id))
      if (candidate?.id) {
        frame.frameId = candidate.id
        frame.parentFrameId = candidate.parentId
        frame.url = sanitizeUrl(candidate.url ?? frame.url)
      }
      if (!frame.frameId) return null
      const parent = frame.parentFrameId ? siblings.find((entry) => entry.frameId === frame.parentFrameId) : undefined
      const parentOffset = parent ? await this.frameViewportOffset(tab, parent, visited) : { x: 0, y: 0 }
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
      if (error instanceof Error && error.message === 'stale_ref') fail('stale_ref', 'Element reference is stale')
      throw error
    }
    if (stored.identity.documentId !== tab.documentId) fail('stale_ref', 'Reference belongs to a previous document')
    const sessionId = stored.cdpSessionId ?? tab.cdpSessionId
    if (sessionId !== tab.cdpSessionId && this.frames.get(sessionId)?.pageSessionId !== tab.cdpSessionId) fail('stale_ref', 'Frame session is detached')
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
    if (!this.chrome || this.closed || this.closing || this.lifecycle === 'closed') fail('session_closed', 'Browser session is closed')
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
