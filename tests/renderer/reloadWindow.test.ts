// @vitest-environment jsdom
/** Reload window, offered when a part of the app cannot load: it saves first and asks before losing edits. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasUnsavedEdits, registerAutosaveFlush, reloadWindow } from '../../src/renderer/services/reloadWindow'

const cleanups: Array<() => void> = []
afterEach(() => {
  // The unload a test's reload would have caused, so its one-time bypass does not carry into the next test.
  window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** An open editor with unsaved edits, as the Files tab and the agent editor register it. */
function dirtyEditor(isDirty: () => boolean) {
  const handler = vi.fn((event: Event) => {
    if (!isDirty()) return
    event.preventDefault()
    ;(event as BeforeUnloadEvent).returnValue = ''
  })
  window.addEventListener('beforeunload', handler)
  cleanups.push(() => window.removeEventListener('beforeunload', handler))
  return handler
}

describe('reloadWindow', () => {
  it('saves what autosave holds, then reloads without asking when nothing is left unsaved', async () => {
    let dirty = true
    dirtyEditor(() => dirty)
    const order: string[] = []
    cleanups.push(registerAutosaveFlush(async () => { order.push('flush'); dirty = false }))
    const confirm = vi.spyOn(window, 'confirm')
    const reload = vi.fn(() => order.push('reload'))
    expect(await reloadWindow(reload)).toBe(true)
    expect(order).toEqual(['flush', 'reload'])
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks before losing edits that could not be saved, and keeps the window when declined', async () => {
    dirtyEditor(() => true)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const reload = vi.fn()
    expect(await reloadWindow(reload)).toBe(false)
    expect(confirm).toHaveBeenCalledWith("Some edits aren't saved. Reload anyway and lose them?")
    expect(reload).not.toHaveBeenCalled()
    expect(hasUnsavedEdits()).toBe(true)
  })

  it('once confirmed, the editors no longer stop the unload', async () => {
    const editor = dirtyEditor(() => true)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const reload = vi.fn()
    expect(await reloadWindow(reload)).toBe(true)
    expect(reload).toHaveBeenCalledOnce()
    editor.mockClear()
    // The unload that follows the reload.
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(false)
    expect(editor).not.toHaveBeenCalled()
    // Only that one unload: the editors are asked again afterwards.
    expect(hasUnsavedEdits()).toBe(true)
  })

  it('a reload that does not happen leaves the editors guarding the window', async () => {
    vi.useFakeTimers()
    dirtyEditor(() => true)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    expect(await reloadWindow(() => {})).toBe(true)
    // Checks for unsaved edits are never skipped.
    expect(hasUnsavedEdits()).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
  })

  it('a save that hangs does not keep the window from reloading', async () => {
    vi.useFakeTimers()
    cleanups.push(registerAutosaveFlush(() => new Promise(() => {})))
    const reload = vi.fn()
    const result = reloadWindow(reload)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toBe(true)
    expect(reload).toHaveBeenCalledOnce()
  })
})
