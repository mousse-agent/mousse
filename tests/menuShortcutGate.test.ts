import { describe, expect, it, vi } from 'vitest'
import { attachMenuShortcutGate, resolvedBindingFromInput, type MenuKeyInput } from '../src/main/menu/menuShortcutGate'
import { buildMenuTemplate } from '../src/main/menu/menuTemplate'
import { parseBinding, resolveBinding, type ShortcutOverrides } from '../src/shared/commands'

type Listener = (event: { preventDefault(): void }, input: MenuKeyInput) => void

function fakeWebContents() {
  let listener: Listener | undefined
  const setIgnoreMenuShortcuts = vi.fn()
  return {
    webContents: {
      on: (channel: string, handler: Listener) => {
        if (channel === 'before-input-event') listener = handler
      },
      setIgnoreMenuShortcuts
    } as never,
    setIgnoreMenuShortcuts,
    press: (input: Partial<MenuKeyInput> & { key: string }) =>
      listener!(
        { preventDefault: vi.fn() },
        { type: 'keyDown', code: '', control: false, meta: false, alt: false, shift: false, isComposing: false, isAutoRepeat: false, ...input }
      )
  }
}

/** The key event that types a binding, the way Electron reports it. */
function inputForBinding(binding: string, platform: string): Partial<MenuKeyInput> & { key: string } {
  const parsed = parseBinding(resolveBinding(binding, platform)!)!
  const named = ['Tab', 'Backspace', 'Delete', 'Enter', 'Home', 'End', 'PageUp', 'PageDown']
  const key = named.includes(parsed.key) ? parsed.key : parsed.key.length === 1 ? parsed.key.toLowerCase() : parsed.key
  return { key, control: parsed.ctrl, meta: parsed.cmd, alt: parsed.alt, shift: parsed.shift }
}

const ctrlN = { key: 'n', code: 'KeyN', control: true }

describe('the menu shortcut gate', () => {
  it('keeps a registry chord away from the native menu', () => {
    const { webContents, press, setIgnoreMenuShortcuts } = fakeWebContents()
    attachMenuShortcutGate(webContents, () => ({}), 'win32')
    press(ctrlN)
    expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
    press({ key: 'Tab', code: 'Tab', control: true })
    expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
  })

  it('lets role chords reach the menu: Select all, Copy, and the zoom keys', () => {
    const { webContents, press, setIgnoreMenuShortcuts } = fakeWebContents()
    attachMenuShortcutGate(webContents, () => ({}), 'win32')
    for (const input of [
      { key: 'a', code: 'KeyA', control: true },
      { key: 'c', code: 'KeyC', control: true },
      { key: '=', code: 'Equal', control: true },
      { key: '-', code: 'Minus', control: true },
      { key: '0', code: 'Digit0', control: true },
      { key: 'x', code: 'KeyX', control: true }
    ]) {
      press(input)
      expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
    }
    press({ key: 'q', code: 'KeyQ', meta: true })
    expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
  })

  it('uses Cmd for the primary modifier on macOS, and leaves Ctrl+N to the menu there', () => {
    const { webContents, press, setIgnoreMenuShortcuts } = fakeWebContents()
    attachMenuShortcutGate(webContents, () => ({}), 'darwin')
    press({ key: 'n', code: 'KeyN', meta: true })
    expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
    press({ key: 'n', code: 'KeyN', control: true })
    expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
  })

  it('follows the profile: a rebound chord is gated and the freed one is not', () => {
    const { webContents, press, setIgnoreMenuShortcuts } = fakeWebContents()
    let shortcuts: ShortcutOverrides = {}
    attachMenuShortcutGate(webContents, () => shortcuts, 'win32')
    press(ctrlN)
    expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)

    shortcuts = { 'thread.new': 'Alt+N' }
    press(ctrlN)
    expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
    press({ key: 'n', code: 'KeyN', alt: true })
    expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)

    shortcuts = { 'thread.new': null }
    press({ key: 'n', code: 'KeyN', alt: true })
    expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
  })

  it('uses the default bindings until the window settings are known', () => {
    const { webContents, press, setIgnoreMenuShortcuts } = fakeWebContents()
    attachMenuShortcutGate(webContents, () => undefined, 'win32')
    press(ctrlN)
    expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
  })

  it('ignores key releases and composition, and unbound plain keys do not gate', () => {
    const { webContents, press, setIgnoreMenuShortcuts } = fakeWebContents()
    attachMenuShortcutGate(webContents, () => ({}), 'win32')
    press({ ...ctrlN, type: 'keyUp' })
    press({ ...ctrlN, isComposing: true })
    expect(setIgnoreMenuShortcuts).not.toHaveBeenCalled()
    press({ key: 'n', code: 'KeyN' })
    expect(setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
  })

  it('gates every accelerator the menu shows, so a chord acts once: in the renderer, not in the menu too', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      for (const shortcuts of [{}, { 'thread.new': 'Alt+Shift+N', 'run.stop': 'CommandOrControl+Shift+X', 'palette.open': 'Ctrl+K' }] as ShortcutOverrides[]) {
        const template = buildMenuTemplate({ isMac: platform === 'darwin', isDev: true, platform, shortcuts })
        const accelerators = template
          .flatMap((menu) => (menu.submenu ?? []) as Electron.MenuItemConstructorOptions[])
          .filter((item) => item.id && item.accelerator)
          .map((item) => String(item.accelerator))
        expect(accelerators.length).toBeGreaterThan(5)
        for (const accelerator of accelerators) {
          const { webContents, press, setIgnoreMenuShortcuts } = fakeWebContents()
          attachMenuShortcutGate(webContents, () => shortcuts, platform)
          press(inputForBinding(accelerator, platform))
          expect(setIgnoreMenuShortcuts, `${platform} ${accelerator}`).toHaveBeenLastCalledWith(true)
        }
      }
    }
  })

  it('reads a key as the same binding the renderer dispatcher would', () => {
    const base = { type: 'keyDown', code: 'KeyN', isComposing: false, isAutoRepeat: false, shift: false, alt: false, meta: false } as const
    expect(resolvedBindingFromInput({ ...base, key: 'n', control: true }, 'win32')).toBe('Ctrl+N')
    expect(resolvedBindingFromInput({ ...base, key: 'n', control: false, meta: true }, 'darwin')).toBe('Cmd+N')
    expect(resolvedBindingFromInput({ ...base, key: 'Shift', control: false, shift: true }, 'win32')).toBeNull()
  })
})
