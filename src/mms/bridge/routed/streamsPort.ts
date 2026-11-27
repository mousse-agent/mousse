import { privateRecordSubject, type PrivateSpec } from '../remote/privateStreams'
import type { ThreadStreamAdapter } from '../remote/ThreadStreamAdapter'
import type { RoutedStreamsPort } from './OwnerRoutes'

/**
 * The private streams of the thread display adapter, as the routed API opens them. A stream is bound
 * to the computer that asked, so the request names only what it is about (a thread, a terminal).
 */
export function routedStreamsPort(
  threads: Pick<ThreadStreamAdapter, 'openPrivateWarm' | 'privateHead' | 'closePrivate'> & {
    store: Pick<ThreadStreamAdapter['store'], 'head'>
  }
): RoutedStreamsPort {
  return {
    open: async (caller, request, stillAllowed) => {
      const spec: PrivateSpec = {
        reader: caller,
        kind: request.kind,
        subject:
          request.kind === 'thread'
            ? request.threadId!
            : request.kind === 'terminal'
              ? `${request.threadId}:${request.ptyId}`
              : ''
      }
      // A thread not open yet reads its transcript off the event loop first; the caller's checks run again after.
      const descriptor = await threads.openPrivateWarm(spec, stillAllowed)
      return {
        descriptor,
        head: threads.store.head(descriptor.id),
        kind: request.kind,
        subject: privateRecordSubject(spec)
      }
    },
    close: (caller, request) => {
      threads.closePrivate({
        reader: caller,
        kind: request.kind,
        subject:
          request.kind === 'thread'
            ? request.threadId
            : request.kind === 'terminal'
              ? `${request.threadId}:${request.ptyId}`
              : ''
      })
    },
    head: (caller, threadId) => threads.privateHead(caller, threadId)
  }
}
