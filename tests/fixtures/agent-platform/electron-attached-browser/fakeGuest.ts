import { EventEmitter } from 'node:events'
import type { GuestDebuggerHandle, GuestWebContentsHandle } from '../../../../src/main/browser/automation/guestHandle'

interface FakeNode {
  backendNodeId: number
  role: string
  name: string
  tag: string
  type: string
  x: number
  y: number
  width: number
  height: number
}

export interface FakePageState {
  url: string
  title: string
  nameValue: string
  result: string
  posts: number
  cookie: string
  destroyed: boolean
  loaderId: string
  frameId: string
}

export class FakeDebugger extends EventEmitter implements GuestDebuggerHandle {
  attached = false
  foreignAttached = false
  focusEmulated = false
  insertedTextCount = 0
  hold = new Map<string, { promise: Promise<void>; release: () => void; entered: Promise<void>; markEntered: () => void }>()
  private page: FakePageState
  private focused = 2
  readonly objects = new Map<string, number>()

  constructor(page: FakePageState) {
    super()
    this.page = page
  }

  attach(): void {
    if (this.attached || this.foreignAttached) throw new Error('Debugger is already attached')
    this.attached = true
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.focusEmulated = false
    this.emit('detach', {}, 'target closed')
  }

  isAttached(): boolean {
    return this.attached || this.foreignAttached
  }

  markForeignAttached(): void {
    this.foreignAttached = true
  }

  holdMethod(method: string): () => void {
    let release = () => undefined
    let markEntered = () => undefined
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    this.hold.set(method, { promise, release, entered, markEntered })
    return release
  }

  async waitUntilHeld(method: string): Promise<void> {
    const held = this.hold.get(method)
    if (!held) throw new Error(`Method is not held: ${method}`)
    await held.entered
  }

  emitEvent(method: string, params: unknown, sessionId = ''): void {
    this.emit('message', {}, method, params, sessionId)
  }

  on(event: 'message' | 'detach', listener: (...args: never[]) => void): this {
    return super.on(event, listener)
  }

  off(event: 'message' | 'detach', listener: (...args: never[]) => void): this {
    return super.off(event, listener)
  }

  async sendCommand(method: string, commandParams?: Record<string, unknown>, _sessionId?: string): Promise<unknown> {
    const held = this.hold.get(method)
    if (held) {
      held.markEntered()
      await held.promise
    }
    if (!this.attached && !this.foreignAttached) throw new Error('Debugger is not attached')
    if (this.page.destroyed) throw new Error('WebContents is destroyed')
    return this.dispatch(method, commandParams ?? {})
  }

  private nodes(): FakeNode[] {
    return [
      { backendNodeId: 2, role: 'textbox', name: 'Name', tag: 'INPUT', type: 'text', x: 10, y: 10, width: 120, height: 24 },
      { backendNodeId: 3, role: 'button', name: 'Save', tag: 'BUTTON', type: '', x: 10, y: 40, width: 80, height: 24 },
      { backendNodeId: 4, role: 'button', name: 'Submit once', tag: 'BUTTON', type: '', x: 10, y: 70, width: 120, height: 24 },
      { backendNodeId: 5, role: 'generic', name: this.page.result, tag: 'P', type: '', x: 10, y: 100, width: 200, height: 20 }
    ]
  }

