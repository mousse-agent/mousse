import { BOTS_BROWSER_METHODS, type BotsBrowserMethod } from '../../../shared/bots/personal/browser'
import { BOTS_PERSONAL_V2_CAPABILITY } from '../../../shared/bots/personal/methods'
import { validateBrowserHumanInput, browserNavigationUrl } from '../../../shared/browser/validation'
import { BrowserAutomationError } from '../../browser/automation/BrowserSessionManager'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../../protocol/domainRegistry'
import { isBotId } from '../definitions/BotDefinitionStore'
import type { BotBrowsers } from './BotBrowsers'

/**
 * The owner's view of each bot's browser (`bots.browser.*`): the live preview and the split view.
 * Profile-bound like the Bot UI's methods, exact keys, and none returns a session id or a path.
 */

const KEYS: Record<BotsBrowserMethod, readonly string[]> = {
  'bots.browser.get': ['botId', 'frame'],
  'bots.browser.control': ['botId', 'control'],
  'bots.browser.input': ['botId', 'input'],
  'bots.browser.open': ['botId', 'url'],
  'bots.browser.close': ['botId']
}

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
      default:
        break
    }
  } catch (error) {
    if (error instanceof DomainRpcError) throw error
    throw new DomainRpcError('invalid_params', error instanceof Error ? error.message : String(error))
  }
  return p
}

function handle(method: BotsBrowserMethod, p: Record<string, unknown>, browsers: BotBrowsers): Promise<unknown> {
  const botId = p.botId as string
  const view = (pending: Promise<Awaited<ReturnType<BotBrowsers['view']>>>) => pending.then((browser) => ({ browser }))
  switch (method) {
    case 'bots.browser.get': return view(browsers.view(botId, { frame: p.frame === true }))
    case 'bots.browser.control': return view(browsers.control(botId, p.control as 'owner' | 'bot'))
    case 'bots.browser.input': return view(browsers.input(botId, p.input as Parameters<BotBrowsers['input']>[1]))
    case 'bots.browser.open': return view(browsers.open(botId, p.url as string | undefined))
    case 'bots.browser.close': return view(browsers.close(botId))
  }
}

/** Bind once before server seal. The browsers come from the daemon's admitted profile, never a client path. */
export function registerBotBrowserMethods(domains: DomainHandlerRegistry, browsersForProfile: (profileId: string) => BotBrowsers | null | undefined | Promise<BotBrowsers | null | undefined>): void {
  for (const method of BOTS_BROWSER_METHODS) {
    domains.register({
      method,
      scope: 'profile',
      capability: BOTS_PERSONAL_V2_CAPABILITY,
      validate: (params) => validate(method, params),
      async handle(_context, params, binding) {
        const browsers = await browsersForProfile(binding!.profileId)
        if (!browsers) throw new DomainRpcError('bots_unavailable', 'Bots are unavailable in this profile.')
        try {
          return await handle(method, params, browsers)
        } catch (error) {
          // The browser's own refusals keep their code and plain message.
          if (error instanceof BrowserAutomationError) throw new DomainRpcError(error.code, error.message)
          throw error
        }
      }
    })
  }
}
