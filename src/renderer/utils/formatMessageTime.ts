/** Clock time without seconds, e.g. "11:00 PM" or "23:00" depending on locale. */
function formatClock(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

/**
 * Human-readable chat timestamp:
 * - today → "11:00 PM"
 * - yesterday → "Yesterday, 11:00 PM"
 * - same year → "Mar 15, 11:00 PM"
 * - earlier → "Mar 15, 2025, 11:00 PM"
 */
export function formatMessageTime(timestamp: string | number | Date, now = new Date()): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''

  const clock = formatClock(date)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfMessageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const dayDiff = Math.round(
    (startOfToday.getTime() - startOfMessageDay.getTime()) / (24 * 60 * 60 * 1000)
  )

  if (dayDiff === 0) return clock
  if (dayDiff === 1) return `Yesterday, ${clock}`

  const sameYear = date.getFullYear() === now.getFullYear()
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  })
  return `${day}, ${clock}`
}

/** Full absolute time for tooltips. */
export function formatMessageTimeTitle(timestamp: string | number | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
