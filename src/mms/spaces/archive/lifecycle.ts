import { NetError } from '../../../shared/net'

/** An aborted wait is failure, never a certificate that an owned task stopped. */
export async function settleArchiveWork(
  work: Iterable<Promise<unknown>>,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) throw new NetError('cancelled')
  let abort!: () => void
  try {
    await Promise.race([
      Promise.allSettled([...work]),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new NetError('cancelled'))
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    ])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
