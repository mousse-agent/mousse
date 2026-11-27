import {
  BOT_BROWSER_FILES_METHOD,
  BOT_BROWSER_FRAME_EVENT,
  BOT_BROWSER_WINDOW_METHOD,
  type BotBrowserFrameEvent,
  type BotBrowserHoldRequest,
  type BotBrowserSent,
  type BotsBrowserMethod
} from '../../../shared/bots/personal/browser'
import { validateWatchedBrowserInput as validateBotBrowserInput, type WatchedBrowserPageSize } from '../../../shared/browser/watched'
import { localBotMethod, localBotMethods } from '../../../shared/bots/personal/methodTable'
import { browserNavigationUrl } from '../../../shared/browser/validation'
import { browserWindowDisplay, type BrowserWindowDisplay } from '../../../shared/browser/window'
import { serviceHasDesktop } from '../../browser/windowDesktop'
import { appWindowConnection, asDomainError, chosenPaths, holdRequest, isCount, isHoldId, isWatchId, pageSize, sentInputs, viewPlatform as platform } from '../../browser/viewer/watchedParams'
import type { HandlerContext } from '../../protocol/handlers'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../../protocol/domainRegistry'
import { isBotId } from '../definitions/BotDefinitionStore'
import type { BotBrowsers } from './BotBrowsers'

/**
 * The owner's view of each bot's browser (`bots.browser.*`): the live preview and the split view.
 * Profile-bound like the Bot UI's methods, exact keys, and none returns a session id or a path.
 * `watch` pushes pictures on the calling connection only (`bots.browser.frame`), and only to the
 * desktop app on this computer. Taking the browser over, and every input, is the desktop app's on
 * this computer alone too (`hold`, `send`, and an older app's `control`, `input` and `open`), and so
 * are a fresh picture (`get` with `frame`) and closing the browser. A hold is bound to the connection
 * that took it. `bots.browser.files` is the app's main process's alone: the renderer cannot call it, and
 * so is `bots.browser.window` (the browser as a real window on that app's screen, which names its display).
 * Every view the desktop app on this computer reads says whether it may open the browser in a window
 * (`windowable`); no other caller is ever told so.
 */

/** The browser's own methods; `bots.browser.window` and `bots.browser.files` are registered apart, below. */
const VIEW_METHODS = localBotMethods('browser').filter((method): method is BotsBrowserMethod => method !== BOT_BROWSER_WINDOW_METHOD && method !== BOT_BROWSER_FILES_METHOD)

function validate(method: BotsBrowserMethod, value: unknown): Record<string, unknown> {
  const p = domainObject(value ?? {}, ['profileId', ...localBotMethod(method).keys])
  if (!isBotId(p.botId)) throw new DomainRpcError('invalid_params', 'A bot id is required')
  if (p.viewId !== undefined && !isWatchId(p.viewId)) throw new DomainRpcError('invalid_params', 'viewId must be an id')
  try {
    switch (method) {
      case 'bots.browser.get':
        if (p.frame !== undefined && typeof p.frame !== 'boolean') throw new DomainRpcError('invalid_params', 'frame must be true or false')
        break
      case 'bots.browser.control':
        if (p.control !== 'owner' && p.control !== 'bot') throw new DomainRpcError('invalid_params', 'control must be owner or bot')
        break
      case 'bots.browser.input':
        // An older app's input: files never come this way.
        p.input = validateBotBrowserInput(p.input)
        if ((p.input as { kind: string }).kind === 'files') throw new DomainRpcError('invalid_params', 'Files go through the hold\'s channel')
        break
      case 'bots.browser.open':
        if (p.url !== undefined) p.url = browserNavigationUrl(p.url)
        p.platform = platform(p.platform)
        break
      case 'bots.browser.watch':
        if (!isWatchId(p.watchId)) throw new DomainRpcError('invalid_params', 'A watch id is required')
        if (!isCount(p.width, 1, 10_000)) throw new DomainRpcError('invalid_params', 'width must be a number of pixels')
        if (!isCount(p.fps, 1, 60)) throw new DomainRpcError('invalid_params', 'fps must be a number of pictures a second')
        p.page = pageSize(p.page)
        break
      case 'bots.browser.unwatch':
        if (!isWatchId(p.watchId)) throw new DomainRpcError('invalid_params', 'A watch id is required')
        break
      case 'bots.browser.hold':
        if (!isWatchId(p.viewId)) throw new DomainRpcError('invalid_params', 'A view id is required')
        p.request = holdRequest(p.request)
        break
      case 'bots.browser.send':
        if (!isWatchId(p.viewId)) throw new DomainRpcError('invalid_params', 'A view id is required')
        if (!isHoldId(p.holdId)) throw new DomainRpcError('invalid_params', 'A hold id is required')
        p.inputs = sentInputs(p.inputs)
        break
      default:
        break
    }
  } catch (error) {
    if (error instanceof DomainRpcError) throw error
    throw new DomainRpcError('invalid_params', error instanceof Error ? error.message : String(error))
  }
  return p
}

