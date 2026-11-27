import { createHash } from 'node:crypto'
import { refused } from './refusal'
import type { ToolOutcome } from './types'

/**
 * Paging (docs/plans/tool-api.md §1.2 "Paging"). A list returns its rows with `nextCursor` (null on the last page) and
 * `complete`; cut text says how long it is (`totalChars`) and the call that reads on (`readMore`), whose page is bounded
 * in bytes. A cursor is bound to the thread that asked and to the query: another thread, or the same one with other
 * filters, can't continue it. A cursor only says where a list goes on: each page is built again for the thread that
 * presents it, with only the rows that thread may read, so a cursor grants nothing.
 */

/** The call that reads on in cut text: the same tool, with these arguments. */
export interface ReadMore {
  tool: string
  args: Record<string, unknown>
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

/**
 * The rows of a page that fit in `maxBytes` together with `envelope` (the rest of the response): whole rows in order,
 * always the first, until the next would pass the cap. `capped` says rows were left out.
 */
export function fitPage<T>(rows: Iterable<T>, envelope: Record<string, unknown>, maxBytes: number): { taken: T[]; capped: boolean } {
  // The envelope as the response will carry it, with room for the numbers, cursor and hints the page adds.
  let used = jsonBytes(envelope) + 512
  const taken: T[] = []
  for (const row of rows) {
    const size = jsonBytes(row) + 1
    if (taken.length > 0 && used + size > maxBytes) return { taken, capped: true }
    taken.push(row)
    used += size
  }
  return { taken, capped: false }
}

/** What a cursor is bound to: the thread that asked, the tool, and every argument but the cursor, the page size and the retry key. */
function bindingOf(callerThreadId: string, tool: string, args: Record<string, unknown>): string {
  const query = Object.keys(args).filter((key) => key !== 'cursor' && key !== 'limit' && key !== 'clientRequestId').sort().map((key) => [key, args[key]])
  return createHash('sha256').update(JSON.stringify([callerThreadId, tool, query])).digest('base64url').slice(0, 22)
}

/** A cursor for the page after `position`, for this caller and query only. */
export function makeCursor(callerThreadId: string, tool: string, args: Record<string, unknown>, position: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ b: bindingOf(callerThreadId, tool, args), p: position }), 'utf8').toString('base64url')
}

/** Where the call's `cursor` says the list goes on (none: the first page), or the refusal of a cursor made for another call. */
export function readCursor(callerThreadId: string, tool: string, args: Record<string, unknown>): { position?: Record<string, unknown> } | { refused: ToolOutcome } {
  if (args.cursor === undefined || args.cursor === null) return {}
  let decoded: { b?: unknown; p?: unknown } | undefined
  try {
    decoded = typeof args.cursor === 'string' ? JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')) : undefined
  } catch {
    decoded = undefined
  }
  if (!decoded || typeof decoded.b !== 'string' || !decoded.p || typeof decoded.p !== 'object')
    return { refused: refused('invalid_arguments', `cursor is not one ${tool} returned: pass nextCursor from the page before, or leave it out for the first page.`, { data: { reason: 'invalid_cursor' } }) }
  if (decoded.b !== bindingOf(callerThreadId, tool, args))
    return { refused: refused('invalid_arguments', `This cursor was made for another ${tool} call: continue a list from the thread that asked for it, with the same arguments, or leave cursor out to start again.`, { data: { reason: 'cursor_mismatch' } }) }
  return { position: decoded.p as Record<string, unknown> }
}

/** The page's paging fields: a cursor for the rest when there is more, and whether this page ends the list. */
export function pageEnd(more: boolean, cursor: () => string): { nextCursor: string | null; complete: boolean } {
  return more ? { nextCursor: cursor(), complete: false } : { nextCursor: null, complete: true }
}