  private dispatch(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'Page.enable':
      case 'DOM.enable':
      case 'Runtime.enable':
      case 'Accessibility.enable':
      case 'Page.setLifecycleEventsEnabled':
      case 'DOMSnapshot.enable':
      case 'DOMSnapshot.disable':
      case 'DOM.scrollIntoViewIfNeeded':
        return {}
      case 'Page.getLayoutMetrics':
        return {
          cssLayoutViewport: { clientWidth: 1280, clientHeight: 720, pageX: 0, pageY: 0 },
          cssVisualViewport: { clientWidth: 1280, clientHeight: 720, pageX: 0, pageY: 0, scale: 1 }
        }
      case 'Page.getFrameTree':
        return {
          frameTree: {
            frame: { id: this.page.frameId, loaderId: this.page.loaderId, url: this.page.url },
            childFrames: []
          }
        }
      case 'Runtime.evaluate': {
        const expression = String(params.expression ?? '')
        if (expression.includes('devicePixelRatio')) return { result: { value: 1 } }
        if (expression.includes('document.title')) return { result: { value: this.page.title } }
        return { result: { value: null } }
      }
      case 'Accessibility.getFullAXTree':
        return {
          nodes: [
            { nodeId: '1', role: { value: 'WebArea' }, name: { value: this.page.title }, backendDOMNodeId: 1, childIds: ['2', '3', '4', '5'] },
            ...this.nodes().map((node, index) => ({
              nodeId: String(index + 2),
              role: { value: node.role },
              name: { value: node.name },
              value: node.backendNodeId === 2 ? { value: this.page.nameValue } : undefined,
              backendDOMNodeId: node.backendNodeId,
              childIds: []
            }))
          ]
        }
      case 'DOMSnapshot.captureSnapshot': {
        const strings = ['INPUT', 'BUTTON', 'P', 'type', 'text', 'visibility', 'display', 'opacity', 'pointer-events', 'visible', 'block', '1', 'auto']
        const nodes = this.nodes()
        return {
          strings,
          documents: [{
            nodes: {
              backendNodeId: nodes.map((node) => node.backendNodeId),
              nodeName: nodes.map((node) => node.tag === 'INPUT' ? 0 : node.tag === 'BUTTON' ? 1 : 2),
              attributes: nodes.map((node) => node.tag === 'INPUT' ? [3, 4] : [])
            },
            layout: {
              nodeIndex: nodes.map((_node, index) => index),
              bounds: nodes.map((node) => [node.x, node.y, node.width, node.height]),
              styles: nodes.map(() => [9, 10, 11, 12])
            }
          }]
        }
      }
      case 'DOM.describeNode': {
        const id = Number(params.backendNodeId)
        if (!this.nodes().some((node) => node.backendNodeId === id)) throw new Error('Could not find node')
        return { node: { backendNodeId: id, nodeName: 'INPUT' } }
      }
      case 'DOM.getContentQuads': {
        const node = this.nodes().find((entry) => entry.backendNodeId === Number(params.backendNodeId))
        if (!node) return { quads: [] }
        const { x, y, width, height } = node
        return { quads: [[x, y, x + width, y, x + width, y + height, x, y + height]] }
      }
      case 'DOM.resolveNode': {
        const id = Number(params.backendNodeId)
        const objectId = 'obj_' + id
        this.objects.set(objectId, id)
        return { object: { objectId } }
      }
      case 'DOM.getNodeForLocation': {
        const x = Number(params.x)
        const y = Number(params.y)
        const hit = this.nodes().find((node) => x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height)
        return hit ? { backendNodeId: hit.backendNodeId } : {}
      }
      case 'Emulation.setFocusEmulationEnabled':
        this.focusEmulated = params.enabled === true
        return {}
      case 'DOM.focus': {
        this.focused = Number(params.backendNodeId) || this.focused
        return {}
      }
      case 'Runtime.callFunctionOn': {
        const objectId = String(params.objectId ?? '')
        const backendNodeId = this.objects.get(objectId)
        const node = this.nodes().find((entry) => entry.backendNodeId === backendNodeId)
        const declaration = String(params.functionDeclaration ?? '')
        if (declaration.includes('getComputedStyle') || declaration.includes('el.disabled')) {
          return {
            result: {
              value: {
                tag: node?.tag ?? 'DIV',
                type: node?.type ?? '',
                disabled: false,
                readOnly: false,
                hidden: false,
                valueLength: node?.backendNodeId === 2 ? this.page.nameValue.length : 0,
                checked: false
              }
            }
          }
        }
        if (declaration.includes('elementFromPoint')) {
          return { result: { value: { ok: true, occluded: false, hitTag: node?.tag ?? '', hitText: node?.name ?? '' } } }
        }
        if (declaration.includes('this.select')) return { result: { value: null } }
        if (declaration.includes('el.value') || declaration.includes('secret')) {
          return {
            result: {
              value: {
                value: node?.backendNodeId === 2 ? this.page.nameValue : '',
                valueLength: node?.backendNodeId === 2 ? this.page.nameValue.length : 0,
                type: node?.type ?? '',
                checked: false,
                selected: []
              }
            }
          }
        }
        return { result: { value: null } }
      }
      case 'Input.insertText':
        this.insertedTextCount++
        if (this.focusEmulated && this.focused === 2) this.page.nameValue = String(params.text ?? '')
        return {}
      case 'Input.dispatchKeyEvent':
        return {}
      case 'Input.dispatchMouseEvent': {
        const type = String(params.type ?? '')
        const x = Number(params.x)
        const y = Number(params.y)
        if (type === 'mouseReleased' || type === 'mousePressed') {
          const hit = this.nodes().find((node) => x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height)
          if (hit?.backendNodeId === 3 && type === 'mouseReleased') {
            this.page.result = 'saved:' + this.page.nameValue + ':pwlen=0'
          }
          if (hit?.backendNodeId === 4 && type === 'mouseReleased') {
            this.page.posts += 1
            this.page.cookie = 'recovery=kept'
            this.page.result = 'submitted'
          }
        }
        return {}
      }
      case 'Page.navigate': {
        this.page.url = String(params.url ?? this.page.url)
        this.page.loaderId = 'ldr_nav'
        this.page.frameId = 'frm_nav'
        this.page.title = 'Navigated'
        this.page.nameValue = ''
        this.emitEvent('Page.frameNavigated', {
          frame: { id: this.page.frameId, loaderId: this.page.loaderId, url: this.page.url }
        })
        this.emitEvent('Page.lifecycleEvent', { name: 'load' })
        return { frameId: this.page.frameId }
      }
      case 'Page.captureScreenshot': {
        const png = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64'
        )
        return { data: png.toString('base64') }
      }
      case 'Page.reload':
      case 'Page.getNavigationHistory':
        return { currentIndex: 0, entries: [{ id: 1 }] }
      default:
        return {}
    }
  }
}

