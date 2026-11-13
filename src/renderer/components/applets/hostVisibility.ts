/**
 * Whether an applet's host element is really on screen. The applet itself is a native view drawn above the whole page,
 * so it may show only while its host is: anything that hides or replaces the host, a dialog or menu, or a page drawn
 * over it hides the view too. Smaller floating UI over the host, such as a hover label, is cut out of the view's clip
 * instead (`appletUncoveredClip`), so the applet stays on screen.
 */
const OVERLAYS =
  '[role="dialog"], [role="menu"], [aria-modal="true"], [data-state="open"][data-radix-popper-content-wrapper], .composer-mode-menu-floating, .composer-model-picker-shell-floating, .context-usage-popover-floating, .composer-workspace-menu, .modal-overlay, .image-preview-overlay'
/** Attribute changes that can show, hide or cover a host: pages and panes toggle these. */
const WATCHED_ATTRIBUTES = ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'aria-modal', 'data-state', 'open']
const subscribers = new Set<() => void>()
let observer: MutationObserver | null = null
let frame = 0
let blocked = false
export function appletHostBlocked(): boolean {
  return blocked
}

/**
 * Floating layers: elements taken out of the page's flow (`position: fixed`, `absolute` or `sticky`), so they can be
 * drawn over a host. Hover labels, popovers, menus, toasts and anything else positioned over the transcript are found
 * this way, without a list of their names: the page is scanned once when the first host subscribes, then only where it
 * changes. Layers that leave the page or stop floating are dropped when next checked.
 */
const layers = new Set<HTMLElement>()
/** Nodes added or changed since the last frame; `added` also has its descendants looked at. */
let added = new Set<Node>()
let changed = new Set<Node>()
/** Descendants looked at in one added subtree; the whole page is scanned only at the start. */
const ADDED_SUBTREE_LIMIT = 400

function floats(style: CSSStyleDeclaration): boolean {
  return style.position === 'fixed' || style.position === 'absolute' || style.position === 'sticky'
}

/** Records each node's layer: the node itself or its closest floating ancestor. */
function findLayers(nodes: Iterable<Element>, seen: Set<Element>) {
  for (const start of nodes) {
    for (let element: Element | null = start; element && element !== document.body; element = element.parentElement) {
      if (seen.has(element)) break
      seen.add(element)
      if (element instanceof HTMLElement && floats(getComputedStyle(element))) {
        layers.add(element)
        break
      }
    }
  }
}

function collectLayers(scanAll: boolean) {
  const seen = new Set<Element>()
  const elements: Element[] = []
  const add = (node: Node) => {
    if (node.nodeType !== 1 || !(node as Element).isConnected) return
    elements.push(node as Element)
  }
  if (scanAll && document.body?.querySelectorAll) elements.push(...Array.from(document.body.querySelectorAll('*')))
  for (const node of added) {
    add(node)
    if (node.nodeType === 1 && (node as Element).isConnected) {
      const inside = (node as Element).querySelectorAll('*')
      for (let index = 0; index < inside.length && index < ADDED_SUBTREE_LIMIT; index++) elements.push(inside[index])
    }
  }
  for (const node of changed) add(node)
  added = new Set()
  changed = new Set()
  if (elements.length) findLayers(elements, seen)
}

/**
 * Calls `callback` (once per frame at most) whenever the page changes in a way that may show, hide or cover a host:
 * a page or pane opening, a dialog or menu appearing, an element being added or removed.
 */
