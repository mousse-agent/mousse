import { BOT_BROWSER_WINDOW_METHOD, type BotBrowserView, type BotBrowserWindowApi } from '../../shared/bots/personal/browser'
import { browserWindowDisplay, type BrowserWindowDisplay } from '../../shared/browser/window'

/**
 * Open in a window and Close window, in a bot's browser view (`bots:browserWindow`): the renderer names the bot, its
 * view, its hold and what to do; this process adds the screen it is on (on Linux, its own display) and asks the
 * service on the window's own connection (`bots.browser.window`, a method the renderer's request bridge does not
 * offer). The renderer never names a screen, so neither a page nor a renderer can put a window anywhere else.
 */

export type BotBrowserWindowRequest = Omit<BotBrowserWindowApi['params'], 'display'>
export type BotBrowserWindowAnswer = { browser: BotBrowserView } | { refused: string }

const ID = /^[A-Za-z0-9_-]{1,64}$/

/** The request as the renderer sent it, checked; undefined when it is not one. */
export function botBrowserWindowRequest(value: unknown): BotBrowserWindowRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => !['botId', 'viewId', 'holdId', 'op'].includes(key))) return undefined
  if (typeof raw.botId !== 'string' || !ID.test(raw.botId) || typeof raw.viewId !== 'string' || !ID.test(raw.viewId)) return undefined
  if (typeof raw.holdId !== 'string' || !/^hold_[A-Za-z0-9-]{1,64}$/.test(raw.holdId)) return undefined
  if (raw.op !== 'open' && raw.op !== 'close') return undefined
  return { botId: raw.botId, viewId: raw.viewId, holdId: raw.holdId, op: raw.op }
}

/** The screen this app shows on, as a window there needs it named: on Linux its display; elsewhere none is needed. */
export function appDisplay(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): BrowserWindowDisplay | undefined {
  if (platform !== 'linux') return undefined
  const named: Record<string, string> = {}
  for (const key of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'] as const) if (env[key]) named[key] = env[key]!
  try {
    return browserWindowDisplay(named)
  } catch {
    return undefined
  }
}

export interface BotBrowserWindowDeps {
  /** A request to the service on the asking window's own connection. */
  request(method: typeof BOT_BROWSER_WINDOW_METHOD, params: BotBrowserWindowApi['params']): Promise<BotBrowserWindowApi['result']>
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

export async function botBrowserWindow(value: unknown, deps: BotBrowserWindowDeps): Promise<BotBrowserWindowAnswer> {
  const request = botBrowserWindowRequest(value)
  if (!request) return { refused: 'That is not a window Mousse can open.' }
  const platform = deps.platform ?? process.platform
  const display = request.op === 'open' ? appDisplay(platform, deps.env) : undefined
  if (request.op === 'open' && platform === 'linux' && !display) return { refused: 'This app has no screen Mousse can open the window on.' }
  try {
    return await deps.request(BOT_BROWSER_WINDOW_METHOD, { ...request, ...(display ? { display } : {}) })
  } catch (error) {
    const message = (error as { message?: unknown } | null)?.message
    return { refused: typeof message === 'string' && message ? message : 'The window did not open.' }
  }
}
