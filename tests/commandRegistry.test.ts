import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDialog } from '../src/renderer/components/ui/Modal'
import {
  applyPatch,
  interpretRecorderKey,
  proposeBinding,
  resetAllPatch,
  resetPatch
} from '../src/renderer/commands/shortcutEditing'
import { attachMenuShortcutGate } from '../src/main/menu/menuShortcutGate'
import {
  attachCommandBridge,
  pushOverlay,
  registerCommand,
  runCommand,
  setRecording,
  useCommandRegistry,
  type CommandsBridge
} from '../src/renderer/commands/commandRegistry'
import { attachCommandShortcuts } from '../src/renderer/commands/useCommandShortcuts'
import { useAppStore } from '../src/renderer/stores/appStore'
import { bindingFor, resolveBinding, type CommandId, type KeyInput } from '../src/shared/commands'

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

describe('rebinding in the Shortcuts section', () => {
  const ctrlShiftX = { key: 'X', code: 'KeyX', ctrlKey: true, shiftKey: true }

  /** What the section does for one recorded press: read it, check it, apply the saved patch to the store. */
  function recordAndSave(id: Parameters<typeof proposeBinding>[0], init: KeyInput) {
    const action = interpretRecorderKey(init, 'win32')
    if (action.type !== 'record') return action
    const proposal = proposeBinding(id, action.binding, useAppStore.getState().shortcuts, 'win32')
    if (proposal.kind === 'save') useAppStore.getState().setShortcuts(applyPatch(useAppStore.getState().shortcuts, proposal.patch, 'win32'))
    return proposal
  }

  it('hands the chord to the recorder and runs nothing, whatever the chord is bound to', () => {
    const { win } = stubWindow()
    attachCommandShortcuts(win as never)
    const created = vi.fn()
    const stopped = vi.fn()
    registerCommand('thread.new', { run: created })
    registerCommand('run.stop', { run: stopped })
    const recorderSaw: string[] = []
    win.addEventListener('keydown', (event) => recorderSaw.push((event as KeyboardEvent).key))

    setRecording(true)
    keydown(win, ctrlN)
    keydown(win, { key: 'Backspace', code: 'Backspace', ctrlKey: true, shiftKey: true })
    expect(created).not.toHaveBeenCalled()
    expect(stopped).not.toHaveBeenCalled()
    expect(recorderSaw).toEqual(['n', 'Backspace'])
  })

  it('keeps the palette closed while recording and working afterwards', () => {
    const { win } = stubWindow()
    attachCommandShortcuts(win as never)
    const palette = vi.fn()
    registerCommand('palette.open', { run: palette })
    const ctrlK = { key: 'k', code: 'KeyK', ctrlKey: true }

    setRecording(true)
    expect(keydown(win, ctrlK).defaultPrevented).toBe(false)
    expect(runCommand('palette.open', 'menu')).toBe(false)
    expect(palette).not.toHaveBeenCalled()

    setRecording(false)
    expect(keydown(win, ctrlK).defaultPrevented).toBe(true)
    expect(palette).toHaveBeenCalledTimes(1)
    // While the palette is the open overlay its own chord still toggles it.
    const closePalette = pushOverlay('palette')
    keydown(win, ctrlK)
    expect(palette).toHaveBeenCalledTimes(2)
    closePalette()
  })

  it('rebinds at once: the new chord runs the command and the old one does not', () => {
    const { win } = stubWindow()
    attachCommandShortcuts(win as never)
    const created = vi.fn()
    registerCommand('thread.new', { run: created })

    setRecording(true)
    const saved = recordAndSave('thread.new', Object.assign({ code: '', metaKey: false, altKey: false }, ctrlShiftX))
    setRecording(false)
    expect(saved).toMatchObject({ kind: 'save' })

    keydown(win, ctrlN)
    expect(created).not.toHaveBeenCalled()
    expect(keydown(win, ctrlShiftX).defaultPrevented).toBe(true)
    expect(created).toHaveBeenCalledTimes(1)
  })

  it('goes back to the default at once on reset, and on reset all', () => {
    const { win } = stubWindow()
    attachCommandShortcuts(win as never)
    const created = vi.fn()
    const searched = vi.fn()
    registerCommand('thread.new', { run: created })
    registerCommand('threads.search', { run: searched })
    const { setShortcuts } = useAppStore.getState()
    setShortcuts({ 'thread.new': 'CommandOrControl+Shift+X', 'threads.search': null })

    keydown(win, ctrlN)
    expect(created).not.toHaveBeenCalled()

    const current = useAppStore.getState().shortcuts
    const afterOne = applyPatch(current, resetPatch('thread.new', current, 'win32'), 'win32')
    setShortcuts(afterOne)
    keydown(win, ctrlN)
    expect(created).toHaveBeenCalledTimes(1)
    keydown(win, ctrlShiftX)
    expect(created).toHaveBeenCalledTimes(1)
    keydown(win, { key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true })
    expect(searched).not.toHaveBeenCalled()

    setShortcuts(applyPatch(afterOne, resetAllPatch(afterOne, 'win32'), 'win32'))
    expect(useAppStore.getState().shortcuts).toEqual({})
    keydown(win, { key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true })
    expect(searched).toHaveBeenCalledTimes(1)
  })

  it('applies Replace: the other command stops answering the shared chord', () => {
    const { win } = stubWindow()
    attachCommandShortcuts(win as never)
    const created = vi.fn()
    const palette = vi.fn()
    registerCommand('thread.new', { run: created })
    registerCommand('palette.open', { run: palette })

    const proposal = proposeBinding('thread.new', 'CommandOrControl+K', {}, 'win32')
    if (proposal.kind !== 'confirm' || !proposal.replacePatch) throw new Error('expected a clash with a Replace choice')
    useAppStore.getState().setShortcuts(applyPatch({}, proposal.replacePatch, 'win32'))

    keydown(win, { key: 'k', code: 'KeyK', ctrlKey: true })
    expect(created).toHaveBeenCalledTimes(1)
    expect(palette).not.toHaveBeenCalled()
  })

  it('refuses a hard-reserved chord before saving, so the stored overrides do not change', () => {
    stubWindow()
    const before = useAppStore.getState().shortcuts
    const result = recordAndSave('thread.new', { key: 'c', code: 'KeyC', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })
    expect(result).toMatchObject({ kind: 'refuse' })
    expect(useAppStore.getState().shortcuts).toBe(before)
    // The zoom family is refused too, including modified variants.
    expect(proposeBinding('thread.new', 'CommandOrControl+Shift+-', {}, 'win32').kind).toBe('refuse')
  })
})

