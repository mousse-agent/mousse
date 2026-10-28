import { privateRecordSubject, type PrivateSpec } from '../remote/privateStreams'
import type { ThreadStreamAdapter } from '../remote/ThreadStreamAdapter'
import type { RoutedStreamsPort } from './OwnerRoutes'

/**
 * The private streams of the thread display adapter, as the routed API opens them. A stream is bound
 * to the computer that asked, so the request names only what it is about (a thread, a terminal).
 */
export function routedStreamsPort(
  threads: Pick<ThreadStreamAdapter, 'openPrivate' | 'privateHead' | 'closePrivate'> & {
    store: Pick<ThreadStreamAdapter['store'], 'head'>
  }
): RoutedStreamsPort {
  return {
    open: (caller, request) => {
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
      const descriptor = threads.openPrivate(spec)
      return {
        descriptor,
        head: threads.store.head(descriptor.id),
        kind: spec.kind,
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
