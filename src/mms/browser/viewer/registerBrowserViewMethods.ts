import {
  BROWSER_VIEW_CAPABILITY,
  BROWSER_VIEW_FILES_METHOD,
  BROWSER_VIEW_FRAME_EVENT,
  BROWSER_VIEW_METHODS,
  type BrowserViewHoldRequest,
  type BrowserViewMethod,
  type ThreadBrowserFrameEvent
} from '../../../shared/browser/threadView'
import type { WatchedBrowserSent } from '../../../shared/browser/watched'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../../protocol/domainRegistry'
import type { HandlerContext } from '../../protocol/handlers'
import type { MmsBrowserService } from '../MmsBrowserService'
import { appWindowConnection, asDomainError, chosenPaths, holdRequest, isCount, isHoldId, isWatchId, sentInputs } from './watchedParams'

/**
 * The person's view of a thread agent's browser without a window (`browser.view.*`), in that thread's
 * Browser panel. Every method is the desktop app's on this computer alone: watching (pictures go on the
 * calling connection only, as `browser.view.frame`), the state, taking it over, every input, and giving
 * it back. An agent, a bot, the command line, a group chat, a workflow and another computer are refused.
 * A hold is bound to the window and the connection that took it. `browser.view.files` is the app's main
 * process's alone: the renderer cannot call it. None returns a session id or a path.
 */

const KEYS: Record<BrowserViewMethod, readonly string[]> = {
  'browser.view.get': ['threadId', 'viewId'],
  'browser.view.watch': ['threadId', 'watchId', 'width', 'fps', 'viewId'],
  'browser.view.unwatch': ['threadId', 'watchId'],
  'browser.view.hold': ['threadId', 'viewId', 'request'],
  'browser.view.send': ['threadId', 'viewId', 'holdId', 'inputs']
}

const isThreadId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value)

function validate(method: BrowserViewMethod, value: unknown): Record<string, unknown> {
  const p = domainObject(value ?? {}, ['profileId', ...KEYS[method]])
  if (!isThreadId(p.threadId)) throw new DomainRpcError('invalid_params', 'A thread id is required')
  if (p.viewId !== undefined && !isWatchId(p.viewId)) throw new DomainRpcError('invalid_params', 'viewId must be an id')
  switch (method) {
    case 'browser.view.watch':
      if (!isWatchId(p.watchId)) throw new DomainRpcError('invalid_params', 'A watch id is required')
      if (!isCount(p.width, 1, 10_000)) throw new DomainRpcError('invalid_params', 'width must be a number of pixels')
      if (!isCount(p.fps, 1, 60)) throw new DomainRpcError('invalid_params', 'fps must be a number of pictures a second')
      break
    case 'browser.view.unwatch':
      if (!isWatchId(p.watchId)) throw new DomainRpcError('invalid_params', 'A watch id is required')
      break
    case 'browser.view.hold':
      if (!isWatchId(p.viewId)) throw new DomainRpcError('invalid_params', 'A view id is required')
      p.request = holdRequest(p.request)
      break
    case 'browser.view.send':
      if (!isWatchId(p.viewId)) throw new DomainRpcError('invalid_params', 'A view id is required')
      if (!isHoldId(p.holdId)) throw new DomainRpcError('invalid_params', 'A hold id is required')
      try {
        p.inputs = sentInputs(p.inputs)
      } catch (error) {
        if (error instanceof DomainRpcError) throw error
        throw new DomainRpcError('invalid_params', error instanceof Error ? error.message : String(error))
      }
      break
    default:
      break
  }
  return p
}

const REFUSAL = 'Only the desktop app on this computer can use a thread\'s browser view.'

function handle(context: HandlerContext, method: BrowserViewMethod, p: Record<string, unknown>, browser: MmsBrowserService): Promise<unknown> {
  const connection = appWindowConnection(context, REFUSAL)
  const threadId = p.threadId as string
  const views = browser.views
  switch (method) {
    case 'browser.view.get':
      return views.view(threadId, { connectionId: connection.id, ...(p.viewId ? { viewId: p.viewId as string } : {}) }).then((view) => ({ browser: view }))
    case 'browser.view.watch': {
      const emit = connection.emitConnectionEvent
      return views.watch(threadId, p.watchId as string, {
        width: p.width as number,
        fps: p.fps as number,
        connectionId: connection.id,
        ...(p.viewId ? { viewId: p.viewId as string } : {}),
        ...(connection.lifetime ? { lifetime: connection.lifetime } : {}),
        emit: (event: ThreadBrowserFrameEvent) => emit(BROWSER_VIEW_FRAME_EVENT, event)
      }).then((view) => ({ browser: view }))
    }
    case 'browser.view.unwatch':
      views.unwatch(threadId, p.watchId as string, connection.id)
      return Promise.resolve({ ok: true })
    case 'browser.view.hold':
      return views.hold(threadId, p.viewId as string, p.request as BrowserViewHoldRequest, connection.id)
    case 'browser.view.send':
      return views.send(threadId, p.viewId as string, p.holdId as string, p.inputs as WatchedBrowserSent[], connection.id)
  }
}

/** Bind once before server seal. The browser comes from the daemon's admitted profile, never a client path. */
export function registerBrowserViewMethods(domains: DomainHandlerRegistry, browserForProfile: (profileId: string) => MmsBrowserService | Promise<MmsBrowserService>): void {
  for (const method of BROWSER_VIEW_METHODS) {
    domains.register({
      method,
      scope: 'profile',
      capability: BROWSER_VIEW_CAPABILITY,
      validate: (params) => validate(method, params),
      async handle(context, params, binding) {
        const browser = await browserForProfile(binding!.profileId)
        try {
          return await handle(context, method, params, browser)
        } catch (error) {
          throw asDomainError(error)
        }
      }
    })
  }
  // The files the person chose in this computer's own file dialog, from the app's main process (the
  // renderer's request bridge does not offer this method): a one-time token for the hold's `files` input.
  domains.register({
    method: BROWSER_VIEW_FILES_METHOD,
    scope: 'profile',
    capability: BROWSER_VIEW_CAPABILITY,
    validate: (params): Record<string, unknown> => {
      const p = domainObject(params ?? {}, ['profileId', 'threadId', 'viewId', 'holdId', 'paths'])
      if (!isThreadId(p.threadId)) throw new DomainRpcError('invalid_params', 'A thread id is required')
      if (!isWatchId(p.viewId)) throw new DomainRpcError('invalid_params', 'A view id is required')
      if (!isHoldId(p.holdId)) throw new DomainRpcError('invalid_params', 'A hold id is required')
      return { ...p, paths: chosenPaths(p.paths) }
    },
    async handle(context, params, binding) {
      const connection = appWindowConnection(context, REFUSAL)
      const browser = await browserForProfile(binding!.profileId)
      try {
        return await browser.views.chooseFiles(params.threadId as string, params.viewId as string, params.holdId as string, params.paths as string[], connection.id)
      } catch (error) {
        throw asDomainError(error)
      }
    }
  })
}
