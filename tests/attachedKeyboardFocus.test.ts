import { createContext, runInContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ session: {} }))
import { wrapElectronWebContents } from '../src/main/browser/automation/electronGuest'

function fixture() {
  const document = { activeElement: null as Element | null, querySelectorAll: () => [first, second] }
  class Element {
    isConnected = true
    constructor(public id: number) {}
    getWebContentsId() { return this.id }
    focus() { document.activeElement = this }
    blur() { if (document.activeElement === this) document.activeElement = body }
  }
  const body = new Element(0), composer = new Element(1), first = new Element(2), second = new Element(3), human = new Element(4)
  document.activeElement = composer
  const context = createContext({ document, window: {} })
  const owner = { isDestroyed: () => false, executeJavaScript: async (code: string) => runInContext(code, context) }
  const guest = (id: number) => wrapElectronWebContents({ id, hostWebContents: owner, debugger: {} } as never)
  return { document, body, composer, first, second, human, a: guest(2), b: guest(3) }
}

it('serializes two guests sharing an embedder and restores the prior control after each settled action', async () => {
  const f = fixture(), a = await f.a.acquireKeyboardFocus(new AbortController().signal)
  await a.focus()
  expect(f.document.activeElement).toBe(f.first)
  let secondAcquired = false
  const waiting = f.b.acquireKeyboardFocus(new AbortController().signal).then((scope) => { secondAcquired = true; return scope })
  await Promise.resolve()
  expect(secondAcquired).toBe(false)
  await a.release(true)
  const b = await waiting
  expect(f.document.activeElement).toBe(f.composer)
  await b.focus()
  expect(f.document.activeElement).toBe(f.second)
  await b.release(true)
  expect(f.document.activeElement).toBe(f.composer)
})

it('does not overwrite a newly focused human control or restore after control takeover', async () => {
  const f = fixture(), scope = await f.a.acquireKeyboardFocus(new AbortController().signal)
  await scope.focus()
  f.human.focus()
  await scope.release(true)
  expect(f.document.activeElement).toBe(f.human)
  const taken = await f.b.acquireKeyboardFocus(new AbortController().signal)
  await taken.focus()
  await taken.release(false)
  expect(f.document.activeElement).toBe(f.second)
})

it('restores an unfocused embedder even when body.focus is a no-op', async () => {
  const f = fixture()
  f.document.activeElement = f.body
  f.body.focus = () => undefined
  const scope = await f.a.acquireKeyboardFocus(new AbortController().signal)
  await scope.focus()
  await scope.release(true)
  expect(f.document.activeElement).toBe(f.body)
})

it('rejects a connected webview rebound to another native guest without focusing or restoring it', async () => {
  const f = fixture(), scope = await f.a.acquireKeyboardFocus(new AbortController().signal)
  f.first.id = 99
  await expect(scope.focus()).rejects.toThrow('scope expired')
  expect(f.document.activeElement).toBe(f.composer)
  // The replacement guest now owns this same connected DOM element. Cleanup
  // must not blur it or restore our previously captured composer focus.
  f.first.focus()
  await scope.release(true)
  expect(f.document.activeElement).toBe(f.first)
})

it('cancels a queued guest before it can focus and releases its reservation for the next guest', async () => {
  const f = fixture(), first = await f.a.acquireKeyboardFocus(new AbortController().signal)
  await first.focus()
  const abort = new AbortController()
  const cancelled = f.b.acquireKeyboardFocus(abort.signal).catch((error: Error) => error)
  abort.abort()
  await first.release(true)
  expect(await cancelled).toMatchObject({ message: 'cancelled' })
  expect(f.document.activeElement).toBe(f.composer)
  const last = await f.b.acquireKeyboardFocus(new AbortController().signal)
  await last.focus()
  await last.release(true)
  expect(f.document.activeElement).toBe(f.composer)
})
