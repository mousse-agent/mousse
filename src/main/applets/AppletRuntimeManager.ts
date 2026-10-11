import {
  session,
  View,
  WebContentsView,
  type BrowserWindow,
  type Rectangle,
  type Session
} from 'electron'
import { randomUUID } from 'node:crypto'
import type { AppletAppearance } from '../../shared/appletAppearance'
import { APPLET_EVENT_PREFIX, APPLET_APPLY_APPEARANCE, appletDocument, type AppletSource } from './document'

// Fail closed between profile managers without retaining a former owner.
const denyRequests: Parameters<Session['webRequest']['onBeforeRequest']>[0] = (
  _details,
  callback
) => callback({ cancel: true })
const denyPermissionRequest: Parameters<Session['setPermissionRequestHandler']>[0] = (
  _wc,
  _permission,
  callback
) => callback(false)
const denyPermission = () => false

export interface AppletMount {
  runtimeId: string
  threadId: string
  revisionId: string
  source: AppletSource
  state?: unknown
  appearance?: AppletAppearance
  bounds: Rectangle
  clip: Rectangle
}
export interface AppletRuntimeEvent {
  runtimeId: string
  threadId: string
  revisionId: string
  type: 'ready' | 'resize' | 'state' | 'error' | 'conversation-input' | 'visual-changed' | 'released'
  payload: unknown
}
interface Runtime {
  mount: AppletMount
  container: View
  guest: WebContentsView
  messages: number
  epoch: number
  slot: number
  documentUrl: string
  heartbeat: number
  visible: boolean
  parkedAt?: number
}

/** All callers must authenticate the owner renderer and retrieve source from durable storage. */
export class AppletRuntimeManager {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly documents = new Map<string, string>()
  private readonly sessions = new Map<number, Session>()
  private readonly scrollPositions = new Map<
    string,
    Map<string, { path: number[]; top: number; left: number }>
  >()
  private readonly partitionPrefix: string
  private destroyed = false
  private readonly onOwnerClosed = () => this.destroy()
  private readonly watchdog: ReturnType<typeof setInterval>
  constructor(
    private readonly owner: BrowserWindow,
    private readonly emit: (event: AppletRuntimeEvent) => void
  ) {
    this.partitionPrefix = `mousse-applet-owner-${owner.webContents.id}`
    owner.once('closed', this.onOwnerClosed)
    this.watchdog = setInterval(() => {
      const now = Date.now()
      for (const runtime of this.runtimes.values()) {
        if (!runtime.visible || owner.isDestroyed() || !owner.isVisible() || owner.isMinimized()) {
          runtime.heartbeat = now
          continue
        }
        if (now - runtime.heartbeat > 5000) {
          this.notify(
            runtime,
            'error',
            'The applet stopped responding and was stopped. Restart it to try again.'
          )
          this.unmount(runtime.mount.runtimeId)
        }
      }
    }, 500)
    this.watchdog.unref()
  }

