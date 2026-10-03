import { NetError } from '../../../shared/net'
import { parseBoundedJsonDocument } from '../../net/sync/codec'
/** MMS local JSON DTOs omit optional undefined fields in their existing IPC encoding. */
export function mmsJson(value:unknown,maximumBytes=25*1024*1024):unknown{
  const text=JSON.stringify(value)
  if(text===undefined)throw new NetError('bad_request','MMS returned no JSON value.')
  return parseBoundedJsonDocument(Buffer.from(text),maximumBytes)
}