/** The calling connection, when it is the desktop app's own on this computer (pictures go, and input comes, through it alone). */
function ownerConnection(context: HandlerContext, what: string): ReturnType<typeof appWindowConnection> {
  return appWindowConnection(context, `Only the desktop app on this computer can ${what} a bot's browser.`)
}

function handle(context: HandlerContext, method: BotsBrowserMethod, p: Record<string, unknown>, browsers: BotBrowsers): Promise<unknown> {
  const botId = p.botId as string
  const view = (pending: Promise<Awaited<ReturnType<BotBrowsers['view']>>>) => pending.then((browser) => ({ browser }))
  switch (method) {
    case 'bots.browser.get': {
      // A fresh picture is the desktop app's alone; the state is anyone's in the profile who may read the bot.
      const connectionId = p.frame === true ? ownerConnection(context, 'watch').id : context.connection?.id
      return view(browsers.view(botId, { frame: p.frame === true, ...(p.viewId ? { viewId: p.viewId as string } : {}), ...(connectionId ? { connectionId } : {}) }))
    }
    case 'bots.browser.control': return view(browsers.control(botId, p.control as 'owner' | 'bot', ownerConnection(context, 'take over').id))
    case 'bots.browser.input': return view(browsers.input(botId, p.input as Parameters<BotBrowsers['input']>[1], ownerConnection(context, 'use').id))
    case 'bots.browser.open': {
      const connection = ownerConnection(context, 'open')
      return browsers.open(botId, p.url as string | undefined, { connectionId: connection.id, ...(p.viewId ? { viewId: p.viewId as string } : {}), ...(p.platform ? { platform: p.platform as 'mac' | 'other' } : {}) })
    }
    case 'bots.browser.close':
      ownerConnection(context, 'close')
      return view(browsers.close(botId))
    case 'bots.browser.hold':
      return browsers.hold(botId, p.viewId as string, p.request as BotBrowserHoldRequest, ownerConnection(context, 'take over').id)
    case 'bots.browser.send':
      return browsers.send(botId, p.viewId as string, p.holdId as string, p.inputs as BotBrowserSent[], ownerConnection(context, 'use').id)
    case 'bots.browser.watch': {
      const connection = ownerConnection(context, 'watch')
      const emit = connection.emitConnectionEvent
      return view(browsers.watch(botId, p.watchId as string, {
        width: p.width as number,
        fps: p.fps as number,
        connectionId: connection.id,
        ...(p.viewId ? { viewId: p.viewId as string } : {}),
        ...(p.page ? { page: p.page as WatchedBrowserPageSize } : {}),
        ...(connection.lifetime ? { lifetime: connection.lifetime } : {}),
        emit: (event: BotBrowserFrameEvent) => emit(BOT_BROWSER_FRAME_EVENT, event)
      }))
    }
    case 'bots.browser.unwatch': {
      const connection = ownerConnection(context, 'watch')
      browsers.unwatch(botId, p.watchId as string, connection.id)
      return Promise.resolve({ ok: true })
    }
  }
}

/** Whether the calling connection is the desktop app's own on this computer. */
function isAppWindow(context: HandlerContext): boolean {
  try {
    appWindowConnection(context, '')
    return true
  } catch {
    return false
  }
}

/**
 * A view of the bot's browser, as the asking connection may see it: the desktop app on this computer, on a service that
 * runs on a desktop a window can appear on, is told it may open the browser in a window (`windowable`).
 */
async function withWindowable(context: HandlerContext, result: unknown): Promise<unknown> {
  const browser = (result as { browser?: Record<string, unknown> } | null)?.browser
  if (!browser || typeof browser !== 'object' || !isAppWindow(context) || !(await serviceHasDesktop())) return result
  return { ...(result as object), browser: { ...browser, windowable: true } }
}