  async mount(input: AppletMount): Promise<void> {
    if (this.destroyed) throw new Error('Applet manager is closed')
    this.unmount(input.runtimeId)
    if (this.owner.isDestroyed()) throw new Error('Applet owner is closed')
    if (this.runtimes.size >= 3) {
      const oldest = [...this.runtimes.values()].filter((item) => item.parkedAt !== undefined)
        .sort((a, b) => a.parkedAt! - b.parkedAt!)[0]
      if (!oldest) throw new Error('Only three applets may run at once')
      this.notify(oldest, 'released', null)
      this.unmount(oldest.mount.runtimeId)
    }
    const slot = [0, 1, 2].find(
      (index) => ![...this.runtimes.values()].some((runtime) => runtime.slot === index)
    )!
    // Electron retains partition sessions. Reuse three isolated slots instead of
    // allocating an unbounded number as the user scrolls through a transcript.
    let isolated = this.sessions.get(slot)
    if (!isolated) {
      const ownsDocument = (url: string) =>
        [...this.runtimes.values()].some(
          (runtime) => runtime.slot === slot && runtime.documentUrl === url
        )
      isolated = session.fromPartition(`${this.partitionPrefix}-${slot}`, { cache: false })
      // A new profile manager reuses the owner's bounded ephemeral partitions.
      // The previous manager detached its handlers when it was destroyed.
      isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
      isolated.setPermissionCheckHandler(() => false)
      isolated.setDevicePermissionHandler(() => false)
      isolated.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('data:') && !ownsDocument(details.url) })
      )
      isolated.protocol.handle(
        'mousse-applet',
        (request) =>
          new Response(ownsDocument(request.url) ? this.documents.get(request.url) : '', {
            status: ownsDocument(request.url) ? 200 : 403,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'X-DNS-Prefetch-Control': 'off',
              'Content-Security-Policy': 'sandbox allow-scripts'
            }
          })
      )
      isolated.on('will-download', (event) => event.preventDefault())
      this.sessions.set(slot, isolated)
    }
    const guest = new WebContentsView({
      webPreferences: {
        session: isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: true
      }
    })
    guest.setBackgroundColor('#00000000')
    const container = new View()
    container.addChildView(guest)
    this.owner.contentView.addChildView(container)
    const documentUrl = `mousse-applet://runtime/${randomUUID()}`
    this.documents.set(
      documentUrl,
      appletDocument(input.source, input.state, input.appearance, [
        ...(this.scrollPositions
          .get(JSON.stringify([input.threadId, input.revisionId]))
          ?.values() ?? [])
      ])
    )
    const runtime: Runtime = {
      mount: input,
      container,
      guest,
      messages: 0,
      epoch: Date.now(),
      slot,
      documentUrl,
      heartbeat: Date.now(),
      visible: false
    }
    this.runtimes.set(input.runtimeId, runtime)
    const wc = guest.webContents
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (event) => event.preventDefault())
    wc.on('will-frame-navigate', (event) => event.preventDefault())
    wc.on('will-attach-webview', (event) => event.preventDefault())
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && !this.owner.isDestroyed()) {
        event.preventDefault()
        this.owner.webContents.focus()
      }
    })
    wc.on('console-message', (event) => this.receive(runtime, event.message))
    wc.on('render-process-gone', () => {
      this.notify(runtime, 'error', 'The applet stopped. Restart it to try again.')
      if (this.runtimes.get(input.runtimeId) === runtime) this.unmount(input.runtimeId)
    })
    wc.on('unresponsive', () =>
      this.notify(runtime, 'error', 'The applet is not responding. Restart it to try again.')
    )
    try {
      this.layout(input.runtimeId, input.bounds, input.clip)
      await wc.loadURL(documentUrl)
    } catch (error) {
      if (this.runtimes.get(input.runtimeId) === runtime) this.unmount(input.runtimeId)
      throw error
    }
  }

  layout(runtimeId: string, bounds: Rectangle, clip: Rectangle): void {
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime || this.owner.isDestroyed()) return
    for (const rect of [bounds, clip]) {
      if (
        ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
        rect.width < 0 ||
        rect.height < 0 ||
        rect.width > 8192 ||
        rect.height > 8192
      )
        throw new Error('Invalid applet bounds')
    }
    const [width, height] = this.owner.getContentSize()
    const zoom = this.owner.webContents.getZoomFactor()
    runtime.guest.webContents.setZoomFactor(zoom)
    // Renderer rectangles are CSS pixels; native Views use device-independent
    // pixels. OS display scaling is handled by Electron, host page zoom is not.
    const scaled = (rect: Rectangle): Rectangle => ({
      x: rect.x * zoom,
      y: rect.y * zoom,
      width: rect.width * zoom,
      height: rect.height * zoom
    })
    const nativeBounds = scaled(bounds),
      nativeClip = scaled(clip)
    const left = Math.max(0, nativeBounds.x, nativeClip.x),
      top = Math.max(0, nativeBounds.y, nativeClip.y)
    const right = Math.min(
        width,
        nativeBounds.x + nativeBounds.width,
        nativeClip.x + nativeClip.width
      ),
      bottom = Math.min(
        height,
        nativeBounds.y + nativeBounds.height,
        nativeClip.y + nativeClip.height
      )
    runtime.parkedAt = undefined
    runtime.visible = right > left && bottom > top
    runtime.container.setBounds({
      x: Math.round(left),
      y: Math.round(top),
      width: Math.max(0, Math.round(right) - Math.round(left)),
      height: Math.max(0, Math.round(bottom) - Math.round(top))
    })
    runtime.guest.setBounds({
      x: Math.round(nativeBounds.x) - Math.round(left),
      y: Math.round(nativeBounds.y) - Math.round(top),
      width: Math.round(nativeBounds.width),
      height: Math.round(nativeBounds.height)
    })
    // Move the hidden surface before revealing it at the settled DOM position.
    runtime.container.setVisible(runtime.visible)
    runtime.mount.bounds = bounds
    runtime.mount.clip = clip
  }

  async appearance(runtimeId: string, appearance: AppletAppearance): Promise<void> {
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime) throw new Error('Applet is not running')
    const argument = JSON.stringify(appearance).replace(/</g, '\\u003c')
    await runtime.guest.webContents.executeJavaScript(`window[${JSON.stringify(APPLET_APPLY_APPEARANCE)}](${argument})`)
    if (this.runtimes.get(runtimeId) !== runtime) throw new Error('Applet is no longer running')
    runtime.mount.appearance = appearance
  }

  async snapshot(runtimeId: string): Promise<string | null> {
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime) throw new Error('Applet is not running')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const image = await Promise.race([
        runtime.guest.webContents.capturePage(undefined, {stayHidden:true}),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 150) })
      ])
      if (!image || image.isEmpty()) return null
      const png = image.toPNG()
      return png.length <= 8 * 1024 * 1024 ? `data:image/png;base64,${png.toString('base64')}` : null
    } finally {
      clearTimeout(timer)
    }
  }

  suspend(runtimeId: string): void {
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime) throw new Error('Applet is not running')
    runtime.visible = false
    runtime.container.setVisible(false)
    // Refresh already reported targets without delaying host scrolling. This
    // catches the final offset even if high-frequency guest reports were capped.
    const positions = [
      ...(this.scrollPositions
        .get(JSON.stringify([runtime.mount.threadId, runtime.mount.revisionId]))
        ?.values() ?? [])
    ]
    if (positions.length)
      void runtime.guest.webContents
        .executeJavaScript(
          `(${JSON.stringify(positions)}).map(position=>{let node=document.documentElement;for(const index of position.path)node=node?.children[index];return node?{path:position.path,top:node.scrollTop,left:node.scrollLeft}:null})`
        )
        .then((values) => {
          if (this.runtimes.get(runtimeId) !== runtime || !Array.isArray(values)) return
          for (const value of values.slice(0, 64)) this.rememberScroll(runtime, value)
        })
        .catch(() => {})
  }

  park(runtimeId: string): void {
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime) return
    this.suspend(runtimeId)
    runtime.parkedAt ??= Date.now()
  }

  unmount(runtimeId: string): void {
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime) return
    this.runtimes.delete(runtimeId)
    this.documents.delete(runtime.documentUrl)
    if (!this.owner.isDestroyed()) this.owner.contentView.removeChildView(runtime.container)
    runtime.container.removeChildView(runtime.guest)
    // close() avoids an untrusted beforeunload handler and terminates a busy renderer.
    if (!runtime.guest.webContents.isDestroyed())
      runtime.guest.webContents.close({ waitForBeforeUnload: false })
  }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.scrollPositions.clear()
    this.owner.removeListener('closed', this.onOwnerClosed)
    clearInterval(this.watchdog)
    for (const id of this.runtimes.keys()) this.unmount(id)
    for (const isolated of this.sessions.values()) {
      isolated.protocol.unhandle('mousse-applet')
      isolated.webRequest.onBeforeRequest(denyRequests)
      isolated.setPermissionRequestHandler(denyPermissionRequest)
      isolated.setPermissionCheckHandler(denyPermission)
      isolated.setDevicePermissionHandler(denyPermission)
      isolated.removeAllListeners('will-download')
    }
    this.sessions.clear()
    this.documents.clear()
  }
  capture(runtimeId: string) {
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime) throw new Error('Applet is not running')
    return runtime.guest.webContents.capturePage()
  }

  private notify(runtime: Runtime, type: AppletRuntimeEvent['type'], payload: unknown): void {
    if (this.runtimes.get(runtime.mount.runtimeId) !== runtime) return
    const { runtimeId, threadId, revisionId } = runtime.mount
    this.emit({ runtimeId, threadId, revisionId, type, payload })
  }
  private rememberScroll(runtime: Runtime, payload: unknown): void {
    const value = payload as { path: unknown; top: unknown; left: unknown } | null
    if (
      !value ||
      !Array.isArray(value.path) ||
      value.path.length > 16 ||
      !value.path.every((index) => Number.isInteger(index) && index >= 0 && index <= 2048) ||
      typeof value.top !== 'number' ||
      typeof value.left !== 'number' ||
      ![value.top, value.left].every((offset) => Number.isFinite(offset) && Math.abs(offset) <= 1e7)
    )
      return
    const key = JSON.stringify([runtime.mount.threadId, runtime.mount.revisionId])
    const positions = this.scrollPositions.get(key) ?? new Map()
    const target = JSON.stringify(value.path)
    if (positions.size >= 64 && !positions.has(target))
      positions.delete(positions.keys().next().value!)
    positions.set(target, { path: value.path, top: value.top, left: value.left })
    this.scrollPositions.delete(key)
    this.scrollPositions.set(key, positions)
    if (this.scrollPositions.size > 32)
      this.scrollPositions.delete(this.scrollPositions.keys().next().value!)
  }
  private receive(runtime: Runtime, message: string): void {
    if (!message.startsWith(APPLET_EVENT_PREFIX) || message.length > 65536) return
    if (Date.now() - runtime.epoch >= 1000) {
      runtime.epoch = Date.now()
      runtime.messages = 0
    }
    if (++runtime.messages > 30) return
    try {
      const event = JSON.parse(message.slice(APPLET_EVENT_PREFIX.length)) as {
        type: string
        payload: unknown
      }
      if (event.type === 'heartbeat') runtime.heartbeat = Date.now()
      else if (event.type === 'ready') this.notify(runtime, 'ready', null)
      else if (event.type === 'visual-changed') this.notify(runtime, 'visual-changed', null)
      else if (event.type === 'scroll-changed' && Array.isArray(event.payload)) {
        for (const position of event.payload.slice(0, 64)) this.rememberScroll(runtime, position)
        this.notify(runtime, 'visual-changed', null)
      } else if (event.type === 'scroll-position') {
        this.rememberScroll(runtime, event.payload)
      } else if (
        event.type === 'resize' &&
        typeof event.payload === 'number' &&
        Number.isFinite(event.payload)
      )
        this.notify(runtime, 'resize', Math.max(120, Math.min(1200, Math.round(event.payload))))
      else if (event.type === 'state') this.notify(runtime, 'state', event.payload)
      else if (
        (event.type === 'error' || event.type === 'conversation-input') &&
        typeof event.payload === 'string'
      )
        this.notify(
          runtime,
          event.type,
          event.payload.slice(0, event.type === 'error' ? 2000 : 4000)
        )
    } catch {
      /* Guest reports are untrusted; malformed messages are ignored. */
    }
  }
}
