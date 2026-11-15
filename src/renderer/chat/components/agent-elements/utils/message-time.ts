const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

/**
 * The time a message shows under its bubble: "3:04 PM" today, "Nov 14" on an earlier day. Used for sent prompts and
 * for queued messages (when each was queued). Undefined for a missing or unreadable time.
 */
export function formatMessageTime(value: Date | string | undefined, now = new Date()): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return isSameDay ? timeFormatter.format(date) : dateFormatter.format(date);
}