/**
 * Bind once before server seal. The browsers come from the daemon's admitted profile, never a client path. Each method's
 * capability is its row's in `BOT_METHODS`: `watch` and `hold` tell the app what this daemon can do.
 */
export function registerBotBrowserMethods(domains: DomainHandlerRegistry, browsersForProfile: (profileId: string) => BotBrowsers | null | undefined | Promise<BotBrowsers | null | undefined>): void {
  for (const method of VIEW_METHODS) {
    domains.register({
      method,
      scope: 'profile',
      capability: localBotMethod(method).capability,
      validate: (params) => validate(method, params),
      async handle(context, params, binding) {
        const browsers = await browsersForProfile(binding!.profileId)
        if (!browsers) throw new DomainRpcError('bots_unavailable', 'Bots are unavailable in this profile.')
        try {
          return await withWindowable(context, await handle(context, method, params, browsers))
        } catch (error) {
          throw asDomainError(error)
        }
      }
    })
  }
  // The browser as a real window on the screen of the app that asks, from that app's main process (the renderer's
  // request bridge does not offer this method), for the view that holds the browser; or back without one.
  domains.register({
    method: BOT_BROWSER_WINDOW_METHOD,
    scope: 'profile',
    capability: localBotMethod(BOT_BROWSER_WINDOW_METHOD).capability,
    validate: (params): Record<string, unknown> => {
      const p = domainObject(params ?? {}, ['profileId', ...localBotMethod(BOT_BROWSER_WINDOW_METHOD).keys])
      if (!isBotId(p.botId)) throw new DomainRpcError('invalid_params', 'A bot id is required')
      if (!isWatchId(p.viewId)) throw new DomainRpcError('invalid_params', 'A view id is required')
      if (!isHoldId(p.holdId)) throw new DomainRpcError('invalid_params', 'A hold id is required')
      if (p.op !== 'open' && p.op !== 'close') throw new DomainRpcError('invalid_params', 'op must be open or close')
      let display: BrowserWindowDisplay | undefined
      try {
        display = browserWindowDisplay(p.display)
      } catch (error) {
        throw new DomainRpcError('invalid_params', error instanceof Error ? error.message : String(error))
      }
      return { ...p, ...(display ? { display } : { display: undefined }) }
    },
    async handle(context, params, binding) {
      const browsers = await browsersForProfile(binding!.profileId)
      if (!browsers) throw new DomainRpcError('bots_unavailable', 'Bots are unavailable in this profile.')
      const connection = ownerConnection(context, 'open a window for')
      if (params.op === 'open' && !(await serviceHasDesktop())) throw new DomainRpcError('unsupported', 'The browser runs where no window can be shown.')
      try {
        const browser = await browsers.window(params.botId as string, params.viewId as string, params.holdId as string, params.op as 'open' | 'close', params.display as BrowserWindowDisplay | undefined, connection.id)
        return withWindowable(context, { browser })
      } catch (error) {
        throw asDomainError(error)
      }
    }
  })
  // The files the person chose in this computer's own file dialog, from the app's main process (the
  // renderer's request bridge does not offer this method): a one-time token for the hold's `files` input.
  domains.register({
    method: BOT_BROWSER_FILES_METHOD,
    scope: 'profile',
    capability: localBotMethod(BOT_BROWSER_FILES_METHOD).capability,
    validate: (params): Record<string, unknown> => {
      const p = domainObject(params ?? {}, ['profileId', ...localBotMethod(BOT_BROWSER_FILES_METHOD).keys])
      if (!isBotId(p.botId)) throw new DomainRpcError('invalid_params', 'A bot id is required')
      if (!isWatchId(p.viewId)) throw new DomainRpcError('invalid_params', 'A view id is required')
      if (!isHoldId(p.holdId)) throw new DomainRpcError('invalid_params', 'A hold id is required')
      return { ...p, paths: chosenPaths(p.paths) }
    },
    async handle(context, params, binding) {
      const browsers = await browsersForProfile(binding!.profileId)
      if (!browsers) throw new DomainRpcError('bots_unavailable', 'Bots are unavailable in this profile.')
      const connection = ownerConnection(context, 'give files to')
      try {
        return await browsers.chooseFiles(params.botId as string, params.viewId as string, params.holdId as string, params.paths as string[], connection.id)
      } catch (error) {
        throw asDomainError(error)
      }
    }
  })
}
