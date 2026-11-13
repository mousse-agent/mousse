import { basename } from 'node:path'
import { BOT_BROWSER_FILES_METHOD, type BotBrowserFilesApi } from '../../shared/bots/personal/browser'
import { BROWSER_VIEW_FILES_METHOD, type BrowserViewFilesApi } from '../../shared/browser/threadView'
import { MAX_WATCHED_BROWSER_FILES, MAX_WATCHED_BROWSER_FILES_BYTES, WATCHED_BROWSER_FILES_LIMIT_TEXT } from '../../shared/browser/watched'

/**
 * A page in a browser without a window asks for files while the person holds it (a bot's browser,
 * `bots:chooseBrowserFiles`, or a thread's, `browser:chooseViewFiles`): this computer's own open-file
 * dialog, opened here by the app (never by the page), names the site that asks and whether it takes one
 * file or several. Only what the person chooses there goes on: the paths go from here to the service on
 * the window's own connection (`bots.browser.files` or `browser.view.files`, methods the renderer's
 * request bridge does not offer), which checks them again and answers a one-time token. The renderer
 * gets the token alone and sends it as the hold's `files` input; it never names a path. At most
 * `MAX_WATCHED_BROWSER_FILES` files, `MAX_WATCHED_BROWSER_FILES_BYTES` in all; over that, a plain
 * refusal. Nothing chosen is logged.
 */

/** Which browser asks: a bot's (`botId`) or a thread's (`threadId`). */
export type BrowserViewFilesOwner = { botId: string } | { threadId: string }

export type BrowserViewFilesRequest = BrowserViewFilesOwner & {
  viewId: string
  holdId: string
  multiple: boolean
  site?: string
}

export type BrowserViewFilesAnswer = { token: string; count: number } | { cancelled: true } | { refused: string }

export interface BrowserViewFilesDeps {
  showOpenDialog(options: { title: string; message: string; buttonLabel: string; properties: Array<'openFile' | 'multiSelections'> }): Promise<{ canceled: boolean; filePaths: string[] }>
  stat(path: string): Promise<{ isFile(): boolean; size: number }>
  /** A request to the service on the asking window's own connection. */
  request(method: typeof BOT_BROWSER_FILES_METHOD, params: BotBrowserFilesApi['params']): Promise<BotBrowserFilesApi['result']>
  request(method: typeof BROWSER_VIEW_FILES_METHOD, params: BrowserViewFilesApi['params']): Promise<BrowserViewFilesApi['result']>
}

const ID = /^[A-Za-z0-9_-]{1,64}$/
const THREAD_ID = /^[a-zA-Z0-9:_-]{1,160}$/

/** The request as the renderer sent it, checked, for the browser `owner` names; undefined when it is not one. */
export function browserViewFilesRequest(value: unknown, owner: 'botId' | 'threadId'): BrowserViewFilesRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => ![owner, 'viewId', 'holdId', 'multiple', 'site'].includes(key))) return undefined
  const id = raw[owner]
  if (typeof id !== 'string' || !(owner === 'botId' ? ID : THREAD_ID).test(id) || typeof raw.viewId !== 'string' || !ID.test(raw.viewId)) return undefined
  if (typeof raw.holdId !== 'string' || !/^hold_[A-Za-z0-9-]{1,64}$/.test(raw.holdId) || typeof raw.multiple !== 'boolean') return undefined
  // A site's name as a host: anything else is not shown.
  const site = typeof raw.site === 'string' && /^[A-Za-z0-9.:[\]-]{1,253}$/.test(raw.site) ? raw.site : undefined
  return { ...(owner === 'botId' ? { botId: id } : { threadId: id }), viewId: raw.viewId, holdId: raw.holdId, multiple: raw.multiple, ...(site ? { site } : {}) }
}

/** What the card and the dialog say: "example.com asks for a file". */
export function filesAsk(request: { multiple: boolean; site?: string }): string {
  return `${request.site ?? 'The page'} asks for ${request.multiple ? 'files' : 'a file'}`
}

export async function chooseBrowserViewFiles(value: unknown, owner: 'botId' | 'threadId', deps: BrowserViewFilesDeps): Promise<BrowserViewFilesAnswer> {
  const request = browserViewFilesRequest(value, owner)
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
  if (paths.length > MAX_WATCHED_BROWSER_FILES || (!request.multiple && paths.length > 1)) return { refused: request.multiple ? WATCHED_BROWSER_FILES_LIMIT_TEXT : 'The page takes one file here.' }
  let total = 0
  for (const path of paths) {
    const info = await deps.stat(path).catch(() => undefined)
    if (!info?.isFile()) return { refused: `${basename(path)} is not a file Mousse can give the page.` }
    total += info.size
  }
  if (total > MAX_WATCHED_BROWSER_FILES_BYTES) return { refused: WATCHED_BROWSER_FILES_LIMIT_TEXT }
  try {
    const hold = { viewId: request.viewId, holdId: request.holdId, paths }
    const answer = 'botId' in request
      ? await deps.request(BOT_BROWSER_FILES_METHOD, { botId: request.botId, ...hold })
      : await deps.request(BROWSER_VIEW_FILES_METHOD, { threadId: request.threadId, ...hold })
    return { token: answer.token, count: answer.count }
  } catch (error) {
    const message = (error as { message?: unknown } | null)?.message
    return { refused: typeof message === 'string' && message ? message : 'The page did not take the files.' }
  }
}
