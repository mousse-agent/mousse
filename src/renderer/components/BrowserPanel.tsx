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
  Globe,
  Minus,
  MoreVertical,
  Plus,
  RefreshCw,
  Smartphone
} from '../lib/icons'
import { isTurnActivePhase, type BrowserElementAttachment, type BrowserTabState } from '../../shared/types'
import type { BrowserAccessState } from '../../shared/browser/access'
import type { InAppBrowserState } from '../../shared/browser/inApp'
import type { BrowserAgentCursor } from '../../shared/browser/agentCursor'
import { AgentCursor } from './browser/AgentCursor'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { useAppStore } from '../stores/appStore'
import { MousseLogoOutline } from './MousseLogoOutline'
import { KeepMounted, KeepMountedStack } from './KeepMounted'
import {
  BrowserAccessControl,
  BrowserDeviceToolbar,
  BrowserNotice,
  BrowserStartPage,
  ClearCookiesDialog,
  DEVICE_PRESETS,
  browserAgentState,
  type BrowserNoticeState
} from './browser/BrowserToolbarParts'

const BLANK_URL = 'about:blank'
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
  agentControlled: boolean
  /** Where the agent acts in this tab: drawn over the page, never in it. */
  agentCursor?: BrowserAgentCursor
  onReady: (id: string, webview: HTMLWebViewElement | null) => void
  onState: (id: string, patch: Partial<BrowserTabState>) => void
  onNavState: (id: string, nav: WebviewNavState) => void
}

