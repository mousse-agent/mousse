import { useEffect, useRef, useState, type ClipboardEvent, type CompositionEvent, type FormEvent, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import type { WatchedBrowserAck, WatchedBrowserInput, WatchedBrowserView } from '../../../shared/browser/watched'
import { BROWSER_MODIFIERS, MAX_BROWSER_PASTE_CHARS, type BrowserMouseButton } from '../../../shared/browser/types'
import { viewerPlatform } from '../../stores/browserInputChannel'

/**
 * The person's input in a browser view, while this window holds the browser: everything a
 * mouse, a keyboard, an IME and a touch screen do, at the page's CSS pixels of the picture they acted
 * on, on the hold's channel (send, which its user numbers and delivers).
 *
 * - **Pointer**: a button going down and up (with how many presses in a row, so a double click is one)
 *   and the moves between, so hover, drag, text selection and a right click work. Control-click on a Mac
 *   is a right click.
 * - **Wheel**: every turn counts (the channel adds them up); a pinch (Control and the wheel) is not sent.
 * - **Keys**: down and up with their modifiers and code. Command (Mac) or Control (elsewhere) with V
 *   pastes the person's clipboard text, with C or X copies (or cuts) the page's selection to their
 *   clipboard: only then is the clipboard read or written.
 * - **IME and dead keys**: composition text as it stands, committed as text.
 * - **Touch**: a tap clicks, a long press is a right click, one or two fingers moving scroll.
 *
 * Keys land in a hidden text field over the page (`keys`), which holds the focus while the person
 * types and moves to where they last clicked, so an IME's candidates show there.
 */

export interface InputMark {
  seq: number
  /** Where, in percent of the picture. */
  left: number
  top: number
  state: 'pending' | 'done' | 'refused'
}

const BUTTONS: Record<number, BrowserMouseButton> = { 0: 'left', 1: 'middle', 2: 'right' }
const BUTTON_BITS: Record<BrowserMouseButton, number> = { left: 1, right: 2, middle: 4 }
/** Presses in a row count as one double (or triple) click within this long and this near. */
const MULTI_CLICK_MS = 500
const MULTI_CLICK_PX = 5
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn'])
/** A touch held this long without moving is a right click. */
const LONG_PRESS_MS = 550
/** A touch that moves more than this scrolls rather than taps. */
const TOUCH_SLOP_PX = 8

function modifiersOf(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? BROWSER_MODIFIERS.alt : 0) | (event.ctrlKey ? BROWSER_MODIFIERS.ctrl : 0) | (event.metaKey ? BROWSER_MODIFIERS.meta : 0) | (event.shiftKey ? BROWSER_MODIFIERS.shift : 0)
}

/** The text a key types (one character), unless Control or Command makes it a shortcut. */
function typed(event: KeyboardEvent): string | undefined {
  if (event.ctrlKey || event.metaKey) return undefined
  return [...event.key].length === 1 ? event.key : undefined
}

