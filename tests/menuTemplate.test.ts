import { describe, expect, it, vi } from 'vitest'
import { buildMenuTemplate, MENU_COMMANDS, menuAccelerator } from '../src/main/menu/menuTemplate'
import { getCommand,normalizeShortcuts, reservedMatches, type CommandId, type ShortcutOverrides } from '../src/shared/commands'

type Item = Electron.MenuItemConstructorOptions

function build(shortcuts: ShortcutOverrides = {}, options: { platform?: string; isDev?: boolean; onRun?: (id: CommandId) => void } = {}): Item[] {
  const platform = options.platform ?? 'win32'
  return buildMenuTemplate({ isMac: platform === 'darwin', isDev: options.isDev ?? false, platform, shortcuts, onRun: options.onRun })
}

const submenu = (template: Item[], label: string): Item[] =>
  (template.find((menu) => menu.label === label)?.submenu ?? []) as Item[]

/** The command items of the whole menu, by command id. */
function commandItems(template: Item[]): Map<string, Item> {
  const items = new Map<string, Item>()
  for (const menu of template) {
    for (const item of (menu.submenu ?? []) as Item[]) if (item.id) items.set(item.id, item)
  }
  return items
}

describe('the application menu template', () => {
  it('lists the menu commands with their current shortcuts', () => {
    const template = build()
    const thread = submenu(template, 'Thread')
    expect(thread.map((item) => [item.id, item.label, item.accelerator])).toEqual([
      ['thread.new', 'New thread', 'CommandOrControl+N'],
      ['thread.next', 'Next thread', 'Ctrl+Tab'],
      ['thread.previous', 'Previous thread', 'Ctrl+Shift+Tab'],
      ['threads.search', 'Search threads', 'CommandOrControl+Shift+O'],
      ['run.stop', 'Stop run', 'CommandOrControl+Shift+Backspace']
    ])
    expect(submenu(template, 'View').filter((item) => item.id).map((item) => [item.id, item.accelerator])).toEqual([
      ['sideCard.toggle', 'CommandOrControl+Shift+D'],
      ['terminal.open', 'CommandOrControl+J']
    ])
    expect(submenu(template, 'Go').map((item) => [item.id, item.accelerator])).toEqual([
      ['palette.open', 'CommandOrControl+K'],
      ['composer.focus', 'CommandOrControl+Shift+M']
    ])
  })

  it('shows the same bindings on macOS, where CommandOrControl is Cmd, and keeps the app menu there', () => {
    const mac = build({}, { platform: 'darwin' })
    expect(mac[0]?.label).toBe('Mousse')
    expect(commandItems(mac).get('thread.new')?.accelerator).toBe('CommandOrControl+N')
    expect(build().some((menu) => menu.label === 'Mousse')).toBe(false)
  })

  it('shows a rebound shortcut, and none for an unbound command', () => {
    const items = commandItems(build({ 'thread.new': 'CommandOrControl+Shift+N', 'palette.open': null }))
    expect(items.get('thread.new')?.accelerator).toBe('CommandOrControl+Shift+N')
    expect(items.has('palette.open')).toBe(true)
    expect(items.get('palette.open')).not.toHaveProperty('accelerator')
    expect(items.get('terminal.open')?.accelerator).toBe('CommandOrControl+J')
  })

  it('builds a different menu for each profile', () => {
    const first = build({ 'thread.new': 'Alt+N' })
    const second = build({ 'thread.new': 'Alt+M', 'run.stop': null })
    expect(commandItems(first).get('thread.new')?.accelerator).toBe('Alt+N')
    expect(commandItems(second).get('thread.new')?.accelerator).toBe('Alt+M')
    expect(commandItems(second).get('run.stop')).not.toHaveProperty('accelerator')
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(second))
  })

  it('leaves out an accelerator Electron would reject', () => {
    expect(menuAccelerator('CommandOrControl+Ж')).toBeUndefined()
    expect(menuAccelerator('CommandOrControl+Plus')).toBe('CommandOrControl+Plus')
    expect(menuAccelerator('CommandOrControl+F12')).toBe('CommandOrControl+F12')
    expect(menuAccelerator('Ctrl+/')).toBe('Ctrl+/')
    expect(menuAccelerator(null)).toBeUndefined()
    expect(menuAccelerator('Super+K')).toBeUndefined()
  })

  it('lists no scoped or fixed command and no command twice', () => {
    const ids = [...commandItems(build()).keys()]
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.sort()).toEqual([...Object.values(MENU_COMMANDS).flat()].sort())
    for (const id of ids) {
      const command = getCommand(id as CommandId)
      expect(command.scope).toBe('global')
      expect(command.fixed).toBeUndefined()
    }
  })

  it('keeps the Edit and zoom roles, which are never registry bindings', () => {
    const template = build()
    expect(submenu(template, 'Edit').map((item) => item.role)).toEqual([
      'undo', 'redo', undefined, 'cut', 'copy', 'paste', 'selectAll'
    ])
    expect(submenu(template, 'View').map((item) => item.role).filter(Boolean)).toEqual(['resetZoom', 'zoomIn', 'zoomOut'])
    for (const platform of ['win32', 'darwin']) {
      for (const accelerator of [...commandItems(build({}, { platform })).values()].map((item) => item.accelerator)) {
        expect(reservedMatches(accelerator as string, platform).filter((entry) => entry.hard)).toEqual([])
      }
    }
  })

  it('never offers a hard-reserved chord that a stored override carries', () => {
    const items = commandItems(build(normalizeShortcuts({ 'thread.new': 'CommandOrControl+C', 'run.stop': 'CommandOrControl+Shift+0' }, 'win32')))
    expect(items.get('thread.new')?.accelerator).toBe('CommandOrControl+N')
    expect(items.get('run.stop')?.accelerator).toBe('CommandOrControl+Shift+Backspace')
  })

  it('adds the development items only in development', () => {
    expect(submenu(build({}, { isDev: true }), 'View').slice(0, 3).map((item) => item.role)).toEqual(['reload', 'forceReload', 'toggleDevTools'])
    expect(submenu(build(), 'View').some((item) => item.role === 'reload')).toBe(false)
  })

  it('runs the chosen command through the callback, and only with one', () => {
    const onRun = vi.fn()
    const items = commandItems(build({}, { onRun }))
    for (const item of items.values()) expect(item.click).toBeTypeOf('function')
    ;(items.get('composer.focus')?.click as () => void)()
    expect(onRun).toHaveBeenCalledTimes(1)
    expect(onRun).toHaveBeenCalledWith('composer.focus')
    expect(commandItems(build()).get('thread.new')).not.toHaveProperty('click')
  })
})
