/**
 * The project row's tooltip, "name · path", on one line: the home folder reads `~`, and a path too long for
 * about 480px loses its middle folders to "…" (the start and the last folder stay). A project of another
 * computer keeps that computer's own path and ends in " · <computer>".
 */

/** About 480px of the tooltip's 12px text. */
export const PROJECT_TOOLTIP_MAX_CHARS = 72

const ELLIPSIS = '…'

/** This computer's home folder, as the window was given it; none outside the app. */
export function thisHomeFolder(): string | undefined {
  const value = (globalThis as { mousse?: { homeFolder?: unknown } }).mousse?.homeFolder
  return typeof value === 'string' && value ? value : undefined
}

/** `path` with the home folder written `~`, for this computer's own paths. */
export function tildePath(path: string, home: string | undefined): string {
  if (!home) return path
  const trimmed = home.replace(/[\\/]+$/, '')
  if (!trimmed) return path
  if (path === trimmed) return '~'
  const next = path.charAt(trimmed.length)
  if (path.startsWith(trimmed) && (next === '/' || next === '\\')) return `~${path.slice(trimmed.length)}`
  return path
}

/**
 * `path` in at most `max` characters: whole folders from the middle become "…", keeping the first folder
 * and as many of the last ones as fit. A path whose first and last folders alone are too long is cut in
 * the middle of its characters.
 */
export function shortenPathMiddle(path: string, max: number): string {
  if (path.length <= max) return path
  const separator = path.includes('/') ? '/' : '\\'
  const parts = path.split(separator)
  // A path from the root, home or a drive keeps its first folder too: "~/code/…", not "~/…".
  const headCount = parts[0] === '' || parts[0] === '~' || /^[A-Za-z]:$/.test(parts[0]) ? 2 : 1
  if (parts.length >= headCount + 2) {
    const head = parts.slice(0, headCount)
    const rest = parts.slice(headCount)
    let tail = [rest[rest.length - 1]]
    const join = (end: string[]) => [...head, ELLIPSIS, ...end].join(separator)
    if (rest.length > 1 && join(tail).length <= max) {
      for (let index = rest.length - 2; index >= 1; index--) {
        const longer = [rest[index], ...tail]
        if (join(longer).length > max) break
        tail = longer
      }
      return join(tail)
    }
  }
  const keep = Math.max(0, max - ELLIPSIS.length)
  const start = Math.ceil(keep / 2)
  return path.slice(0, start) + ELLIPSIS + path.slice(path.length - (keep - start))
}

export type ProjectTooltipInput = {
  name: string
  path?: string
  /** Set for another computer's project: its path stays as that computer has it. */
  computerName?: string
  /** This computer's name, shown when projects of several computers are listed. */
  selfName?: string
  /** This computer's home folder. */
  home?: string
  max?: number
}

/** `text` is the one-line tooltip; `full` names the whole path, for screen readers. */
export function projectTooltip(input: ProjectTooltipInput): { text: string; full: string } {
  const max = input.max ?? PROJECT_TOOLTIP_MAX_CHARS
  const path = input.path ? (input.computerName ? input.path : tildePath(input.path, input.home)) : ''
  const computer = input.computerName ?? input.selfName
  const full = [input.name, path, computer].filter(Boolean).join(' · ')
  if (!path || full.length <= max) return { text: full, full }
  const others = [input.name, computer].filter(Boolean).join(' · ').length + ' · '.length * (computer ? 2 : 1)
  const short = shortenPathMiddle(path, Math.max(12, max - others))
  return { text: [input.name, short, computer].filter(Boolean).join(' · '), full }
}
