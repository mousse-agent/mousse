import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearGuestShortcuts,
  createGuestShortcutHandler,
  guestShortcutsFor,
  setGuestShortcuts
} from '../src/main/menu/guestShortcutForward'
import type { MenuKeyInput } from '../src/main/menu/menuShortcutGate'
import type { CommandId } from '../src/shared/commands'

const noKeys: MenuKeyInput = {
  type: 'keyDown',
  key: '',
  code: '',
  control: false,
  meta: false,
  alt: false,
  shift: false,
  isComposing: false,
  isAutoRepeat: false
}

/** A guest whose renderer-supplied set is `entries`, and what it did with the keys typed in it. */
function guest(entries: { binding: string; id: CommandId }[], platform = 'win32') {
  setGuestShortcuts(1, entries, platform)
  const setIgnoreMenuShortcuts = vi.fn()
  const preventDefault = vi.fn()
  const send = vi.fn()
  const handler = createGuestShortcutHandler({
    guest: { setIgnoreMenuShortcuts },
    getForwarded: () => guestShortcutsFor(1),
    send,
    platform
  })
  return {
    setIgnoreMenuShortcuts,
    preventDefault,
    send,
    press: (input: Partial<MenuKeyInput>) => handler({ preventDefault }, { ...noKeys, ...input })
  }
}

const ctrlK = { key: 'k', code: 'KeyK', control: true }
const defaults = [
  { binding: 'Ctrl+K', id: 'palette.open' as const },
  { binding: 'Ctrl+N', id: 'thread.new' as const }
]

beforeEach(() => clearGuestShortcuts(1))

describe('chords typed into the browser surface', () => {
  it('reach the renderer when the command is eligible, and no longer reach the page or the menu', () => {
    const { press, send, preventDefault, setIgnoreMenuShortcuts } = guest(defaults)
    press(ctrlK)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ id: 'palette.open', source: 'guest' })
    expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
  })

  it('stay with the page when the command is not in the set the renderer supplied', () => {
    const { press, send, preventDefault, setIgnoreMenuShortcuts } = guest([{ binding: 'Ctrl+K', id: 'palette.open' }])
    press({ key: 'n', code: 'KeyN', control: true })
    expect(preventDefault).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
  })

  it('follow the macOS primary modifier', () => {
    const { press, send } = guest([{ binding: 'CommandOrControl+K', id: 'palette.open' }], 'darwin')
    press({ key: 'k', code: 'KeyK', control: true })
    expect(send).not.toHaveBeenCalled()
    press({ key: 'k', code: 'KeyK', meta: true })
    expect(send).toHaveBeenCalledWith({ id: 'palette.open', source: 'guest' })
  })

  it('are not forwarded when held down or while composing, and key releases do nothing', () => {
    const { press, send, preventDefault, setIgnoreMenuShortcuts } = guest(defaults)
    press({ ...ctrlK, isAutoRepeat: true })
    press({ ...ctrlK, isComposing: true })
    press({ ...ctrlK, type: 'keyUp' })
    expect(send).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
    expect(setIgnoreMenuShortcuts).toHaveBeenCalledTimes(1)
  })

  it('leave a reserved chord to the page even when New thread is rebound to it', () => {
    for (const [binding, key, code] of [['Ctrl+S', 's', 'KeyS'], ['Ctrl+F', 'f', 'KeyF']] as const) {
      const { press, send, preventDefault, setIgnoreMenuShortcuts } = guest([{ binding, id: 'thread.new' }])
      expect(guestShortcutsFor(1)?.size).toBe(0)
      press({ key, code, control: true })
      expect(send).not.toHaveBeenCalled()
      expect(preventDefault).not.toHaveBeenCalled()
      // The menu is gated, so the accelerator does not fire New thread from the page either.
      expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
    }
  })

  it('never forward a reserved chord, even if the set somehow carries one', () => {
    const forwarded = new Map<string, CommandId>([['Ctrl+S', 'thread.new'], ['Ctrl+F', 'thread.new']])
    const send = vi.fn()
    const preventDefault = vi.fn()
    const handler = createGuestShortcutHandler({
      guest: { setIgnoreMenuShortcuts: vi.fn() },
      getForwarded: () => forwarded,
      send,
      platform: 'win32'
    })
    handler({ preventDefault }, { ...noKeys, key: 's', code: 'KeyS', control: true })
    handler({ preventDefault }, { ...noKeys, key: 'f', code: 'KeyF', control: true })
    expect(send).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('let editing and window roles through to the menu while the page keeps its keys', () => {
    const { press, send, preventDefault, setIgnoreMenuShortcuts } = guest(defaults)
    for (const input of [
      { key: 'c', code: 'KeyC', control: true },
      { key: 'a', code: 'KeyA', control: true },
      { key: 'z', code: 'KeyZ', control: true },
      { key: '=', code: 'Equal', control: true },
      { key: '0', code: 'Digit0', control: true }
    ]) {
      press(input)
      expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
    }
    expect(send).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('let Quit and Hide through to the macOS menu', () => {
    const { press, setIgnoreMenuShortcuts } = guest(defaults, 'darwin')
    press({ key: 'q', code: 'KeyQ', meta: true })
    expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
    press({ key: 'h', code: 'KeyH', meta: true })
    expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
  })

  it('keep a plain key from the menu without taking it from the page', () => {
    const { press, send, preventDefault, setIgnoreMenuShortcuts } = guest(defaults)
    press({ key: 'a', code: 'KeyA' })
    press({ key: 'Escape', code: 'Escape' })
    expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
    expect(send).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })
})

describe('the set of chords the renderer supplies', () => {
  it('keeps only commands the browser surface may forward, on chords that are not reserved', () => {
    setGuestShortcuts(
      1,
      [
        { binding: 'CommandOrControl+K', id: 'palette.open' },
        { binding: 'CommandOrControl+1', id: 'model.pick1' },
        { binding: 'B', id: 'surface.browser' },
        { binding: 'CommandOrControl+C', id: 'thread.new' },
        { binding: 'CommandOrControl+Shift+0', id: 'thread.new' },
        { binding: 'not a binding', id: 'thread.new' },
        { binding: 'CommandOrControl+N', id: 'nope' },
        null,
        { binding: 7, id: 'thread.new' }
      ],
      'win32'
    )
    expect([...(guestShortcutsFor(1) ?? [])]).toEqual([['Ctrl+K', 'palette.open']])
    setGuestShortcuts(1, 'garbage', 'win32')
    expect(guestShortcutsFor(1)?.size).toBe(0)
  })

  it('is cleared with its window', () => {
    setGuestShortcuts(1, defaults, 'win32')
    expect(guestShortcutsFor(1)?.size).toBe(2)
    clearGuestShortcuts(1)
    expect(guestShortcutsFor(1)).toBeUndefined()
  })
})
