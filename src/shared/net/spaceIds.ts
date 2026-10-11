import { isId, type SpaceId, type StreamId } from './ids'
import { NetError } from './errors'

/** The Space's random identity also names its one meta stream. */
export function spaceMetaStream(space: SpaceId): StreamId {
  if (!isId('space', space)) throw new NetError('bad_request')
  return `str_${space.slice(4)}`
}