export function useBrowserInput(options: {
  owner: boolean
  view: Pick<WatchedBrowserView, 'frame'>
  frame: RefObject<HTMLDivElement | null>
  keys: RefObject<HTMLTextAreaElement | null>
  /** Sends one input, made on picture `picture`, on the hold's channel. */
  send(input: WatchedBrowserInput, picture?: number): { seq: number; done: Promise<WatchedBrowserAck> }
  /** Says a short line about the person's input (a paste too long to send). */
  note(text: string): void
}) {
  const { owner, frame, keys } = options
  const [marks, setMarks] = useState<InputMark[]>([])
  const viewRef = useRef(options.view)
  viewRef.current = options.view
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const pressed = useRef(new Map<number, BrowserMouseButton>())
  const lastPress = useRef<{ button: BrowserMouseButton; x: number; y: number; at: number; count: number } | undefined>(undefined)
  const lastPoint = useRef<{ x: number; y: number } | undefined>(undefined)
  const keysDown = useRef(new Map<string, { key: string; code: string; keyCode: number }>())
  const composing = useRef(false)
  const touches = useRef(new Map<number, { x: number; y: number; startX: number; startY: number; at: number }>())
  const touchGesture = useRef<{ moved: boolean; long: boolean; timer?: ReturnType<typeof setTimeout> }>({ moved: false, long: false })
  const mac = viewerPlatform() === 'mac'

  const send = (input: WatchedBrowserInput): { seq: number; done: Promise<WatchedBrowserAck> } =>
    options.send(input, viewRef.current.frame?.id)

  /** A client point at the page's CSS pixels, and in percent of the picture (for a mark). */
  const point = (event: { clientX: number; clientY: number }) => {
    const rect = frame.current?.getBoundingClientRect()
    const viewport = viewRef.current.frame?.viewport
    if (!rect || !viewport || !rect.width || !rect.height) return undefined
    const fx = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    const fy = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    return { x: Math.round(fx * viewport.width * 100) / 100, y: Math.round(fy * viewport.height * 100) / 100, left: fx * 100, top: fy * 100, scale: viewport.width / rect.width }
  }

  /** A small mark where the person pressed, that settles when the host answers. */
  const mark = (sent: { seq: number; done: Promise<WatchedBrowserAck> }, at: { left: number; top: number }) => {
    setMarks((list) => [...list.filter((entry) => entry.seq !== sent.seq), { seq: sent.seq, left: at.left, top: at.top, state: 'pending' }])
    void sent.done.then((ack) => {
      const state = ack.status === 'refused' || (ack.status === 'duplicate' && ack.reason) ? 'refused' : 'done'
      setMarks((list) => list.map((entry) => entry.seq === sent.seq ? { ...entry, state } : entry))
      setTimeout(() => setMarks((list) => list.filter((entry) => entry.seq !== sent.seq)), state === 'refused' ? 1_200 : 450)
    })
  }

  /** The hidden field follows the last press, so an IME shows its candidates there. */
  const placeKeys = (at: { left: number; top: number }) => {
    const field = keys.current
    if (!field) return
    field.style.left = `${at.left}%`
    field.style.top = `${at.top}%`
    field.focus({ preventScroll: true })
  }

  const buttonsHeld = () => [...pressed.current.values()].reduce((bits, button) => bits | BUTTON_BITS[button], 0)

  const clickCount = (button: BrowserMouseButton, x: number, y: number) => {
    const last = lastPress.current
    const now = Date.now()
    const count = last && last.button === button && now - last.at < MULTI_CLICK_MS && Math.hypot(last.x - x, last.y - y) < MULTI_CLICK_PX ? Math.min(3, last.count + 1) : 1
    lastPress.current = { button, x, y, at: now, count }
    return count
  }

  /** A click as a mouse makes one, at a touch's point (a tap, or a long press as a right click). */
  const clickAt = (event: { clientX: number; clientY: number }, button: BrowserMouseButton) => {
    const at = point(event)
    if (!at) return
    const clicks = clickCount(button, at.x, at.y)
    send({ kind: 'pointer', type: 'move', x: at.x, y: at.y, button: 'none', buttons: 0 })
    const down = send({ kind: 'pointer', type: 'down', x: at.x, y: at.y, button, buttons: BUTTON_BITS[button], clicks })
    send({ kind: 'pointer', type: 'up', x: at.x, y: at.y, button, buttons: 0, clicks })
    mark(down, at)
    placeKeys(at)
  }

  const scrollBy = (event: { clientX: number; clientY: number }, dx: number, dy: number, modifiers = 0) => {
    const at = point(event)
    if (!at || (!dx && !dy)) return
    send({ kind: 'scroll', x: at.x, y: at.y, deltaX: Math.round(dx * at.scale), deltaY: Math.round(dy * at.scale), ...(modifiers ? { modifiers } : {}) })
  }

  // Wheel: a listener that may prevent the app scrolling under it (React's own is passive).
  useEffect(() => {
    const target = frame.current
    if (!target) return
    const onWheel = (event: WheelEvent) => {
      if (!ownerRef.current) return
      event.preventDefault()
      // A pinch (or Control with the wheel) would zoom the page: not sent.
      if (event.ctrlKey) return
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? (viewRef.current.frame?.viewport.height ?? 720) / (frame.current?.getBoundingClientRect().height || 1) : 1
      scrollBy(event, event.deltaX * unit, event.deltaY * unit, modifiersOf(event) & ~BROWSER_MODIFIERS.ctrl)
    }
    target.addEventListener('wheel', onWheel, { passive: false })
    return () => target.removeEventListener('wheel', onWheel)
  })

  /** Lets go of what is still down here (the window lost focus, the hold ended): the page never keeps a key or button stuck. */
  const releaseAll = () => {
    for (const key of keysDown.current.values()) send({ kind: 'keys', type: 'up', key: key.key, code: key.code, keyCode: key.keyCode, modifiers: 0 })
    keysDown.current.clear()
    const at = lastPoint.current
    for (const button of pressed.current.values()) if (at) send({ kind: 'pointer', type: 'up', x: at.x, y: at.y, button, buttons: 0 })
    pressed.current.clear()
  }

  useEffect(() => {
    if (!owner) {
      keysDown.current.clear()
      pressed.current.clear()
    }
  }, [owner])

  // -- touch

  const touchDown = (event: PointerEvent<HTMLDivElement>) => {
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, at: Date.now() })
    const gesture = touchGesture.current
    if (gesture.timer) clearTimeout(gesture.timer)
    if (touches.current.size === 1) {
      touchGesture.current = { moved: false, long: false }
      const start = { clientX: event.clientX, clientY: event.clientY }
      touchGesture.current.timer = setTimeout(() => {
        if (touchGesture.current.moved || touches.current.size !== 1) return
        touchGesture.current.long = true
        clickAt(start, 'right')
      }, LONG_PRESS_MS)
    } else {
      // Two fingers scroll; neither taps.
      gesture.moved = true
    }
  }

  const touchMove = (event: PointerEvent<HTMLDivElement>) => {
    const touch = touches.current.get(event.pointerId)
    if (!touch) return
    const dx = event.clientX - touch.x
    const dy = event.clientY - touch.y
    touch.x = event.clientX
    touch.y = event.clientY
    const gesture = touchGesture.current
    if (!gesture.moved && Math.hypot(touch.x - touch.startX, touch.y - touch.startY) > TOUCH_SLOP_PX) {
      gesture.moved = true
      if (gesture.timer) clearTimeout(gesture.timer)
    }
    // The page follows the finger: one finger, or the two together (each counts half).
    if (gesture.moved && !gesture.long) scrollBy(event, -dx / touches.current.size, -dy / touches.current.size)
  }

  const touchUp = (event: PointerEvent<HTMLDivElement>) => {
    const touch = touches.current.get(event.pointerId)
    touches.current.delete(event.pointerId)
    const gesture = touchGesture.current
    if (gesture.timer) clearTimeout(gesture.timer)
    if (touch && !touches.current.size && !gesture.moved && !gesture.long) clickAt(event, 'left')
  }

  /** A press on the view's own panels over the picture (the page's dialog, its file request) is theirs, not the page's. */
  const onPanel = (event: { target: EventTarget | null }) => event.target instanceof Element && Boolean(event.target.closest('.bot-browser-dialog, .bot-browser-closed'))

  const frameHandlers = {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (!owner || onPanel(event)) return
      event.preventDefault()
      frame.current?.setPointerCapture?.(event.pointerId)
      if (event.pointerType === 'touch') return touchDown(event)
      const at = point(event)
      let button = BUTTONS[event.button]
      if (!at || !button) return
      // Control-click on a Mac is a right click, as everywhere there.
      if (mac && event.ctrlKey && button === 'left') button = 'right'
      pressed.current.set(event.button, button)
      lastPoint.current = { x: at.x, y: at.y }
      const clicks = clickCount(button, at.x, at.y)
      const down = send({ kind: 'pointer', type: 'down', x: at.x, y: at.y, button, buttons: buttonsHeld(), clicks, modifiers: modifiersOf(event) & ~(mac && button === 'right' && event.ctrlKey ? BROWSER_MODIFIERS.ctrl : 0) })
      mark(down, at)
      placeKeys(at)
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      if (!owner || (onPanel(event) && !pressed.current.size)) return
      if (event.pointerType === 'touch') return touchMove(event)
      const at = point(event)
      if (!at) return
      lastPoint.current = { x: at.x, y: at.y }
      send({ kind: 'pointer', type: 'move', x: at.x, y: at.y, button: 'none', buttons: buttonsHeld(), modifiers: modifiersOf(event) })
    },
    onPointerUp(event: PointerEvent<HTMLDivElement>) {
      if (!owner) return
      if (event.pointerType === 'touch') return touchUp(event)
      const button = pressed.current.get(event.button)
      const at = point(event)
      if (!button || !at) return
      pressed.current.delete(event.button)
      lastPoint.current = { x: at.x, y: at.y }
      send({ kind: 'pointer', type: 'up', x: at.x, y: at.y, button, buttons: buttonsHeld(), clicks: lastPress.current?.count ?? 1, modifiers: modifiersOf(event) })
    },
    onPointerCancel(event: PointerEvent<HTMLDivElement>) {
      if (event.pointerType === 'touch') {
        touches.current.delete(event.pointerId)
        return
      }
      if (owner) releaseAll()
    },
    onContextMenu(event: { preventDefault(): void; target: EventTarget | null }) {
      // The page has its own menu, if any: the app's never opens over it.
      if (!onPanel(event)) event.preventDefault()
    }
  }

  const keyHandlers = {
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
      if (!owner) return
      // An IME or a dead key is composing: its text comes as composition.
      if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current || event.key === 'Dead') return
      const primary = mac ? event.metaKey : event.ctrlKey
      // Paste: the field gets the person's clipboard text (a paste event), only now.
      if (primary && !event.altKey && event.code === 'KeyV') return
      if (primary && !event.altKey && !event.shiftKey && (event.code === 'KeyC' || event.code === 'KeyX')) {
        event.preventDefault()
        send({ kind: 'copy', ...(event.code === 'KeyX' ? { cut: true } : {}) })
        return
      }
      if (event.key === 'Unidentified') return
      event.preventDefault()
      const text = typed(event)
      const id = event.code || event.key
      const modifiers = modifiersOf(event)
      send({ kind: 'keys', type: 'down', key: event.key, code: event.code, keyCode: event.keyCode, modifiers, ...(text ? { text } : {}), ...(event.repeat ? { repeat: true } : {}) })
      // A Mac window never hears a key go up while Command is held: a Command shortcut's key goes up at once, so it is not left pressed.
      if (mac && event.metaKey && !MODIFIER_KEYS.has(event.key)) {
        send({ kind: 'keys', type: 'up', key: event.key, code: event.code, keyCode: event.keyCode, modifiers })
        return
      }
      keysDown.current.set(id, { key: event.key, code: event.code, keyCode: event.keyCode })
    },
    onKeyUp(event: KeyboardEvent<HTMLTextAreaElement>) {
      if (!owner) return
      const id = event.code || event.key
      const down = keysDown.current.get(id)
      if (!down) return
      keysDown.current.delete(id)
      event.preventDefault()
      send({ kind: 'keys', type: 'up', key: down.key, code: down.code, keyCode: down.keyCode, modifiers: modifiersOf(event) })
    },
    onBlur() {
      if (owner) releaseAll()
    },
    onCompositionStart() {
      composing.current = true
    },
    onCompositionUpdate(event: CompositionEvent<HTMLTextAreaElement>) {
      if (!owner) return
      const text = event.data ?? ''
      send({ kind: 'compose', text, selectionStart: text.length, selectionEnd: text.length })
    },
    onCompositionEnd(event: CompositionEvent<HTMLTextAreaElement>) {
      composing.current = false
      if (keys.current) keys.current.value = ''
      if (!owner) return
      if (event.data) send({ kind: 'type', text: event.data })
      else send({ kind: 'compose', text: '', selectionStart: 0, selectionEnd: 0 })
    },
    onInput(event: FormEvent<HTMLTextAreaElement>) {
      // Text that came without a key (an emoji or character picker): typed as it is.
      const field = event.currentTarget
      const native = event.nativeEvent as InputEvent
      if (composing.current || native.isComposing || native.inputType === 'insertCompositionText') return
      const text = field.value
      field.value = ''
      if (owner && text) send({ kind: 'type', text })
    },
    onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
      event.preventDefault()
      if (!owner) return
      const text = event.clipboardData.getData('text/plain')
      if (!text) return
      if (text.length > MAX_BROWSER_PASTE_CHARS) {
        options.note(`Too long to paste (over ${MAX_BROWSER_PASTE_CHARS.toLocaleString()} characters)`)
        return
      }
      send({ kind: 'paste', text })
    },
    onCopy(event: ClipboardEvent<HTMLTextAreaElement>) {
      // Copy from the app's menu: the page's selection comes to the clipboard.
      event.preventDefault()
      if (owner) send({ kind: 'copy' })
    },
    onCut(event: ClipboardEvent<HTMLTextAreaElement>) {
      event.preventDefault()
      if (owner) send({ kind: 'copy', cut: true })
    }
  }

  return { marks, frameHandlers, keyHandlers, send }
}
