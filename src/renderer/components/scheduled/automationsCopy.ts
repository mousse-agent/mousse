/** Automations' headlines: short, a little playful, one line each (in the spirit of the new-thread headlines). */
export const AUTOMATIONS_HOME_HEADLINES = [
  'What runs while you sleep?',
  'Put it on autopilot.',
  'Chores, meet clockwork.',
  'Set it. Forget it.'
] as const

/** The quick-add line's placeholder. */
export const QUICK_ADD_PLACEHOLDER = 'Hand off a chore…'

/** Home's list of what runs next. */
export const UP_NEXT_HEADING = 'Up next'

/** The Schedule tab with no tasks at all, and with only done ones hidden. */
export const SCHEDULE_EMPTY = 'Nothing on the clock.'
export const SCHEDULE_ALL_CLEAR = 'All clear.'

/** Home's headline: one per day, so it does not change under the person while they look. */
export function automationsHomeHeadline(date: Date = new Date()): string {
  const day = Math.floor((date.getTime() - date.getTimezoneOffset() * 60_000) / 86_400_000)
  return AUTOMATIONS_HOME_HEADLINES[day % AUTOMATIONS_HOME_HEADLINES.length]!
}
