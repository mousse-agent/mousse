import { useEffect, useMemo, useRef } from 'react'
import { create } from 'zustand'
import {
  COMMANDS,
  bindingFor,
  commandAllowedInContext,
  getCommand,
  isCommandId,
  reservedMatches,
  resolveBindings,
  type CommandContext,
  type CommandId,
  type OverlayScope,
  type ShortcutOverrides
} from '../../shared/commands'
import { hasOpenDialog } from '../components/ui/Modal'
import { useAppStore } from '../stores/appStore'
import { commandContextFromDom, type ClosestTarget } from './commandContext'

export interface CommandHandler {
  run: () => void
  /** False while the command cannot run (nothing to act on). A disabled command is treated as unregistered. */
  enabled?: () => boolean
}

/** Where a run came from; each source builds its text-field and overlay context differently. */
export type CommandSource = 'key' | 'menu' | 'palette' | 'guest'

interface CommandRegistryState {
  handlers: ReadonlyMap<CommandId, CommandHandler>
  /** The Shortcuts recorder is listening: no command runs from any source. */
  recording: boolean
  /** Open overlays that own the keyboard, last opened on top. */
  overlays: readonly OverlayScope[]
}

export const useCommandRegistry = create<CommandRegistryState>(() => ({
  handlers: new Map(),
  recording: false,
  overlays: []
}))

/** Registers a handler for a command; the returned function removes it, unless a later one replaced it. */
export function registerCommand(id: CommandId, handler: CommandHandler): () => void {
  useCommandRegistry.setState((state) => ({ handlers: new Map(state.handlers).set(id, handler) }))
  return () =>
    useCommandRegistry.setState((state) => {
      if (state.handlers.get(id) !== handler) return state
      const handlers = new Map(state.handlers)
      handlers.delete(id)
      return { handlers }
    })
}

/** Registers a command for as long as the calling component is mounted. `run` and `enabled` are read when the command fires. */
export function useCommand(id: CommandId, run: () => void, enabled?: () => boolean): void {
  const latest = useRef({ run, enabled })
  latest.current = { run, enabled }
  useEffect(
    () => registerCommand(id, { run: () => latest.current.run(), enabled: () => latest.current.enabled?.() ?? true }),
    [id]
  )
}

/** `useCommand` for a fixed list of commands, such as the five surface letters or the five model slots. */
export function useCommands(commands: ReadonlyArray<{ id: CommandId; run: () => void; enabled?: () => boolean }>): void {
  const latest = useRef(commands)
  latest.current = commands
  const key = commands.map((command) => command.id).join(',')
  useEffect(() => {
    const unregister = latest.current.map((command, index) =>
      registerCommand(command.id, {
        run: () => latest.current[index]?.run(),
        enabled: () => latest.current[index]?.enabled?.() ?? true
      })
    )
    return () => unregister.forEach((off) => off())
  }, [key])
}

/** Marks an overlay as topmost; the returned function removes it. */
export function pushOverlay(scope: OverlayScope): () => void {
  useCommandRegistry.setState((state) => ({ overlays: [...state.overlays, scope] }))
  let popped = false
  return () => {
    if (popped) return
    popped = true
    useCommandRegistry.setState((state) => {
      const index = state.overlays.lastIndexOf(scope)
      if (index === -1) return state
      return { overlays: state.overlays.filter((_, at) => at !== index) }
    })
  }
}

/** An overlay (palette, search dialog, model picker) owns the keyboard while `open`. Modal dialogs are read from `Modal.tsx`. */
export function useCommandOverlay(scope: OverlayScope, open: boolean): void {
  useEffect(() => (open ? pushOverlay(scope) : undefined), [scope, open])
}

export function setRecording(recording: boolean): void {
  useCommandRegistry.setState({ recording })
}

/** Whether a handler is mounted for the command and not disabled. */
export function isCommandRegistered(id: CommandId): boolean {
  const handler = useCommandRegistry.getState().handlers.get(id)
  return Boolean(handler) && (handler!.enabled?.() ?? true)
}

/** `closest` is on elements only; a key can also target `window` or `document`. */
export function asClosestTarget(value: unknown): ClosestTarget | null {
  return value && typeof (value as ClosestTarget).closest === 'function' ? (value as ClosestTarget) : null
}

/**
 * The context for a run. A key press reads the focused element. A palette row and a menu click are
 * not typed into a field, so they see neither a text field nor a terminal; the palette also leaves
 * its own overlay out, while a menu click sees every overlay (a dialog stays above the menu). A chord
 * forwarded from the browser surface came from a text-capable page.
 */
