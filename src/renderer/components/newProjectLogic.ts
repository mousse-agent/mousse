/** What one field in New project can hold, and the rows it offers. */

export type NewProjectRow =
  /** Asks for a folder with the system's folder picker. */
  | { kind: 'open-folder' }
  /** Start from: says what to type for a clone or a new project. */
  | { kind: 'clone-hint' }
  | { kind: 'new-hint' }
  /** Clones a GitHub repository (`owner/name`) into `destination`; null until a folder for new projects is known. */
  | { kind: 'clone'; repository: string; name: string; destination: string | null }
  /** Makes an empty folder and a Git repository in it. */
  | { kind: 'create'; name: string; destination: string | null }
  /** Adds a folder that is already there, by its path. */
  | { kind: 'add-path'; path: string }
  /** Another computer: a folder its projects are in, which fills the field. */
  | { kind: 'suggest'; path: string }
  /** A repository that is not on GitHub: shown, but it cannot be cloned. */
  | { kind: 'not-github' }

export interface RowGroup {
  label: string
  rows: NewProjectRow[]
}

const SEGMENT = '[A-Za-z0-9][A-Za-z0-9_.-]{0,99}'
const GITHUB = new RegExp(`^(?:(?:https?://)?(?:www\\.)?github\\.com/|git@github\\.com:)?(${SEGMENT})/(${SEGMENT})/?$`, 'i')

/**
 * A GitHub repository in any of the forms people paste — `owner/name`, a github.com URL with or without https, or an
 * SSH address — as `owner/name`; null for anything else.
 */
export function githubRepository(text: string): string | null {
  const match = GITHUB.exec(text.trim())
  if (!match) return null
  return `${match[1]}/${match[2]!.replace(/\.git$/i, '')}`
}

/** A full folder path: from the root, a drive, a network share, or "~" (the home folder). */
export function isFolderPath(text: string): boolean {
  return /^(?:\/|~(?:$|[\\/])|\\\\|[A-Za-z]:[\\/])/.test(text.trim())
}

/** A name a new project's folder can take: letters, numbers, spaces, dots, dashes and underscores. */
export function isProjectName(text: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(text.trim())
}

const separatorOf = (path: string) => (path.includes('\\') && !path.includes('/') ? '\\' : '/')

/** `name` inside `parent`, with the parent's own separator. */
export function joinFolder(parent: string, name: string): string {
  return `${parent.replace(/[\\/]+$/, '')}${separatorOf(parent)}${name}`
}

/** The folder a path is in; null for a path with none. */
export function parentFolder(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut <= 0) return null
  // "C:\dev" → "C:\", not "C:".
  return /^[A-Za-z]:$/.test(trimmed.slice(0, cut)) ? trimmed.slice(0, cut + 1) : trimmed.slice(0, cut)
}

/** Where new projects go when none was chosen: the folder most of these projects are in (the first such on a tie). */
export function usualParent(paths: readonly string[]): string | null {
  const counts = new Map<string, number>()
  for (const path of paths) {
    const parent = parentFolder(path)
    if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1)
  }
  let best: string | null = null
  for (const [parent, count] of counts) if (!best || count > counts.get(best)!) best = parent
  return best
}

/** The folders another computer's projects are in, each ending in its separator, so picking one is ready for a name. */
export function projectFolders(paths: readonly string[]): string[] {
  const folders = new Set<string>()
  for (const path of paths) {
    const parent = parentFolder(path)
    if (parent) folders.add(/[\\/]$/.test(parent) ? parent : `${parent}${separatorOf(parent)}`)
  }
  return [...folders].sort((a, b) => a.localeCompare(b))
}

/**
 * The rows for what is typed. On this computer: Start from (empty); a GitHub repository clones, or names a new
 * project; a path adds that folder; a name makes a new project. On another computer only a folder that is already
 * there can be added, by its path; the folders its projects are in are offered as starting points.
 */
export function newProjectRows(text: string, where: { remote: false; parent: string | null } | { remote: true; folders: readonly string[]; computer: string }): RowGroup[] {
  const typed = text.trim()
  if (where.remote) {
    const lower = typed.toLowerCase()
    const folders = where.folders.filter((folder) => folder.toLowerCase().startsWith(lower) && folder.toLowerCase() !== lower)
    const suggestions: RowGroup[] = folders.length > 0 ? [{ label: `Folders with projects on ${where.computer}`, rows: folders.map((path) => ({ kind: 'suggest', path })) }] : []
    if (!typed) return suggestions
    if (!isFolderPath(typed)) return []
    return [{ label: `On ${where.computer}`, rows: [{ kind: 'add-path', path: typed }] }, ...suggestions]
  }
  if (!typed) return [{ label: 'Start from', rows: [{ kind: 'open-folder' }, { kind: 'clone-hint' }, { kind: 'new-hint' }] }]
  const into = (name: string) => (where.parent ? joinFolder(where.parent, name) : null)
  const repository = githubRepository(typed)
  if (repository) {
    const name = repository.split('/')[1]!
    return [
      { label: 'Clone', rows: [{ kind: 'clone', repository, name, destination: into(name) }] },
      { label: 'Or', rows: [{ kind: 'create', name, destination: into(name) }] }
    ]
  }
  if (isFolderPath(typed)) return [{ label: 'Add', rows: [{ kind: 'add-path', path: typed }] }]
  if (/^(?:https?:\/\/|ssh:\/\/|git@)/i.test(typed)) return [{ label: 'Clone', rows: [{ kind: 'not-github' }] }]
  if (isProjectName(typed)) return [{ label: 'New', rows: [{ kind: 'create', name: typed, destination: into(typed) }] }]
  return []
}
