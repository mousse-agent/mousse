import type { WebContents } from 'electron'
import { getCommand, isCommandId, parseBinding, reservedMatches, resolveBinding, type CommandId } from '../../shared/commands'
import { resolvedBindingFromInput, type MenuKeyInput } from './menuShortcutGate'

/** A chord the renderer will run if the browser surface forwards it: the resolved binding and its command. */
export interface GuestShortcut {
  binding: string
  id: CommandId
}

const forwardedByOwner = new Map<number, ReadonlyMap<string, CommandId>>()

/**
 * Remembers the chords the renderer of a window can run from the browser surface. Entries that are
 * malformed, name a command that may not run from the browser surface, or sit on a reserved chord
 * are dropped, whatever the renderer sent.
 */
export function setGuestShortcuts(ownerId: number, entries: unknown, platform: string = process.platform): void {
  const forwarded = new Map<string, CommandId>()
  if (Array.isArray(entries)) {
    for (const entry of entries as Partial<GuestShortcut>[]) {
      if (!entry || typeof entry.binding !== 'string' || !isCommandId(entry.id)) continue
      if (!parseBinding(entry.binding) || getCommand(entry.id).guest !== 'allow') continue
      const resolved = resolveBinding(entry.binding, platform)
      if (resolved === null || reservedMatches(resolved, platform, entry.id).length > 0) continue
      if (!forwarded.has(resolved)) forwarded.set(resolved, entry.id)
    }
  }
  forwardedByOwner.set(ownerId, forwarded)
}

export function clearGuestShortcuts(ownerId: number): void {
  forwardedByOwner.delete(ownerId)
}

export function guestShortcutsFor(ownerId: number): ReadonlyMap<string, CommandId> | undefined {
  return forwardedByOwner.get(ownerId)
}

export interface GuestShortcutHandlerOptions {
  guest: Pick<WebContents, 'setIgnoreMenuShortcuts'>
  /** The chords currently forwardable; read on every key. */
  getForwarded: () => ReadonlyMap<string, CommandId> | undefined
  /** Delivers a forwarded command to the window's renderer. */
  send: (run: { id: CommandId; source: 'guest' }) => void
  platform?: string
}

/**
 * The `before-input-event` handler of a browser-surface guest. A key typed there never reaches the
 * window's own listeners, so two things happen here.
 *
 * First the guest's native-menu path is gated: only chords that can never be registry bindings (Edit,
 * window and zoom roles) may reach the menu, so a registry accelerator cannot fall back to a menu
 * click while the page keeps its editing keys. Then a chord the renderer can run is taken from the
 * page and sent to the renderer. Anything else, including reserved chords such as Mod+S and Mod+F and
 * chords of commands that are not eligible, reaches the page untouched.
 */
export function createGuestShortcutHandler(
  options: GuestShortcutHandlerOptions
): (event: { preventDefault(): void }, input: MenuKeyInput) => void {
  const platform = options.platform ?? process.platform
  return (event, input) => {
    if (input.type !== 'keyDown' || input.isComposing) return
    const binding = resolvedBindingFromInput(input, platform)
    const roleChord = binding !== null && reservedMatches(binding, platform).some((entry) => entry.hard)
    options.guest.setIgnoreMenuShortcuts(!roleChord)
    if (binding === null || input.isAutoRepeat) return
    const id = options.getForwarded()?.get(binding)
    if (!id || reservedMatches(binding, platform, id).length > 0) return
    event.preventDefault()
    options.send({ id, source: 'guest' })
  }
}

/** Wires a browser-surface guest to the window that owns it. */
export function attachGuestShortcuts(guest: WebContents, owner: WebContents, platform?: string): void {
  const ownerId = owner.id
  guest.on(
    'before-input-event',
    createGuestShortcutHandler({
      guest,
      getForwarded: () => guestShortcutsFor(ownerId),
      send: (run) => {
        if (!owner.isDestroyed()) owner.send('commands:run', run)
      },
      platform
    })
  )
}
