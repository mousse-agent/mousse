/** Headlines for an empty chat, by local time of day. Short, plain, one question each. */
export const EMPTY_THREAD_HEADLINES = {
  morning: ['Morning. What are we building?', "Fresh start. What's first?", 'What are we starting on today?'],
  afternoon: ['What should we build?', "What's next?", 'What are we working on?'],
  evening: ['Evening session?', 'What are we making tonight?', "What's on for tonight?"],
  lateNight: ['Up late brainstorming?', "Night owl mode. What's the idea?", 'Late one. What are we building?']
} as const

export type DaySlot = keyof typeof EMPTY_THREAD_HEADLINES

/** Morning 5–11, afternoon 12–17, evening 18–22, late night 23–4, by the local hour. */
export function daySlot(date: Date): DaySlot {
  const hour = date.getHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'lateNight'
}

/** A stable non-negative hash of the seed (FNV-1a), so one chat keeps its line. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** The empty chat's headline: picked by time of day, and within it by the chat's id. */
export function emptyThreadHeadline(date: Date, seed: string): string {
  const lines = EMPTY_THREAD_HEADLINES[daySlot(date)]
  return lines[hashSeed(seed) % lines.length]!
}
