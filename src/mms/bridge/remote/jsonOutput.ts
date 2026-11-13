import { NetError } from '../../../shared/net'
import { MAX_DISPLAY_JSON_NODES, parseBoundedJsonDocument } from '../../net/sync/codec'
/**
 * MMS local JSON DTOs omit optional undefined fields in their existing IPC encoding. What this computer
 * sends its owner's devices has the display bounds: 32 MiB and `MAX_DISPLAY_JSON_NODES`, not the wire's
 * 16,384 nodes, which a thread of about 400 messages already passes.
 */
export function mmsJson(
  value: unknown,
  maximumBytes = 32 * 1024 * 1024,
  maximumNodes = MAX_DISPLAY_JSON_NODES
): unknown {
  const text = JSON.stringify(value)
  if (text === undefined) throw new NetError('bad_request', 'MMS returned no JSON value.')
  return parseBoundedJsonDocument(Buffer.from(text), maximumBytes, maximumNodes)
}
