import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDialog } from '../src/renderer/components/ui/Modal'
import {
  pushOverlay,
  registerCommand,
  runCommand,
  setRecording,
  useCommandRegistry
} from '../src/renderer/commands/commandRegistry'
import { attachCommandShortcuts } from '../src/renderer/commands/useCommandShortcuts'
import { useAppStore } from '../src/renderer/stores/appStore'
import type { KeyInput } from '../src/shared/commands'

const globals = globalThis as { window?: unknown; document?: unknown }
const original = { window: globals.window, document: globals.document }

type FakeWindow = EventTarget & { mousse: { platform: string } }
type FakeElement = { closest(selector: string): unknown }

const textarea: FakeElement = { closest: (selector) => (selector.includes('textarea') ? {} : null) }
const button: FakeElement = { closest: () => null }

function stubWindow(activeElement: FakeElement | null = button) {
  const win = new EventTarget() as FakeWindow
  win.mousse = { platform: 'win32' }
  const doc = new EventTarget() as EventTarget & { activeElement: FakeElement | null }
  doc.activeElement = activeElement
  globals.window = win
  globals.document = doc
  return { win, doc }
}

/** Fires a keydown the way the browser would: cancelable, with the fields the dispatcher reads. */
function keydown(win: EventTarget, init: Partial<KeyInput> & { key: string; repeat?: boolean }) {
  const event = Object.assign(
    new Event('keydown', { cancelable: true }),
    { code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false, keyCode: 0 },
    init
  )
  win.dispatchEvent(event)
  return event
}

const ctrlN = { key: 'n', code: 'KeyN', ctrlKey: true }

beforeEach(() => {
  useCommandRegistry.setState({ handlers: new Map(), recording: false, overlays: [] })
  useAppStore.setState({
    shortcuts: {},
    activeThreadId: 'thread-1',
    turnStates: { 'thread-1': { threadId: 'thread-1', phase: 'streaming' } as never },
    mainAreaOpen: true,
    sidebarMode: 'projects',
    appInfo: { platform: 'win32', repoRoot: '', llmProvider: '' }
  })
})

afterEach(() => {
  globals.window = original.window
  globals.document = original.document
})

