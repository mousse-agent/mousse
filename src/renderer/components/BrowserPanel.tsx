import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, RefreshCw } from 'lucide-react'
import type { BrowserState } from '../../shared/types'
import { MousseLogoOutline } from './MousseLogoOutline'

const BLANK_URL = 'about:blank'

function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return BLANK_URL
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^[\w-]+(\.[\w-]+)+/.test(trimmed)) return `https://${trimmed}`
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

function displayUrl(state: BrowserState): string {
  if (!state.url || state.url === BLANK_URL) return ''
  return state.url
}

export function BrowserPanel() {
  const webviewRef = useRef<HTMLWebViewElement>(null)
  const isEditingAddressRef = useRef(false)
  const [inputUrl, setInputUrl] = useState('')
  const [state, setState] = useState<BrowserState>({
    url: BLANK_URL,
    canGoBack: false,
    canGoForward: false,
    isLoading: false
  })

  const readState = useCallback((webview: HTMLWebViewElement): BrowserState => {
    return {
      url: webview.getURL() || BLANK_URL,
      canGoBack: webview.canGoBack(),
      canGoForward: webview.canGoForward(),
      isLoading: webview.isLoading()
    }
  }, [])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return

    const updateState = () => {
      const next = readState(webview)
      setState(next)
      if (!isEditingAddressRef.current) {
        setInputUrl(displayUrl(next))
      }
    }

    const loadPopupInPlace = (event: Event) => {
      event.preventDefault()
      const url = (event as Event & { url?: string }).url
      if (url) {
        void webview.loadURL(url)
      }
    }

    webview.addEventListener('dom-ready', updateState)
    webview.addEventListener('did-start-loading', updateState)
    webview.addEventListener('did-stop-loading', updateState)
    webview.addEventListener('did-navigate', updateState)
    webview.addEventListener('did-navigate-in-page', updateState)
    webview.addEventListener('new-window', loadPopupInPlace)

    return () => {
      webview.removeEventListener('dom-ready', updateState)
      webview.removeEventListener('did-start-loading', updateState)
      webview.removeEventListener('did-stop-loading', updateState)
      webview.removeEventListener('did-navigate', updateState)
      webview.removeEventListener('did-navigate-in-page', updateState)
      webview.removeEventListener('new-window', loadPopupInPlace)
    }
  }, [readState])

  const navigate = useCallback(() => {
    const target = inputUrl.trim()
    const webview = webviewRef.current
    if (!webview) return

    isEditingAddressRef.current = false
    if (!target) {
      void webview.loadURL(BLANK_URL)
      setState({
        url: BLANK_URL,
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
        isLoading: false
      })
      setInputUrl('')
      return
    }

    const url = normalizeUrl(target)
    void webview.loadURL(url)
    const next = { ...readState(webview), url, isLoading: true }
    setState(next)
    setInputUrl(displayUrl(next))
  }, [inputUrl, readState])

  const goBack = useCallback(() => {
    const webview = webviewRef.current
    if (!webview || !webview.canGoBack()) return
    webview.goBack()
  }, [])

  const goForward = useCallback(() => {
    const webview = webviewRef.current
    if (!webview || !webview.canGoForward()) return
    webview.goForward()
  }, [])

  const reload = useCallback(() => {
    webviewRef.current?.reload()
  }, [])

  const isBlank = !state.url || state.url === BLANK_URL

  return (
    <div className="browser-panel">
      <div className="browser-toolbar">
        <button
          type="button"
          className="icon-btn icon-btn-ghost browser-toolbar-btn"
          disabled={!state.canGoBack}
          onClick={goBack}
          aria-label="Back"
        >
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-ghost browser-toolbar-btn"
          disabled={!state.canGoForward}
          onClick={goForward}
          aria-label="Forward"
        >
          <ArrowRight size={16} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-ghost browser-toolbar-btn"
          onClick={reload}
          aria-label="Reload"
        >
          <RefreshCw size={16} strokeWidth={2} className={state.isLoading ? 'spin' : ''} />
        </button>
        <form
          className="browser-url-form"
          onSubmit={(e) => {
            e.preventDefault()
            navigate()
          }}
        >
          <Globe size={14} className="browser-url-icon" />
          <input
            type="text"
            className="browser-url-input"
            value={inputUrl}
            onFocus={() => {
              isEditingAddressRef.current = true
            }}
            onBlur={() => {
              isEditingAddressRef.current = false
              setInputUrl(displayUrl(state))
            }}
            onChange={(e) => {
              isEditingAddressRef.current = true
              setInputUrl(e.target.value)
            }}
            placeholder="Search or enter URL"
            spellCheck={false}
          />
        </form>
      </div>
      <div className={`browser-content${isBlank ? ' browser-content-empty' : ''}`}>
        {isBlank && (
          <div className="browser-blank" aria-hidden="true">
            <MousseLogoOutline className="browser-blank-logo" />
          </div>
        )}
        <webview
          ref={webviewRef}
          className={`browser-webview${isBlank ? ' browser-webview-hidden' : ''}`}
          src={BLANK_URL}
          partition="persist:mousse-browser"
          webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
        />
      </div>
    </div>
  )
}
