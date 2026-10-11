import type { Socket } from 'node:net'
import { DomainRpcError } from './domainRegistry'

/** Resolves only after Node has flushed the write and any backpressure drain.
 * The caller serializes writes and bounds their size; a paused peer cannot make
 * a producer enqueue the whole snapshot in the socket's user-space buffer. */
export function writeConnectionEventFrame(
  socket: Socket,
  frame: Buffer,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted || socket.destroyed)
    return Promise.reject(
      new DomainRpcError('connection_closed', 'Display connection is no longer active')
    )
  return new Promise((resolve, reject) => {
    let settled = false,
      callbackDone = false,
      drained = false
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('close', onClose)
      socket.off('error', onError)
      socket.off('drain', onDrain)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const ready = (): void => {
      if (callbackDone && drained) finish()
    }
    const onClose = (): void =>
      finish(new DomainRpcError('connection_closed', 'Display connection closed'))
    const onError = (error: Error): void => finish(error)
    const onAbort = (): void =>
      finish(new DomainRpcError('cancelled', 'Display delivery was cancelled'))
    const onDrain = (): void => {
      drained = true
      ready()
    }
    const timer = setTimeout(() => {
      finish(new DomainRpcError('connection_closed', 'Display peer did not drain'))
      socket.destroy()
    }, 15000)
    socket.once('close', onClose)
    socket.once('error', onError)
    socket.once('drain', onDrain)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const writable = socket.write(frame, (error) => {
        if (error) {
          finish(error)
          return
        }
        callbackDone = true
        ready()
      })
      drained = writable
      if (writable) socket.off('drain', onDrain)
      ready()
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
