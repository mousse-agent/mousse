import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensureWindowsBrowserSandboxAccess } from '../../shared/browser/windowsSandboxPermissions.mjs'
import {
  BROWSER_MODIFIERS,
  type BrowserActionRequest,
  type BrowserAction,
  type BrowserTarget,
  type BrowserActionResult,
  type BrowserElement,
  type BrowserHumanInput,
  type BrowserHumanInputResult,
  type BrowserLifecycle,
  type BrowserMouseButton,
  type BrowserObservation,
  type BrowserPageDialog,
  type BrowserPictureSpot,
  type BrowserSessionRecord,
  type BrowserTab,
  type BrowserTakeoverEffect,
  type BrowserViewerFrame,
  type BrowserViewerUpdate,
  type BrowserWaitCondition,
  type BrowserWorkerRequest,
  browserTakeoverMessage
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
import { dispatchAction, dispatchHumanInput, navigateHistory, navigateTab, navigationPace, readPageSigns, readSelectedText, type DispatchedHumanInput, type NavigationOptions } from '../action/dispatch'
import { BROWSER_PROBLEM_CODES, browserNoteForPerson, browserProblemMessage, classifyOpenedPage, hostOf, type BrowserNavigation, type BrowserProblem } from '../../shared/browser/navigation'
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
  /**
   * The page the tab shows, renewed only when another page commits (an observation renews
   * `documentId` each time): a person's input on a picture is checked against it.
   */
  page: string
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
/** An observation's warning while its page is still loading (`browser_wait` `document-ready` waits it out). */
export const PAGE_STILL_LOADING = 'page-still-loading'
/** How long a new page or frame is held for its mark before it is let go. A page a site opens without an opener has no renderer yet: it answers only once it runs. */
const MARK_BEFORE_RUN_MS = 1_000
/** How long after that its mark may still take before the page is closed: it never runs on unmarked. */
const MARK_AFTER_RUN_MS = 10_000
/** How long Take over and Give back wait for each page or frame to take its mark, per try (a page with an open dialog never answers). */
const MARK_ANSWER_MS = 2_000

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
  /**
   * The target Chromium paints: the tab last brought to the front (`toFront`) or opened. Kept true:
   * a tab a site opens is sent behind again at once (nobody uses it), and when the front tab closes,
   * the tab in front before it comes back (`frontGone`), rather than the one Chromium would pick.
   */
  private frontTargetId = ''
  /** Tabs in the order they came to the front, the latest last. */
  private frontHistory: string[] = []
  /** The pictures of the tabs people watch (`frame.next`, `frame`), created on the first one asked for. */
  private viewers: ViewerCaptures | null = null
  /** Each tab's title as its page last set it, by target id, for people watching. */
  private readonly viewerTitles = new Map<string, string>()
  /** Tabs whose page is still loading (its main frame started and has not stopped), by CDP session. */
  private readonly loadingTabs = new Set<string>()
  /** What each tab's last navigation ran into, or what its opened page needs, by CDP session: for people watching. */
  private readonly tabProblems = new Map<string, BrowserProblem>()
  /** A tab's page to be read again for what it needs (`recheckPage`), by CDP session. */
  private readonly pageRechecks = new Map<string, ReturnType<typeof setTimeout>>()
  /** How the session's first page went (`start` with a URL): a slow or failed page never fails the session. */
  firstNavigation: BrowserNavigation | undefined
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
  /** Each tab's open dialog (alert, confirm, prompt, leave page), by CDP session: the page waits for its answer. */
  private readonly tabDialogs = new Map<string, BrowserPageDialog>()
  /** Each tab's file picker waiting for the person, by CDP session. */
  private readonly tabChoosers = new Map<string, { mode: 'selectSingle' | 'selectMultiple'; backendNodeId: number }>()
  /** A person's input waiting on a tab that may open a dialog (`untilDialog`), by CDP session. */
  private readonly dialogWaiters = new Map<string, Set<() => void>>()
  /** What the person holds down now, so it is let go of when they leave (`releaseHuman`). */
  private humanPressed: { keys: Map<string, { key: string; code: string; keyCode: number }>; buttons: Set<BrowserMouseButton>; point?: { x: number; y: number }; composing: boolean; tabSessionId?: string } = { keys: new Map(), buttons: new Set(), composing: false }

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
      page: 'doc_' + randomUUID(),
      documentId: 'doc_' + randomUUID(),
      loaderId: '',
      frameId: ''
    }
    await this.enableTab(tab, signal)
    this.throwIfUnavailable(signal)
    this.tabs.set(tabId, tab)
    this.activeTabId = tabId
    // The tab in front closed (by itself, or a site's): the one in front before it comes back.
    this.chrome.cdp.on('Target.targetDestroyed', (params: unknown) => {
      const targetId = (params as { targetId?: string })?.targetId
      if (targetId && !this.closed && !this.closing) this.frontGone(targetId)
    })
    this.chrome.cdp.on('Page.frameNavigated', (params: unknown, sessionId?: string) => {
      if (this.closed || this.closing) return
      const frame = (params as { frame?: { id?: string; parentId?: string; loaderId?: string; url?: string; unreachableUrl?: string } })?.frame
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
      navigated.page = 'doc_' + randomUUID()
      // A file picker of the page before is no longer waiting.
      if (this.tabChoosers.has(navigated.cdpSessionId)) this.pageChooser(navigated.cdpSessionId, undefined)
      // Chromium may send no more screencast pictures once a new page commits: a watched tab's starts again.
      this.viewers?.committed(navigated.cdpSessionId, navigated.url)
      // A person watching sees a page that could not be loaded as such (Chromium's error page has no code to show).
      const unreachable = frame.unreachableUrl ? hostOf(frame.unreachableUrl) : undefined
      const known = this.tabProblems.get(navigated.cdpSessionId)
      // The navigation's own answer (with Chromium's code) may have come first: it stands.
      if (!frame.unreachableUrl || known?.kind !== 'unreachable' || known.host !== unreachable)
        this.tabProblem(navigated.cdpSessionId, frame.unreachableUrl ? { kind: 'unreachable', ...(unreachable ? { host: unreachable } : {}) } : undefined)
      this.refs.invalidateTab(navigated.publicId)
      this.touch()
    })
    // Whether a tab's page is still loading: a page target's main frame has the target's id. A tab opened
    // on a URL starts loading before it is one of the session's tabs, so every page Chromium attached counts.
    const loading = (started: boolean) => (params: unknown, sessionId?: string) => {
      if (this.closed || this.closing || !sessionId) return
      const frameId = (params as { frameId?: string } | undefined)?.frameId
      const page = this.marked.get(sessionId)
      if (!page || page.type !== 'page' || frameId !== page.targetId) return
      if (started) this.loadingTabs.add(sessionId)
      else this.loadingTabs.delete(sessionId)
      this.viewers?.loading(sessionId, started)
    }
    this.chrome.cdp.on('Page.frameStartedLoading', loading(true))
    this.chrome.cdp.on('Page.frameStoppedLoading', loading(false))
    // A page that moved without loading another (a sign-in done in place): what it needs is read again.
    this.chrome.cdp.on('Page.navigatedWithinDocument', (params: unknown, sessionId?: string) => {
      if (this.closed || this.closing || !sessionId) return
      const tab = [...this.tabs.values()].find((entry) => entry.cdpSessionId === sessionId)
      if (tab && (params as { frameId?: string } | undefined)?.frameId === tab.targetId) this.recheckPage(tab)
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
    // A page's dialog (alert, confirm, prompt, leave page) stops it until it is answered: a person watching is shown it.
    this.chrome.cdp.on('Page.javascriptDialogOpening', (params: unknown, sessionId?: string) => {
      if (!sessionId || this.closed || this.closing || ![...this.tabs.values()].some((entry) => entry.cdpSessionId === sessionId)) return
      const opened = params as { type?: string; message?: string; defaultPrompt?: string }
      const type = opened.type === 'confirm' || opened.type === 'prompt' || opened.type === 'beforeunload' ? opened.type : 'alert'
      this.pageDialog(sessionId, { type, message: boundText(String(opened.message ?? ''), 2_000), ...(type === 'prompt' ? { defaultPrompt: boundText(String(opened.defaultPrompt ?? ''), 2_000) } : {}) })
    })
    this.chrome.cdp.on('Page.javascriptDialogClosed', (_params: unknown, sessionId?: string) => {
      if (sessionId && this.tabDialogs.has(sessionId)) this.pageDialog(sessionId, undefined)
    })
    // The page asks for files while a person holds the browser (`interceptChooser`): their view answers it.
    this.chrome.cdp.on('Page.fileChooserOpened', (params: unknown, sessionId?: string) => {
      if (!sessionId || this.closed || this.closing || this.controlOwner !== 'human') return
      const opened = params as { mode?: string; backendNodeId?: number }
      if (typeof opened.backendNodeId !== 'number') return
      this.pageChooser(sessionId, { mode: opened.mode === 'selectMultiple' ? 'selectMultiple' : 'selectSingle', backendNodeId: opened.backendNodeId })
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
        this.loadingTabs.delete(sessionId)
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
        this.loadingTabs.delete(detached.cdpSessionId)
        this.tabProblems.delete(detached.cdpSessionId)
        this.tabDialogs.delete(detached.cdpSessionId)
        this.tabChoosers.delete(detached.cdpSessionId)
        this.viewers?.forget(detached.cdpSessionId)
        this.refs.invalidateTab(detached.publicId)
        this.tabs.delete(detached.publicId)
        if (this.activeTabId === detached.publicId) this.activeTabId = this.tabs.keys().next().value ?? ''
        this.frontGone(detached.targetId)
      }
    })
    if (initialUrl) {
      // A slow or failed first page never fails the session: the caller gets the session and how the page went.
      this.firstNavigation = await this.navigateTabOf(tab, initialUrl, { signal }).catch((error: unknown) => {
        if (isBrowserWorkerError(error) && error.problem) return { url: initialUrl, state: 'failed' as const, problem: error.problem }
        throw error
      })
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
    this.loadingTabs.clear()
    this.tabProblems.clear()
    this.tabDialogs.clear()
    this.tabChoosers.clear()
    for (const timer of this.pageRechecks.values()) clearTimeout(timer)
    this.pageRechecks.clear()
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
  async newTab(url?: string, signal?: AbortSignal): Promise<BrowserTab & { navigation?: BrowserNavigation }> {
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
        page: 'doc_' + randomUUID(),
        documentId: 'doc_' + randomUUID(),
        loaderId: '',
        frameId: ''
      }
      await this.enableTab(tab, opSignal)
      this.throwIfUnavailable(opSignal)
      this.refuseWhileHeld()
      const navigation = url ? await this.loadNewTab(tab, url, opSignal) : undefined
      this.tabs.set(tabId, tab)
      this.activeTabId = tabId
      // It came to the front when it was created (`openPage`), unless another tab was brought forward since.
      this.viewers?.frontChanged()
      this.touch()
      return { id: tabId, title: tab.title, url: tab.url, ...(navigation ? { navigation } : {}) }
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
   * The new tab's first page, followed like any navigation (`navigateTab`): done once it committed
   * and its document is ready, still loading after that, and a failure in its class (the tab is then
   * closed). The blank page it opened on is dropped from its history, so Back in a fresh tab has
   * nowhere to go, as for a tab opened on a URL.
   */
  private async loadNewTab(tab: TabState, url: string, signal: AbortSignal): Promise<BrowserNavigation> {
    const cdp = this.requireChrome().cdp
    const navigation = await this.navigateTabOf(tab, url, { signal })
    if (signal.aborted) this.throwIfUnavailable(signal)
    tab.url = sanitizeUrl(navigation.url)
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
    // A site that has not answered yet has only the blank page in its history: nothing to forget.
    await forgetBlankPage().catch(() => undefined)
    return navigation
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
    this.frontGone(tab.targetId)
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
      warnings: [...new Set([...collected.warnings.filter((warning) => warning !== 'unsupported-oopif' && warning !== 'iframe-observation-limited'), ...childCollections.flatMap((item) => item.warnings), ...(attachedFrames.length ? ['oopif-attached'] : []), ...(childObservationTruncated ? ['frame-observation-truncated'] : []), ...(this.loadingTabs.has(tab.cdpSessionId) ? [PAGE_STILL_LOADING] : [])])],
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
    const startedAt = Date.now()
    let observation = await this.observe(params)
    while (Date.now() < deadline) {
      if (signal?.aborted) fail('cancelled', 'Wait cancelled')
      if (this.matchWait(observation, condition)) return observation
      await new Promise((resolve) => setTimeout(resolve, 100))
      observation = await this.observe(params)
    }
    // A page that never stops loading (a stream, a script that keeps fetching) is still usable.
    if (observation.warnings.includes(PAGE_STILL_LOADING)) {
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      fail('timeout', condition.type === 'document-ready'
        ? `The page is still loading after ${seconds} s. It can be used as it is: carry on with what is there, or wait again if you need what is still coming.`
        : `The condition was not met in ${seconds} s, and the page is still loading. Carry on with what is there, or wait again.`)
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
    // A person took the browser over while its tab came forward: the action never ran.
    if (!humanLease && this.controlOwner === 'human') return this.takenOver(request, false, 'not-applied')
    if (request.generation !== this.generation) fail('stale_generation', 'Action generation is stale')
    const abort = new AbortController()
    const onAbort = () => abort.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) fail('cancelled', 'Action cancelled before dispatch')
      signal.addEventListener('abort', onAbort, { once: true })
    }
    this.inFlight = { requestId: request.requestId, dispatched: false, abort, tabSessionId: tab.cdpSessionId }
    // How far it got, for an agent whose action a person's Take over cuts short.
    let effect: BrowserTakeoverEffect = 'not-applied'
    const pageBefore = tab.page
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
      if (abort.signal.aborted) fail('cancelled', 'Action cancelled before dispatch')
      this.inFlight.dispatched = true
      dispatched = true
      effect = 'unknown'
      this.journal.append({
        at: nowIso(this.clock), profileId: this.profileId, sessionId: this.id, requestId: request.requestId,
        generation: this.generation, phase: 'dispatched', actionType: request.action.type, dispatched: true
      })
      const actionSessionId = target && 'from' in target
        ? target.from.cdpSessionId === target.to.cdpSessionId
          ? target.from.cdpSessionId
          : (fail('unsupported', 'Cross-frame drag is not certified'), tab.cdpSessionId)
        : target?.cdpSessionId ?? tab.cdpSessionId
      this.viewers?.acted(tab.publicId)
      // A navigation is done once its page committed and is ready; later loading is reported, not waited for.
      const ceilingMs = Math.min(request.timeoutMs, navigationPace.ceilingMs())
      let navigation: BrowserNavigation | undefined
      if (request.action.type === 'navigate') navigation = await this.navigateTabOf(tab, request.action.url, { signal: abort.signal, ceilingMs })
      else if (request.action.type === 'reload' || request.action.type === 'back' || request.action.type === 'forward')
        navigation = await this.navigateHistoryOf(tab, request.action.type, { signal: abort.signal, ceilingMs })
      else await dispatchAction(this.requireChrome().cdp, actionSessionId, request.action, target, abort.signal)
      effect = 'applied'
      const downloads = await this.publishCompletedDownloads(request.timeoutMs, abort.signal)
      if (navigation) this.refs.invalidateTab(tab.publicId)
      else this.recheckPage(tab)
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
          code: 'timeout', message: 'Expected state was not observed', ...(navigation ? { navigation } : {})
        }
        this.journal.append({
          at: nowIso(this.clock), profileId: this.profileId, sessionId: this.id, requestId: request.requestId,
          generation: this.generation, phase: 'outcome', actionType: request.action.type, dispatched: true, outcome: 'unverified'
        })
        return result
      }
      // A page that opened but is nothing but a check or a wall (or that the site refused): the action failed, the tab shows it.
      const failedPage = navigation?.state === 'failed' && navigation.problem ? navigation.problem : undefined
      const result: BrowserActionResult = {
        requestId: request.requestId, outcome: failedPage ? 'failed' : 'verified', dispatched: true, observation,
        artifactIds: [...(observation.screenshot ? [observation.screenshot.artifactId] : []), ...downloads.map((item) => item.artifactId)],
        ...(downloads.length ? { artifacts: downloads } : {}),
        ...(failedPage ? { code: BROWSER_PROBLEM_CODES[failedPage.kind], message: browserProblemMessage(failedPage) } : {}),
        ...(navigation ? { navigation } : {})
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
      // A person took the browser over meanwhile: the agent is told so, and whether its action took
      // effect (a navigation whose page committed did), so it does not blindly do it again.
      if (!humanLease && abort.signal.reason === 'human_controlled') {
        const navigates = ['navigate', 'reload', 'back', 'forward'].includes(request.action.type)
        return this.takenOver(request, dispatched, effect === 'unknown' && navigates && tab.page !== pageBefore ? 'applied' : effect)
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

  /** An agent's action a person's Take over cut short (or kept from running): blocked, with whether it took effect. */
  private takenOver(request: BrowserActionRequest, dispatched: boolean, takeover: BrowserTakeoverEffect): BrowserActionResult {
    this.journal.append({
      at: nowIso(this.clock), profileId: this.profileId, sessionId: this.id, requestId: request.requestId,
      generation: this.generation, phase: 'outcome', actionType: request.action.type, dispatched, outcome: 'blocked'
    })
    return { requestId: request.requestId, outcome: 'blocked', dispatched, takeover, code: 'human_controlled', message: browserTakeoverMessage(takeover), artifactIds: [] }
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
    if (this.frontTargetId === tab.targetId) return
    await this.requireChrome().cdp.send('Target.activateTarget', { targetId: tab.targetId }, { timeoutMs: 5_000 })
    this.setFront(tab.targetId)
  }

  /** Chromium paints `targetId` now. */
  private setFront(targetId: string): void {
    this.frontTargetId = targetId
    this.frontHistory = [...this.frontHistory.filter((entry) => entry !== targetId), targetId].slice(-64)
    this.viewers?.frontChanged()
  }

  /** A tab a site opened may have taken the front: the tab in front before is brought back. */
  private async keepFront(): Promise<void> {
    const front = this.frontTargetId
    if (!front || this.closed || this.closing) return
    await this.chrome?.cdp.send('Target.activateTarget', { targetId: front }, { timeoutMs: 5_000 }).catch(() => undefined)
  }

  /**
   * A target closed. When it was the one in front, Chromium puts another in front by its own rule
   * (the tab next to it); the session's tab most recently in front is brought there instead, so
   * which tab is in front is always known.
   */
  private frontGone(targetId: string): void {
    this.frontHistory = this.frontHistory.filter((entry) => entry !== targetId)
    if (targetId !== this.frontTargetId) return
    const open = new Set([...this.tabs.values()].map((tab) => tab.targetId))
    const next = [...this.frontHistory].reverse().find((entry) => open.has(entry)) ?? [...open].at(-1)
    if (!next) {
      this.frontTargetId = ''
      this.viewers?.frontChanged()
      return
    }
    this.setFront(next)
    void this.chrome?.cdp.send('Target.activateTarget', { targetId: next }, { timeoutMs: 5_000 }).catch(() => undefined)
  }

  /** Whether a tab is not the one in front, so Chromium does not paint it. */
  private behind(cdpSessionId: string): boolean {
    const tab = [...this.tabs.values()].find((entry) => entry.cdpSessionId === cdpSessionId)
    return Boolean(tab && this.frontTargetId && tab.targetId !== this.frontTargetId)
  }

  private viewerCaptures(): ViewerCaptures {
    this.viewers ??= new ViewerCaptures(this.requireChrome().cdp, {
      behind: (cdpSessionId) => this.behind(cdpSessionId),
      loading: (cdpSessionId) => this.loadingTabs.has(cdpSessionId),
      problem: (cdpSessionId) => this.tabProblems.get(cdpSessionId),
      document: (cdpSessionId) => [...this.tabs.values()].find((entry) => entry.cdpSessionId === cdpSessionId)?.page,
      dialog: (cdpSessionId) => this.tabDialogs.get(cdpSessionId),
      chooser: (cdpSessionId) => {
        const chooser = this.tabChoosers.get(cdpSessionId)
        return chooser ? { multiple: chooser.mode === 'selectMultiple' } : undefined
      },
      now: () => this.clock().getTime()
    })
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
    if (painted) return { ...picture, data: painted.data, width: painted.width, height: painted.height, capturedAt: new Date(painted.at).toISOString(), ...(painted.spot ? { spot: painted.spot } : {}) }
    const metrics = await cdp.send<{ cssVisualViewport?: { pageX?: number; pageY?: number } }>('Page.getLayoutMetrics', {}, { sessionId: tab.cdpSessionId, timeoutMs: 5_000 })
    const scale = Math.min(1, maxWidth / viewport.width, SCREENCAST_MAX_HEIGHT / viewport.height)
    // The clip is in page coordinates: the visible viewport starts at the scroll offset.
    const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', {
      format: 'jpeg', quality: 60, fromSurface: true, captureBeyondViewport: false,
      clip: { x: metrics.cssVisualViewport?.pageX ?? 0, y: metrics.cssVisualViewport?.pageY ?? 0, width: viewport.width, height: viewport.height, scale }
    }, { sessionId: tab.cdpSessionId, timeoutMs: 10_000 })
    const spot = { documentId: tab.page, scrollX: metrics.cssVisualViewport?.pageX ?? 0, scrollY: metrics.cssVisualViewport?.pageY ?? 0 }
    const taken = { data: shot.data, width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale), at: this.clock().getTime(), sharp: false, spot }
    viewers.keep(tab.cdpSessionId, taken)
    return { ...picture, data: taken.data, width: taken.width, height: taken.height, capturedAt: nowIso(this.clock), spot }
  }

  /**
   * A person's input while they hold the session (`control.take` as human): trusted input on the tab.
   * One input (`input`, answered as before) or several in order (`inputs`, each answered on its own in
   * `results`). An input made on a picture (`spot`: its document and scroll) lands on what the person
   * saw: on another document it is refused (`page_changed`); scrolled since, its point moves by the
   * scroll, and is refused when that takes it out of view. While the page shows a dialog, only an
   * answer to it is taken (the page takes no other input until then).
   */
  async humanInput(params: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: true; navigation?: BrowserNavigation; results?: BrowserHumanInputResult[] }> {
    if (this.lifecycle !== 'human-controlled') fail('human_controlled', 'A human control lease is not active')
    if (params.controlLeaseId !== this.controlLeaseId) fail('human_controlled', 'Control lease was replaced')
    const tab = this.requireTab(typeof params.tabId === 'string' ? params.tabId : this.activeTabId)
    const batch = Array.isArray(params.inputs)
    const entries = (batch ? params.inputs as unknown[] : [{ input: params.input }]).slice(0, 64).map((entry) => {
      const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
      return { input: validateBrowserHumanInput(record.input), spot: pictureSpot(record.spot) }
    })
    // What the person's input changes reaches the view at once, even a picture the page showed before.
    this.viewers?.acted(tab.publicId)
    // A tab in the back takes no input in a browser without a window (the event never completes): it comes forward first.
    await this.toFront(tab)
    const results: BrowserHumanInputResult[] = []
    for (const entry of entries) results.push(await this.humanInputOne(tab, entry.input, entry.spot, signal))
    // What the person did may change the page under any ref the agent holds, and what it needs of them.
    this.refs.invalidateTab(tab.publicId)
    if (!results.some((result) => result.applied && result.navigation)) this.recheckPage(tab)
    this.touch()
    if (batch) return { ok: true, results }
    const only = results[0]!
    // One input refused: an error, as before.
    if (!only.applied) fail(only.code === 'page_changed' ? 'stale_observation' : 'not_actionable', only.message)
    return { ok: true, ...(only.navigation ? { navigation: only.navigation } : {}) }
  }

  private async humanInputOne(tab: TabState, input: BrowserHumanInput, spot: BrowserPictureSpot | undefined, signal?: AbortSignal): Promise<BrowserHumanInputResult> {
    const cdp = this.requireChrome().cdp
    const pressed = this.humanPressed
    const dialog = this.tabDialogs.get(tab.cdpSessionId)
    if (input.kind === 'dialog') {
      if (!dialog) return { applied: false, code: 'dialog_open', message: 'The page has no dialog open' }
      await cdp.send('Page.handleJavaScriptDialog', { accept: input.accept, ...(input.text !== undefined && dialog.type === 'prompt' ? { promptText: input.text } : {}) }, { sessionId: tab.cdpSessionId, signal, timeoutMs: 5_000 })
      this.pageDialog(tab.cdpSessionId, undefined)
      return { applied: true }
    }
    // The page waits for its dialog and takes nothing else meanwhile (an event sent now would never complete).
    if (dialog && input.kind !== 'release') return { applied: false, code: 'dialog_open', message: 'Answer the page\'s dialog first' }
    switch (input.kind) {
      case 'navigate':
      case 'back':
      case 'forward':
      case 'reload': {
        // The person's own navigation answers once the page has committed: their view shows it loading from there.
        // A page that asks first (leave this page?) waits for the person's answer: the navigation is under way.
        const navigation = await this.untilDialog(tab, input.kind === 'navigate'
          ? this.navigateTabOf(tab, input.url, { signal, untilCommit: true })
          : this.navigateHistoryOf(tab, input.kind, { signal, untilCommit: true }))
        if (!navigation) return { applied: true }
        // The page it committed, known now (Chromium's commit event may come a moment after the answer).
        if (navigation.state !== 'failed') tab.url = sanitizeUrl(navigation.url)
        return { applied: true, navigation }
      }
      case 'release':
        await this.releaseHuman(tab)
        return { applied: true }
      case 'files': {
        const chooser = this.tabChoosers.get(tab.cdpSessionId)
        if (!chooser) return { applied: false, code: 'no_chooser', message: 'The page is not asking for a file now' }
        this.pageChooser(tab.cdpSessionId, undefined)
        // None chosen: the picker was cancelled, and the page keeps what it had.
        if (!input.paths.length) return { applied: true }
        if (input.paths.length > 1 && chooser.mode !== 'selectMultiple') return { applied: false, code: 'too_large', message: 'The page takes one file here' }
        await cdp.send('DOM.setFileInputFiles', { files: input.paths, backendNodeId: chooser.backendNodeId }, { sessionId: tab.cdpSessionId, signal, timeoutMs: 10_000 })
        return { applied: true }
      }
      case 'copy': {
        const frameId = tab.frameId || (await cdp.send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree', {}, { sessionId: tab.cdpSessionId, signal, timeoutMs: 5_000 })).frameTree?.frame?.id
        const copied = frameId ? await readSelectedText(cdp, tab.cdpSessionId, frameId, signal) : ''
        // The page's own copy or cut runs too (a page may listen for it); cut removes the selection.
        const primary = process.platform === 'darwin' ? BROWSER_MODIFIERS.meta : BROWSER_MODIFIERS.ctrl
        const key = input.cut ? { key: 'x', code: 'KeyX', keyCode: 88 } : { key: 'c', code: 'KeyC', keyCode: 67 }
        await this.untilDialog(tab, (async () => {
          await dispatchHumanInput(cdp, tab.cdpSessionId, { kind: 'keys', type: 'down', ...key, modifiers: primary, command: input.cut ? 'cut' : 'copy' }, signal)
          await dispatchHumanInput(cdp, tab.cdpSessionId, { kind: 'keys', type: 'up', ...key, modifiers: primary }, signal)
        })())
        return { applied: true, copied }
      }
      default:
        break
    }
    let sent: DispatchedHumanInput = input
    let shifted: { x: number; y: number } | undefined
    const located = 'x' in input && 'y' in input
    if (located && spot) {
      const fenced = await this.fencePoint(tab, input, spot, signal)
      if (!fenced.ok) {
        // A button or key the person holds is still let go of where it is: nothing is left pressed.
        if (!(input.kind === 'pointer' && input.type === 'up' && pressed.buttons.has(input.button as BrowserMouseButton))) return { applied: false, code: 'page_changed', message: fenced.message }
        const last = pressed.point ?? { x: input.x, y: input.y }
        sent = { ...input, x: last.x, y: last.y }
      } else if (fenced.dx || fenced.dy) {
        shifted = { x: fenced.dx, y: fenced.dy }
        sent = { ...input, x: input.x + fenced.dx, y: input.y + fenced.dy } as DispatchedHumanInput
      }
    }
    // An input that opens a dialog (a click on a button that alerts) is done once the dialog is open:
    // the page waits for its answer, which comes next.
    await this.untilDialog(tab, dispatchHumanInput(cdp, tab.cdpSessionId, sent, signal))
    this.notePressed(tab, sent)
    return { applied: true, ...(shifted ? { shifted } : {}) }
  }

  /**
   * Waits for input the page takes, or until the page opens a dialog because of it: the page then
   * stops until the dialog is answered, so the input is under way (Chromium answers it after), and
   * the answer must not wait behind it. Undefined when a dialog opened.
   */
  private async untilDialog<T>(tab: TabState, work: Promise<T>): Promise<T | undefined> {
    const sessionId = tab.cdpSessionId
    let wake!: () => void
    const opened = new Promise<typeof DIALOG_OPENED>((resolve) => { wake = () => resolve(DIALOG_OPENED) })
    const waiting = this.dialogWaiters.get(sessionId) ?? new Set<() => void>()
    waiting.add(wake)
    this.dialogWaiters.set(sessionId, waiting)
    try {
      const done = await Promise.race([work, opened])
      if (done !== DIALOG_OPENED) return done as T
      void work.catch(() => undefined)
      return undefined
    } finally {
      waiting.delete(wake)
      if (!waiting.size) this.dialogWaiters.delete(sessionId)
    }
  }

  /**
   * Checks a point the person picked on a picture against the page as it is now: the same document,
   * and how far it has scrolled since (the point moves with it, so it lands on what they saw).
   */
  private async fencePoint(tab: TabState, input: { x: number; y: number }, spot: BrowserPictureSpot, signal?: AbortSignal): Promise<{ ok: true; dx: number; dy: number } | { ok: false; message: string }> {
    if (spot.documentId !== tab.page) return { ok: false, message: 'The page changed since that picture' }
    const metrics = await this.requireChrome().cdp.send<{ cssVisualViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number } }>('Page.getLayoutMetrics', {}, { sessionId: tab.cdpSessionId, signal, timeoutMs: 5_000 })
    const visual = metrics.cssVisualViewport ?? {}
    const dx = Math.round((spot.scrollX - (visual.pageX ?? 0)) * 100) / 100
    const dy = Math.round((spot.scrollY - (visual.pageY ?? 0)) * 100) / 100
    if (!dx && !dy) return { ok: true, dx: 0, dy: 0 }
    const x = input.x + dx
    const y = input.y + dy
    if (x < 0 || y < 0 || x > (visual.clientWidth ?? Number.POSITIVE_INFINITY) || y > (visual.clientHeight ?? Number.POSITIVE_INFINITY)) {
      return { ok: false, message: 'What that picture showed there has scrolled out of view' }
    }
    return { ok: true, dx, dy }
  }

  /** Keeps what the person holds down (keys, buttons, a composition), so it is let go of when they leave. */
  private notePressed(tab: TabState, input: DispatchedHumanInput): void {
    const pressed = this.humanPressed
    pressed.tabSessionId = tab.cdpSessionId
    if (input.kind === 'pointer') {
      pressed.point = { x: input.x, y: input.y }
      if (input.type === 'down' && input.button !== 'none') pressed.buttons.add(input.button)
      if (input.type === 'up' && input.button !== 'none') pressed.buttons.delete(input.button)
    } else if (input.kind === 'keys') {
      if (input.type === 'down') pressed.keys.set(input.code || input.key, { key: input.key, code: input.code, keyCode: input.keyCode })
      else pressed.keys.delete(input.code || input.key)
    } else if (input.kind === 'compose') pressed.composing = input.text.length > 0
    else if (input.kind === 'type' || input.kind === 'paste') pressed.composing = false
  }

  /**
   * Lets go of everything the person left down: each key goes up, each button is released where the
   * pointer was, and a composition under way is dropped. Bounded: a page that does not answer (a
   * dialog) does not hold the browser up.
   */
  private async releaseHuman(tab?: TabState): Promise<void> {
    const pressed = this.humanPressed
    this.humanPressed = { keys: new Map(), buttons: new Set(), composing: false }
    const sessionId = tab?.cdpSessionId ?? pressed.tabSessionId
    const cdp = this.chrome?.cdp
    if (!sessionId || !cdp || this.tabDialogs.has(sessionId)) return
    if (!pressed.keys.size && !pressed.buttons.size && !pressed.composing) return
    const send = (method: string, params: Record<string, unknown>) => cdp.send(method, params, { sessionId, timeoutMs: MARK_ANSWER_MS }).catch(() => undefined)
    for (const key of pressed.keys.values()) await send('Input.dispatchKeyEvent', { type: 'keyUp', key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode })
    const at = pressed.point ?? { x: 0, y: 0 }
    for (const button of pressed.buttons) await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button, buttons: 0, clickCount: 1 })
    if (pressed.composing) await send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  }

  /** The page opened a dialog, or it was answered: kept per tab, for the person watching. */
  private pageDialog(cdpSessionId: string, dialog: BrowserPageDialog | undefined): void {
    if (dialog) this.tabDialogs.set(cdpSessionId, dialog)
    else this.tabDialogs.delete(cdpSessionId)
    this.viewers?.dialog(cdpSessionId, dialog)
    if (dialog) for (const wake of [...this.dialogWaiters.get(cdpSessionId) ?? []]) wake()
  }

  /** The page asks for files (while a person holds the browser), or was answered. */
  private pageChooser(cdpSessionId: string, chooser: { mode: 'selectSingle' | 'selectMultiple'; backendNodeId: number } | undefined): void {
    if (chooser) this.tabChoosers.set(cdpSessionId, chooser)
    else this.tabChoosers.delete(cdpSessionId)
    this.viewers?.chooser(cdpSessionId, chooser ? { multiple: chooser.mode === 'selectMultiple' } : undefined)
  }

  /**
   * While a person holds the browser, the tab they took answers its file picker through their view
   * (`Page.fileChooserOpened`); otherwise a picker opens nothing, as a browser without a window has
   * none to show.
   */
  private async interceptChooser(tab: TabState | undefined, enabled: boolean): Promise<void> {
    const cdp = this.chrome?.cdp
    if (!cdp) return
    const tabs = tab ? [tab] : [...this.tabs.values()]
    for (const entry of tabs) {
      if (!enabled) this.pageChooser(entry.cdpSessionId, undefined)
      await cdp.send('Page.setInterceptFileChooserDialog', { enabled }, { sessionId: entry.cdpSessionId, timeoutMs: MARK_ANSWER_MS }).catch(() => undefined)
    }
  }

  /**
   * Navigates a tab (`navigateTab`): its pace and the page's signs for every caller, and its outcome
   * for anyone watching (a problem it ran into, or what an opened page needs).
   */
  private async navigateTabOf(tab: TabState, url: string, options: NavigationOptions): Promise<BrowserNavigation> {
    return this.watchNavigation(tab, navigateTab(this.requireChrome().cdp, tab.cdpSessionId, url, this.navigationOptions(tab, options)))
  }

  private async navigateHistoryOf(tab: TabState, kind: 'back' | 'forward' | 'reload', options: NavigationOptions): Promise<BrowserNavigation> {
    return this.watchNavigation(tab, navigateHistory(this.requireChrome().cdp, tab.cdpSessionId, kind, tab.url, this.navigationOptions(tab, options)))
  }

  private navigationOptions(tab: TabState, options: NavigationOptions): NavigationOptions {
    const cdp = this.requireChrome().cdp
    return { ...options, ...(options.untilCommit ? {} : { signs: (frameId: string) => readPageSigns(cdp, tab.cdpSessionId, frameId) }) }
  }

  private async watchNavigation(tab: TabState, navigation: Promise<BrowserNavigation>): Promise<BrowserNavigation> {
    try {
      const outcome = await navigation
      // A person watching is told of a failure, or of a sign-in or check on the page that is theirs to do.
      this.tabProblem(tab.cdpSessionId, outcome.problem ?? browserNoteForPerson(outcome.notes, hostOf(outcome.url)))
      return outcome
    } catch (error) {
      if (isBrowserWorkerError(error) && error.problem) this.tabProblem(tab.cdpSessionId, error.problem)
      throw error
    }
  }

  /**
   * What a tab's page needs from a person follows the page as it is now: after the person's or the
   * agent's input, or a same-page navigation, a tab told it needs a sign-in or a check is read again
   * (the person signed in by typing and clicking, say), a moment after.
   */
  private recheckPage(tab: TabState, delayMs = 700): void {
    if (this.tabProblems.get(tab.cdpSessionId)?.kind !== 'needs-you') return
    const pending = this.pageRechecks.get(tab.cdpSessionId)
    if (pending) clearTimeout(pending)
    const timer = setTimeout(() => {
      this.pageRechecks.delete(tab.cdpSessionId)
      if (this.closed || this.closing || !this.tabs.has(tab.publicId) || this.tabProblems.get(tab.cdpSessionId)?.kind !== 'needs-you') return
      void (async () => {
        const cdp = this.requireChrome().cdp
        const frameId = tab.frameId || (await cdp.send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree', {}, { sessionId: tab.cdpSessionId, timeoutMs: 5_000 })).frameTree?.frame?.id
        if (!frameId) return
        const signs = await readPageSigns(cdp, tab.cdpSessionId, frameId)
        if (!signs || this.tabProblems.get(tab.cdpSessionId)?.kind !== 'needs-you') return
        const opened = classifyOpenedPage({ ...signs, url: signs.url ?? tab.url })
        this.tabProblem(tab.cdpSessionId, opened.problem ?? browserNoteForPerson(opened.notes, hostOf(signs.url ?? tab.url)))
      })().catch(() => undefined)
    }, delayMs)
    timer.unref?.()
    this.pageRechecks.set(tab.cdpSessionId, timer)
  }

  /** Keeps what a tab's navigation ran into (with Chromium's code when it is known), for people watching. */
  private tabProblem(cdpSessionId: string, problem: BrowserProblem | undefined): void {
    if (problem) this.tabProblems.set(cdpSessionId, problem)
    else this.tabProblems.delete(cdpSessionId)
    this.viewers?.problem(cdpSessionId, problem)
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
        // Given back: what the person left down is let go of first, while the page is still theirs.
        const leaving = owner === 'agent' && this.controlOwner === 'human'
        const released = leaving ? this.releaseHuman().then(() => this.interceptChooser(undefined, false)) : Promise.resolve()
        return released.then(() => {
          const taken = this.takeControl(owner)
          // The tab a person takes comes to the front: Chromium paints only that one, so they see what they do.
          const held = owner === 'human' && typeof params.tabId === 'string' ? this.tabs.get(params.tabId) : undefined
          return this.afterControlMoved(loadingForAgent)
            .then(() => held && this.tabs.has(held.publicId) ? this.toFront(held).catch(() => undefined) : undefined)
            // Its file picker is answered in the person's view (`chooser`), when that view can.
            .then(() => held && params.chooser === true ? this.interceptChooser(held, true) : undefined)
            .then(() => taken)
        })
      }
      case 'control.release':
        return this.releaseHuman().then(() => this.interceptChooser(undefined, false)).then(() => {
          this.releaseControl(requiredId(params.controlLeaseId))
          return this.afterControlMoved().then(() => ({ ok: true, lifecycle: this.lifecycle }))
        })
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
    const record = params as { sessionId?: string; waitingForDebugger?: boolean; targetInfo?: { type?: string; targetId?: string; parentFrameId?: string; url?: string; openerId?: string } }
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
    // A tab a site opened (a link to a new tab, `window.open`) may take the front: nobody uses it, so
    // the tab in front before goes back there, and the agent, the person and the view stay on it.
    if (type === 'page' && info.openerId) void this.keepFront()
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
    // Chromium puts a new tab in front.
    this.setFront(targetId)
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
        // Ready once the page has finished loading (an agent told it is still loading waits with this).
        return !observation.warnings.includes(PAGE_STILL_LOADING)
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

/** What `untilDialog` races the input against. */
const DIALOG_OPENED = Symbol('dialog opened')

/** The document and scroll of the picture a person acted on, when the daemon sent them. */
function pictureSpot(value: unknown): BrowserPictureSpot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const spot = value as Record<string, unknown>
  const finite = (entry: unknown) => typeof entry === 'number' && Number.isFinite(entry) && Math.abs(entry) <= 10_000_000
  if (typeof spot.documentId !== 'string' || !/^doc_[A-Za-z0-9-]{1,64}$/.test(spot.documentId) || !finite(spot.scrollX) || !finite(spot.scrollY)) return undefined
  return { documentId: spot.documentId, scrollX: spot.scrollX as number, scrollY: spot.scrollY as number }
}

export function mapImagePoint(observation: BrowserObservation, point: { x: number; y: number }): { x: number; y: number } {
  if (!observation.screenshot) fail('invalid_geometry', 'Coordinate action requires a screenshot observation')
  return imagePointToViewport(point, observation.screenshot, observation.viewport)
}
