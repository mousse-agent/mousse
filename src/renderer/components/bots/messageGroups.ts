/**
 * How a bot chat's messages sit together. Messages from one sender in a row, each within GROUP_GAP_MS of the
 * one before it and on the same day, form a group: the bot's face and name show once, on the first, and one
 * time shows under the last. A new day starts with a day line ("Today", "Yesterday", "3 Nov").
 */

/** Ten minutes between two messages from one sender keeps them in one group. */
export const GROUP_GAP_MS = 10 * 60_000

export interface MessagePlace {
  /** The first message of its group: the bot's face and name go here, and the group's space above it. */
  starts: boolean
  /** The last message of its group: the group's time goes under it. */
  ends: boolean
  /** The day line above this message, when it is the first of its day. */
  day?: string
}

const dayOf = (date: Date) => date.toDateString()

/** A day line's words: "Today", "Yesterday", "3 Nov", or "3 Nov 2025" in another year. */
export function botDayLabel(at: string, now = new Date()): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  if (dayOf(date) === dayOf(now)) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (dayOf(date) === dayOf(yesterday)) return 'Yesterday'
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
}

/** A group's time under its last message: the hour as the locale writes it ("1:59 PM", not "01:59 PM") and the minute. */
export function botGroupTime(at: string, locales?: Intl.LocalesArgument): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(locales ?? [], { hour: 'numeric', minute: '2-digit' })
}

/** A message's full date and time, for its tooltip. */
export function botFullTime(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })
}

/**
 * The small label on a bot message that is not a plain reply: "Reminder" for a reminder said at its time (its row is
 * `bm_<reminder id>`, and reminder ids start `rem_`; BotEngine), "Work report" for what a run of work reported.
 */
export function botMessageLabel(message: { id: string; kind: string; author: string }): string | undefined {
  if (message.author !== 'bot' || message.kind !== 'run_report') return undefined
  return message.id.startsWith('bm_rem_') ? 'Reminder' : 'Work report'
}

/** Where each message sits:whether it starts or ends its group, and the day line above it. */
export function placeMessages(messages: ReadonlyArray<{ author: string; at: string }>, now = new Date()): MessagePlace[] {
  const places: MessagePlace[] = []
  let previous: { author: string; time: number; day: string } | undefined
  for (const message of messages) {
    const date = new Date(message.at)
    const time = date.getTime()
    const day = Number.isNaN(time) ? '' : dayOf(date)
    const newDay = day !== '' && day !== previous?.day
    const starts = !previous || newDay || message.author !== previous.author || !(time - previous.time <= GROUP_GAP_MS)
    if (starts && places.length) places[places.length - 1]!.ends = true
    places.push({ starts, ends: false, ...(newDay ? { day: botDayLabel(message.at, now) } : {}) })
    previous = { author: message.author, time, day: day || (previous?.day ?? '') }
  }
  if (places.length) places[places.length - 1]!.ends = true
  return places
}
