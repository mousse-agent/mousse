import type { Clock } from './contracts'

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms)
    return { cancel: () => clearTimeout(handle) }
  }
}
