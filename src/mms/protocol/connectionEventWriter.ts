import type { Socket } from 'node:net'
import { DomainRpcError } from './domainRegistry'

/** How long a peer that stopped reading keeps its connection. */
export const OUTBOUND_DRAIN_STALL_MS = 15_000

/**
 * Bytes Node may hold for the peer before the next frame waits for a drain. Frames up to this
 * are handed over in one turn of the event loop, so a busy daemon is not held to one frame per
 * turn while a reading peer keeps up.
 */
export const OUTBOUND_BATCH_BYTES = 1024 * 1024

/**
 * Writes a frame without waiting for it to be flushed. Waits for a drain first only when Node
 * already holds more than `OUTBOUND_BATCH_BYTES` for the peer, so user-space buffering stays
 * bounded. A peer that does not drain within `OUTBOUND_DRAIN_STALL_MS` is disconnected.
 */
export async function writeBatchedFrame(socket: Socket, frame: Buffer, signal: AbortSignal): Promise<void> {
  if (signal.aborted || socket.destroyed)
    throw new DomainRpcError('connection_closed', 'Display connection is no longer active')
  // `drain` follows only a write that returned false, which `writableNeedDrain` reports.
  if (socket.writableNeedDrain && socket.writableLength + frame.length > OUTBOUND_BATCH_BYTES)
    await waitForDrain(socket, signal)
  // A failed write also emits `error` and `close` on the socket, which close the connection.
  socket.write(frame)
}

function waitForDrain(socket: Socket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('close', onClose)
      socket.off('error', onError)
      socket.off('drain', onDrain)
      signal.removeEventListener('abort', onAbort)
    }
    const onDrain = (): void => { cleanup(); resolve() }
    const onClose = (): void => { cleanup(); reject(new DomainRpcError('connection_closed', 'Display connection closed')) }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const onAbort = (): void => { cleanup(); reject(new DomainRpcError('cancelled', 'Display delivery was cancelled')) }
    const timer = setTimeout(() => {
      cleanup()
      reject(new DomainRpcError('connection_closed', 'Display peer did not drain'))
      socket.destroy()
    }, OUTBOUND_DRAIN_STALL_MS)
    socket.once('close', onClose)
    socket.once('error', onError)
    socket.once('drain', onDrain)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

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
    }, OUTBOUND_DRAIN_STALL_MS)
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
