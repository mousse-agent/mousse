import { basename } from 'node:path'
import {
  BOT_BROWSER_FILES_LIMIT_TEXT,
  BOT_BROWSER_FILES_METHOD,
  MAX_BOT_BROWSER_FILES,
  MAX_BOT_BROWSER_FILES_BYTES,
  type BotBrowserFilesApi
} from '../../shared/bots/personal/browser'

/**
 * A page in a bot's browser asks for files while the owner holds it (`bots:chooseBrowserFiles`): this
 * computer's own open-file dialog, opened here by the app (never by the page), names the site that
 * asks and whether it takes one file or several. Only what the person chooses there goes on: the
 * paths go from here to the service on the window's own connection (`bots.browser.files`, a method the
 * renderer's request bridge does not offer), which checks them again and answers a one-time token.
 * The renderer gets the token alone and sends it as the hold's `files` input; it never names a path.
 * At most `MAX_BOT_BROWSER_FILES` files, `MAX_BOT_BROWSER_FILES_BYTES` in all; over that, a plain
 * refusal. Nothing chosen is logged.
 */

export interface BotBrowserFilesRequest {
  botId: string
  viewId: string
  holdId: string
  multiple: boolean
  site?: string
}

export type BotBrowserFilesAnswer = { token: string; count: number } | { cancelled: true } | { refused: string }

export interface BotBrowserFilesDeps {
  showOpenDialog(options: { title: string; message: string; buttonLabel: string; properties: Array<'openFile' | 'multiSelections'> }): Promise<{ canceled: boolean; filePaths: string[] }>
  stat(path: string): Promise<{ isFile(): boolean; size: number }>
  /** A request to the service on the asking window's own connection. */
  request(method: typeof BOT_BROWSER_FILES_METHOD, params: BotBrowserFilesApi['params']): Promise<BotBrowserFilesApi['result']>
}

const ID = /^[A-Za-z0-9_-]{1,64}$/

/** The request as the renderer sent it, checked; undefined when it is not one. */
export function botBrowserFilesRequest(value: unknown): BotBrowserFilesRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => !['botId', 'viewId', 'holdId', 'multiple', 'site'].includes(key))) return undefined
  if (typeof raw.botId !== 'string' || !ID.test(raw.botId) || typeof raw.viewId !== 'string' || !ID.test(raw.viewId)) return undefined
  if (typeof raw.holdId !== 'string' || !/^hold_[A-Za-z0-9-]{1,64}$/.test(raw.holdId) || typeof raw.multiple !== 'boolean') return undefined
  // A site's name as a host: anything else is not shown.
  const site = typeof raw.site === 'string' && /^[A-Za-z0-9.:[\]-]{1,253}$/.test(raw.site) ? raw.site : undefined
  return { botId: raw.botId, viewId: raw.viewId, holdId: raw.holdId, multiple: raw.multiple, ...(site ? { site } : {}) }
}

/** What the card and the dialog say: "example.com asks for a file". */
export function filesAsk(request: { multiple: boolean; site?: string }): string {
  return `${request.site ?? 'The page'} asks for ${request.multiple ? 'files' : 'a file'}`
}

export async function chooseBotBrowserFiles(value: unknown, deps: BotBrowserFilesDeps): Promise<BotBrowserFilesAnswer> {
  const request = botBrowserFilesRequest(value)
  if (!request) return { refused: 'That file request is not one Mousse can answer.' }
  const asks = filesAsk(request)
  const picked = await deps.showOpenDialog({
    title: asks,
    message: `${asks}. Only what you choose here goes to the page.`,
    buttonLabel: 'Give to the page',
    properties: request.multiple ? ['openFile', 'multiSelections'] : ['openFile']
  })
  if (picked.canceled || !picked.filePaths.length) return { cancelled: true }
  const paths = picked.filePaths
  if (paths.length > MAX_BOT_BROWSER_FILES || (!request.multiple && paths.length > 1)) return { refused: request.multiple ? BOT_BROWSER_FILES_LIMIT_TEXT : 'The page takes one file here.' }
  let total = 0
  for (const path of paths) {
    const info = await deps.stat(path).catch(() => undefined)
    if (!info?.isFile()) return { refused: `${basename(path)} is not a file Mousse can give the page.` }
    total += info.size
  }
  if (total > MAX_BOT_BROWSER_FILES_BYTES) return { refused: BOT_BROWSER_FILES_LIMIT_TEXT }
  try {
    const answer = await deps.request(BOT_BROWSER_FILES_METHOD, { botId: request.botId, viewId: request.viewId, holdId: request.holdId, paths })
    return { token: answer.token, count: answer.count }
  } catch (error) {
    const message = (error as { message?: unknown } | null)?.message
    return { refused: typeof message === 'string' && message ? message : 'The page did not take the files.' }
  }
}
