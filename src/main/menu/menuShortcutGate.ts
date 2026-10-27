import type { WebContents } from 'electron'
import {
  bindingFromKey,
  resolveBinding,
  resolveBindings,
  type CommandId,
  type ShortcutOverrides
} from '../../shared/commands'

/** The fields of Electron's `Input` that a binding is made from. */
export type MenuKeyInput = Pick<
  Electron.Input,
  'type' | 'key' | 'code' | 'control' | 'meta' | 'alt' | 'shift' | 'isComposing' | 'isAutoRepeat'
>

/** The platform-resolved binding a key-down stands for, or null when it is not a shortcut candidate. */
export function resolvedBindingFromInput(input: MenuKeyInput, platform: string): string | null {
  const binding = bindingFromKey(
    {
      key: input.key,
      code: input.code,
      ctrlKey: input.control,
      metaKey: input.meta,
      altKey: input.alt,
      shiftKey: input.shift,
      isComposing: input.isComposing
    },
    platform
  )
  return binding === null ? null : resolveBinding(binding, platform)
}

const NO_OVERRIDES: ShortcutOverrides = {}

type BindingTable =Map<string, CommandId[]>
let cachedTable: { overrides: ShortcutOverrides; platform: string; table: BindingTable } | null = null

/** `resolveBindings`, kept until the overrides object changes: key presses are frequent. */
function bindingTable(overrides: ShortcutOverrides, platform: string): BindingTable {
  if (!cachedTable || cachedTable.overrides !== overrides || cachedTable.platform !== platform) {
    cachedTable = { overrides, platform, table: resolveBindings(overrides, platform) }
  }
  return cachedTable.table
}

/**
 * Keeps the native menu from acting on a registry chord. Electron hands a key to the menu
 * accelerators after `before-input-event`; `setIgnoreMenuShortcuts` suppresses only that path, so the
 * page still receives the key and the renderer decides whether the command runs. Role chords (Edit,
 * zoom) are not registry bindings and keep reaching the menu. Until the window's settings are known
 * the default bindings apply.
 */
export function attachMenuShortcutGate(
  webContents: Pick<WebContents, 'on' | 'setIgnoreMenuShortcuts'>,
  getShortcuts: () => ShortcutOverrides | undefined,
  platform: string = process.platform
): void {
  webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown' || input.isComposing) return
    const binding = resolvedBindingFromInput(input, platform)
    const table = bindingTable(getShortcuts() ?? NO_OVERRIDES, platform)
    webContents.setIgnoreMenuShortcuts(binding !== null && table.has(binding))
  })
}
