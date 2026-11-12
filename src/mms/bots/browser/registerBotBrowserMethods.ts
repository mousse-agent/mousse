import { BOT_BROWSER_FRAME_EVENT, BOTS_BROWSER_METHODS, BOTS_BROWSER_STREAM_CAPABILITY, type BotBrowserFrameEvent, type BotsBrowserMethod } from '../../../shared/bots/personal/browser'
import { BOTS_PERSONAL_V2_CAPABILITY } from '../../../shared/bots/personal/methods'
import { validateBrowserHumanInput, browserNavigationUrl } from '../../../shared/browser/validation'
import { BrowserAutomationError } from '../../browser/automation/BrowserSessionManager'
import type { HandlerContext } from '../../protocol/handlers'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../../protocol/domainRegistry'
import { isBotId } from '../definitions/BotDefinitionStore'
import type { BotBrowsers } from './BotBrowsers'

/**
 * The owner's view of each bot's browser (`bots.browser.*`): the live preview and the split view.
 * Profile-bound like the Bot UI's methods, exact keys, and none returns a session id or a path.
 * `watch` pushes pictures on the calling connection only (`bots.browser.frame`), and only to the
 * desktop app on this computer.
 */

const KEYS: Record<BotsBrowserMethod, readonly string[]> = {
  'bots.browser.get': ['botId', 'frame'],
  'bots.browser.control': ['botId', 'control'],
  'bots.browser.input': ['botId', 'input'],
  'bots.browser.open': ['botId', 'url'],
  'bots.browser.close': ['botId'],
  'bots.browser.watch': ['botId', 'watchId', 'width', 'fps'],
  'bots.browser.unwatch': ['botId', 'watchId']
}

const isWatchId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
const isCount = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

function validate(method: BotsBrowserMethod, value: unknown): Record<string, unknown> {
  const p = domainObject(value ?? {}, ['profileId', ...KEYS[method]])
  if (!isBotId(p.botId)) throw new DomainRpcError('invalid_params', 'A bot id is required')
  try {
    switch (method) {
      case 'bots.browser.get':
        if (p.frame !== undefined && typeof p.frame !== 'boolean') throw new DomainRpcError('invalid_params', 'frame must be true or false')
        break
      case 'bots.browser.control':
        if (p.control !== 'owner' && p.control !== 'bot') throw new DomainRpcError('invalid_params', 'control must be owner or bot')
        break
      case 'bots.browser.input':
        p.input = validateBrowserHumanInput(p.input)
        break
      case 'bots.browser.open':
        if (p.url !== undefined) p.url = browserNavigationUrl(p.url)
        break
      case 'bots.browser.watch':
        if (!isWatchId(p.watchId)) throw new DomainRpcError('invalid_params', 'A watch id is required')
        if (!isCount(p.width, 1, 10_000)) throw new DomainRpcError('invalid_params', 'width must be a number of pixels')
        if (!isCount(p.fps, 1, 60)) throw new DomainRpcError('invalid_params', 'fps must be a number of pictures a second')
        break
      case 'bots.browser.unwatch':
        if (!isWatchId(p.watchId)) throw new DomainRpcError('invalid_params', 'A watch id is required')
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

/** The calling connection, when it is the desktop app's own (pictures are pushed to it alone). */
function watcherConnection(context: HandlerContext): NonNullable<HandlerContext['connection']> & { emitConnectionEvent: NonNullable<NonNullable<HandlerContext['connection']>['emitConnectionEvent']> } {
  const connection = context.connection
  if (!connection?.emitConnectionEvent || connection.clientType !== 'gui' || connection.bridgeCaller)
    throw new DomainRpcError('unsupported', 'Only the desktop app on this computer can watch a bot\'s browser.')
  return connection as never
}

function handle(context: HandlerContext, method: BotsBrowserMethod, p: Record<string, unknown>, browsers: BotBrowsers): Promise<unknown> {
  const botId = p.botId as string
  const view = (pending: Promise<Awaited<ReturnType<BotBrowsers['view']>>>) => pending.then((browser) => ({ browser }))
  switch (method) {
    case 'bots.browser.get': return view(browsers.view(botId, { frame: p.frame === true }))
    case 'bots.browser.control': return view(browsers.control(botId, p.control as 'owner' | 'bot'))
    case 'bots.browser.input': return view(browsers.input(botId, p.input as Parameters<BotBrowsers['input']>[1]))
    case 'bots.browser.open': return view(browsers.open(botId, p.url as string | undefined))
    case 'bots.browser.close': return view(browsers.close(botId))
    case 'bots.browser.watch': {
      const connection = watcherConnection(context)
      const emit = connection.emitConnectionEvent
      return view(browsers.watch(botId, p.watchId as string, {
        width: p.width as number,
        fps: p.fps as number,
        connectionId: connection.id,
        ...(connection.lifetime ? { lifetime: connection.lifetime } : {}),
        emit: (event: BotBrowserFrameEvent) => emit(BOT_BROWSER_FRAME_EVENT, event)
      }))
    }
    case 'bots.browser.unwatch': {
      const connection = watcherConnection(context)
      browsers.unwatch(botId, p.watchId as string, connection.id)
      return Promise.resolve({ ok: true })
    }
  }
}

/** Bind once before server seal. The browsers come from the daemon's admitted profile, never a client path. */
export function registerBotBrowserMethods(domains: DomainHandlerRegistry, browsersForProfile: (profileId: string) => BotBrowsers | null | undefined | Promise<BotBrowsers | null | undefined>): void {
  for (const method of BOTS_BROWSER_METHODS) {
    domains.register({
      method,
      scope: 'profile',
      // `watch` is offered under its own capability: the app knows from it that pictures are pushed.
      capability: method === 'bots.browser.watch' || method === 'bots.browser.unwatch' ? BOTS_BROWSER_STREAM_CAPABILITY : BOTS_PERSONAL_V2_CAPABILITY,
      validate: (params) => validate(method, params),
      async handle(context, params, binding) {
        const browsers = await browsersForProfile(binding!.profileId)
        if (!browsers) throw new DomainRpcError('bots_unavailable', 'Bots are unavailable in this profile.')
        try {
          return await handle(context, method, params, browsers)
        } catch (error) {
          // The browser's own refusals keep their code and plain message, and a failed page its class and Chromium's code.
          if (error instanceof BrowserAutomationError) throw new DomainRpcError(error.code, error.message, error.details?.problem ? { problem: error.details.problem } : undefined)
          throw error
        }
      }
    })
  }
}
