import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Crosshair,
  Globe,
  Minus,
  MoreVertical,
  Pin,
  Plus,
  RefreshCw,
  X
} from 'lucide-react'
import {
  ArrowSyncRegular,
  BroomRegular,
  CookiesRegular,
  DeleteDismissRegular,
  PinOffRegular,
  PinRegular,
  WindowDevToolsRegular
} from '@fluentui/react-icons'
import type { BrowserElementAttachment, BrowserTabState } from '../../shared/types'
import type { BrowserAccessState } from '../../shared/browser/access'
import type { InAppBrowserState } from '../../shared/browser/inApp'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { useAppStore } from '../stores/appStore'
import { MousseLogoOutline } from './MousseLogoOutline'
import { KeepMounted, KeepMountedStack } from './KeepMounted'
import { setReferenceDragData } from '../../shared/chatReferences'

const BLANK_URL = 'about:blank'
function browserErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return typeof error === 'string' ? error : 'Browser request failed. Please try again.'
}
// Electron types this as boolean, but React drops boolean attributes on webview.
// A literal string emits the native attribute and preserves popup navigation.
const ALLOW_POPUPS_ATTRIBUTE = 'true' as unknown as boolean
const DEVICE_PRESETS = [
  { id: 'responsive', label: 'Responsive', width: null },
  { id: 'iphone-14', label: 'iPhone 14', width: 390 },
  { id: 'pixel-7', label: 'Pixel 7', width: 412 },
  { id: 'ipad', label: 'iPad', width: 768 },
  { id: 'desktop', label: 'Desktop', width: 1280 }
] as const

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
  onReady: (id: string, webview: HTMLWebViewElement | null) => void
  onState: (id: string, patch: Partial<BrowserTabState>) => void
  onNavState: (id: string, nav: WebviewNavState) => void
}

