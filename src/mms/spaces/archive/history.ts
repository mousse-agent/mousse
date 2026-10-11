import { NetError, type SpaceDescriptor, type StreamDescriptor } from '../../../shared/net'
import type { StreamStore } from '../../net/contracts'
import { verifyDocument } from '../../net/identity/crypto'
import { json } from '../../net/store/database'
import type { VerifiedSpaceArchive } from './contracts'

/** Original Root-signed epoch placement, for isolated/hidden archive replay only.
 * No descriptor is rewritten in the active store. */
export class ArchiveHistoryPlacement {
  private readonly epochs = new Map<number, SpaceDescriptor>()
  private readonly streams: Map<string, StreamDescriptor>
  constructor(readonly archive: VerifiedSpaceArchive) {
    const manifest = archive.manifest
    let previous = 0
    for (const signed of manifest.descriptors) {
      const descriptor = verifyDocument<SpaceDescriptor>(
        signed,
        manifest.owner.rootKey,
        'spaceDescriptor'
      )
      if (
        descriptor.space !== manifest.space ||
        descriptor.owner !== manifest.owner.user ||
        descriptor.epoch <= previous
      )
        throw new NetError('forbidden')
      this.epochs.set(descriptor.epoch, descriptor)
      previous = descriptor.epoch
    }
    const last = this.epochs.get(manifest.frozen.epoch)
    if (!last || previous !== manifest.frozen.epoch || last.hostNode !== manifest.exporter)
      throw new NetError('forbidden')
    this.streams = new Map(manifest.streams.map((s) => [s.descriptor.id, s.descriptor]))
    for (const descriptor of this.streams.values())
      if (descriptor.space !== manifest.space || descriptor.authority !== last.hostNode)
        throw new NetError('forbidden')
  }
  descriptor(descriptor: StreamDescriptor, epoch: number): StreamDescriptor {
    const host = this.epochs.get(epoch)
    if (
      !host ||
      json(descriptor) !== json(this.streams.get(descriptor.id)) ||
      descriptor.space !== this.archive.manifest.space
    )
      throw new NetError('forbidden')
    return { ...descriptor, authority: host.hostNode }
  }
  store(store: StreamStore, epoch: number): StreamStore {
    if (!this.epochs.has(epoch)) throw new NetError('forbidden')
    return new Proxy(store, {
      get: (target, name: keyof StreamStore) => {
        if (name === 'getStream')
          return (id: StreamDescriptor['id']) => {
            const value = target.getStream(id)
            return value && this.streams.has(id) ? this.descriptor(value, epoch) : value
          }
        const value = target[name]
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
}
