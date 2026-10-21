import type { MmsProfileServices } from '../../MmsProfileServices'
import { mmsJson } from './jsonOutput'
import { MmsRemoteBackend } from './MmsBackend'
import type { ThreadSourcePort, ThreadSourceEvent } from './ThreadStreamAdapter'
/** Actual thread events/snapshots from the already-owned profile, never the old global event ring. */
export class MmsThreadSource implements ThreadSourcePort {
  private readonly backend: MmsRemoteBackend
  constructor(
    private readonly services: MmsProfileServices,
    revision?: () => number
  ) {
    this.backend = new MmsRemoteBackend(services, revision)
  }
  snapshot(threadId: string): unknown {
    return this.backend.snapshot(threadId, 32 * 1024 * 1024)
  }
  onThread(
    threadId: string,
    listener: (event: ThreadSourceEvent) => void,
    onError?: (error: unknown) => void
  ): () => void {
    const deliver = (type: ThreadSourceEvent['type'], data: unknown, ephemeral = false): void => {
      try {
        listener({
          type,
          data: mmsJson(data),
          ...(ephemeral ? { ephemeral: true } : {})
        } as ThreadSourceEvent)
      } catch (error) {
        if (onError) onError(error)
        else throw error
      }
    }
    const mappings = [
      ['thread-message', 'thread.message'],
      ['thread-message-updated', 'thread.message-updated'],
      ['thread-messages', 'thread.messages'],
      ['queue-updated', 'queue.updated'],
      ['turn-started', 'turn.started'],
      ['turn-completed', 'turn.completed'],
      ['turn-interrupted', 'turn.interrupted'],
      ['turn-aborted', 'turn.aborted'],
      ['turn-state', 'turn.state'],
      ['turn-steered', 'turn.steered'],
      ['connection-failed', 'connection.failed']
    ] as const
    const disposers: Array<() => void> = []
    for (const [source, type] of mappings) {
      const handle = (data: { threadId?: string; message?: { streaming?: boolean } }): void => {
        if (data?.threadId === threadId) deliver(type, data, data.message?.streaming === true)
      }
      this.services.orchestrator.on(source, handle)
      disposers.push(() => this.services.orchestrator.off(source, handle))
    }
    // Pending questions change rarely and are memory-only; remote readers get the full list live.
    const questions = (data: { threadId?: string }): void => {
      if (data?.threadId !== threadId) return
      deliver(
        'questions.updated',
        { threadId, pending: this.services.questions.listPendingForThread(threadId) },
        true
      )
    }
    for (const event of ['pending', 'cleared'] as const) {
      this.services.questions.on(event, questions)
      disposers.push(() => this.services.questions.off(event, questions))
    }
    let lastMetadata: string | undefined
    const metadata = (thread: { id: string }): void => {
      if (thread.id !== threadId) return
      const data = { thread },
        fingerprint = JSON.stringify(data)
      if (fingerprint === lastMetadata) return
      lastMetadata = fingerprint
      deliver('thread.metadata', data)
    }
    this.services.threads.on('updated', metadata)
    disposers.push(() => this.services.threads.off('updated', metadata))
    const lists = (data: unknown): void => {
      const rows = Array.isArray(data) ? data : (data as { threads?: unknown[] })?.threads
      if (!Array.isArray(rows)) return
      const thread = rows.find((row) => (row as { id?: string })?.id === threadId)
      if (thread) metadata(thread as { id: string })
    }
    this.services.events.on('threads:updated', lists)
    disposers.push(() => this.services.events.off('threads:updated', lists))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }
}