function BrowserWebview({ tab, profileId, active, agentControlled, onReady, onState, onNavState }: BrowserWebviewProps) {
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
  useEffect(() => { if (agentControlled) ref.current?.blur() }, [agentControlled])
  return (
    <KeepMounted active={active} preserveLayout
      className={`browser-viewport${active ? ' active' : ''}`}
      style={tab.deviceToolbarOpen && preset?.width ? { width: preset.width } : undefined}
    >
      {tab.url === BLANK_URL && (
        <div className="browser-blank" aria-hidden="true">
          <MousseLogoOutline className="browser-blank-logo" />
        </div>
      )}
      <webview
        ref={ref}
        data-browser-tab-id={tab.id}
        inert={agentControlled}
        className={`browser-webview${tab.url === BLANK_URL ? ' browser-webview-hidden' : ''}`}
        src={initialUrl.current}
        partition={`persist:mousse-profile-${profileId.toLowerCase()}`}
        allowpopups={ALLOW_POPUPS_ATTRIBUTE}
        webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
      />
      {agentControlled && <div className="browser-agent-shield" aria-label="Agent is controlling this tab; use Take control to interact" />}
    </KeepMounted>
  )
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
  const closeTab = useAppStore((s) => s.closeBrowserTab)
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
  const [controlByTab, setControlByTab] = useState<Record<string, InAppBrowserState>>({})
  const [browserBusy, setBrowserBusy] = useState(false)
  const [browserError, setBrowserError] = useState('')
  const activeControl = activeTab ? controlByTab[activeTab.id] : undefined
  const agentControlled = activeControl?.owner === 'agent'
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
      store.setMainAreaOpen(true)
      store.setMainView('browser')
      // A browser-wide tab is visible even if the requesting thread is not active.
      // The trusted host registers it on dom-ready, waking the waiting tool call.
      const tabId = store.addBrowserTab(null)
      store.setActiveBrowserTab(store.activeThreadId, tabId)
    }
  }, [access.allowed, access.tabRequests])
  useEffect(() => {
    if (!pendingAccess) return
    const store = useAppStore.getState()
    store.setMainAreaOpen(true)
    store.setMainView('browser')
  }, [pendingAccess?.requestId])
  useEffect(() => window.mousse?.inAppBrowser?.onState((state) => {
    if (state.profileId === profileId) setControlByTab((previous) => ({ ...previous, [state.uiTabId]: state }))
  }), [profileId])

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
        const registration = window.mousse.inAppBrowser.registerTab({ localTabId: id, webContentsId: webview.getWebContentsId() })
        registrations.current.set(id, registration)
        void registration.catch((error) => {
          registrations.current.delete(id)
          setBrowserError(browserErrorMessage(error))
        })
      }
    }
    else webviews.current.delete(id)
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

  const navigate = () => {
    const webview = getActiveWebview()
    if (!activeTab || !webview) return
    const url = normalizeUrl(inputUrl)
    editingAddress.current = false
    setBrowserError('')
    const navigation = withWebview(webview, (wv) => wv.loadURL(url), undefined)
    void navigation?.catch((error: unknown) => {
      // A newer navigation or a redirect can intentionally cancel this load.
      const failure = error as { errno?: number; code?: string; message?: string }
      if (failure.errno === -3 || failure.code === 'ERR_ABORTED' || /ERR_ABORTED|\(-3\)/.test(failure.message ?? '')) return
      setBrowserError(browserErrorMessage(error))
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
    setBrowserBusy(true); setBrowserError('')
    try {
      if (!api) throw new Error('In-app browser automation is unavailable')
      if (operation === 'take') await api.takeControl(tabId)
      else await api.resumeAgent(tabId)
    } catch (error) { setBrowserError(browserErrorMessage(error)) }
    finally { setBrowserBusy(false) }
  }

  const changeAccess = async (allowed: boolean, requestId?: string) => {
    accessRevision.current += 1
    setBrowserBusy(true)
    setBrowserError('')
    try {
      const state = await window.mousse.platformRequest.request<BrowserAccessState>(requestId ? 'browser.access.respond' : 'browser.access.set', { profileId, allowed, ...(requestId ? { requestId } : {}) })
      setAccess(state)
    } catch (error) {
      setBrowserError(browserErrorMessage(error))
      // Revocation may have succeeded even if its response was interrupted.
      try { setAccess(await window.mousse.platformRequest.request<BrowserAccessState>('browser.access.status', { profileId })) } catch { /* Keep the original error. */ }
    }
    finally { accessRevision.current += 1; setBrowserBusy(false) }
  }

  return (
    <div
      className={`browser-panel${picking ? ' browser-panel-picking' : ''}${
        !hasVisibleTabs ? ' browser-panel-empty' : ''
      }`}
    >
      <KeepMountedStack>
      <KeepMounted active preserveLayout className="keep-mounted-pane browser-manual-surface">
      {pendingAccess && <div className="browser-agent-controls" role="region" aria-label="Agent browser access request">
        <span>Let an agent use any tabs in the browser</span>
        <button type="button" disabled={browserBusy} onClick={() => void changeAccess(true, pendingAccess.requestId)}>Allow</button>
        <button type="button" disabled={browserBusy} onClick={() => void changeAccess(false, pendingAccess.requestId)}>Deny</button>
      </div>}
      {hasVisibleTabs && (agentControlled || activeControl?.owner === 'human') && <div className="browser-agent-controls" aria-label="Agent browser controls">
        <span>{agentControlled ? 'Agent is using this tab' : 'You have control'}</span>
        {agentControlled ? <button type="button" disabled={browserBusy} onClick={() => void browserControl('take')}>Take control</button>
          : <button type="button" disabled={browserBusy || !access.allowed} onClick={() => void browserControl('resume')}>Resume agent</button>}
      </div>}
      {browserError && <div className="browser-agent-controls" role="alert">{browserError}</div>}
      <div className="browser-tabs">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`browser-tab${tab.id === activeTab?.id ? ' active' : ''}`}
            draggable
            onDragStart={(event) => setReferenceDragData(event.dataTransfer, {
              kind: 'browser', title: tab.title || tab.url, url: tab.url,
              tabId: tab.id, threadId: tab.ownerThreadId ?? undefined
            })}
            onClick={() => setActiveTab(activeThreadId, tab.id)}
            title={tab.title}
          >
            {tab.ownerThreadId === null && <Pin size={10} />}
            <span>{tab.title}</span>
            <span
              className="browser-tab-close"
              role="button"
              aria-label="Close tab"
              onClick={(event) => { event.stopPropagation(); closeTab(tab.id) }}
            ><X size={12} /></span>
          </button>
        ))}
        <button type="button" className="browser-new-tab" onClick={() => addTab(activeThreadId)} aria-label="New tab">
          <Plus size={14} />
        </button>
      </div>
      {hasVisibleTabs ? (
        <>
          <div className="browser-toolbar">
            <div style={{ display: 'contents' }} inert={agentControlled}>
            <button type="button" className="icon-btn icon-btn-ghost browser-toolbar-btn" disabled={!canGoBack} onClick={() => withWebview(getActiveWebview(), (wv) => wv.goBack(), undefined)} aria-label="Back"><ArrowLeft size={16} /></button>
            <button type="button" className="icon-btn icon-btn-ghost browser-toolbar-btn" disabled={!canGoForward} onClick={() => withWebview(getActiveWebview(), (wv) => wv.goForward(), undefined)} aria-label="Forward"><ArrowRight size={16} /></button>
            <button type="button" className="icon-btn icon-btn-ghost browser-toolbar-btn" onClick={() => withWebview(getActiveWebview(), (wv) => wv.reload(), undefined)} aria-label="Reload"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
            <form className="browser-url-form" onSubmit={(event) => { event.preventDefault(); navigate() }}>
              <Globe size={14} className="browser-url-icon" />
              <input className="browser-url-input" value={inputUrl} onFocus={() => { editingAddress.current = true }} onBlur={() => { editingAddress.current = false }} onChange={(event) => setInputUrl(event.target.value)} placeholder="Search or enter URL" spellCheck={false} />
            </form>
            <button
              type="button"
              className={`icon-btn icon-btn-ghost browser-toolbar-btn${picking ? ' active' : ''}`}
              onClick={() => void chooseElement()}
              disabled={!activeTab || activeTab.url === BLANK_URL}
              aria-label={picking ? 'Cancel element selection' : 'Point and click to select element'}
              title={picking ? 'Cancel element selection (Esc)' : 'Point and click to select element'}
            >
              <Crosshair size={16} />
            </button>
            </div>
            <div className="browser-menu-wrap">
              <button
                ref={menuButtonRef}
                type="button"
                className="icon-btn icon-btn-ghost browser-toolbar-btn"
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
                  <div className="browser-menu browser-menu-floating" ref={menuRef} style={menuStyle} role="menu">
                    <button type="button" role="menuitemcheckbox" aria-checked={access.allowed} disabled={browserBusy} onClick={() => void changeAccess(!access.allowed)}>
                      <span>Agents Browser Access</span><span className={`browser-access-toggle${access.allowed ? ' enabled' : ''}`} aria-hidden="true" />
                    </button>
                    <div className="browser-menu-separator" />
                    <div className="browser-menu-actions" style={{ display: 'contents' }} inert={agentControlled}>
                    <button type="button" onClick={() => { withWebview(getActiveWebview(), (wv) => wv.reloadIgnoringCache(), undefined); setMenuOpen(false) }}>
                      <span className="browser-menu-label"><ArrowSyncRegular />Hard reload</span>
                    </button>
                    <button type="button" onClick={() => { withWebview(getActiveWebview(), (wv) => wv.openDevTools(), undefined); setMenuOpen(false) }}>
                      <span className="browser-menu-label"><WindowDevToolsRegular />DevTools</span>
                    </button>
                    <button type="button" onClick={() => updateTab(activeTab.id, { deviceToolbarOpen: !activeTab.deviceToolbarOpen })}>
                      <span>Show device toolbar</span>{activeTab.deviceToolbarOpen && <Check size={14} />}
                    </button>
                    <div className="browser-menu-zoom"><span>Zoom</span><button type="button" onClick={() => changeZoom(-0.1)}><Minus size={13} /></button><span>{Math.round(activeTab.zoomFactor * 100)}%</span><button type="button" onClick={() => changeZoom(0.1)}><Plus size={13} /></button></div>
                    <button type="button" onClick={() => updateTab(activeTab.id, { ownerThreadId: activeTab.ownerThreadId === null ? activeThreadId : null })}>
                      <span>{activeTab.ownerThreadId === null ? 'Unpin from all threads' : 'Pin across threads'}</span>{activeTab.ownerThreadId === null ? <PinOffRegular /> : <PinRegular />}
                    </button>
                    <div className="browser-menu-separator" />
                    <button type="button" onClick={() => { void window.mousse.browser.clearCookies(); setMenuOpen(false) }}>
                      <span className="browser-menu-label"><CookiesRegular />Clear cookies</span>
                      <DeleteDismissRegular />
                    </button>
                    <button type="button" onClick={() => { void window.mousse.browser.clearCache(); setMenuOpen(false) }}>
                      <span className="browser-menu-label"><BroomRegular />Clear cache</span>
                    </button>
                    </div>
                  </div>
                </FloatingPortal>
              )}
            </div>
          </div>
          {activeTab?.deviceToolbarOpen && (
            <div className="browser-device-toolbar">
              <select value={activeTab.devicePreset} onChange={(event) => updateTab(activeTab.id, { devicePreset: event.target.value })}>
                {DEVICE_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
              </select>
              <span>{DEVICE_PRESETS.find((preset) => preset.id === activeTab.devicePreset)?.width ?? 'Auto'} px</span>
            </div>
          )}
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
            onReady={registerWebview}
            onState={handleWebviewState}
            onNavState={handleNavState}
          />
        ))}
      </KeepMounted>
      </KeepMounted>
      </KeepMountedStack>
    </div>
  )
}