let nextNativeId = 1000

export class FakeWebContents implements GuestWebContentsHandle {
  keyboardFocusCalls = 0
  keyboardReleaseRestores: boolean[] = []
  readonly nativeId: number
  readonly debugger: FakeDebugger
  destroyed = false
  url: string
  title: string
  partition: string
  private readonly host: FakeWebContents | null
  private readonly destroyedListeners: Array<() => void> = []
  private readonly navListeners: Array<(url: string) => void> = []

  constructor(options: {
    url: string
    title: string
    partition: string
    host?: FakeWebContents | null
    page: FakePageState
    debugger?: FakeDebugger
    nativeId?: number
  }) {
    this.nativeId = options.nativeId ?? nextNativeId++
    this.url = options.url
    this.title = options.title
    this.partition = options.partition
    this.host = options.host ?? null
    this.debugger = options.debugger ?? new FakeDebugger(options.page)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  getURL(): string {
    return this.url
  }

  getTitle(): string {
    return this.title
  }

  hostWebContents(): GuestWebContentsHandle | null {
    return this.host
  }

  async acquireKeyboardFocus(signal: AbortSignal) {
    return {
      focus: async () => {
        if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
        this.keyboardFocusCalls++
      },
      release: async (restore: boolean) => { this.keyboardReleaseRestores.push(restore) }
    }
  }

  get session() {
    return {
      matchesPartition: (expected: string) => this.partition === expected
    }
  }

  onDestroyed(listener: () => void): () => void {
    this.destroyedListeners.push(listener)
    return () => {
      const index = this.destroyedListeners.indexOf(listener)
      if (index >= 0) this.destroyedListeners.splice(index, 1)
    }
  }

  onNavigated(listener: (url: string) => void): () => void {
    this.navListeners.push(listener)
    return () => {
      const index = this.navListeners.indexOf(listener)
      if (index >= 0) this.navListeners.splice(index, 1)
    }
  }

  destroy(): void {
    this.destroyed = true
    for (const listener of [...this.destroyedListeners]) listener()
  }

  navigate(url: string): void {
    this.url = url
    for (const listener of [...this.navListeners]) listener(url)
  }
}

export function createFakeGuestPair(options: {
  profileId: string
  url?: string
  partition?: string
}): { owner: FakeWebContents; guest: FakeWebContents; page: FakePageState; debugger: FakeDebugger } {
  const page: FakePageState = {
    url: options.url ?? 'http://127.0.0.1:1/page.html',
    title: 'Fixture Form',
    nameValue: '',
    result: 'idle',
    posts: 0,
    cookie: '',
    destroyed: false,
    loaderId: 'ldr_1',
    frameId: 'frm_1'
  }
  const dbg = new FakeDebugger(page)
  const owner = new FakeWebContents({
    url: 'file://host',
    title: 'host',
    partition: 'persist:host',
    page,
    nativeId: nextNativeId++
  })
  const guest = new FakeWebContents({
    url: page.url,
    title: page.title,
    partition: options.partition ?? `persist:mousse-profile-${options.profileId.toLowerCase()}`,
    host: owner,
    page,
    debugger: dbg
  })
  return { owner, guest, page, debugger: dbg }
}