describe('the keyboard dispatcher', () => {
  it('runs the handler of a bound chord once and consumes the key', () => {
    const { win } = stubWindow()
    const detach = attachCommandShortcuts(win as never)
    const run = vi.fn()
    registerCommand('thread.new', { run })

    const event = keydown(win, ctrlN)
    expect(run).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    expect(event.cancelBubble).toBe(true)
    detach()
    keydown(win, ctrlN)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('leaves every other key alone', () => {
    const { win } = stubWindow()
    attachCommandShortcuts(win as never)
    const run = vi.fn()
    registerCommand('thread.new', { run })

    for (const init of [{ key: 'a', code: 'KeyA' }, { key: 'n', code: 'KeyN' }, { key: 'n', code: 'KeyN', ctrlKey: true, altKey: true }]) {
      const event = keydown(win, init)
      expect(event.defaultPrevented).toBe(false)
      expect(event.cancelBubble).toBe(false)
    }
    // A chord with no handler is not consumed either.
    const unclaimed = keydown(win, { key: 'k', code: 'KeyK', ctrlKey: true })
    expect(unclaimed.defaultPrevented).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('does nothing while the Shortcuts recorder is listening', () => {
    const { win } = stubWindow()
    attachCommandShortcuts(win as never)
    const run = vi.fn()
    registerCommand('thread.new', { run })
    const recorded = vi.fn()
    win.addEventListener('keydown', recorded)

    setRecording(true)
    const event = keydown(win, ctrlN)
    expect(run).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    expect(recorded).toHaveBeenCalledTimes(1)

    setRecording(false)
    keydown(win, ctrlN)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('ignores composition and a disabled handler', () => {
    const { win } = stubWindow()
    attachCommandShortcuts(win as never)
    const run = vi.fn()
    let enabled = false
    registerCommand('thread.new', { run, enabled: () => enabled })

    expect(keydown(win, ctrlN).defaultPrevented).toBe(false)
    enabled = true
    expect(keydown(win, { ...ctrlN, isComposing: true }).defaultPrevented).toBe(false)
    expect(keydown(win, { ...ctrlN, keyCode: 229 }).defaultPrevented).toBe(false)
    expect(run).not.toHaveBeenCalled()
    keydown(win, ctrlN)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('runs a held chord once, except thread navigation', () => {
    const { win } = stubWindow()
    attachCommandShortcuts(win as never)
    const created = vi.fn()
    const next = vi.fn()
    registerCommand('thread.new', { run: created })
    registerCommand('thread.next', { run: next })

    keydown(win, { ...ctrlN, repeat: true })
    expect(created).not.toHaveBeenCalled()
    const held = keydown(win, { key: 'Tab', code: 'Tab', ctrlKey: true, repeat: true })
    expect(held.defaultPrevented).toBe(true)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('does not run a text-denied command in a text field, and lets Stop run through', () => {
    const { win, doc } = stubWindow(textarea)
    attachCommandShortcuts(win as never)
    const browser = vi.fn()
    const stop = vi.fn()
    registerCommand('surface.browser', { run: browser })
    registerCommand('run.stop', { run: stop })

    const typed = keydown(win, { key: 'b', code: 'KeyB' })
    expect(typed.defaultPrevented).toBe(false)
    expect(browser).not.toHaveBeenCalled()
    keydown(win, { key: 'Backspace', code: 'Backspace', ctrlKey: true, shiftKey: true })
    expect(stop).toHaveBeenCalledTimes(1)

    doc.activeElement = button
    keydown(win, { key: 'b', code: 'KeyB' })
    expect(browser).toHaveBeenCalledTimes(1)
  })

  it('follows the model picker: its chords run, the global ones stand down', () => {
    const { win } = stubWindow()
    attachCommandShortcuts(win as never)
    const pick = vi.fn()
    const created = vi.fn()
    registerCommand('model.pick1', { run: pick })
    registerCommand('thread.new', { run: created })

    keydown(win, { key: '1', code: 'Digit1', ctrlKey: true })
    expect(pick).not.toHaveBeenCalled()

    const pop = pushOverlay('model-picker')
    keydown(win, { key: '1', code: 'Digit1', ctrlKey: true })
    keydown(win, ctrlN)
    expect(pick).toHaveBeenCalledTimes(1)
    expect(created).not.toHaveBeenCalled()

    pop()
    keydown(win, ctrlN)
    expect(created).toHaveBeenCalledTimes(1)
  })

  it('stands down for an open dialog, except Stop run', () => {
    const { win } = stubWindow()
    attachCommandShortcuts(win as never)
    const created = vi.fn()
    const stop = vi.fn()
    registerCommand('thread.new', { run: created })
    registerCommand('run.stop', { run: stop })

    const release = registerDialog({} as HTMLElement)
    keydown(win, ctrlN)
    keydown(win, { key: 'Backspace', code: 'Backspace', ctrlKey: true, shiftKey: true })
    expect(created).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)

    release()
    keydown(win, ctrlN)
    expect(created).toHaveBeenCalledTimes(1)
  })

  it('matches the overrides of the profile that is bound', () => {
    const { win } = stubWindow()
    attachCommandShortcuts(win as never)
    const created = vi.fn()
    registerCommand('thread.new', { run: created })
    const ctrlShiftX = { key: 'X', code: 'KeyX', ctrlKey: true, shiftKey: true }
    const ctrlShiftY = { key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true }

    useAppStore.getState().setShortcuts({ 'thread.new': 'CommandOrControl+Shift+X' })
    keydown(win, ctrlN)
    expect(created).not.toHaveBeenCalled()
    keydown(win, ctrlShiftX)
    expect(created).toHaveBeenCalledTimes(1)

    // Switching profile drops the first profile's overrides until the second one's arrive.
    useAppStore.getState().activateProfile('profile-b')
    keydown(win, ctrlShiftX)
    expect(created).toHaveBeenCalledTimes(1)
    keydown(win, ctrlN)
    expect(created).toHaveBeenCalledTimes(2)

    useAppStore.getState().setShortcuts({ 'thread.new': 'CommandOrControl+Shift+Y' })
    keydown(win, ctrlN)
    keydown(win, ctrlShiftY)
    expect(created).toHaveBeenCalledTimes(3)

    useAppStore.getState().setShortcuts({ 'thread.new': null })
    keydown(win, ctrlShiftY)
    expect(created).toHaveBeenCalledTimes(3)
  })
})

describe('runCommand', () => {
  it('is refused while the recorder is listening, for every source', () => {
    stubWindow()
    const run = vi.fn()
    registerCommand('thread.new', { run })
    setRecording(true)
    for (const source of ['key', 'menu', 'palette', 'guest'] as const) expect(runCommand('thread.new', source)).toBe(false)
    expect(run).not.toHaveBeenCalled()
    setRecording(false)
    expect(runCommand('thread.new', 'menu')).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('is refused for a menu click while a dialog is open, and for an unregistered command', () => {
    stubWindow()
    const run = vi.fn()
    registerCommand('thread.new', { run })
    expect(runCommand('threads.search', 'menu')).toBe(false)

    const release = registerDialog({} as HTMLElement)
    expect(runCommand('thread.new', 'menu')).toBe(false)
    expect(runCommand('thread.new', 'palette')).toBe(false)
    release()
    expect(runCommand('thread.new', 'menu')).toBe(true)
  })

  it('runs from the palette what a key press in a text field would not', () => {
    stubWindow(textarea)
    const run = vi.fn()
    registerCommand('surface.browser', { run })

    expect(runCommand('surface.browser', 'key')).toBe(false)
    expect(runCommand('surface.browser', 'key', textarea)).toBe(false)
    expect(runCommand('surface.browser', 'palette')).toBe(true)
    expect(runCommand('surface.browser', 'menu')).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
    // `when` still holds for them.
    useAppStore.setState({ mainAreaOpen: false })
    expect(runCommand('surface.browser', 'palette')).toBe(false)
  })

  it('lets the palette run over its own overlay but not over another', () => {
    stubWindow()
    const run = vi.fn()
    registerCommand('thread.new', { run })

    const closePalette = pushOverlay('palette')
    expect(runCommand('thread.new', 'palette')).toBe(true)
    expect(runCommand('thread.new', 'menu')).toBe(false)
    closePalette()

    const closeSearch = pushOverlay('thread-search')
    expect(runCommand('thread.new', 'palette')).toBe(false)
    closeSearch()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('treats a chord from the browser surface as typed into a text field and refuses commands that deny it', () => {
    stubWindow()
    const palette = vi.fn()
    const browser = vi.fn()
    registerCommand('palette.open', { run: palette })
    registerCommand('surface.browser', { run: browser })

    expect(runCommand('palette.open', 'guest')).toBe(true)
    expect(runCommand('surface.browser', 'guest')).toBe(false)
    expect(browser).not.toHaveBeenCalled()
  })

  it('stops a handler once it unregisters', () => {
    stubWindow()
    const run = vi.fn()
    const unregister = registerCommand('thread.new', { run })
    const replacement = vi.fn()
    registerCommand('thread.new', { run: replacement })

    // The first handler was replaced; removing it must not remove the newer one.
    unregister()
    expect(runCommand('thread.new', 'menu')).toBe(true)
    expect(replacement).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
  })
})