export function currentContext(source: CommandSource, target?: ClosestTarget | null): CommandContext {
  const focused = source === 'key' ? (target ?? asClosestTarget(typeof document === 'undefined' ? null : document.activeElement)) : null
  const context = commandContextFromDom(focused, useAppStore.getState(), {
    modalOpen: hasOpenDialog(),
    stack: useCommandRegistry.getState().overlays,
    ignore: source === 'palette' ? 'palette' : undefined
  })
  // Until the app info arrives the preload still knows the platform.
  if (!context.platform && typeof window !== 'undefined') context.platform = window.mousse?.platform ?? ''
  // A palette row or menu click has no focus to judge, so it counts as being in the Files panel.
  if (source !== 'key') context.inFilesPanel = true
  return source === 'guest' ? { ...context, inTextInput: true } : context
}

let bindingsCache: { overrides: ShortcutOverrides; platform: string; bindings: Map<string, CommandId[]> } | null = null

/** `resolveBindings`, kept until the overrides or the platform change. */
export function currentBindings(overrides: ShortcutOverrides, platform: string): Map<string, CommandId[]> {
  if (!bindingsCache || bindingsCache.overrides !== overrides || bindingsCache.platform !== platform) {
    bindingsCache = { overrides, platform, bindings: resolveBindings(overrides, platform) }
  }
  return bindingsCache.bindings
}

/** Runs a handler that is known to be eligible. Used by the key dispatcher, which has already resolved the context. */
export function invokeCommand(id: CommandId): boolean {
  const handler = useCommandRegistry.getState().handlers.get(id)
  if (!handler) return false
  handler.run()
  return true
}

/**
 * Runs a command from the menu, the palette, a key press or the browser surface. Refused while the
 * Shortcuts recorder is listening, when nothing is registered or enabled, when the context does not
 * allow it (an open dialog, `when`), or for a chord the browser surface may not forward.
 */
export function runCommand(id: CommandId, source: CommandSource, target?: ClosestTarget | null): boolean {
  if (useCommandRegistry.getState().recording) return false
  const command = getCommand(id)
  if (source === 'guest' && command.guest === 'deny') return false
  if (!isCommandRegistered(id)) return false
  if (!commandAllowedInContext(command, currentContext(source, target))) return false
  return invokeCommand(id)
}

/** What the preload offers for commands started outside the renderer (the menu, the browser surface). */
export interface CommandsBridge {
  onRun(cb: (run: { id: CommandId; source: 'menu' | 'guest' }) => void): () => void
  setGuestShortcuts(shortcuts: GuestShortcutEntry[]): unknown
}

export interface GuestShortcutEntry {
  binding: string
  id: CommandId
}

/**
 * The chords the browser surface may hand to the renderer: the resolved binding of each command that
 * is registered and enabled, allowed from the browser surface, and eligible in the current context
 * with a text field focused. Reserved chords are never listed; nothing is while the recorder listens.
 */
export function guestShortcutEntries(): GuestShortcutEntry[] {
  if (useCommandRegistry.getState().recording) return []
  const context = currentContext('guest')
  const entries: GuestShortcutEntry[] = []
  for (const [binding, ids] of currentBindings(useAppStore.getState().shortcuts, context.platform)) {
    const id = ids.find((candidate) => {
      const command = getCommand(candidate)
      return (
        command.guest === 'allow' &&
        isCommandRegistered(candidate) &&
        commandAllowedInContext(command, context) &&
        reservedMatches(binding, context.platform, candidate).length === 0
      )
    })
    if (id) entries.push({ binding, id })
  }
  return entries
}

/**
 * Connects the registry to the main process: a command chosen in the application menu or typed in the
 * browser surface runs through `runCommand`, and the chords the browser surface may forward are
 * published whenever handlers, overrides or the context change. Returns what disconnects it.
 */
export function attachCommandBridge(bridge: CommandsBridge | undefined): () => void {
  if (!bridge) return () => undefined
  const stopRun = bridge.onRun(({ id, source }) => {
    if (isCommandId(id)) runCommand(id, source)
  })
  let published = ''
  let scheduled = false
  const publish = (): void => {
    scheduled = false
    const entries = guestShortcutEntries()
    const next = JSON.stringify(entries)
    if (next === published) return
    published = next
    void Promise.resolve(bridge.setGuestShortcuts(entries)).catch(() => undefined)
  }
  // Many store updates arrive together; one publish follows them.
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(publish)
  }
  const stopRegistry = useCommandRegistry.subscribe(schedule)
  const stopApp = useAppStore.subscribe(schedule)
  schedule()
  return () => {
    stopRun()
    stopRegistry()
    stopApp()
  }
}

/** The binding of every command under the bound profile's overrides; null where unbound. */
export function useCommandBindings(): Record<CommandId, string | null> {
  const overrides = useAppStore((state) => state.shortcuts)
  const platform = useAppStore((state) => state.appInfo?.platform) ?? ''
  return useMemo(
    () => Object.fromEntries(COMMANDS.map((command) => [command.id, bindingFor(command.id, overrides, platform)])) as Record<CommandId, string | null>,
    [overrides, platform]
  )
}
