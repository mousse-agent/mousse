/**
 * Files between a bot and the user's other devices (`docs/plans/remote-bots.md`, Calls from the viewing computer): what
 * a device sends a bot goes up in parts ahead of the message (`bots.stage`), and what a bot's chat shows comes down in
 * pages from the bot's files folder (`bots.chat.file`). These are the limits both sides hold to.
 */

/** The largest file another device sends a bot, or reads from one. */
export const REMOTE_BOT_FILE_BYTES = 25 * 1024 * 1024
/** One page of `bots.chat.file`: 40 KiB, under 55 KiB as base64, so a page fits one reply. */
export const REMOTE_BOT_FILE_PAGE_BYTES = 40 * 1024
/** One part of `bots.stage`: 32 KiB, under 44 KiB as base64, so a part and its keys fit one bot call (48 KiB). */
export const BOT_STAGE_PART_BYTES = 32 * 1024
/** The files one device may hold staged on a computer at once, for all its bots there. */
export const BOT_STAGE_CALLER_FILES = 20
/** The bytes one device may hold staged on a computer at once. */
export const BOT_STAGE_CALLER_BYTES = 64 * 1024 * 1024
/** The bytes all devices together may hold staged on a computer. */
export const BOT_STAGE_TOTAL_BYTES = 256 * 1024 * 1024
/** A staged file no message used goes after this long. */
export const BOT_STAGE_TTL_MS = 60 * 60 * 1000
/** The longest path `bots.chat.file` takes, inside the bot's files folder. */
export const MAX_BOT_FILE_PATH = 1024

const STAGE_ID = /^bst_[0-9a-f]{32}$/
/** A staged file's id, as the bot's computer gives it. */
export function isBotStageId(value: unknown): value is string {
  return typeof value === 'string' && STAGE_ID.test(value)
}

/**
 * A file's place inside a bot's files folder as another device names it: relative, with `/` between its parts, and no
 * part that is empty, `.` or `..`. Nothing absolute (`/x`, `C:\x`, `\\server`), no backslash, no control character.
 * No `:` anywhere (a Windows stream, `pic.png:secret`) and no part that ends in a dot or a space, which Windows drops
 * (`pic.svg.` is `pic.svg` there). The bot's computer still follows links and checks that the file it reaches is
 * inside the folder.
 */
export function isBotFileRef(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > MAX_BOT_FILE_PATH) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\:]/.test(value)) return false
  if (value.startsWith('/') || value.startsWith('~')) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part))
}

/**
 * Whether a file's name says SVG, which is never served to another device (it can carry scripts). Read as a file
 * system keeps it: dots and spaces at the end go (`evil.svg.` is `evil.svg`, as `attachmentFileName` saves it), and
 * case does not count.
 */
export function isSvgName(name: string): boolean {
  return /\.svgz?$/.test(name.trim().replace(/[\s.]+$/, '').toLowerCase())
}
