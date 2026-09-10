import { randomUUID } from 'node:crypto'

interface CancellationEntry {
  profileId: string
  controller: AbortController
  detach?: () => void
}

/** Cancellation IDs are serialized; process-owned AbortSignals are not. */
export class CancellationRegistry {
  private readonly entries = new Map<string, CancellationEntry>()

  create(profileId: string, parentId?: string): { id: string; signal: AbortSignal } {
    if (!profileId) throw new Error('Profile identity is required')
    const controller = new AbortController()
    const id = randomUUID()
    const entry: CancellationEntry = { profileId, controller }
    if (parentId) {
      const parent = this.resolve(profileId, parentId)
      const cancel = () => controller.abort(parent.reason)
      if (parent.aborted) cancel()
      else {
        parent.addEventListener('abort', cancel, { once: true })
        entry.detach = () => parent.removeEventListener('abort', cancel)
      }
    }
    this.entries.set(id, entry)
    return { id, signal: controller.signal }
  }

  /** Recreate the process-owned signal for a durable cancellation id after restart. */
  restore(profileId: string, id: string): AbortSignal {
    if (!profileId || !id) throw new Error('Profile identity and cancellation id are required')
    const existing = this.entries.get(id)
    if (existing) {
      if (existing.profileId !== profileId) throw new Error('Cancellation profile mismatch')
      return existing.controller.signal
    }
    const controller = new AbortController()
    this.entries.set(id, { profileId, controller })
    return controller.signal
  }

  resolve(profileId: string, id: string): AbortSignal {
    const entry = this.entries.get(id)
    if (!entry || entry.profileId !== profileId) throw new Error('Unknown cancellation context')
    return entry.controller.signal
  }

  abort(profileId: string, id: string, reason = 'Cancelled'): void {
    this.resolve(profileId, id)
    this.entries.get(id)!.controller.abort(reason)
  }

  release(profileId: string, id: string): void {
    this.resolve(profileId, id)
    const entry = this.entries.get(id)!
    entry.controller.abort('Execution context released')
    entry.detach?.()
    this.entries.delete(id)
  }
}
