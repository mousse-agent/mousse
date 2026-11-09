import { useEffect, useMemo, useRef } from 'react'
import { create } from 'zustand'
import {
  COMMANDS,
  bindingFor,
  commandAllowedInContext,
  formatBinding,
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
  /**
   * False: the handler answers the palette and the menu but never a key press, so a scoped binding
   * (a surface letter) stays with the view that owns it while the palette can still list the command.
   */
  keys?: boolean
  /**
   * True: the handler answers key presses only, never the palette, the menu or the browser surface. A page uses it
   * to give a chord its own meaning while the page has focus (⌘N on Automations), and the palette keeps the
   * command's app-wide meaning.
   */
  keysOnly?: boolean
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

/** The handlers registered for one command, oldest first; a later one is asked first. */
interface StackedHandler extends CommandHandler {
  stack: readonly CommandHandler[]
}

const handlersOf = (handler: CommandHandler | undefined): readonly CommandHandler[] =>
  handler ? ((handler as Partial<StackedHandler>).stack ?? [handler]) : []

const isEnabled = (handler: CommandHandler): boolean => handler.enabled?.() ?? true

/** Whether a run from `source` may use the handler: key presses and forwarded chords skip `keys: false`. */
const servesSource = (handler: CommandHandler, source: CommandSource): boolean =>
  handler.keysOnly === true ? source === 'key' : handler.keys !== false || (source !== 'key' && source !== 'guest')

function stacked(stack: readonly CommandHandler[]): CommandHandler {
  if (stack.length === 1) return stack[0]!
  const handler: StackedHandler = {
    stack,
    // A run with no source (a direct call) is not a key press, so a key-only handler sits it out.
    run: () => [...stack].reverse().find((entry) => isEnabled(entry) && entry.keysOnly !== true)?.run(),
    enabled: () => stack.some(isEnabled)
  }
  return handler
}

/** The newest enabled handler of a command that a run from `source` may use. */
function handlerFor(id: CommandId, source: CommandSource): CommandHandler | undefined {
  return [...handlersOf(useCommandRegistry.getState().handlers.get(id))]
    .reverse()
    .find((handler) => isEnabled(handler) && servesSource(handler, source))
}

/**
 * Registers a handler for a command; the returned function removes it. Two views can be mounted at
 * once (a hidden thread and the one shown): the newest enabled handler runs, and when it goes away
 * the one before it answers again.
 */
export function registerCommand(id: CommandId, handler: CommandHandler): () => void {
  useCommandRegistry.setState((state) => ({
    handlers: new Map(state.handlers).set(id, stacked([...handlersOf(state.handlers.get(id)), handler]))
  }))
  return () =>
    useCommandRegistry.setState((state) => {
      const current = handlersOf(state.handlers.get(id))
      const remaining = current.filter((entry) => entry !== handler)
      if (remaining.length === current.length) return state
      const handlers = new Map(state.handlers)
      if (remaining.length) handlers.set(id, stacked(remaining))
      else handlers.delete(id)
      return { handlers }
    })
}

/**
 * Registers a command for as long as the calling component is mounted. `run` and `enabled` are read when the command
 * fires. `keysOnly` registers a key-press-only handler (see `CommandHandler.keysOnly`).
 */
export function useCommand(id: CommandId, run: () => void, enabled?: () => boolean, options: { keysOnly?: boolean } = {}): void {
  const latest = useRef({ run, enabled })
  latest.current = { run, enabled }
  const keysOnly = options.keysOnly === true
  useEffect(
    () => registerCommand(id, { run: () => latest.current.run(), enabled: () => latest.current.enabled?.() ?? true, ...(keysOnly ? { keysOnly: true } : {}) }),
    [id, keysOnly]
  )
}

/**
 * `useCommand` for a fixed list of commands, such as the five surface letters or the five model slots.
 * `keys: false` registers them for the palette and the menu only.
 */
export function useCommands(
  commands: ReadonlyArray<{ id: CommandId; run: () => void; enabled?: () => boolean }>,
  options: { keys?: boolean } = {}
): void {
  const latest = useRef(commands)
  latest.current = commands
  const key = commands.map((command) => command.id).join(',')
  const keys = options.keys ?? true
  useEffect(() => {
    const unregister = latest.current.map((command, index) =>
      registerCommand(command.id, {
        run: () => latest.current[index]?.run(),
        enabled: () => latest.current[index]?.enabled?.() ?? true,
        ...(keys ? {} : { keys: false })
      })
    )
    return () => unregister.forEach((off) => off())
  }, [key, keys])
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

/**
 * Whether a handler is mounted for the command and not disabled. With a `source`, only handlers a run
 * from there may use count (a key press skips palette-only handlers).
 */
export function isCommandRegistered(id: CommandId, source?: CommandSource): boolean {
  if (source) return handlerFor(id, source) !== undefined
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
  context.fromKey = source === 'key' || source === 'guest'
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

/**
 * Runs a handler that is known to be eligible. Used by the key dispatcher, which has already resolved
 * the context; with a `source` the newest handler that serves it runs.
 */
export function invokeCommand(id: CommandId, source?: CommandSource): boolean {
  const handler = source ? handlerFor(id, source) : useCommandRegistry.getState().handlers.get(id)
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
  if (!isCommandRegistered(id, source)) return false
  if (!commandAllowedInContext(command, currentContext(source, target))) return false
  return invokeCommand(id, source)
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
        isCommandRegistered(candidate, 'guest') &&
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

/** A tooltip that names its shortcut: `Hide sidebar · Ctrl+B`, or the label alone when unbound. */
export function shortcutTitle(label: string, binding: string | null, platform: string): string {
  const keys = binding === null ? '' : formatBinding(binding, platform)
  return keys ? `${label} · ${keys}` : label
}

/** `shortcutTitle` for a command under the bound profile's overrides. */
export function useShortcutTitle(label: string, id: CommandId): string {
  const binding = useCommandBindings()[id]
  const platform = useAppStore((state) => state.appInfo?.platform) ?? (typeof window === 'undefined' ? '' : window.mousse?.platform ?? '')
  return shortcutTitle(label, binding, platform)
}
