import {
  MAX_WATCHED_BROWSER_FILES,
  MAX_WATCHED_BROWSER_SENT,
  validateWatchedBrowserInput,
  watchedBrowserPageSize,
  type WatchedBrowserHoldRequest,
  type WatchedBrowserPageSize,
  type WatchedBrowserSent
} from '../../../shared/browser/watched'
import { BrowserAutomationError } from '../automation/BrowserSessionManager'
import type { HandlerContext } from '../../protocol/handlers'
import { DomainRpcError, domainObject } from '../../protocol/domainRegistry'

/**
 * The checks every view of a browser without a window shares at the protocol: ids, a hold's request,
 * numbered inputs, chosen files, and who may call (the desktop app on this computer alone).
 */

export const isWatchId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
export const isHoldId = (value: unknown): value is string => typeof value === 'string' && /^hold_[A-Za-z0-9-]{1,64}$/.test(value)
export const isCount = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const isSeq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

/**
 * The page size a large view asks for while it shows the browser (`watch`'s `page`): its own size in CSS
 * pixels and the screen's pixel ratio, kept within `WATCHED_BROWSER_PAGE`. Absent: it asks for none.
 */
export function pageSize(value: unknown): WatchedBrowserPageSize | undefined {
  if (value === undefined) return undefined
  const r = domainObject(value, ['width', 'height', 'scale'])
  if (!isCount(r.width, 1, 100_000) || !isCount(r.height, 1, 100_000)) throw new DomainRpcError('invalid_params', 'page must give a width and a height in pixels')
  if (r.scale !== undefined && !isCount(r.scale, 0.1, 16)) throw new DomainRpcError('invalid_params', 'page scale must be the screen pixel ratio')
  return watchedBrowserPageSize(r)
}

export function viewPlatform(value: unknown): 'mac' | 'other' | undefined {
  if (value === undefined) return undefined
  if (value !== 'mac' && value !== 'other') throw new DomainRpcError('invalid_params', 'platform must be mac or other')
  return value
}

export function holdRequest(value: unknown): WatchedBrowserHoldRequest {
  const op = (value as { op?: unknown } | null)?.op
  if (op === 'take') {
    const r = domainObject(value, ['op', 'force', 'platform'])
    if (r.force !== undefined && typeof r.force !== 'boolean') throw new DomainRpcError('invalid_params', 'force must be true or false')
    const os = viewPlatform(r.platform)
    return { op, ...(r.force ? { force: true } : {}), ...(os ? { platform: os } : {}) }
  }
  if (op === 'renew' || op === 'release') {
    const r = domainObject(value, ['op', 'holdId'])
    if (!isHoldId(r.holdId)) throw new DomainRpcError('invalid_params', 'A hold id is required')
    return { op, holdId: r.holdId }
  }
  throw new DomainRpcError('invalid_params', 'request must take, renew or release a hold')
}

export function sentInputs(value: unknown): WatchedBrowserSent[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_WATCHED_BROWSER_SENT) throw new DomainRpcError('invalid_params', `inputs must hold 1 to ${MAX_WATCHED_BROWSER_SENT} inputs`)
  return value.map((entry): WatchedBrowserSent => {
    // A number the view gives up on comes as a skip, so the count never waits on a hole.
    if (entry && typeof entry === 'object' && 'skip' in entry) {
      const skip = domainObject(entry, ['seq', 'skip'])
      if (!isSeq(skip.seq) || skip.skip !== true) throw new DomainRpcError('invalid_params', 'A skip names its seq')
      return { seq: skip.seq, skip: true }
    }
    const sent = domainObject(entry, ['seq', 'picture', 'input'])
    if (!isSeq(sent.seq)) throw new DomainRpcError('invalid_params', 'seq must be a whole number from 1')
    if (sent.picture !== undefined && !(typeof sent.picture === 'number' && Number.isSafeInteger(sent.picture) && sent.picture >= 0)) throw new DomainRpcError('invalid_params', 'picture must be a picture number')
    return { seq: sent.seq, ...(sent.picture !== undefined ? { picture: sent.picture as number } : {}), input: validateWatchedBrowserInput(sent.input) }
  })
}

/** The files this computer's own file dialog answered: absolute paths, at most `MAX_WATCHED_BROWSER_FILES`. */
export function chosenPaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_WATCHED_BROWSER_FILES) throw new DomainRpcError('invalid_params', `paths must hold 1 to ${MAX_WATCHED_BROWSER_FILES} files`)
  return value.map((path) => {
    if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) throw new DomainRpcError('invalid_params', 'Each path must be a file on this computer')
    return path
  })
}

/**
 * The calling connection, when it is the desktop app's own on this computer: pictures go, and input
 * comes, through it alone. An agent, a bot, the command line, a group chat, a workflow and another
 * computer (a routed call) are refused with `refusal`.
 */
export function appWindowConnection(context: HandlerContext, refusal: string): NonNullable<HandlerContext['connection']> & { emitConnectionEvent: NonNullable<NonNullable<HandlerContext['connection']>['emitConnectionEvent']> } {
  const connection = context.connection
  if (!connection?.emitConnectionEvent || connection.clientType !== 'gui' || connection.bridgeCaller)
    throw new DomainRpcError('unsupported', refusal)
  return connection as never
}

/** The browser's own refusals keep their code and plain message, and a failed page its class and Chromium's code. */
export function asDomainError(error: unknown): unknown {
  if (error instanceof BrowserAutomationError) return new DomainRpcError(error.code, error.message, error.details?.problem ? { problem: error.details.problem } : undefined)
  return error
}
