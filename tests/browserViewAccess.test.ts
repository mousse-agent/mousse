/**
 * Who may watch, hold and type into a thread's browser without a window (`browser.view.*`): the
 * desktop app's own window on this computer alone. The command line (and so an agent's shell), a call
 * routed from another computer, and a connection that cannot be sent pictures are refused before the
 * browser is touched. The files method is the app's main process's; the renderer cannot reach it.
 */
import { describe, expect, it } from 'vitest'
import { registerBrowserViewMethods } from '../src/mms/browser/viewer/registerBrowserViewMethods'
import type { MmsBrowserService } from '../src/mms/browser/MmsBrowserService'
import { DomainHandlerRegistry } from '../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../src/mms/protocol/handlers'
import { BROWSER_VIEW_CAPABILITY, BROWSER_VIEW_FILES_METHOD, BROWSER_VIEW_METHODS } from '../src/shared/browser/threadView'

const profileId = '55555555-5555-4555-8555-555555555555'

/** A browser composition whose thread views answer, and say which method reached them. */
function fakeBrowser() {
  const reached: string[] = []
  const answer = (name: string) => async () => { reached.push(name); return name === 'send' ? { acks: [], lastSeq: 0 } : name === 'files' ? { token: 'files_00000000', count: 1 } : { open: false, control: 'bot' } }
  const views = { view: answer('get'), watch: answer('watch'), unwatch: () => { reached.push('unwatch') }, hold: async () => { reached.push('hold'); return { browser: { open: false, control: 'bot' } } }, send: answer('send'), chooseFiles: answer('files') }
  return { browser: { views } as unknown as MmsBrowserService, reached }
}

const PARAMS: Record<string, Record<string, unknown>> = {
  'browser.view.get': { threadId: 'thread-1', viewId: 'view-1' },
  'browser.view.watch': { threadId: 'thread-1', watchId: 'watch-1', width: 480, fps: 5, viewId: 'view-1' },
  'browser.view.unwatch': { threadId: 'thread-1', watchId: 'watch-1' },
  'browser.view.hold': { threadId: 'thread-1', viewId: 'view-1', request: { op: 'take' } },
  'browser.view.send': { threadId: 'thread-1', viewId: 'view-1', holdId: 'hold_1', inputs: [{ seq: 1, input: { kind: 'type', text: 'hi' } }] },
  [BROWSER_VIEW_FILES_METHOD]: { threadId: 'thread-1', viewId: 'view-1', holdId: 'hold_1', paths: ['/tmp/a.txt'] }
}

/** Callers, and whether each may use the view. */
const CALLERS: Array<{ who: string; connection: Record<string, unknown>; allowed: boolean }> = [
  { who: 'the app\'s window on this computer', connection: { clientType: 'gui', emitConnectionEvent: async () => undefined }, allowed: true },
  { who: 'the command line (an agent\'s shell, a script)', connection: { clientType: 'cli', emitConnectionEvent: async () => undefined }, allowed: false },
  { who: 'another computer (a routed call)', connection: { clientType: 'gui', bridgeCaller: { deviceId: 'other' }, emitConnectionEvent: async () => undefined }, allowed: false },
  { who: 'a bridge connection', connection: { clientType: 'bridge', emitConnectionEvent: async () => undefined }, allowed: false },
  { who: 'a window that cannot be sent pictures', connection: { clientType: 'gui' }, allowed: false }
]

describe('who may use a thread\'s browser view', () => {
  for (const caller of CALLERS) {
    it(`${caller.who}: ${caller.allowed ? 'every method answers' : 'every method is refused, and the browser is not touched'}`, async () => {
      const { browser, reached } = fakeBrowser()
      const domains = new DomainHandlerRegistry()
      registerBrowserViewMethods(domains, () => browser)
      domains.seal()
      const context = { connection: { id: 'conn-1', binding: { profileId, epoch: 1 }, capabilities: new Set([BROWSER_VIEW_CAPABILITY]), ...caller.connection } } as unknown as HandlerContext
      for (const method of [...BROWSER_VIEW_METHODS, BROWSER_VIEW_FILES_METHOD]) {
        const call = domains.dispatch(context, method, PARAMS[method])
        if (caller.allowed) await expect(call, method).resolves.toBeDefined()
        else await expect(call, method).rejects.toMatchObject({ code: 'unsupported' })
      }
      expect(reached).toHaveLength(caller.allowed ? BROWSER_VIEW_METHODS.length + 1 : 0)
    })
  }

  it('the renderer may ask for the view\'s methods, never for the files method', async () => {
    const { PLATFORM_REQUEST_METHODS } = await import('../src/main/ipc/registerGuiIpc')
    for (const method of BROWSER_VIEW_METHODS) expect(PLATFORM_REQUEST_METHODS.has(method)).toBe(true)
    expect(PLATFORM_REQUEST_METHODS.has(BROWSER_VIEW_FILES_METHOD as never)).toBe(false)
  })
})
