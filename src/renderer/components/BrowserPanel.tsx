import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BrowserTab,
  Check,
  Clean,
  Code2,
  Cookie,
  Crosshair,
  Minus,
  MoreVertical,
  Plus,
  RefreshCw,
  Smartphone
} from '../lib/icons'
import { isTurnActivePhase, type BrowserElementAttachment, type BrowserTabState } from '../../shared/types'
import type { BrowserAccessState } from '../../shared/browser/access'
import type { InAppBrowserActivity, InAppBrowserState } from '../../shared/browser/inApp'
import type { BrowserAgentCursor } from '../../shared/browser/agentCursor'
import { AgentCursor } from './browser/AgentCursor'
import { ThreadBrowserLayer, ThreadBrowserRow } from './browser/ThreadBrowserView'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { browserTabsOpenedThisSession, useAppStore } from '../stores/appStore'
import { MousseLogoOutline } from './MousseLogoOutline'
import { KeepMounted, KeepMountedStack } from './KeepMounted'
import { NO_LOADED_BROWSER_TABS, nextLoadedBrowserTabs, type LoadedBrowserTabs } from '../lib/loadedBrowserTabs'
import {
  BrowserActivityIndicator,
  BrowserDeviceToolbar,
  BrowserNotice,
  BrowserStartPage,
  ClearCookiesDialog,
  DEVICE_PRESETS,
  browserTabActivity,
  type BrowserNoticeState
} from './browser/BrowserToolbarParts'
import { BrowserLoadErrorPage } from './browser/BrowserLoadErrorPage'
import { isPageLoadRejection, isShownLoadFailure, type BrowserLoadFailure } from './browser/browserLoadError'

const BLANK_URL = 'about:blank'

/** The person used a tab outside its page (toolbar, address bar, picker, the agent's shield): main keeps it theirs. */
function reportBrowserActivity(activity: InAppBrowserActivity): void {
  const pending = window.mousse?.inAppBrowser?.reportActivity?.(activity)
  // A tab not registered yet has no agent to give way.
  void pending?.catch(() => {})
}

/** How long a success notice stays under the toolbar. Errors stay until dismissed or replaced. */
const DONE_NOTICE_MS = 4000
function browserErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return typeof error === 'string' ? error : 'Browser request failed. Please try again.'
}
// Electron types this as boolean, but React drops boolean attributes on webview.
// A literal string emits the native attribute and preserves popup navigation.
const ALLOW_POPUPS_ATTRIBUTE = 'true' as unknown as boolean