export function subscribeAppletHostVisibility(callback: () => void): () => void {
  subscribers.add(callback)
  if (!observer) {
    let scanAll = true
    const refresh = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        blocked = Array.from(document.querySelectorAll<HTMLElement>(OVERLAYS)).some(
          (node) => node.getClientRects().length > 0 && node.getAttribute('aria-hidden') !== 'true'
        )
        collectLayers(scanAll)
        scanAll = false
        for (const subscriber of subscribers) subscriber()
      })
    }
    observer = new MutationObserver((records) => {
      for (const record of records ?? []) {
        if (record.type === 'childList') record.addedNodes.forEach((node) => added.add(node))
        else changed.add(record.target)
      }
      refresh()
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRIBUTES
    })
    refresh()
  } else callback()
  return () => {
    subscribers.delete(callback)
    if (!subscribers.size) {
      observer?.disconnect()
      observer = null
      cancelAnimationFrame(frame)
      frame = 0
      blocked = false
      layers.clear()
      added = new Set()
      changed = new Set()
    }
  }
}

export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/** Rendered: not `display: none`, `visibility: hidden` or fully transparent through any ancestor. */
function rendered(node: HTMLElement): boolean {
  const check = (node as HTMLElement & { checkVisibility?: (options?: object) => boolean }).checkVisibility
  if (typeof check === 'function')
    return check.call(node, { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })
  return node.getClientRects().length > 0
}

/** Something else is topmost at one of a few points across the visible part of the host. */
function covered(node: HTMLElement, area: ScreenRect): boolean {
  if (typeof document.elementFromPoint !== 'function' || area.width <= 0 || area.height <= 0) return false
  const inset = (size: number) => Math.min(12, size / 2)
  const left = area.x + inset(area.width), right = area.x + area.width - inset(area.width)
  const top = area.y + inset(area.height), bottom = area.y + area.height - inset(area.height)
  const points: Array<[number, number]> = [
    [(left + right) / 2, (top + bottom) / 2],
    [left, top], [right, top], [left, bottom], [right, bottom]
  ]
  return points.some(([x, y]) => {
    const hit = document.elementFromPoint(x, y)
    return !!hit && hit !== node && !node.contains(hit)
  })
}

/**
 * True while the host may show its native view: it is in the page, the window is visible, the host is rendered and
 * not inside an inert (replaced or covered) part of the app, no dialog or menu is open, and nothing else is drawn over
 * `area`, the part of the host inside its clip.
 */
export function appletHostShown(node: HTMLElement, area: ScreenRect): boolean {
  if (!node.isConnected || document.visibilityState === 'hidden') return false
  if (blocked || node.closest('[inert]')) return false
  if (!rendered(node)) return false
  return !covered(node, area)
}

/** Overlaps of less than this (a border touching the host's edge) leave the applet as it is. */
const MIN_OVERLAP = 1
/** Elements looked at inside one transparent layer to find what it paints. */
const PAINT_SEARCH_LIMIT = 200

function intersect(a: ScreenRect, b: ScreenRect): ScreenRect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  const width = Math.min(a.x + a.width, b.x + b.width) - x
  const height = Math.min(a.y + a.height, b.y + b.height) - y
  return width >= MIN_OVERLAP && height >= MIN_OVERLAP ? { x, y, width, height } : null
}

function opaqueColor(color: string): boolean {
  if (!color || color === 'transparent') return false
  const alpha = /rgba?\([^)]*[,/]\s*([\d.]+%?)\s*\)/.exec(color)?.[1]
  return alpha === undefined || Number.parseFloat(alpha) > 0
}

/** Whether an element draws a box of its own: a background, a border, a shadow, or replaced content. */
function paintsBox(element: Element, style: CSSStyleDeclaration): boolean {
  if (/^(IMG|CANVAS|VIDEO|SVG|IFRAME)$/i.test(element.tagName)) return true
  if (opaqueColor(style.backgroundColor)) return true
  if (style.backgroundImage && style.backgroundImage !== 'none') return true
  if (style.boxShadow && style.boxShadow !== 'none') return true
  return (['Top', 'Right', 'Bottom', 'Left'] as const).some(
    (side) =>
      Number.parseFloat(style[`border${side}Width`]) > 0 &&
      style[`border${side}Style`] !== 'none' &&
      opaqueColor(style[`border${side}Color`])
  )
}

