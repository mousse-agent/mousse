export interface Clock {
  now(): Date
}

export const systemClock: Clock = {
  now(): Date {
    return new Date()
  }
}

export function isoNow(clock: Clock): string {
  return clock.now().toISOString()
}
