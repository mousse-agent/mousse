/**
 * Which completed responses a connection keeps so a request sent again with the same id is answered
 * without running twice. Only calls that change something need that: a read sent again simply runs
 * again and returns current state, so its answer (an image, a thread snapshot) is not kept.
 */
import { ROUTED_METHODS } from '../../shared/bridge/routed'
import { SHARED_READ_METHODS } from './client'
import type { ProtocolResponse } from './types'

/** Local reads that are neither routed reads nor shared by the client, but only return state. */
const LOCAL_READ_METHODS = ['health'] as const

/**
 * Methods whose answer is not kept for a repeated id. Everything else is kept, so a new method that
 * changes something is replay-safe without being listed anywhere.
 */
export const NON_REPLAYED_METHODS: ReadonlySet<string> = new Set([
  ...Object.entries(ROUTED_METHODS)
    .filter(([, row]) => row.capability === 'read')
    .map(([method]) => method),
  ...SHARED_READ_METHODS,
  ...LOCAL_READ_METHODS
])

/** The largest answer kept whole; a larger one is replaced by a small marker. */
export const MMS_PROTOCOL_MAX_REPLAYED_RESPONSE_BYTES = 256 * 1024
/** Answers kept per connection. */
export const MMS_PROTOCOL_MAX_COMPLETED_REQUEST_IDS = 64
/** Bytes of kept answers per connection. */
export const MMS_PROTOCOL_MAX_COMPLETED_RESPONSE_BYTES = 4 * 1024 * 1024

export function keepsResponseForReplay(method: string): boolean {
  return !NON_REPLAYED_METHODS.has(method)
}

/**
 * The entry kept for a completed change. A large answer becomes an error that says the request already
 * ran, so a repeated id still never runs the change twice.
 */
export function replayEntryFor(res: ProtocolResponse): { entry: ProtocolResponse; bytes: number } {
  const bytes = Buffer.byteLength(JSON.stringify(res), 'utf8')
  if (bytes <= MMS_PROTOCOL_MAX_REPLAYED_RESPONSE_BYTES) return { entry: res, bytes }
  const entry: ProtocolResponse = {
    kind: 'res',
    id: res.id,
    ok: false,
    error: {
      code: 'duplicate_request',
      message: 'Request already completed; its response is too large to send again'
    }
  }
  return { entry, bytes: Buffer.byteLength(JSON.stringify(entry), 'utf8') }
}