/**
 * The boxes `layer` paints over `area`: its own box when it draws one, else those of its descendants that do. A
 * transparent container the size of the window (the layer that holds a side card) covers only what is inside it.
 */
function paintedOver(layer: HTMLElement, area: ScreenRect, out: ScreenRect[]) {
  const queue: Element[] = [layer]
  for (let looked = 0; queue.length && looked < PAINT_SEARCH_LIMIT; looked++) {
    const element = queue.shift()!
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue
    if (paintsBox(element, style)) {
      const box = element.getBoundingClientRect()
      const over = intersect(area, { x: box.left, y: box.top, width: box.width, height: box.height })
      if (over) out.push(over)
      continue
    }
    queue.push(...Array.from(element.children))
  }
}

/** Whether `layer` is drawn above `node`: after it in the page, or raised with a positive z-index; never below it. */
function drawnAbove(layer: HTMLElement, node: HTMLElement, style: CSSStyleDeclaration): boolean {
  const z = Number.parseInt(style.zIndex, 10)
  if (z < 0) return false
  return z > 0 || (node.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

function nativeClipping(): boolean {
  return (window as { mousse?: { platform?: string } }).mousse?.platform !== 'darwin'
}

/**
 * The part of `clip` the applet's native view may draw in, so that floating app UI over its host stays visible. The
 * view is drawn above the whole page, so any floating layer (see `layers`) drawn over the host would be hidden behind
 * it. Instead of hiding the applet, the view is cut back to the largest band of its visible area, above, below, left
 * or right of everything painted over it. The strip cut away shows the host underneath, which holds the applet's last
 * frame, with the layer drawn on top. When no band is left, or on macOS (see below), the clip is empty and the view
 * hides while the layer is there, its last frame showing in its place.
 */
export function appletUncoveredClip(node: HTMLElement, clip: ScreenRect): ScreenRect {
  if (!layers.size) return clip
  const box = node.getBoundingClientRect()
  const area = intersect({ x: box.left, y: box.top, width: box.width, height: box.height }, clip)
  if (!area) return clip
  const covers: ScreenRect[] = []
  for (const layer of layers) {
    if (!layer.isConnected) {
      layers.delete(layer)
      continue
    }
    if (layer.contains(node) || node.contains(layer)) continue
    const style = getComputedStyle(layer)
    if (!floats(style)) {
      layers.delete(layer)
      continue
    }
    if (!drawnAbove(layer, node, style) || layer.closest('[inert]') || !rendered(layer)) continue
    paintedOver(layer, area, covers)
  }
  if (!covers.length) return clip
  // Chromium clips a native view to its parent's bounds on Windows and Linux, not on macOS, where a cut clip would
  // still draw the whole view over the layer. There the view hides instead, only while something is drawn over it.
  if (!nativeClipping()) return { x: area.x, y: area.y, width: 0, height: 0 }
  const right = area.x + area.width, bottom = area.y + area.height
  const coverTop = Math.min(...covers.map((cover) => cover.y))
  const coverBottom = Math.max(...covers.map((cover) => cover.y + cover.height))
  const coverLeft = Math.min(...covers.map((cover) => cover.x))
  const coverRight = Math.max(...covers.map((cover) => cover.x + cover.width))
  const bands: ScreenRect[] = [
    { x: area.x, y: area.y, width: area.width, height: coverTop - area.y },
    { x: area.x, y: coverBottom, width: area.width, height: bottom - coverBottom },
    { x: area.x, y: area.y, width: coverLeft - area.x, height: area.height },
    { x: coverRight, y: area.y, width: right - coverRight, height: area.height }
  ]
  let best: ScreenRect = { x: area.x, y: area.y, width: 0, height: 0 }
  for (const band of bands) {
    if (band.width > 0 && band.height > 0 && band.width * band.height > best.width * best.height) best = band
  }
  return best
}