function BrowserWebview({ tab, profileId, active, agentControlled, agentCursor, onReady, onState, onNavState }: BrowserWebviewProps) {
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
  zoomRef.current = tab.zoomFactor
  onReadyRef.current = onReady
  onStateRef.current = onState
  onNavStateRef.current = onNavState

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

    const onStartLoading = () => onNavStateRef.current(tab.id, { ...readNav(), isLoading: true })
    const onStopLoading = () => {
      update()
      onNavStateRef.current(tab.id, { ...readNav(), isLoading: false })
    }

    webview.addEventListener('dom-ready', onDomReady)
    webview.addEventListener('did-start-loading', onStartLoading)
    webview.addEventListener('did-stop-loading', onStopLoading)
    webview.addEventListener('did-navigate', update)
    webview.addEventListener('did-navigate-in-page', update)
    webview.addEventListener('page-title-updated', update)

    // If the guest was already ready (effect re-bind / remount), re-register immediately.
    // dom-ready will not fire again for an already-loaded document.
    if (isWebviewGuestReady(webview)) {
      onDomReady()
    }

    return () => {
      readyRef.current = false
      onReadyRef.current(tab.id, null)
      onNavStateRef.current(tab.id, { canGoBack: false, canGoForward: false, isLoading: false })
      webview.removeEventListener('dom-ready', onDomReady)
      webview.removeEventListener('did-start-loading', onStartLoading)
      webview.removeEventListener('did-stop-loading', onStopLoading)
      webview.removeEventListener('did-navigate', update)
      webview.removeEventListener('did-navigate-in-page', update)
      webview.removeEventListener('page-title-updated', update)
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
  useEffect(() => { if (agentControlled) ref.current?.blur() }, [agentControlled])
  return (
    <KeepMounted active={active} preserveLayout
      className={`browser-viewport${active ? ' active' : ''}${blank ? ' browser-viewport-blank' : ''}`}
      style={tab.deviceToolbarOpen && preset?.width ? { width: preset.width } : undefined}
    >
      {blank && <BrowserStartPage />}
      <webview
        ref={ref}
        data-browser-tab-id={tab.id}
        inert={agentControlled}
        className={`browser-webview${blank ? ' browser-webview-hidden' : ''}`}
        src={initialUrl.current}
        partition={`persist:mousse-profile-${profileId.toLowerCase()}`}
        allowpopups={ALLOW_POPUPS_ATTRIBUTE}
        webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
      />
      {agentControlled && <div className="browser-agent-shield" aria-label="Agent is controlling this tab; use Take control to interact" />}
      {!blank && <AgentCursor cursor={agentCursor} />}
    </KeepMounted>
  )
}

/** Makes an agent's tab its thread's current tab, and opens the browser when that thread is on screen. */
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
  const registrations = useRef(new Map<string, Promise<unknown>>())
  const editingAddress = useRef(false)
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
  const [access, setAccess] = useState<BrowserAccessState>({ allowed: false, pending: [] })
  const accessRevision = useRef(0)
  const provisionedRequests = useRef(new Set<string>())
  const agentTabByThread = useRef(new Map<string, { tabId: string; sessionId?: string }>())
  const [controlByTab, setControlByTab] = useState<Record<string, InAppBrowserState>>({})
  const [cursorByTab, setCursorByTab] = useState<Record<string, BrowserAgentCursor>>({})
  const [browserBusy, setBrowserBusy] = useState(false)
  const [notice, setNotice] = useState<BrowserNoticeState | null>(null)
  const [confirmClearCookies, setConfirmClearCookies] = useState(false)
  const setBrowserError = useCallback((error: unknown) => setNotice({ kind: 'error', text: browserErrorMessage(error) }), [])
  const activeControl = activeTab ? controlByTab[activeTab.id] : undefined
  const agentControlled = activeControl?.owner === 'agent'
  const agentState = browserAgentState(access.allowed, activeControl?.owner)
  const picker = useRef<{ webview: HTMLWebViewElement } | null>(null)
  const manualActive = active && !agentControlled
  const pendingAccess = access.allowed ? undefined : access.pending[0]
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      const revision = accessRevision.current
      try {
        const state = await window.mousse.platformRequest.request<BrowserAccessState>('browser.access.status', { profileId })
        if (!disposed && revision === accessRevision.current) setAccess(state)
      } catch { /* Reconnect on the next poll. */ }
      if (!disposed) timer = setTimeout(() => void refresh(), 750)
    }
    void refresh()
    return () => { disposed = true; clearTimeout(timer) }
  }, [profileId])
  useEffect(() => {
    if (!access.allowed) return
    const pending = access.tabRequests ?? []
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
      store.addBrowserTab(request.threadId)
      if (store.activeThreadId === request.threadId) store.openSurfaceKind('browser')
    }
  }, [access.allowed, access.tabRequests])
  useEffect(() => {
    if (!pendingAccess) return
    const store = useAppStore.getState()
    store.openSurfaceKind('browser')
  }, [pendingAccess?.requestId])
  useEffect(() => window.mousse?.inAppBrowser?.onState((state) => {
    if (state.profileId !== profileId) return
    setControlByTab((previous) => ({ ...previous, [state.uiTabId]: state }))
    const { threadId } = state
    if (!threadId) return
    const known = agentTabByThread.current.get(threadId)
    if (state.owner === 'disconnected') {
      if (known?.tabId === state.uiTabId) agentTabByThread.current.delete(threadId)
      return
    }
    // Show the tab once per agent session; later navigations and handoffs keep the user's view.
    if (known?.tabId === state.uiTabId && known.sessionId === state.sessionId) return
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

  const cancelPicker = useCallback(() => {
    const current = picker.current
    picker.current = null
    if (current) {
      const pending = withWebview(current.webview, (wv) => wv.executeJavaScript('window.__mousseCancelElementPicker?.()', true), undefined)
      void pending?.catch(() => { /* Guest navigation/destruction already cancels selection. */ })
    }
    setPicking(false)
  }, [])
  useEffect(() => cancelPicker, [cancelPicker, activeTab?.id, activeThreadId, manualActive])

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
        const registration = window.mousse.inAppBrowser.registerTab({
          localTabId: id, webContentsId: webview.getWebContentsId(), ...(threadId ? { threadId } : {})
        })
        registrations.current.set(id, registration)
        void registration.catch((error) => {
          registrations.current.delete(id)
          // A kept tab can outlive its thread; a failure there is not this view's to report.
          if (!threadId || threadId === useAppStore.getState().activeThreadId) setBrowserError(error)
        })
      }
    }
    else webviews.current.delete(id)
  }, [setBrowserError])
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
      setBrowserError(error)
    })
  }

  const chooseElement = async () => {
    const webview = getActiveWebview()
    if (!manualActive || !webview || !activeTab || activeTab.url === BLANK_URL) return
    if (picker.current) {
      cancelPicker()
      return
    }
    if (!isWebviewGuestReady(webview)) return
    const selection = { webview }
    picker.current = selection
    setPicking(true)
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
      }
    }
  }

  const changeZoom = (delta: number) => {
    if (!activeTab) return
    updateTab(activeTab.id, { zoomFactor: Math.min(2, Math.max(0.5, activeTab.zoomFactor + delta)) })
  }

  const browserControl = async (operation: 'take' | 'resume') => {
    if (!activeTab || !activeThreadId || browserBusy) return
    const tabId = activeTab.id
    const api = window.mousse?.inAppBrowser
    setBrowserBusy(true); setNotice(null)
    try {
      if (!api) throw new Error('In-app browser automation is unavailable')
      if (operation === 'take') await api.takeControl(tabId)
      else await api.resumeAgent(tabId)
    } catch (error) { setBrowserError(error) }
    finally { setBrowserBusy(false) }
  }

  const changeAccess = async (allowed: boolean, requestId?: string) => {
    accessRevision.current += 1
    setBrowserBusy(true)
    setNotice(null)
    try {
      const state = await window.mousse.platformRequest.request<BrowserAccessState>(requestId ? 'browser.access.respond' : 'browser.access.set', { profileId, allowed, ...(requestId ? { requestId } : {}) })
      setAccess(state)
    } catch (error) {
      setNotice({
        kind: 'error',
        text: requestId ? 'Couldn’t answer the access request' : allowed ? 'Couldn’t turn on agent access' : 'Couldn’t turn off agent access',
        detail: browserErrorMessage(error)
      })
      // Revocation may have succeeded even if its response was interrupted.
      try { setAccess(await window.mousse.platformRequest.request<BrowserAccessState>('browser.access.status', { profileId })) } catch { /* Keep the original error. */ }
    }
    finally { accessRevision.current += 1; setBrowserBusy(false) }
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
      {pendingAccess && <div className="browser-agent-controls" role="region" aria-label="Agent browser access request">
        <span>Allow access to all browser tabs?</span>
        <button type="button" disabled={browserBusy} onClick={() => void changeAccess(true, pendingAccess.requestId)}>Allow</button>
        <button type="button" disabled={browserBusy} onClick={() => void changeAccess(false, pendingAccess.requestId)}>Deny</button>
      </div>}
      {hasVisibleTabs && (agentControlled || activeControl?.owner === 'human') && <div className="browser-agent-controls" aria-label="Agent browser controls">
        <span>{agentControlled ? 'Agent is using this tab' : 'You have control'}</span>
        {agentControlled ? <button type="button" disabled={browserBusy} onClick={() => void browserControl('take')}>Take control</button>
          : <button type="button" disabled={browserBusy || !access.allowed} onClick={() => void browserControl('resume')}>Resume agent</button>}
      </div>}
      {!hasVisibleTabs && noticeView}
      {hasVisibleTabs ? (
        <>
          <div className="browser-toolbar">
            <div style={{ display: 'contents' }} inert={agentControlled}>
            <button type="button" className="browser-toolbar-btn" disabled={!canGoBack} onClick={() => withWebview(getActiveWebview(), (wv) => wv.goBack(), undefined)} aria-label="Back"><ArrowLeft size={16} /></button>
            <button type="button" className="browser-toolbar-btn" disabled={!canGoForward} onClick={() => withWebview(getActiveWebview(), (wv) => wv.goForward(), undefined)} aria-label="Forward"><ArrowRight size={16} /></button>
            <button type="button" className="browser-toolbar-btn" onClick={() => withWebview(getActiveWebview(), (wv) => wv.reload(), undefined)} aria-label="Reload"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
            <form className="browser-url-form" onSubmit={(event) => { event.preventDefault(); navigate() }}>
              <Globe size={14} className="browser-url-icon" />
              <input className="browser-url-input" aria-label="Browser address" value={inputUrl} onFocus={() => { editingAddress.current = true }} onBlur={() => { editingAddress.current = false }} onChange={(event) => setInputUrl(event.target.value)} placeholder="Search or enter URL" spellCheck={false} />
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
            </div>
            <BrowserAccessControl state={agentState} allowed={access.allowed} busy={browserBusy} onChange={(allowed) => void changeAccess(allowed)} />
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
                    <div className="browser-menu-actions" style={{ display: 'contents' }} inert={agentControlled}>
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
      ) : (
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
      {/* All guests stay mounted so switching threads does not reload pages or lose DOM state. */}
      <KeepMounted active={hasVisibleTabs} preserveLayout className="browser-content">
        {tabs.map((tab) => (
          <BrowserWebview
            key={`${profileId}:${tab.id}`}
            tab={tab}
            profileId={profileId}
            active={tab.id === activeTab?.id}
            agentControlled={controlByTab[tab.id]?.owner === 'agent'}
            agentCursor={cursorByTab[tab.id]}
            onReady={registerWebview}
            onState={handleWebviewState}
            onNavState={handleNavState}
          />
        ))}
      </KeepMounted>
      </KeepMounted>
      </KeepMountedStack>
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
