import {
  bindingFor,
  getCommand,
  parseBinding,
  serializeBinding,
  type CommandId,
  type ShortcutOverrides
} from '../../shared/commands'

/** The registry commands the menu lists, by menu. Scoped and fixed commands are not menu items. */
export const MENU_COMMANDS = {
  Thread: ['thread.new', 'thread.next', 'thread.previous', 'threads.search', 'run.stop'],
  View: ['sideCard.toggle', 'terminal.open'],
  Go: ['palette.open', 'composer.focus']
} as const satisfies Record<string, readonly CommandId[]>

export interface MenuTemplateOptions {
  isMac: boolean
  isDev: boolean
  platform: string
  /** The bound profile's overrides; a missing entry means the command's default. */
  shortcuts: ShortcutOverrides
  appName?: string
  /** Called when a command item is chosen. Items have no `click` without it. */
  onRun?: (id: CommandId) => void
}

const ACCELERATOR_NAMED_KEYS: ReadonlySet<string> = new Set([
  'Tab',
  'Backspace',
  'Delete',
  'Enter',
  'Space',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
  'Plus'
])
const ACCELERATOR_PUNCTUATION = '`-=[]\\;\',./'

/**
 * The accelerator text for a binding, or undefined when it has none or Electron would not accept
 * its key (a non-Latin letter). The menu only displays it: the main-process gate keeps the native
 * menu from acting on it, and the renderer runs the command.
 */
export function menuAccelerator(binding: string | null): string | undefined {
  if (binding === null) return undefined
  const parsed = parseBinding(binding)
  if (!parsed) return undefined
  const { key } = parsed
  const valid =
    /^[A-Z0-9]$/.test(key) ||
    /^F([1-9]|1\d|2[0-4])$/.test(key) ||
    ACCELERATOR_NAMED_KEYS.has(key) ||
    (key.length === 1 && ACCELERATOR_PUNCTUATION.includes(key))
  return valid ? serializeBinding(parsed) : undefined
}

function commandItem(id: CommandId, options: MenuTemplateOptions): Electron.MenuItemConstructorOptions {
  const accelerator = menuAccelerator(bindingFor(id, options.shortcuts, options.platform))
  const { onRun } = options
  return {
    id,
    label: getCommand(id).title,
    ...(accelerator ? { accelerator } : {}),
    ...(onRun ? { click: () => onRun(id) } : {})
  }
}

/**
 * The application menu: Electron roles plus the registry commands with the shortcuts in force. No
 * `electron` import, so it can be built and checked without a running app.
 */
export function buildMenuTemplate(options: MenuTemplateOptions): Electron.MenuItemConstructorOptions[] {
  const { isMac, isDev } = options
  const items = (ids: readonly CommandId[]) => ids.map((id) => commandItem(id, options))

  const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
    ...items(MENU_COMMANDS.View),
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' }
  ]

  if (isDev) {
    viewSubmenu.unshift(
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' }
    )
  }

  return [
    ...(isMac
      ? [
          {
            label: options.appName ?? 'Mousse',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } satisfies Electron.MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    { label: 'Thread', submenu: items(MENU_COMMANDS.Thread) },
    { label: 'View', submenu: viewSubmenu },
    { label: 'Go', submenu: items(MENU_COMMANDS.Go) }
  ]
}
