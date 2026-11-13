/**
 * Paths a bot writes in its messages (`C:\Users\me\…\chip-clouds-boy.png`, `/home/me/notes.md`) are drawn as file
 * chips, not as raw text that wraps across lines. Before the Markdown is read, a bare path in the prose, or a code
 * span that holds one path and nothing else, becomes a file link (`mousse-file://open?path=…`), which the chat
 * draws as a chip (BotPathChip). Fenced code is left as written. Browser-safe: only text is read here.
 */

/** A drive path with backslashes or slashes (`C:\a\b.png`, `C:/a/b.png`), or a network path (`\\server\share\x`). */
const WINDOWS_PATH = String.raw`(?:[A-Za-z]:[\\/]|\\\\[\w.$-]+\\)[^\s\`<>"|*?\[\]()]+`
/** A path under a home or system folder (`/Users/…`, `/home/…`, `~/…`): narrow, so "and/or" or "/24" stay text. */
const POSIX_PATH = String.raw`(?:~|/(?:Users|home|tmp|var|opt|private|mnt|Volumes|srv|etc|root))/[^\s\`<>"|*?\[\]()]+`
/** Not inside a word, a link's text or target, another path, or an address. */
const BEFORE = String.raw`(?<![\w\]\[\\/.:~=\-])(?<!\]\()`
const BARE_PATH = new RegExp(`${BEFORE}(?:${WINDOWS_PATH}|${POSIX_PATH})`, 'g')
/** A code span that holds one path and nothing else; there a path may have spaces (`C:\My notes\plan.md`). */
const WHOLE_PATH = new RegExp(`^(?:${WINDOWS_PATH}|${POSIX_PATH})$`.replaceAll(String.raw`[^\s\``, String.raw`[^\``))
/** What a sentence leaves at a path's end: a full stop, a comma, a closing quote. */
const TRAILING = /[.,;:!?'"]+$/

const FILE_LINK = 'mousse-file://open?path='

/** The link a path becomes. */
export function botFileHref(path: string): string {
  return `${FILE_LINK}${encodeURIComponent(path)}`
}

/** A path's last name: `chip-clouds-boy.png`. */
export function pathName(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).at(-1) ?? path
}

/** The folder a path is in, as the computer writes it; undefined at a root. */
export function pathFolder(path: string): string | undefined {
  const at = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  if (at <= 0) return undefined
  const folder = path.slice(0, at)
  return /^[A-Za-z]:$/.test(folder) ? `${folder}\\` : folder
}

/**
 * What a path's chip reads. A file in the bot's own files folder (`…/bots/files/<botId>/…`) reads as its path inside
 * that folder (`chip-clouds-boy.png`, `attachments/2026-11-13/notes.md`), never the profile's folders around it;
 * any other file as its name.
 */
export function botPathLabel(path: string, botId?: string): string {
  if (botId) {
    const parts = path.split(/[\\/]+/).filter(Boolean)
    for (let at = 0; at + 3 < parts.length; at += 1) {
      if (parts[at] === 'bots' && parts[at + 1] === 'files' && parts[at + 2] === botId) return parts.slice(at + 3).join('/')
    }
  }
  return pathName(path)
}

/** A bare path with the sentence's punctuation, and any closing bracket it never opened, left out. */
function trimPath(path: string): string {
  let value = path
  for (;;) {
    const before = value
    value = value.replace(TRAILING, '')
    if (value.endsWith(')') && (value.match(/\)/g)?.length ?? 0) > (value.match(/\(/g)?.length ?? 0)) value = value.slice(0, -1)
    if (value === before) return value
  }
}

/** A Markdown link that draws as the path's chip. Its text is the name, with Markdown's brackets escaped. */
function linkTo(path: string): string {
  return `[${pathName(path).replace(/[[\]\\]/g, '\\$&')}](${botFileHref(path)})`
}

function linkProse(prose: string): string {
  return prose.replace(BARE_PATH, (match) => {
    const path = trimPath(match)
    // A path that is only a drive or a home folder is not a file to open.
    if (path.length < 4 || !/[\\/][^\\/]+$/.test(path)) return match
    return linkTo(path) + match.slice(path.length)
  })
}

/** One line outside fenced code: code spans stay as written unless one is a whole path; the prose between gets links. */
function linkLine(line: string): string {
  let out = ''
  let at = 0
  while (at < line.length) {
    const tick = line.indexOf('`', at)
    if (tick < 0) break
    let run = 1
    while (line[tick + run] === '`') run += 1
    const close = line.indexOf('`'.repeat(run), tick + run)
    if (close < 0) break
    out += linkProse(line.slice(at, tick))
    const inside = line.slice(tick + run, close)
    const path = inside.trim()
    out += WHOLE_PATH.test(path) && /[\\/][^\\/]+$/.test(path) ? linkTo(path) : line.slice(tick, close + run)
    at = close + run
  }
  return out + linkProse(line.slice(at))
}

/** A bot message's Markdown with each path in its prose made a file link, ready for the chat's Markdown. */
export function linkBotPaths(markdown: string): string {
  if (!/[\\/]/.test(markdown)) return markdown
  let fence: string | null = null
  return markdown.split('\n').map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = null
      return line
    }
    if (marker) {
      fence = marker
      return line
    }
    // An indented line may be code: left as written.
    if (/^(?: {4}|\t)/.test(line) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) return line
    return linkLine(line)
  }).join('\n')
}
