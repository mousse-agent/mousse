// @vitest-environment jsdom
/**
 * Reload window, offered when a part of the app cannot load: it saves what autosave holds, reloads only when
 * nothing is left unsaved, and never silences the editors' unload checks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasUnsavedEdits, registerAutosaveFlush, reloadWindow } from '../../src/renderer/services/reloadWindow'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** An open editor with unsaved edits, as the Files tab and the agent editor register it. */
function editor(isDirty: () => boolean) {
  const handler = vi.fn((event: Event) => {
    if (!isDirty()) return
    event.preventDefault()
    ;(event as BeforeUnloadEvent).returnValue = ''
  })
  window.addEventListener('beforeunload', handler)
  cleanups.push(() => window.removeEventListener('beforeunload', handler))
  return handler
}

const unloadIsStopped = () => {
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  return unload.defaultPrevented
}

describe('reloadWindow', () => {
  it('saves what autosave holds, then reloads when nothing is left unsaved', async () => {
    let dirty = true
    editor(() => dirty)
    const order: string[] = []
    cleanups.push(registerAutosaveFlush(async () => { order.push('flush'); dirty = false }))
    const reload = vi.fn(() => order.push('reload'))
    expect(await reloadWindow(reload)).toBe('reloaded')
    expect(order).toEqual(['flush', 'reload'])
  })

  it('does not reload while edits are still unsaved, and asks nothing that could discard them', async () => {
    editor(() => true)
    const confirm = vi.spyOn(window, 'confirm')
    const reload = vi.fn()
    expect(await reloadWindow(reload)).toBe('unsaved')
    expect(reload).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(hasUnsavedEdits()).toBe(true)
  })

  it('never silences the editors: edits made after a reload was asked for still stop the unload', async () => {
    let dirty = false
    const check = editor(() => dirty)
    // The reload is asked for but stalls; the person types, then closes the window.
    expect(await reloadWindow(() => {})).toBe('reloaded')
    dirty = true
    check.mockClear()
    expect(unloadIsStopped()).toBe(true)
    expect(check).toHaveBeenCalledOnce()
  })

  it('a save that hangs is waited for at most a few seconds', async () => {
    vi.useFakeTimers()
    cleanups.push(registerAutosaveFlush(() => new Promise(() => {})))
    const reload = vi.fn()
    const result = reloadWindow(reload)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toBe('reloaded')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('an edit still waiting on a hung save keeps the window', async () => {
    vi.useFakeTimers()
    editor(() => true)
    cleanups.push(registerAutosaveFlush(() => new Promise(() => {})))
    const reload = vi.fn()
    const result = reloadWindow(reload)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toBe('unsaved')
    expect(reload).not.toHaveBeenCalled()
  })
})
