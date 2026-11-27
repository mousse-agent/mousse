import { session, type BrowserWindow, type Session, type WebContents, type WebPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import { markWebContentsRole } from '../diagnostics/webContentsRoles'
import type { AppletAppearance } from '../../shared/appletAppearance'
import { appletFrameHeight } from '../../shared/appletRuntime'
import { appletToRelease } from './slots'
import { APPLET_EVENT_PREFIX, APPLET_APPLY_APPEARANCE, appletDocument, type AppletSource } from './document'

/** How long a shown applet may leave a liveness probe unanswered before it is stopped. */
export const APPLET_UNRESPONSIVE_MS = 5000
/** Every applet page address; the rest of the address is minted per mount and is valid for one page only. */
export const APPLET_DOCUMENT_PREFIX = 'mousse-applet://runtime/'
const WHEEL_PREFIX = `${APPLET_EVENT_PREFIX}{"type":"wheel"`

/** A `<webview>` that asks for an applet page; such a webview never takes the browser's path. */
export function isAppletWebviewSource(src: unknown): boolean {
  return typeof src === 'string' && /^mousse-applet:/i.test(src.trim())
}

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

/** Every slot holds an applet on screen; the card waits until one comes free. */
export class AppletSlotsBusyError extends Error {
  constructor() {
    super('Every applet slot is in use')
  }
}

export interface AppletMount {
  runtimeId: string
  /** Where the page shows; the side panel may take a slot from a transcript card that is on screen. */
  host?: 'transcript' | 'panel'
  threadId: string
  revisionId: string
  source: AppletSource
  state?: unknown
  appearance?: AppletAppearance
}
export interface AppletRuntimeEvent {
  runtimeId: string
  threadId: string
  revisionId: string
  type: 'ready' | 'resize' | 'state' | 'error' | 'conversation-input' | 'wheel' | 'escape' | 'released'
  payload: unknown
}
interface Runtime {
  mount: AppletMount
  /** The page, once the window's `<webview>` for this address attached. */
  guest: WebContents | null
  /** The address was claimed by a `<webview>`; it is never valid for a second one. */
  claimed: boolean
  messages: number
  epoch: number
  slot: number
  documentUrl: string
  /** When the page last answered a liveness probe (or could not be expected to). */
  heartbeat: number
  /** A probe is waiting for the page's answer. */
  probing: boolean
  wheels: number
  wheelEpoch: number
  /** False while the applet's card is out of sight; such an applet is not watched and may be released for a new one. */
  visible: boolean
  parkedAt?: number
}

/**
 * The applets of one window. Each runs in a `<webview>` the window's page draws, so the page's own scrolling, clipping
 * and layering place it; this class owns everything else about the page: its isolated session, its one document, what
 * it may do, its liveness and its end. All callers must authenticate the owner renderer and retrieve source from
 * durable storage.
 */
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
    // Liveness is asked for, not volunteered: the probe is a task on the page's main thread, which a loop blocks but
    // timer throttling (a covered or hidden window, Chromium's intensive throttling) does not delay.
    this.watchdog = setInterval(() => {
      const now = Date.now()
      for (const runtime of [...this.runtimes.values()]) {
        if (!runtime.guest || !runtime.visible || owner.isDestroyed() || !owner.isVisible() || owner.isMinimized()) {
          runtime.heartbeat = now
          continue
        }
        if (now - runtime.heartbeat > APPLET_UNRESPONSIVE_MS) {
          this.notify(
            runtime,
            'error',
            'The applet stopped responding and was stopped. Restart it to try again.'
          )
          this.unmount(runtime.mount.runtimeId, { crash: true })
        } else this.probe(runtime)
      }
    }, 500)
    this.watchdog.unref()
  }

  /** Prepares an applet's page and returns the one address its `<webview>` may load. */
  mount(input: AppletMount): string {
    if (this.destroyed) throw new Error('Applet manager is closed')
    this.unmount(input.runtimeId)
    if (this.owner.isDestroyed()) throw new Error('Applet owner is closed')
    if (this.runtimes.size >= 3) {
      const released = appletToRelease([...this.runtimes.values()], input)
      if (!released) throw new AppletSlotsBusyError()
      this.notify(released, 'released', null)
      this.unmount(released.mount.runtimeId)
    }
    const slot = [0, 1, 2].find(
      (index) => ![...this.runtimes.values()].some((runtime) => runtime.slot === index)
    )!
    this.isolatedSession(slot)
    const documentUrl = `${APPLET_DOCUMENT_PREFIX}${randomUUID()}`
    this.documents.set(
      documentUrl,
      appletDocument(input.source, input.state, input.appearance, [
        ...(this.scrollPositions
          .get(JSON.stringify([input.threadId, input.revisionId]))
          ?.values() ?? [])
      ], { transparent: true })
    )
    this.runtimes.set(input.runtimeId, {
      mount: input,
      guest: null,
      claimed: false,
      messages: 0,
      epoch: Date.now(),
      slot,
      documentUrl,
      heartbeat: Date.now(),
      probing: false,
      wheels: 0,
      wheelEpoch: 0,
      visible: true
    })
    return documentUrl
  }

  /**
   * Decides a `<webview>` that asks for an applet page (`will-attach-webview`). Only an address this manager minted
   * and no webview has claimed attaches, into that applet's own session with fixed preferences; the page supplies no
   * partition or preload of its own. Returns false to refuse the attach.
   */
  attach(webPreferences: WebPreferences, params: Record<string, string>): boolean {
    if (this.destroyed || this.owner.isDestroyed()) return false
    const runtime = [...this.runtimes.values()].find((item) => item.documentUrl === params.src)
    if (!runtime || runtime.claimed) return false
    if (webPreferences.partition || webPreferences.preload || params.partition || params.preload) return false
    runtime.claimed = true
    for (const key of Object.keys(webPreferences) as Array<keyof WebPreferences>)
      if (!SAFE_INHERITED.has(key)) delete webPreferences[key]
    Object.assign(webPreferences, {
      partition: this.partition(runtime.slot),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      plugins: false,
      experimentalFeatures: false,
      javascript: true,
      images: true,
      webgl: true,
      spellcheck: false,
      navigateOnDragDrop: false,
      autoplayPolicy: 'user-gesture-required',
      disableDialogs: true,
      backgroundThrottling: true,
      transparent: true,
      disablePopups: true
    } as WebPreferences)
    return true
  }

  /** Takes the page a claimed `<webview>` attached (`did-attach-webview`). False when it is not an applet's. */
  adopt(guest: WebContents): boolean {
    const runtime = [...this.runtimes.values()].find(
      (item) => item.claimed && !item.guest && this.sessions.get(item.slot) === guest.session
    )
    if (!runtime) return false
    runtime.guest = guest
    runtime.heartbeat = Date.now()
    const { runtimeId } = runtime.mount
    markWebContentsRole(guest, 'applet')
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    guest.on('will-navigate', (event) => event.preventDefault())
    guest.on('will-frame-navigate', (event) => event.preventDefault())
    guest.on('will-redirect', (event) => event.preventDefault())
    guest.on('will-attach-webview', (event) => event.preventDefault())
    guest.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && !this.owner.isDestroyed()) {
        event.preventDefault()
        this.owner.webContents.focus()
        this.notify(runtime, 'escape', null)
      }
    })
    guest.on('console-message', (event) => this.receive(runtime, event.message))
    guest.on('render-process-gone', () => {
      this.notify(runtime, 'error', 'The applet stopped. Restart it to try again.')
      if (this.runtimes.get(runtimeId) === runtime) this.unmount(runtimeId)
    })
    guest.on('unresponsive', () =>
      this.notify(runtime, 'error', 'The applet is not responding. Restart it to try again.')
    )
    // The page removed or moved the webview: this page is gone for good, and a new one needs a new address.
    guest.once('destroyed', () => {
      if (this.runtimes.get(runtimeId) !== runtime) return
      this.notify(runtime, 'released', null)
      this.unmount(runtimeId)
    })
    return true
  }

  /** The applet's card left the screen (it may be released for a newer one) or came back. */
  setVisible(runtimeId: string, visible: boolean): void {
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime) return
    runtime.visible = visible
    runtime.heartbeat = Date.now()
    if (visible) runtime.parkedAt = undefined
    else {
      runtime.parkedAt ??= Date.now()
      this.refreshScroll(runtime)
    }
  }

  async appearance(runtimeId: string, appearance: AppletAppearance): Promise<void> {
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime) throw new Error('Applet is not running')
    runtime.mount.appearance = appearance
    // Before the page exists the next document would carry it; the page reads its first appearance from the document.
    if (!runtime.guest) {
      if (!runtime.claimed)
        this.documents.set(runtime.documentUrl, appletDocument(runtime.mount.source, runtime.mount.state, appearance, [
          ...(this.scrollPositions.get(JSON.stringify([runtime.mount.threadId, runtime.mount.revisionId]))?.values() ?? [])
        ], { transparent: true }))
      return
    }
    const argument = JSON.stringify(appearance).replace(/</g, '\\u003c')
    await runtime.guest.executeJavaScript(`window[${JSON.stringify(APPLET_APPLY_APPEARANCE)}](${argument})`)
    if (this.runtimes.get(runtimeId) !== runtime) throw new Error('Applet is no longer running')
  }

  unmount(runtimeId: string, options: { crash?: boolean } = {}): void {
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime) return
    this.runtimes.delete(runtimeId)
    this.documents.delete(runtime.documentUrl)
    const guest = runtime.guest
    if (guest && !guest.isDestroyed()) {
      // A page stuck in a loop never runs unload; ending its process is immediate. Otherwise close() skips any
      // untrusted beforeunload handler.
      if (options.crash) guest.forcefullyCrashRenderer()
      guest.close({ waitForBeforeUnload: false })
    }
  }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.scrollPositions.clear()
    this.owner.removeListener('closed', this.onOwnerClosed)
    clearInterval(this.watchdog)
    for (const id of [...this.runtimes.keys()]) this.unmount(id)
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
    if (!runtime?.guest) throw new Error('Applet is not running')
    return runtime.guest.capturePage()
  }

  private partition(slot: number): string {
    return `${this.partitionPrefix}-${slot}`
  }

  /**
   * Electron retains partition sessions. Three isolated slots are reused instead of allocating an unbounded number as
   * the user scrolls through a transcript; a new profile manager reuses the owner's slots, the previous one having
   * detached its handlers when it was destroyed.
   */
  private isolatedSession(slot: number): Session {
    const existing = this.sessions.get(slot)
    if (existing) return existing
    const ownsDocument = (url: string) =>
      [...this.runtimes.values()].some((runtime) => runtime.slot === slot && runtime.documentUrl === url)
    const isolated = session.fromPartition(this.partition(slot), { cache: false })
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
    return isolated
  }

  /** Reads back the page's already reported scroll offsets, so a page released later restores where it was. */
  private refreshScroll(runtime: Runtime): void {
    const positions = [
      ...(this.scrollPositions
        .get(JSON.stringify([runtime.mount.threadId, runtime.mount.revisionId]))
        ?.values() ?? [])
    ]
    if (!positions.length || !runtime.guest || runtime.guest.isDestroyed()) return
    void runtime.guest
      .executeJavaScript(
        `(${JSON.stringify(positions)}).map(position=>{let node=document.documentElement;for(const index of position.path)node=node?.children[index];return node?{path:position.path,top:node.scrollTop,left:node.scrollLeft}:null})`
      )
      .then((values) => {
        if (this.runtimes.get(runtime.mount.runtimeId) !== runtime || !Array.isArray(values)) return
        for (const value of values.slice(0, 64)) this.rememberScroll(runtime, value)
      })
      .catch(() => {})
  }

  /** One probe at a time; its answer, however late, counts as the page being alive at that moment. */
  private probe(runtime: Runtime): void {
    const guest = runtime.guest
    if (runtime.probing || !guest || guest.isDestroyed()) return
    runtime.probing = true
    guest
      .executeJavaScript('0')
      .then(
        () => {
          runtime.heartbeat = Date.now()
        },
        () => {}
      )
      .finally(() => {
        runtime.probing = false
      })
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
    if (message.startsWith(WHEEL_PREFIX)) {
      // Wheel turns come at the display's rate during a gesture; they have their own budget.
      if (Date.now() - runtime.wheelEpoch >= 1000) {
        runtime.wheelEpoch = Date.now()
        runtime.wheels = 0
      }
      if (message.length > 256 || ++runtime.wheels > 120) return
      try {
        const deltaY = (JSON.parse(message.slice(APPLET_EVENT_PREFIX.length)) as { payload?: { deltaY?: unknown } }).payload?.deltaY
        if (typeof deltaY === 'number' && Number.isFinite(deltaY) && deltaY !== 0 && Math.abs(deltaY) <= 10000)
          this.notify(runtime, 'wheel', deltaY)
      } catch {
        /* Untrusted. */
      }
      return
    }
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
      if (event.type === 'ready') this.notify(runtime, 'ready', null)
      else if (event.type === 'scroll-changed' && Array.isArray(event.payload)) {
        for (const position of event.payload.slice(0, 64)) this.rememberScroll(runtime, position)
      } else if (event.type === 'scroll-position') {
        this.rememberScroll(runtime, event.payload)
      } else if (event.type === 'resize' && appletFrameHeight(event.payload) !== null)
        this.notify(runtime, 'resize', appletFrameHeight(event.payload))
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

/** Preferences Electron derives for every webview that may stay as they are; everything else is set here. */
const SAFE_INHERITED = new Set<keyof WebPreferences>(['zoomFactor', 'defaultFontFamily', 'defaultFontSize', 'defaultMonospaceFontSize', 'minimumFontSize', 'defaultEncoding'])
