import { WebContentsView, type BrowserWindow } from 'electron'
import type { BrowserBounds, BrowserState } from '../../shared/types'
import { isAllowedBrowserPopupUrl, MOUSSE_BROWSER_PARTITION } from './browserPolicy'

const BLANK_URL = 'about:blank'

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

export class BrowserViewManager {
  private view: WebContentsView | null = null
  private getWindow: (() => BrowserWindow | null) | null = null
  private sendState: ((state: BrowserState) => void) | null = null
  private visible = false
  private attached = false
  private lastBounds: BrowserBounds | null = null

  init(getWindow: () => BrowserWindow | null, sendState: (state: BrowserState) => void): void {
    this.getWindow = getWindow
    this.sendState = sendState
  }

  private attachView(): boolean {
    const win = this.getWindow?.()
    if (!win || win.isDestroyed() || !this.view) return false
    if (!this.attached) {
      win.contentView.addChildView(this.view)
      this.attached = true
    }
    return true
  }

  private detachView(): void {
    const win = this.getWindow?.()
    if (!win || win.isDestroyed() || !this.view || !this.attached) return
    win.contentView.removeChildView(this.view)
    this.attached = false
  }

  private ensureView(): WebContentsView | null {
    const win = this.getWindow?.()
    if (!win || win.isDestroyed()) return null

    if (!this.view) {
      this.view = new WebContentsView({
        webPreferences: {
          partition: MOUSSE_BROWSER_PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true
        }
      })

      const wc = this.view.webContents
      wc.setWindowOpenHandler(({ url }) => {
        if (!isAllowedBrowserPopupUrl(url)) return { action: 'deny' }
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: win,
            autoHideMenuBar: true,
            webPreferences: {
              session: wc.session,
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true
            }
          }
        }
      })

      const emit = () => this.sendState?.(this.getState())
      wc.on('did-start-loading', emit)
      wc.on('did-stop-loading', emit)
      wc.on('did-navigate', emit)
      wc.on('did-navigate-in-page', emit)
      wc.on('page-title-updated', emit)
    }

    if (!this.visible || !this.attachView()) return this.view
    this.view.setVisible(true)
    if (this.lastBounds) {
      this.applyBounds(this.lastBounds)
    }

    return this.view
  }

  private clampBounds(bounds: BrowserBounds): BrowserBounds {
    const win = this.getWindow?.()
    const contentBounds = win && !win.isDestroyed() ? win.getContentBounds() : null
    const maxWidth = Math.max(0, contentBounds?.width ?? bounds.x + bounds.width)
    const maxHeight = Math.max(0, contentBounds?.height ?? bounds.y + bounds.height)
    const x = Math.min(maxWidth, Math.max(0, Math.round(bounds.x)))
    const y = Math.min(maxHeight, Math.max(0, Math.round(bounds.y)))
    const right = Math.min(maxWidth, Math.max(x, Math.round(bounds.x + bounds.width)))
    const bottom = Math.min(maxHeight, Math.max(y, Math.round(bounds.y + bounds.height)))

    return {
      x,
      y,
      width: Math.max(0, right - x),
      height: Math.max(0, bottom - y)
    }
  }

  private applyBounds(bounds: BrowserBounds): void {
    if (!this.view) return
    const clamped = this.clampBounds(bounds)
    if (clamped.width <= 0 || clamped.height <= 0) {
      this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      return
    }
    this.view.setBounds(clamped)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (!this.view) {
      if (visible) this.ensureView()
      return
    }

    if (visible) {
      this.attachView()
      this.view.setVisible(true)
      if (this.lastBounds) {
        this.applyBounds(this.lastBounds)
      }
      return
    }

    this.view.setVisible(false)
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    this.detachView()
  }

  setBounds(bounds: BrowserBounds): void {
    this.lastBounds = this.clampBounds(bounds)
    if (!this.visible || !this.view) return
    this.applyBounds(this.lastBounds)
  }

  navigate(input: string): void {
    const url = normalizeUrl(input)
    const view = this.ensureView()
    if (!view) return
    void view.webContents.loadURL(url)
  }

  goBack(): void {
    const view = this.ensureView()
    if (view?.webContents.canGoBack()) view.webContents.goBack()
  }

  goForward(): void {
    const view = this.ensureView()
    if (view?.webContents.canGoForward()) view.webContents.goForward()
  }

  reload(): void {
    this.ensureView()?.webContents.reload()
  }

  openExternal(url: string): void {
    this.navigate(url)
  }

  getState(): BrowserState {
    const wc = this.view?.webContents
    if (!wc) {
      return { url: BLANK_URL, canGoBack: false, canGoForward: false, isLoading: false }
    }
    return {
      url: wc.getURL() || BLANK_URL,
      canGoBack: wc.canGoBack(),
      canGoForward: wc.canGoForward(),
      isLoading: wc.isLoading()
    }
  }

  destroy(): void {
    if (!this.view) return
    this.detachView()
    this.view.webContents.close()
    this.view = null
  }
}
