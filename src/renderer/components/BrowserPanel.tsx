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
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { useAppStore } from '../stores/appStore'
import { MousseLogoOutline } from './MousseLogoOutline'

const BLANK_URL = 'about:blank'
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
  active: boolean
  onReady: (id: string, webview: HTMLWebViewElement | null) => void
  onState: (id: string, patch: Partial<BrowserTabState>) => void
  onNavState: (id: string, nav: WebviewNavState) => void
}

function BrowserWebview({ tab, active, onReady, onState, onNavState }: BrowserWebviewProps) {
  const ref = useRef<HTMLWebViewElement>(null)
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

    const popup = (event: Event) => {
      event.preventDefault()
      const url = (event as Event & { url?: string }).url
      if (url) withWebview(webview, (wv) => void wv.loadURL(url), undefined)
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
    webview.addEventListener('new-window', popup)

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
      webview.removeEventListener('new-window', popup)
    }
  }, [tab.id])

  useEffect(() => {
    if (!readyRef.current) return
    withWebview(ref.current, (wv) => {
      wv.setZoomFactor(tab.zoomFactor)
    }, undefined)
  }, [tab.zoomFactor])

  const preset = DEVICE_PRESETS.find((item) => item.id === tab.devicePreset)
  return (
    <div
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
        className={`browser-webview${tab.url === BLANK_URL ? ' browser-webview-hidden' : ''}`}
        src={tab.url}
        partition="persist:mousse-browser"
        webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
      />
    </div>
  )
}

export function BrowserPanel() {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const tabs = useAppStore((s) => s.browserTabs)
  const activeByThread = useAppStore((s) => s.browserActiveTabByThread)
  const addTab = useAppStore((s) => s.addBrowserTab)
  const closeTab = useAppStore((s) => s.closeBrowserTab)
  const updateTab = useAppStore((s) => s.updateBrowserTab)
  const setActiveTab = useAppStore((s) => s.setActiveBrowserTab)
  const addElementAttachment = useAppStore((s) => s.addBrowserElementAttachment)
  const webviews = useRef(new Map<string, HTMLWebViewElement>())
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

  // Close the overflow menu when there is no active tab to act on.
  useEffect(() => {
    if (!hasVisibleTabs || !activeTab) setMenuOpen(false)
  }, [activeTab, hasVisibleTabs])

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
    open: menuOpen && Boolean(activeTab),
    anchorRef: menuButtonRef,
    contentRef: menuRef,
    placement: 'below-end',
    gap: 5,
    deps: [activeTab?.id, activeTab?.deviceToolbarOpen, activeTab?.zoomFactor, activeTab?.ownerThreadId]
  })

  const registerWebview = useCallback((id: string, webview: HTMLWebViewElement | null) => {
    if (webview) webviews.current.set(id, webview)
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
    updateTab(activeTab.id, { url })
    withWebview(webview, (wv) => void wv.loadURL(url), undefined)
  }

  const chooseElement = async () => {
    const webview = getActiveWebview()
    if (!webview || !activeTab || activeTab.url === BLANK_URL) return
    if (picking) {
      withWebview(webview, (wv) => void wv.executeJavaScript('window.__mousseCancelElementPicker?.()', true), undefined)
      setPicking(false)
      return
    }
    if (!isWebviewGuestReady(webview)) return
    setPicking(true)
    try {
      const result = await withWebview(
        webview,
        (wv) => wv.executeJavaScript(PICK_ELEMENT_SCRIPT, true) as Promise<Omit<BrowserElementAttachment, 'id'> | null>,
        Promise.resolve(null)
      )
      if (result) addElementAttachment(activeThreadId, { ...result, id: crypto.randomUUID() })
    } catch {
      // Navigation or a page teardown cancels the picker promise.
    } finally {
      setPicking(false)
    }
  }

  const changeZoom = (delta: number) => {
    if (!activeTab) return
    updateTab(activeTab.id, { zoomFactor: Math.min(2, Math.max(0.5, activeTab.zoomFactor + delta)) })
  }

  return (
    <div
      className={`browser-panel${picking ? ' browser-panel-picking' : ''}${
        menuOpen ? ' browser-panel-menu-open' : ''
      }${!hasVisibleTabs ? ' browser-panel-empty' : ''}`}
    >
      <div className="browser-tabs">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`browser-tab${tab.id === activeTab?.id ? ' active' : ''}`}
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
              {menuOpen && activeTab && (
                <FloatingPortal>
                  <div className="browser-menu browser-menu-floating" ref={menuRef} style={menuStyle} role="menu">
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
          <div className="browser-content">
            {tabs.map((tab) => (
              <BrowserWebview
                key={tab.id}
                tab={tab}
                active={tab.id === activeTab?.id}
                onReady={registerWebview}
                onState={handleWebviewState}
                onNavState={handleNavState}
              />
            ))}
          </div>
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
    </div>
  )
}