describe('commands started outside the renderer', () => {
  function fakeBridge() {
    let listener: ((run: { id: CommandId; source: 'menu' | 'guest' }) => void) | undefined
    const setGuestShortcuts = vi.fn()
    return {
      bridge: {
        onRun: (cb: typeof listener) => {
          listener = cb
          return () => {
            listener = undefined
          }
        },
        setGuestShortcuts
      } as CommandsBridge,
      deliver: (id: CommandId, source: 'menu' | 'guest') => listener?.({ id, source }),
      setGuestShortcuts,
      connected: () => listener !== undefined
    }
  }
  const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve))
  const published = (setGuestShortcuts: ReturnType<typeof vi.fn>) =>
    (setGuestShortcuts.mock.calls.at(-1)?.[0] ?? []) as { binding: string; id: string }[]

  it('runs a command chosen in the application menu through the registry, once', () => {
    stubWindow()
    const { bridge, deliver, connected } = fakeBridge()
    const detach = attachCommandBridge(bridge)
    const run = vi.fn()
    registerCommand('thread.new', { run })

    deliver('thread.new', 'menu')
    expect(run).toHaveBeenCalledTimes(1)

    // The registry's rules apply to a menu click like to any other source.
    deliver('threads.search', 'menu')
    deliver('nope' as CommandId, 'menu')
    const release = registerDialog({} as HTMLElement)
    deliver('thread.new', 'menu')
    release()
    setRecording(true)
    deliver('thread.new', 'menu')
    setRecording(false)
    expect(run).toHaveBeenCalledTimes(1)

    detach()
    expect(connected()).toBe(false)
    expect(attachCommandBridge(undefined)).toBeTypeOf('function')
  })

  it('runs a chord once: the menu does not act on the key the page already handled', () => {
    const { win } = stubWindow()
    const { bridge, deliver } = fakeBridge()
    attachCommandBridge(bridge)
    attachCommandShortcuts(win as never)
    const run = vi.fn()
    registerCommand('thread.new', { run })

    // Electron's order for a key typed in the window: the before-input gate, the page, then the
    // menu accelerator, unless the gate switched the menu off for that key.
    let ignoreMenu = false
    let fire: ((event: unknown, input: unknown) => void) | undefined
    attachMenuShortcutGate(
      {
        on: (_channel: string, handler: (event: unknown, input: unknown) => void) => {
          fire = handler
        },
        setIgnoreMenuShortcuts: (ignore: boolean) => {
          ignoreMenu = ignore
        }
      } as never,
      () => useAppStore.getState().shortcuts,
      'win32'
    )
    const type = (init: { key: string; code: string; control?: boolean; alt?: boolean }) => {
      fire!({}, { type: 'keyDown', control: false, meta: false, alt: false, shift: false, isComposing: false, ...init })
      keydown(win, { key: init.key, code: init.code, ctrlKey: init.control ?? false, altKey: init.alt ?? false })
      const accelerator = resolveBinding(bindingFor('thread.new', useAppStore.getState().shortcuts, 'win32')!, 'win32')
      const typed = resolveBinding(init.alt ? `Alt+${init.key}` : `Ctrl+${init.key}`, 'win32')
      if (!ignoreMenu && typed === accelerator) deliver('thread.new', 'menu')
    }

    type({ key: 'n', code: 'KeyN', control: true })
    expect(run).toHaveBeenCalledTimes(1)

    // Rebound: the old chord is free and the new one acts once.
    useAppStore.setState({ shortcuts: { 'thread.new': 'Alt+N' } })
    type({ key: 'n', code: 'KeyN', control: true })
    expect(run).toHaveBeenCalledTimes(1)
    type({ key: 'n', code: 'KeyN', alt: true })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('publishes the chords the browser surface may forward, and follows rebinding and registration', async () => {
    stubWindow()
    const { bridge, setGuestShortcuts } = fakeBridge()
    const detach = attachCommandBridge(bridge)
    await settle()
    expect(published(setGuestShortcuts)).toEqual([])

    const unregister = registerCommand('palette.open', { run: vi.fn() })
    registerCommand('thread.new', { run: vi.fn() })
    registerCommand('surface.browser', { run: vi.fn() })
    registerCommand('run.stop', { run: vi.fn() })
    await settle()
    // Surface letters deny the browser surface; Stop run is listed because a turn is streaming.
    expect(published(setGuestShortcuts)).toEqual([
      { binding: 'Ctrl+K', id: 'palette.open' },
      { binding: 'Ctrl+N', id: 'thread.new' },
      { binding: 'Ctrl+Shift+Backspace', id: 'run.stop' }
    ])

    useAppStore.setState({ shortcuts: { 'thread.new': 'Alt+N', 'palette.open': null } })
    await settle()
    expect(published(setGuestShortcuts)).toEqual([
      { binding: 'Alt+N', id: 'thread.new' },
      { binding: 'Ctrl+Shift+Backspace', id: 'run.stop' }
    ])

    // New thread on Save or Find is never forwarded, so the page keeps those keys.
    useAppStore.setState({ shortcuts: { 'thread.new': 'CommandOrControl+S', 'palette.open': 'CommandOrControl+F' } })
    await settle()
    expect(published(setGuestShortcuts).map((entry) => entry.id)).toEqual(['run.stop'])

    useAppStore.setState({ shortcuts: {}, turnStates: {} })
    await settle()
    expect(published(setGuestShortcuts).map((entry) => entry.id)).toEqual(['palette.open', 'thread.new'])

    unregister()
    setRecording(true)
    await settle()
    expect(published(setGuestShortcuts)).toEqual([])

    const calls = setGuestShortcuts.mock.calls.length
    useAppStore.setState({ activeThreadId: 'thread-2' })
    await settle()
    expect(setGuestShortcuts.mock.calls.length).toBe(calls)
    detach()
  })

  it('runs a chord forwarded from the browser surface when the command is eligible', () => {
    stubWindow(textarea)
    const { bridge, deliver } = fakeBridge()
    attachCommandBridge(bridge)
    const palette = vi.fn()
    const browser = vi.fn()
    registerCommand('palette.open', { run: palette })
    registerCommand('surface.browser', { run: browser })

    deliver('palette.open', 'guest')
    deliver('surface.browser', 'guest')
    expect(palette).toHaveBeenCalledTimes(1)
    expect(browser).not.toHaveBeenCalled()

    // An open dialog owns the keyboard: nothing but Stop run is eligible.
    const release = registerDialog({} as HTMLElement)
    deliver('palette.open', 'guest')
    release()
    expect(palette).toHaveBeenCalledTimes(1)
  })
})
