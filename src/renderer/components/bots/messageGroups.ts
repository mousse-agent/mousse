/**
 * How a bot chat's messages sit together. Messages from one sender in a row, each within GROUP_GAP_MS of the
 * one before it and on the same day, form a group: they sit close together, with space above the first. A new day
 * starts with a day line ("Today", "Yesterday", "3 Nov").
 *
 * Times: messages from one sender in a row within the same minute, with nothing between them, show one time, on the
 * last of them. Another sender, a quiet line, a day line or another minute ends that run. A message still on its way
 * ("Sending…") has no time yet, so it ends the run too: the message above it keeps its time.
 */

/** Ten minutes between two messages from one sender keeps them in one group. */
export const GROUP_GAP_MS = 10 * 60_000

export interface MessagePlace {
  /** The first message of its group, with the group's space above it. */
  starts: boolean
  /** The last message of its group. */
  ends: boolean
  /** The day line above this message, when it is the first of its day. */
  day?: string
  /** Shows its time: false when the next message is from the same sender in the same minute, with nothing between. */
  time: boolean
}

/** A row to place: `sending` for a message still on its way, which shows "Sending…" in place of a time. */
export interface PlacedMessage { author: string; at: string; sending?: boolean }

const minuteOf = (time: number) => (Number.isNaN(time) ? Number.NaN : Math.floor(time / 60_000))

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

/** A message's time, in its bubble's corner: the hour as the locale writes it ("1:59 PM", not "01:59 PM") and the minute. */
export function botGroupTime(at: string, locales?: Intl.LocalesArgument): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(locales ?? [], { hour: 'numeric', minute: '2-digit' })
}

/** Where each message sits: whether it starts or ends its group, and the day line above it. */
export function placeMessages(messages: ReadonlyArray<PlacedMessage>, now = new Date()): MessagePlace[] {
  const places: MessagePlace[] = []
  let previous: { author: string; time: number; day: string; sending: boolean } | undefined
  for (const message of messages) {
    const date = new Date(message.at)
    const time = date.getTime()
    const day = Number.isNaN(time) ? '' : dayOf(date)
    const newDay = day !== '' && day !== previous?.day
    const starts = !previous || newDay || message.author !== previous.author || !(time - previous.time <= GROUP_GAP_MS)
    if (starts && places.length) places[places.length - 1]!.ends = true
    // Another day is another minute; NaN never equals NaN, so a message with no readable time never joins a run.
    const sending = Boolean(message.sending)
    if (previous && !sending && !previous.sending && message.author === previous.author && minuteOf(time) === minuteOf(previous.time)) places[places.length - 1]!.time = false
    places.push({ starts, ends: false, time: true, ...(newDay ? { day: botDayLabel(message.at, now) } : {}) })
    previous = { author: message.author, time, day: day || (previous?.day ?? ''), sending }
  }
  if (places.length) places[places.length - 1]!.ends = true
  return places
}