/** Treat bare host input as a navigable URL (not a search query). */
function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return BLANK_URL
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/\s/.test(trimmed)) {
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
  }

  // localhost / 127.0.0.1 / bare host:port — local dev; prefer http
  if (
    /^localhost(?::\d+)?(?:[/?#].*)?$/i.test(trimmed) ||
    /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#].*)?$/.test(trimmed) ||
    (/^[\w-]+(?::\d+)(?:[/?#].*)?$/i.test(trimmed) && !trimmed.includes('.'))
  ) {
    return `http://${trimmed}`
  }

  // domain.tld, subdomain.example.com, optionally with port/path
  if (/^[\w-]+(?:\.[\w-]+)+(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)) {
    return `https://${trimmed}`
  }

  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

/**
 * Point-and-click element picker injected into the guest page.
 * Uses a full-viewport shield so page handlers cannot steal the click,
 * then samples elementsFromPoint under the cursor for highlighting/selection.
 */
const PICK_ELEMENT_SCRIPT = `(() => new Promise((resolve) => {
  window.__mousseCancelElementPicker?.();
  const prevCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = 'crosshair';

  const shield = document.createElement('div');
  shield.setAttribute('data-mousse-element-picker', 'shield');
  Object.assign(shield.style, {
    position: 'fixed', inset: '0', zIndex: '2147483646',
    cursor: 'crosshair', background: 'transparent'
  });

  const overlay = document.createElement('div');
  overlay.setAttribute('data-mousse-element-picker', 'highlight');
  Object.assign(overlay.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: '2147483647',
    border: '2px solid #8b5cf6', background: 'rgba(139,92,246,.12)',
    boxSizing: 'border-box', display: 'none'
  });

  document.documentElement.appendChild(shield);
  document.documentElement.appendChild(overlay);

  let target = null;
  const isPickerNode = (el) =>
    el === shield || el === overlay ||
    (el && el.getAttribute && el.getAttribute('data-mousse-element-picker') != null);

  const selectorFor = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      const classes = [...node.classList].filter(Boolean).slice(0, 2);
      if (classes.length) part += '.' + classes.map((value) => CSS.escape(value)).join('.');
      if (node.parentElement) {
        const peers = [...node.parentElement.children].filter((peer) => peer.tagName === node.tagName);
        if (peers.length > 1) part += ':nth-of-type(' + (peers.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (parts.length >= 5) break;
    }
    return parts.join(' > ');
  };

  const elementUnder = (x, y) => {
    shield.style.pointerEvents = 'none';
    overlay.style.pointerEvents = 'none';
    const stack = document.elementsFromPoint(x, y) || [];
    shield.style.pointerEvents = 'auto';
    const el = stack.find((node) => node && !isPickerNode(node) && node !== document.documentElement && node !== document.body);
    return el || null;
  };

  const cleanup = (result) => {
    document.documentElement.style.cursor = prevCursor;
    shield.removeEventListener('mousemove', move, true);
    shield.removeEventListener('mousedown', block, true);
    shield.removeEventListener('mouseup', block, true);
    shield.removeEventListener('click', click, true);
    shield.removeEventListener('auxclick', block, true);
    shield.removeEventListener('contextmenu', block, true);
    document.removeEventListener('keydown', key, true);
    shield.remove();
    overlay.remove();
    delete window.__mousseCancelElementPicker;
    resolve(result);
  };

  const move = (event) => {
    const el = elementUnder(event.clientX, event.clientY);
    if (!el) {
      overlay.style.display = 'none';
      target = null;
      return;
    }
    target = el;
    const rect = el.getBoundingClientRect();
    Object.assign(overlay.style, {
      display: 'block',
      left: rect.left + 'px',
      top: rect.top + 'px',
      width: Math.max(0, rect.width) + 'px',
      height: Math.max(0, rect.height) + 'px'
    });
  };

  const block = (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const click = (event) => {
    block(event);
    const el = target || elementUnder(event.clientX, event.clientY);
    if (!el) {
      cleanup(null);
      return;
    }
    cleanup({
      url: location.href,
      tagName: el.tagName.toLowerCase(),
      selector: selectorFor(el),
      text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 500),
      ariaLabel: el.getAttribute('aria-label') || undefined,
      role: el.getAttribute('role') || undefined,
      outerHTML: (el.outerHTML || '').slice(0, 1500)
    });
  };

  const key = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cleanup(null);
    }
  };

  window.__mousseCancelElementPicker = () => cleanup(null);
  shield.addEventListener('mousemove', move, true);
  shield.addEventListener('mousedown', block, true);
  shield.addEventListener('mouseup', block, true);
  shield.addEventListener('click', click, true);
  shield.addEventListener('auxclick', block, true);
  shield.addEventListener('contextmenu', block, true);
  document.addEventListener('keydown', key, true);
}))()`

/** Electron <webview> throws if guest methods run before attach + dom-ready. */
function withWebview<T>(webview: HTMLWebViewElement | null | undefined, fn: (wv: HTMLWebViewElement) => T, fallback: T): T {
  if (!webview) return fallback
  try {
    return fn(webview)
  } catch {
    return fallback
  }
}

function isWebviewGuestReady(webview: HTMLWebViewElement): boolean {
  try {
    void webview.getURL()
    return true
  } catch {
    return false
  }
}

interface WebviewNavState {
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
}

interface BrowserWebviewProps {
  tab: BrowserTabState
  profileId: string
  active: boolean
  /** An agent session drives this tab: its page keeps drawing while hidden, for the agent's screenshots. */
  agentBound: boolean
  /** One of the agent's steps is changing the page now: a shield takes the person's first touch and stops it. */
  agentBusy: boolean
  /** Where the agent acts in this tab: drawn over the page, never in it. */
  agentCursor?: BrowserAgentCursor
  onReady: (id: string, webview: HTMLWebViewElement | null) => void
  onState: (id: string, patch: Partial<BrowserTabState>) => void
  onNavState: (id: string, nav: WebviewNavState) => void
  /** The page started or stopped playing audio or video. */
  onMedia: (id: string, playing: boolean) => void
}

function BrowserWebview({ tab, profileId, active, agentBound, agentBusy, agentCursor, onReady, onState, onNavState, onMedia }: BrowserWebviewProps) {
  const ref = useRef<HTMLWebViewElement>(null)
  // src is the mount URL. Observed URLs (including redirects) must never be
  // written back to src: doing so starts a second, competing guest navigation.
  const initialUrl = useRef(tab.url)
  const readyRef = useRef(false)
  const zoomRef = useRef(tab.zoomFactor)
  // Keep host callbacks stable so re-renders do not tear down guest listeners.
  const onReadyRef = useRef(onReady)
  const onStateRef = useRef(onState)
  const onNavStateRef = useRef(onNavState)
  const onMediaRef = useRef(onMedia)
  // The page the tab couldn't open, shown over the guest's blank error document until a page commits.
  const [failure, setFailure] = useState<BrowserLoadFailure | null>(null)
  const [pageLoading, setPageLoading] = useState(false)
  zoomRef.current = tab.zoomFactor
  onReadyRef.current = onReady
  onStateRef.current = onState
  onNavStateRef.current = onNavState
  onMediaRef.current = onMedia

  useEffect(() => {
    const webview = ref.current
    if (!webview) return

    readyRef.current = false

    const readNav = (): WebviewNavState =>
      withWebview(
        webview,
        (wv) => ({
          canGoBack: wv.canGoBack(),
          canGoForward: wv.canGoForward(),
          isLoading: wv.isLoading()
        }),
        { canGoBack: false, canGoForward: false, isLoading: false }
      )

    const update = () => {
      if (!readyRef.current) return
      const url = withWebview(webview, (wv) => wv.getURL() || BLANK_URL, BLANK_URL)
      const title = withWebview(
        webview,
        (wv) => wv.getTitle() || (url === BLANK_URL ? 'New tab' : url),
        url === BLANK_URL ? 'New tab' : url
      )
      onStateRef.current(tab.id, { url, title })
      onNavStateRef.current(tab.id, readNav())
    }

    const onDomReady = () => {
      readyRef.current = true
      withWebview(webview, (wv) => {
        wv.setZoomFactor(zoomRef.current)
      }, undefined)
      onReadyRef.current(tab.id, webview)
      update()
    }

    const onStartLoading = () => {
      setPageLoading(true)
      onNavStateRef.current(tab.id, { ...readNav(), isLoading: true })
    }
    const onStopLoading = () => {
      setPageLoading(false)
      update()
      onNavStateRef.current(tab.id, { ...readNav(), isLoading: false })
    }

    const onMediaStarted = () => onMediaRef.current(tab.id, true)
    const onMediaPaused = () => onMediaRef.current(tab.id, false)
    // A new page in the tab has stopped whatever the last one played.
    // did-navigate fires only for a page that committed, never for Chromium's error document.
    const onNavigate = () => { setFailure(null); onMediaPaused(); update() }
    const onFailLoad = (domEvent: Event) => {
      const event = domEvent as Electron.DidFailLoadEvent
      if (!isShownLoadFailure(event.errorCode, event.isMainFrame)) return
      setFailure({ url: event.validatedURL, errorCode: event.errorCode, errorDescription: event.errorDescription })
    }

    webview.addEventListener('dom-ready', onDomReady)
    webview.addEventListener('did-start-loading', onStartLoading)
    webview.addEventListener('did-stop-loading', onStopLoading)
    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-fail-load', onFailLoad)
    webview.addEventListener('did-navigate-in-page', update)
    webview.addEventListener('page-title-updated', update)
    webview.addEventListener('media-started-playing', onMediaStarted)
    webview.addEventListener('media-paused', onMediaPaused)

    // If the guest was already ready (effect re-bind / remount), re-register immediately.
    // dom-ready will not fire again for an already-loaded document.
    if (isWebviewGuestReady(webview)) {
      onDomReady()
    }

    return () => {
      readyRef.current = false
      onReadyRef.current(tab.id, null)
      onNavStateRef.current(tab.id, { canGoBack: false, canGoForward: false, isLoading: false })
      onMediaPaused()
      webview.removeEventListener('dom-ready', onDomReady)
      webview.removeEventListener('did-start-loading', onStartLoading)
      webview.removeEventListener('did-stop-loading', onStopLoading)
      webview.removeEventListener('did-navigate', onNavigate)
      webview.removeEventListener('did-fail-load', onFailLoad)
      webview.removeEventListener('did-navigate-in-page', update)
      webview.removeEventListener('page-title-updated', update)
      webview.removeEventListener('media-started-playing', onMediaStarted)
      webview.removeEventListener('media-paused', onMediaPaused)
    }
  }, [tab.id])

  useEffect(() => {
    if (!readyRef.current) return
    withWebview(ref.current, (wv) => {
      wv.setZoomFactor(tab.zoomFactor)
    }, undefined)
  }, [tab.zoomFactor])

  const preset = DEVICE_PRESETS.find((item) => item.id === tab.devicePreset)
  const blank = tab.url === BLANK_URL
  const failed = !blank && failure !== null
  const reloadFailed = () => {
    if (!failure) return
    const pending = withWebview(ref.current, (wv) => wv.loadURL(failure.url), undefined)
    // A failure that repeats replaces this page's; nothing else to report.
    void pending?.catch(() => {})
  }
  const takeOver = () => reportBrowserActivity({ localTabId: tab.id, kind: 'input' })
  return (
    <KeepMounted active={active} preserveLayout
      className={`browser-viewport${active ? ' active' : ''}${blank || failed ? ' browser-viewport-blank' : ''}`}
      style={tab.deviceToolbarOpen && preset?.width ? { width: preset.width } : undefined}
    >
      {blank && <BrowserStartPage />}
      {failed && <BrowserLoadErrorPage failure={failure} loading={pageLoading} onReload={reloadFailed} />}
      <webview
        ref={ref}
        data-browser-tab-id={tab.id}
        className={`browser-webview${blank || failed ? ' browser-webview-hidden' : ''}`}
        src={initialUrl.current}
        partition={`persist:mousse-profile-${profileId.toLowerCase()}`}
        allowpopups={ALLOW_POPUPS_ATTRIBUTE}
        data-agent-controlled={agentBound ? '' : undefined}
        webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
      />
      {/* The person's first click, wheel or key stops the agent's step (main gives the tab back to them); the next reaches the page. */}
      {agentBusy && (
        <div
          className="browser-agent-shield"
          tabIndex={-1}
          aria-label="Agent is acting in this tab. Click the page to take over"
          onPointerDown={(event) => { event.currentTarget.focus(); takeOver() }}
          onWheel={takeOver}
          onKeyDown={takeOver}
        />
      )}
      {!blank && <AgentCursor cursor={agentCursor} zoom={tab.zoomFactor || 1} />}
    </KeepMounted>
  )
}

/** Makes an agent's tab its thread's current tab, and opens the browser when that thread is on screen (once a session). */
function showAgentTab(threadId: string, tabId: string) {
  const store = useAppStore.getState()
  if (!store.browserTabs.some((tab) => tab.id === tabId)) return
  store.setActiveBrowserTab(threadId, tabId)
  if (store.activeThreadId !== threadId || store.sidebarMode !== 'projects') return
  if (store.mainView !== 'browser' || !store.mainAreaOpen || !store.openedSurfaceKinds.includes('browser')) store.openSurfaceKind('browser')
}

export function BrowserPanel({ active = true }: { active?: boolean }) {
  const profileId = useAppStore((s) => s.profileId)
  return <ProfileBrowserPanel key={profileId} profileId={profileId} active={active} />
}

function ProfileBrowserPanel({ profileId, active }: { profileId: string; active: boolean }) {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const tabs = useAppStore((s) => s.browserTabs)
  const activeByThread = useAppStore((s) => s.browserActiveTabByThread)
  const addTab = useAppStore((s) => s.addBrowserTab)
  const updateTab = useAppStore((s) => s.updateBrowserTab)
  const setActiveTab = useAppStore((s) => s.setActiveBrowserTab)
  const addElementAttachment = useAppStore((s) => s.addBrowserElementAttachment)
  const webviews = useRef(new Map<string, HTMLWebViewElement>())
  const loadedTabs = useRef<LoadedBrowserTabs>(NO_LOADED_BROWSER_TABS)
  const [mediaTabs, setMediaTabs] = useState<ReadonlySet<string>>(() => new Set())
  const registrations = useRef(new Map<string, Promise<unknown>>())
  const editingAddress = useRef(false)
  /** The tab the address bar holds while it has focus: the one unpinned on blur, whatever tab is active by then. */
  const addressPin = useRef<string | null>(null)
  /** The address bar has focus: whichever tab is shown is the person's while it does. */
  const addressFocused = useRef(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const key = activeThreadId ?? '__standalone__'
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => tab.ownerThreadId === activeThreadId || tab.ownerThreadId === null),
    [activeThreadId, tabs]
  )
  const hasVisibleTabs = visibleTabs.length > 0
  const requestedActiveId = activeByThread[key]
  const activeTab = visibleTabs.find((tab) => tab.id === requestedActiveId) ?? visibleTabs[0]
  const [inputUrl, setInputUrl] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [navByTab, setNavByTab] = useState<Record<string, WebviewNavState>>({})
  // Tabs thread agents wait for: their first tab in this window (`browser.access.status`).
  const [tabRequests, setTabRequests] = useState<NonNullable<BrowserAccessState['tabRequests']>>([])
  // Tabs an agent opened (`browser_tabs` new), by local tab id: their registration answers main's request.
  const openRequests = useRef(new Map<string, string>())
  /** Tabs the window opened because an agent asked for one: the only tabs agents may close. */
  const agentOpenedTabs = useRef(new Set<string>())
  // The thread each registered tab was last reported to main as belonging to.
  const reportedOwners = useRef(new Map<string, string | null>())
  const provisionedRequests = useRef(new Set<string>())
  const agentTabByThread = useRef(new Map<string, { tabId: string; sessionId?: string }>())
  const [controlByTab, setControlByTab] = useState<Record<string, InAppBrowserState>>({})
  const [cursorByTab, setCursorByTab] = useState<Record<string, BrowserAgentCursor>>({})
  const [browserBusy, setBrowserBusy] = useState(false)
  const [notice, setNotice] = useState<BrowserNoticeState | null>(null)
  const [confirmClearCookies, setConfirmClearCookies] = useState(false)
  const setBrowserError = useCallback((error: unknown) => setNotice({ kind: 'error', text: browserErrorMessage(error) }), [])
  const activeControl = activeTab ? controlByTab[activeTab.id] : undefined
  const activity = browserTabActivity(activeControl)
  const picker = useRef<{ webview: HTMLWebViewElement; tabId: string } | null>(null)
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const state = await window.mousse.platformRequest.request<BrowserAccessState>('browser.access.status', { profileId })
        if (!disposed) setTabRequests((previous) => {
          const next = state.tabRequests ?? []
          const same = previous.length === next.length && previous.every((request, index) => request.requestId === next[index]?.requestId)
          return same ? previous : next
        })
      } catch { /* Reconnect on the next poll. */ }
      if (!disposed) timer = setTimeout(() => void refresh(), 750)
    }
    void refresh()
    return () => { disposed = true; clearTimeout(timer) }
  }, [profileId])
  useEffect(() => {
    const pending = tabRequests
    const liveIds = new Set(pending.map((request) => request.requestId))
    for (const id of provisionedRequests.current) {
      if (!liveIds.has(id)) provisionedRequests.current.delete(id)
    }
    for (const request of pending) {
      if (provisionedRequests.current.has(request.requestId)) continue
      provisionedRequests.current.add(request.requestId)
      const store = useAppStore.getState()
      // The tab belongs to the requesting thread. Hidden guests still load, so the
      // trusted host registers it on dom-ready and wakes the waiting tool call.
      agentOpenedTabs.current.add(store.addBrowserTab(request.threadId))
      if (store.activeThreadId === request.threadId) store.openSurfaceKind('browser')
    }
  }, [tabRequests])
  // An agent's own new tab (`browser_tabs` new) and its closing one. A tab opened while the person uses another stays
  // in the background, so it never takes the page from under them.
  useEffect(() => window.mousse?.inAppBrowser?.onTabCommand?.((command) => {
    const store = useAppStore.getState()
    if (command.kind === 'close') {
      if (store.browserTabs.some((tab) => tab.id === command.localTabId)) store.closeBrowserTab(command.localTabId)
      return
    }
    const previous = store.browserActiveTabByThread[command.threadId]
    const tabId = store.addBrowserTab(command.threadId)
    openRequests.current.set(tabId, command.requestId)
    agentOpenedTabs.current.add(tabId)
    if (!command.activate && previous && previous !== tabId) store.setActiveBrowserTab(command.threadId, previous)
  }), [])
  // Main offers a tab only to its thread's agent: a tab moved to another thread, or kept in every thread, says so.
  useEffect(() => {
    for (const tab of tabs) {
      if (!reportedOwners.current.has(tab.id) || reportedOwners.current.get(tab.id) === tab.ownerThreadId) continue
      reportedOwners.current.set(tab.id, tab.ownerThreadId)
      const pending = window.mousse?.inAppBrowser?.setTabOwner?.({ localTabId: tab.id, threadId: tab.ownerThreadId })
      void pending?.catch(() => { /* A tab unloaded meanwhile registers with its owner again. */ })
    }
  }, [tabs])
  useEffect(() => window.mousse?.inAppBrowser?.onState((state) => {
    if (state.profileId !== profileId) return
    setControlByTab((previous) => ({ ...previous, [state.uiTabId]: state }))
    const { threadId } = state
    // Who is using a tab (`activity`) arrives for tabs no agent session holds too: only a session's states show its tab.
    if (!threadId || !state.sessionId) return
    const known = agentTabByThread.current.get(threadId)
    if (state.owner === 'disconnected') {
      if (known?.tabId === state.uiTabId) agentTabByThread.current.delete(threadId)
      return
    }
    // Show the tab once per agent session; its later tabs, navigations and handoffs keep the user's view.
    if (known?.sessionId === state.sessionId) return
    agentTabByThread.current.set(threadId, { tabId: state.uiTabId, sessionId: state.sessionId })
    if (state.owner === 'agent') showAgentTab(threadId, state.uiTabId)
  }), [profileId])
  // The agent cursor of each tab: main sends where an agent is about to act in it.
  useEffect(() => window.mousse?.inAppBrowser?.onCursor?.((event) => {
    if (event.profileId !== profileId) return
    setCursorByTab((previous) => ({ ...previous, [event.uiTabId]: event.cursor }))
  }), [profileId])
  useEffect(() => {
    // Returning to a thread whose agent is still working in the browser shows its tab again.
    const known = activeThreadId ? agentTabByThread.current.get(activeThreadId) : undefined
    const phase = activeThreadId ? useAppStore.getState().turnStates[activeThreadId]?.phase : undefined
    if (activeThreadId && known && isTurnActivePhase(phase ?? 'idle')) showAgentTab(activeThreadId, known.tabId)
  }, [activeThreadId])

  useEffect(() => {
    if (notice?.kind !== 'done') return
    const timer = setTimeout(() => setNotice((current) => (current === notice ? null : current)), DONE_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  // Close the overflow menu when there is no active tab to act on.
  useEffect(() => {
    setMenuOpen(false)
    editingAddress.current = false
  }, [activeTab?.id, active])

  const unpinAddress = useCallback(() => {
    const held = addressPin.current
    addressPin.current = null
    if (held) reportBrowserActivity({ localTabId: held, kind: 'unpin', pin: 'address' })
  }, [])
  // Another tab shown while the address bar has focus: the bar now holds that tab, and lets the one it held go.
  useEffect(() => {
    if (addressFocused.current && active && activeTab) {
      addressPin.current = activeTab.id
      reportBrowserActivity({ localTabId: activeTab.id, kind: 'pin', pin: 'address' })
    }
    return unpinAddress
  }, [unpinAddress, activeTab?.id, activeThreadId, active])

  const cancelPicker = useCallback(() => {
    const current = picker.current
    picker.current = null
    if (current) {
      const pending = withWebview(current.webview, (wv) => wv.executeJavaScript('window.__mousseCancelElementPicker?.()', true), undefined)
      void pending?.catch(() => { /* Guest navigation/destruction already cancels selection. */ })
      reportBrowserActivity({ localTabId: current.tabId, kind: 'unpin', pin: 'picker' })
    }
    setPicking(false)
  }, [])
  useEffect(() => cancelPicker, [cancelPicker, activeTab?.id, activeThreadId, active])

  useEffect(() => {
    if (activeTab && requestedActiveId !== activeTab.id) {
      setActiveTab(activeThreadId, activeTab.id)
    }
  }, [activeTab?.id, activeThreadId, requestedActiveId, setActiveTab])

  useEffect(() => {
    if (editingAddress.current) return
    const next = activeTab?.url === BLANK_URL ? '' : activeTab?.url ?? ''
    setInputUrl((prev) => (prev === next ? prev : next))
  }, [activeTab?.url])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target)) return
      if (menuButtonRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  const menuStyle = useFloatingPosition({
    open: menuOpen && active && Boolean(activeTab),
    anchorRef: menuButtonRef,
    contentRef: menuRef,
    placement: 'below-end',
    gap: 5,
    deps: [activeTab?.id, activeTab?.deviceToolbarOpen, activeTab?.zoomFactor, activeTab?.ownerThreadId]
  })

  const registerWebview = useCallback((id: string, webview: HTMLWebViewElement | null) => {
    if (webview) {
      webviews.current.set(id, webview)
      if (!registrations.current.has(id)) {
        // A thread's own tab is offered only to that thread's agent, so it never drives a tab hidden from its thread.
        const threadId = useAppStore.getState().browserTabs.find((tab) => tab.id === id)?.ownerThreadId
        const openRequestId = openRequests.current.get(id)
        openRequests.current.delete(id)
        const registration = window.mousse.inAppBrowser.registerTab({
          localTabId: id, webContentsId: webview.getWebContentsId(), ...(threadId ? { threadId } : {}), ...(openRequestId ? { openRequestId } : {}),
          ...(agentOpenedTabs.current.has(id) ? { agentOpened: true } : {})
        })
        registrations.current.set(id, registration)
        reportedOwners.current.set(id, threadId ?? null)
        void registration.catch((error) => {
          // A tab that unloaded meanwhile has nothing to report.
          if (registrations.current.get(id) !== registration) return
          registrations.current.delete(id)
          // A kept tab can outlive its thread; a failure there is not this view's to report.
          if (!threadId || threadId === useAppStore.getState().activeThreadId) setBrowserError(error)
        })
      }
    }
    else {
      // An unloaded tab's page is gone with its registration; the page it loads when shown again registers anew.
      webviews.current.delete(id)
      registrations.current.delete(id)
      reportedOwners.current.delete(id)
    }
  }, [setBrowserError])
  const handleMedia = useCallback((id: string, playing: boolean) => {
    setMediaTabs((previous) => {
      if (previous.has(id) === playing) return previous
      const next = new Set(previous)
      if (playing) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const handleWebviewState = useCallback((id: string, patch: Partial<BrowserTabState>) => {
    updateTab(id, patch)
    if (id === activeTab?.id && !editingAddress.current && patch.url) {
      setInputUrl(patch.url === BLANK_URL ? '' : patch.url)
    }
  }, [activeTab?.id, updateTab])
  const handleNavState = useCallback((id: string, nav: WebviewNavState) => {
    setNavByTab((prev) => {
      const existing = prev[id]
      if (
        existing &&
        existing.canGoBack === nav.canGoBack &&
        existing.canGoForward === nav.canGoForward &&
        existing.isLoading === nav.isLoading
      ) {
        return prev
      }
      return { ...prev, [id]: nav }
    })
  }, [])

  const getActiveWebview = useCallback((): HTMLWebViewElement | undefined => {
    if (!activeTab) return undefined
    return webviews.current.get(activeTab.id)
  }, [activeTab?.id])

  const activeNav = activeTab ? navByTab[activeTab.id] : undefined
  const canGoBack = activeNav?.canGoBack ?? false
  const canGoForward = activeNav?.canGoForward ?? false
  const loading = activeNav?.isLoading ?? false

  // A tab an agent works in (or a person took over from one) keeps its page, so the agent's session goes on.
  const busyTabs = useMemo(() => {
    const busy = new Set(mediaTabs)
    for (const [id, state] of Object.entries(controlByTab)) if (state.owner === 'agent' || state.owner === 'human') busy.add(id)
    return busy
  }, [controlByTab, mediaTabs])
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs])
  loadedTabs.current = nextLoadedBrowserTabs(loadedTabs.current, {
    tabIds, activeTabId: activeTab?.id, shown: active, openedThisSession: browserTabsOpenedThisSession, busy: busyTabs
  })
  const loaded = loadedTabs.current.loaded

  const navigate = () => {
    const webview = getActiveWebview()
    if (!activeTab || !webview) return
    const url = normalizeUrl(inputUrl)
    editingAddress.current = false
    setNotice(null)
    const navigation = withWebview(webview, (wv) => wv.loadURL(url), undefined)
    void navigation?.catch((error: unknown) => {
      // A newer navigation or a redirect can intentionally cancel this load.
      const failure = error as { errno?: number; code?: string; message?: string }
      if (failure.errno === -3 || failure.code === 'ERR_ABORTED' || /ERR_ABORTED|\(-3\)/.test(failure.message ?? '')) return
      // The tab shows its own page for an address it couldn't open.
      if (isPageLoadRejection(error)) return
      setBrowserError(error)
    })
  }

  const chooseElement = async () => {
    const webview = getActiveWebview()
    if (!active || !webview || !activeTab || activeTab.url === BLANK_URL) return
    if (picker.current) {
      cancelPicker()
      return
    }
    if (!isWebviewGuestReady(webview)) return
    const selection = { webview, tabId: activeTab.id }
    picker.current = selection
    setPicking(true)
    // Picking is using the tab: an agent's step there gives way until the pick ends.
    reportBrowserActivity({ localTabId: selection.tabId, kind: 'pin', pin: 'picker' })
    try {
      const result = await withWebview(
        webview,
        (wv) => wv.executeJavaScript(PICK_ELEMENT_SCRIPT, true) as Promise<Omit<BrowserElementAttachment, 'id'> | null>,
        Promise.resolve(null)
      )
      if (result && picker.current === selection) addElementAttachment(activeThreadId, { ...result, id: crypto.randomUUID() })
    } catch {
      // Navigation or a page teardown cancels the picker promise.
    } finally {
      if (picker.current === selection) {
        picker.current = null
        setPicking(false)
        reportBrowserActivity({ localTabId: selection.tabId, kind: 'unpin', pin: 'picker' })
      }
    }
  }

  const changeZoom = (delta: number) => {
    if (!activeTab) return
    updateTab(activeTab.id, { zoomFactor: Math.min(2, Math.max(0.5, activeTab.zoomFactor + delta)) })
  }

  /** Hands a tab the agent gave the person (`browser_request_human`) back to the agent. */
  const resumeAgent = async () => {
    if (!activeTab || browserBusy) return
    const tabId = activeTab.id
    const api = window.mousse?.inAppBrowser
    setBrowserBusy(true); setNotice(null)
    try {
      if (!api) throw new Error('In-app browser automation is unavailable')
      await api.resumeAgent(tabId)
    } catch (error) { setBrowserError(error) }
    finally { setBrowserBusy(false) }
  }
  const reportToolbarInput = () => { if (activeTab) reportBrowserActivity({ localTabId: activeTab.id, kind: 'input' }) }
  const pinAddress = (pinned: boolean) => {
    addressFocused.current = pinned
    unpinAddress()
    if (!pinned || !activeTab) return
    addressPin.current = activeTab.id
    reportBrowserActivity({ localTabId: activeTab.id, kind: 'pin', pin: 'address' })
  }

  const clearBrowserData = async (what: 'cookies' | 'cache') => {
    setNotice(null)
    try {
      if (what === 'cookies') await window.mousse.browser.clearCookies()
      else await window.mousse.browser.clearCache()
      setNotice({ kind: 'done', text: what === 'cookies' ? 'Cookies cleared' : 'Cache cleared' })
    } catch (error) {
      setNotice({ kind: 'error', text: `Couldn’t clear ${what}`, detail: browserErrorMessage(error) })
    }
  }

  const noticeView = notice && <BrowserNotice notice={notice} onDismiss={() => setNotice(null)} />

  return (
    <div
      className={`browser-panel${picking ? ' browser-panel-picking' : ''}${
        !hasVisibleTabs ? ' browser-panel-empty' : ''
      }`}
    >
      <KeepMountedStack>
      <KeepMounted active preserveLayout className="keep-mounted-pane browser-manual-surface">
      {/* The thread agent's browser without a window, when it has one open: its line, and its view over the tabs. */}
      {activeThreadId && <ThreadBrowserRow threadId={activeThreadId} active={active} />}
      {!hasVisibleTabs && noticeView}
      {hasVisibleTabs ? (
        <>
          {/* Using the toolbar is using the tab: an agent's step there gives way. */}
          <div className="browser-toolbar" onPointerDownCapture={reportToolbarInput} onKeyDownCapture={reportToolbarInput}>
            <button type="button" className="browser-toolbar-btn" disabled={!canGoBack} onClick={() => withWebview(getActiveWebview(), (wv) => wv.goBack(), undefined)} aria-label="Back"><ArrowLeft size={16} /></button>
            <button type="button" className="browser-toolbar-btn" disabled={!canGoForward} onClick={() => withWebview(getActiveWebview(), (wv) => wv.goForward(), undefined)} aria-label="Forward"><ArrowRight size={16} /></button>
            <button type="button" className="browser-toolbar-btn" onClick={() => withWebview(getActiveWebview(), (wv) => wv.reload(), undefined)} aria-label="Reload"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
            <form className="browser-url-form" onSubmit={(event) => { event.preventDefault(); navigate() }}>
              <input className="browser-url-input" aria-label="Browser address" value={inputUrl} onFocus={() => { editingAddress.current = true; pinAddress(true) }} onBlur={() => { editingAddress.current = false; pinAddress(false) }} onChange={(event) => setInputUrl(event.target.value)} placeholder="Search or enter URL" spellCheck={false} />
            </form>
            <button
              type="button"
              className={`browser-toolbar-btn${picking ? ' active' : ''}`}
              onClick={() => void chooseElement()}
              disabled={!activeTab || activeTab.url === BLANK_URL}
              aria-label={picking ? 'Cancel element selection' : 'Point and click to select element'}
              title={picking ? 'Cancel element selection (Esc)' : 'Point and click to select element'}
            >
              <Crosshair size={16} />
            </button>
            <BrowserActivityIndicator activity={activity} busy={browserBusy} onResume={() => void resumeAgent()} />
            <div className="browser-menu-wrap">
              <button
                ref={menuButtonRef}
                type="button"
                className="browser-toolbar-btn"
                onClick={() => setMenuOpen((open) => !open)}
                aria-label="Browser menu"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
              >
                <MoreVertical size={16} />
              </button>
              {menuOpen && active && activeTab && (
                <FloatingPortal>
                  <div
                    className="browser-menu-backdrop"
                    aria-hidden="true"
                    onPointerDown={() => setMenuOpen(false)}
                  />
                  <div className="browser-menu browser-menu-floating" ref={menuRef} style={menuStyle} role="menu" aria-label="Browser menu">
                    <button type="button" role="menuitem" onClick={() => { withWebview(getActiveWebview(), (wv) => wv.reloadIgnoringCache(), undefined); setMenuOpen(false) }}>
                      <span className="browser-menu-label"><RefreshCw size={14} />Hard reload</span>
                    </button>
                    <button type="button" role="menuitem" onClick={() => { withWebview(getActiveWebview(), (wv) => wv.openDevTools(), undefined); setMenuOpen(false) }}>
                      <span className="browser-menu-label"><Code2 size={14} />DevTools</span>
                    </button>
                    <button type="button" role="menuitemcheckbox" aria-checked={activeTab.deviceToolbarOpen} onClick={() => { updateTab(activeTab.id, { deviceToolbarOpen: !activeTab.deviceToolbarOpen }); setMenuOpen(false) }}>
                      <span className="browser-menu-label"><Smartphone size={14} />Device toolbar</span>{activeTab.deviceToolbarOpen && <Check size={14} />}
                    </button>
                    <div className="browser-menu-zoom"><span>Zoom</span><button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => changeZoom(-0.1)}><Minus size={14} aria-hidden="true" /></button><span>{Math.round(activeTab.zoomFactor * 100)}%</span><button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => changeZoom(0.1)}><Plus size={14} aria-hidden="true" /></button></div>
                    <button type="button" role="menuitemcheckbox" aria-checked={activeTab.ownerThreadId === null} onClick={() => { updateTab(activeTab.id, { ownerThreadId: activeTab.ownerThreadId === null ? activeThreadId : null }); setMenuOpen(false) }}>
                      <span className="browser-menu-label"><BrowserTab size={14} />Keep tab in every thread</span>{activeTab.ownerThreadId === null && <Check size={14} />}
                    </button>
                    <div className="browser-menu-separator" />
                    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setConfirmClearCookies(true) }}>
                      <span className="browser-menu-label"><Cookie size={14} />Clear cookies…</span>
                    </button>
                    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void clearBrowserData('cache') }}>
                      <span className="browser-menu-label"><Clean size={14} />Clear cache</span>
                    </button>
                  </div>
                </FloatingPortal>
              )}
            </div>
          </div>
          {activeTab?.deviceToolbarOpen && (
            <BrowserDeviceToolbar presetId={activeTab.devicePreset} onChange={(devicePreset) => updateTab(activeTab.id, { devicePreset })} />
          )}
          {noticeView}
        </>
      ) : !active ? null : (
        // The pane keeps its layout while hidden, for live tabs; an empty one has nothing to keep.
        <div className="browser-empty-state" role="status">
          <MousseLogoOutline className="browser-empty-logo" />
          <p className="browser-empty-title">No tabs open</p>
          <p className="browser-empty-copy">Open a tab to browse the web for this thread.</p>
          <button type="button" className="browser-empty-action" onClick={() => addTab(activeThreadId)}>
            <Plus size={14} />
            New tab
          </button>
        </div>
      )}
      {/* Loaded guests stay mounted across threads, so going back to a recent tab neither reloads it nor loses its page. */}
      <KeepMounted active={hasVisibleTabs} preserveLayout className="browser-content">
        {tabs.filter((tab) => loaded.has(tab.id)).map((tab) => (
          <BrowserWebview
            key={`${profileId}:${tab.id}`}
            tab={tab}
            profileId={profileId}
            active={tab.id === activeTab?.id}
            agentBound={controlByTab[tab.id]?.owner === 'agent'}
            agentBusy={controlByTab[tab.id]?.owner !== 'disconnected' && controlByTab[tab.id]?.activity === 'agent-busy'}
            agentCursor={cursorByTab[tab.id]}
            onReady={registerWebview}
            onState={handleWebviewState}
            onNavState={handleNavState}
            onMedia={handleMedia}
          />
        ))}
      </KeepMounted>
      </KeepMounted>
      </KeepMountedStack>
      {activeThreadId && <ThreadBrowserLayer threadId={activeThreadId} />}
      {confirmClearCookies && (
        <FloatingPortal>
          <ClearCookiesDialog
            open
            onCancel={() => setConfirmClearCookies(false)}
            onConfirm={() => { setConfirmClearCookies(false); void clearBrowserData('cookies') }}
          />
        </FloatingPortal>
      )}
    </div>
  )
}
