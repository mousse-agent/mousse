import { useEffect } from 'react'
import { resolveCommand, type CommandId } from '../../shared/commands'
import { useAppStore } from '../stores/appStore'
import {
  asClosestTarget,
  attachCommandBridge,
  currentBindings,
  currentContext,
  invokeCommand,
  isCommandRegistered,
  useCommandRegistry
} from './commandRegistry'

/** Holding the chord keeps moving through threads; every other command runs once per press. */
const REPEATABLE: ReadonlySet<CommandId> = new Set(['thread.next', 'thread.previous'])

/**
 * The one keyboard dispatcher, on `window` in the capture phase. It only takes over a key press that
 * resolves to a command that is registered and allowed here; every other key continues untouched.
 */
export function handleCommandKeyDown(event: KeyboardEvent): void {
  if (useCommandRegistry.getState().recording) return
  if (event.isComposing || event.keyCode === 229) return
  const context = currentContext('key', asClosestTarget(event.target))
  const overrides = useAppStore.getState().shortcuts
  const id = resolveCommand(event, overrides, context, isCommandRegistered, currentBindings(overrides, context.platform))
  if (!id) return
  event.preventDefault()
  event.stopPropagation()
  if (event.repeat && !REPEATABLE.has(id)) return
  invokeCommand(id)
}

/** Listens for shortcuts on a window-like target; returns what removes the listener. */
export function attachCommandShortcuts(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
  target.addEventListener('keydown', handleCommandKeyDown, { capture: true })
  return () => target.removeEventListener('keydown', handleCommandKeyDown, { capture: true })
}

export function useCommandShortcuts(): void {
  useEffect(() => {
    const detachKeys = attachCommandShortcuts(window)
    const detachBridge = attachCommandBridge(window.mousse?.commands)
    return () => {
      detachKeys()
      detachBridge()
    }
  }, [])
}
