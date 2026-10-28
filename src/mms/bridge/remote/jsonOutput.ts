import { NetError } from '../../../shared/net'
import { parseBoundedJsonDocument } from '../../net/sync/codec'
/**
 * MMS local JSON DTOs omit optional undefined fields in their existing IPC encoding. A document that is
 * a display snapshot gives its own node bound (`MAX_DISPLAY_JSON_NODES`).
 */
export function mmsJson(value: unknown, maximumBytes = 25 * 1024 * 1024, maximumNodes?: number): unknown {
  const text = JSON.stringify(value)
  if (text === undefined) throw new NetError('bad_request', 'MMS returned no JSON value.')
  return parseBoundedJsonDocument(Buffer.from(text), maximumBytes, maximumNodes)
}
