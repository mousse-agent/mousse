import { NetError } from '../../../shared/net'
import { parseProtocolJson } from '../../net/sync/codec'
/** MMS local JSON DTOs omit optional undefined fields in their existing IPC encoding. */
export function mmsJson(value:unknown):unknown{
  const text=JSON.stringify(value)
  if(text===undefined)throw new NetError('bad_request','MMS returned no JSON value.')
  return parseProtocolJson(Buffer.from(text))
}
