import {
  BOT_BROWSER_FILES_METHOD,
  BOT_BROWSER_FRAME_EVENT,
  BOTS_BROWSER_HOLD_CAPABILITY,
  BOTS_BROWSER_METHODS,
  BOTS_BROWSER_STREAM_CAPABILITY,
  MAX_BOT_BROWSER_FILES,
  MAX_BOT_BROWSER_SENT,
  type BotBrowserFrameEvent,
  type BotBrowserHoldRequest,
  type BotBrowserSent,
  type BotsBrowserMethod
} from '../../../shared/bots/personal/browser'
import { validateBotBrowserInput } from '../../../shared/bots/personal/browserInput'
import { BOTS_PERSONAL_V2_CAPABILITY } from '../../../shared/bots/personal/methods'
import { browserNavigationUrl } from '../../../shared/browser/validation'
import { BrowserAutomationError } from '../../browser/automation/BrowserSessionManager'
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
 * that took it. `bots.browser.files` is the app's main process's alone: the renderer cannot call it.
 */

const KEYS: Record<BotsBrowserMethod, readonly string[]> = {
  'bots.browser.get': ['botId', 'frame', 'viewId'],
  'bots.browser.control': ['botId', 'control'],
  'bots.browser.input': ['botId', 'input'],
  'bots.browser.open': ['botId', 'url', 'viewId', 'platform'],
  'bots.browser.close': ['botId'],
  'bots.browser.watch': ['botId', 'watchId', 'width', 'fps', 'viewId'],
  'bots.browser.unwatch': ['botId', 'watchId'],
  'bots.browser.hold': ['botId', 'viewId', 'request'],
  'bots.browser.send': ['botId', 'viewId', 'holdId', 'inputs']
}

const isWatchId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
const isHoldId = (value: unknown): value is string => typeof value === 'string' && /^hold_[A-Za-z0-9-]{1,64}$/.test(value)
const isCount = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const isSeq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

function platform(value: unknown): 'mac' | 'other' | undefined {
  if (value === undefined) return undefined
  if (value !== 'mac' && value !== 'other') throw new DomainRpcError('invalid_params', 'platform must be mac or other')
  return value
}

function holdRequest(value: unknown): BotBrowserHoldRequest {
  const op = (value as { op?: unknown } | null)?.op
  if (op === 'take') {
    const r = domainObject(value, ['op', 'force', 'platform'])
    if (r.force !== undefined && typeof r.force !== 'boolean') throw new DomainRpcError('invalid_params', 'force must be true or false')
    const os = platform(r.platform)
    return { op, ...(r.force ? { force: true } : {}), ...(os ? { platform: os } : {}) }
  }
  if (op === 'renew' || op === 'release') {
    const r = domainObject(value, ['op', 'holdId'])
    if (!isHoldId(r.holdId)) throw new DomainRpcError('invalid_params', 'A hold id is required')
    return { op, holdId: r.holdId }
  }
  throw new DomainRpcError('invalid_params', 'request must take, renew or release a hold')
}

function sentInputs(value: unknown): BotBrowserSent[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_BOT_BROWSER_SENT) throw new DomainRpcError('invalid_params', `inputs must hold 1 to ${MAX_BOT_BROWSER_SENT} inputs`)
  return value.map((entry): BotBrowserSent => {
    // A number the view gives up on comes as a skip, so the count never waits on a hole.
    if (entry && typeof entry === 'object' && 'skip' in entry) {
      const skip = domainObject(entry, ['seq', 'skip'])
      if (!isSeq(skip.seq) || skip.skip !== true) throw new DomainRpcError('invalid_params', 'A skip names its seq')
      return { seq: skip.seq, skip: true }
    }
    const sent = domainObject(entry, ['seq', 'picture', 'input'])
    if (!isSeq(sent.seq)) throw new DomainRpcError('invalid_params', 'seq must be a whole number from 1')
    if (sent.picture !== undefined && !(typeof sent.picture === 'number' && Number.isSafeInteger(sent.picture) && sent.picture >= 0)) throw new DomainRpcError('invalid_params', 'picture must be a picture number')
    return { seq: sent.seq, ...(sent.picture !== undefined ? { picture: sent.picture as number } : {}), input: validateBotBrowserInput(sent.input) }
  })
}

/** The files this computer's own file dialog answered: absolute paths, at most `MAX_BOT_BROWSER_FILES`. */
function chosenPaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_BOT_BROWSER_FILES) throw new DomainRpcError('invalid_params', `paths must hold 1 to ${MAX_BOT_BROWSER_FILES} files`)
  return value.map((path) => {
    if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) throw new DomainRpcError('invalid_params', 'Each path must be a file on this computer')
    return path
  })
}

function validate(method: BotsBrowserMethod, value: unknown): Record<string, unknown> {
  const p = domainObject(value ?? {}, ['profileId', ...KEYS[method]])
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
function ownerConnection(context: HandlerContext, what: string): NonNullable<HandlerContext['connection']> & { emitConnectionEvent: NonNullable<NonNullable<HandlerContext['connection']>['emitConnectionEvent']> } {
  const connection = context.connection
  if (!connection?.emitConnectionEvent || connection.clientType !== 'gui' || connection.bridgeCaller)
    throw new DomainRpcError('unsupported', `Only the desktop app on this computer can ${what} a bot's browser.`)
  return connection as never
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

/** The capability each method is offered under: `watch` and `hold` tell the app what this daemon can do. */
function capabilityOf(method: BotsBrowserMethod): string {
  if (method === 'bots.browser.watch' || method === 'bots.browser.unwatch') return BOTS_BROWSER_STREAM_CAPABILITY
  if (method === 'bots.browser.hold' || method === 'bots.browser.send') return BOTS_BROWSER_HOLD_CAPABILITY
  return BOTS_PERSONAL_V2_CAPABILITY
}

/** The browser's own refusals keep their code and plain message, and a failed page its class and Chromium's code. */
function asDomainError(error: unknown): unknown {
  if (error instanceof BrowserAutomationError) return new DomainRpcError(error.code, error.message, error.details?.problem ? { problem: error.details.problem } : undefined)
  return error
}

/** Bind once before server seal. The browsers come from the daemon's admitted profile, never a client path. */
export function registerBotBrowserMethods(domains: DomainHandlerRegistry, browsersForProfile: (profileId: string) => BotBrowsers | null | undefined | Promise<BotBrowsers | null | undefined>): void {
  for (const method of BOTS_BROWSER_METHODS) {
    domains.register({
      method,
      scope: 'profile',
      capability: capabilityOf(method),
      validate: (params) => validate(method, params),
      async handle(context, params, binding) {
        const browsers = await browsersForProfile(binding!.profileId)
        if (!browsers) throw new DomainRpcError('bots_unavailable', 'Bots are unavailable in this profile.')
        try {
          return await handle(context, method, params, browsers)
        } catch (error) {
          throw asDomainError(error)
        }
      }
    })
  }
  // The files the person chose in this computer's own file dialog, from the app's main process (the
  // renderer's request bridge does not offer this method): a one-time token for the hold's `files` input.
  domains.register({
    method: BOT_BROWSER_FILES_METHOD,
    scope: 'profile',
    capability: BOTS_BROWSER_HOLD_CAPABILITY,
    validate: (params): Record<string, unknown> => {
      const p = domainObject(params ?? {}, ['profileId', 'botId', 'viewId', 'holdId', 'paths'])
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
