/** What one field in New project can hold, and the rows it offers. */

export type NewProjectRow =
  /** Asks for a folder with the system's folder picker. */
  | { kind: 'open-folder' }
  /** Start from: says what to type for a clone or a new project. */
  | { kind: 'clone-hint' }
  | { kind: 'new-hint' }
  /**
   * Clones a GitHub repository (`owner/name`) into `destination`; null until a folder for new projects is known.
   * `owned` marks one of the signed-in account's repositories, offered from its list.
   */
  | { kind: 'clone'; repository: string; name: string; destination: string | null; owned?: { private: boolean }; branch?: string }
  /** Adding a project to another computer: pick a checkout of it there by browsing, which becomes the project there. */
  | { kind: 'pick-checkout'; name: string }
  /**
   * GitHub is not connected: on this computer Settings → Source control connects it; on another, it connects there from
   * here. The account's repositories then show here.
   */
  | { kind: 'connect-github' }
  /** Browsing another computer's folders for where a clone goes: use the folder shown, or open another. */
  | { kind: 'browse-use'; path: string }
  | { kind: 'browse-open'; name: string; path: string; up?: true }
  /** Makes an empty folder and a Git repository in it. */
  | { kind: 'create'; name: string; destination: string | null }
  /** Adds a folder that is already there, by its path. */
  | { kind: 'add-path'; path: string }
  /** Another computer: a folder its projects are in, which fills the field. */
  | { kind: 'suggest'; path: string }
  /** A repository that is not on GitHub: shown, but it cannot be cloned. */
  | { kind: 'not-github' }
  /** Where a clone or a new project would go is already a project here: it opens with a new thread instead. */
  | { kind: 'existing'; projectId: string; name: string; path: string }

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

/** Whether two paths name the same folder: trailing separators aside, and without case on Windows. */
export function sameFolder(a: string, b: string): boolean {
  const trim = (path: string) => path.trim().replace(/[\\/]+$/, '')
  const [x, y] = [trim(a), trim(b)]
  return /^[A-Za-z]:|\\/.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y
}

/**
 * A clone or a new project whose folder is already a project here becomes that project's row, once: typing its name
 * again opens it rather than offering to make it.
 */
export function withExisting(groups: readonly RowGroup[], projectAt: (path: string) => { id: string; name: string; path: string } | undefined): RowGroup[] {
  const seen = new Set<string>()
  return groups
    .map((group) => ({
      label: group.label,
      rows: group.rows.flatMap((row): NewProjectRow[] => {
        if ((row.kind !== 'clone' && row.kind !== 'create') || !row.destination) return [row]
        const project = projectAt(row.destination)
        if (!project) return [row]
        if (seen.has(project.id)) return []
        seen.add(project.id)
        return [{ kind: 'existing', projectId: project.id, name: project.name, path: project.path }]
      })
    }))
    .filter((group) => group.rows.length > 0)
    .map((group) => (group.rows.every((row) => row.kind === 'existing') ? { ...group, label: 'Open' } : group))
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
 * The account's repositories that match what is typed, best first: a name that starts with it, then `owner/name`
 * that does, then one that contains it. With nothing typed, the most recently pushed. The repository the text itself
 * names is left out: its own Clone row is already there.
 */
export function repositoryMatches<T extends { nameWithOwner: string }>(text: string, repositories: readonly T[], limit = 6): T[] {
  const typed = text.trim().toLowerCase()
  if (!typed) return repositories.slice(0, limit)
  const named = githubRepository(typed)?.toLowerCase()
  const scored: { repository: T; score: number }[] = []
  for (const repository of repositories) {
    const full = repository.nameWithOwner.toLowerCase()
    if (full === named) continue
    const name = full.slice(full.indexOf('/') + 1)
    const score = name.startsWith(typed) ? 3 : full.startsWith(typed) ? 2 : full.includes(typed) ? 1 : 0
    if (score > 0) scored.push({ repository, score })
  }
  // Stable: among equal scores the list's own order (most recently pushed) holds.
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((entry) => entry.repository)
}

/**
 * New project on this computer with the account's repositories: the ones that match what is typed, as Clone rows
 * into the projects folder. After "Clone a repository…" (`cloning`) they come first and, with nothing typed, show
 * the most recent; otherwise they follow the other rows and show only once something matches. When GitHub is not
 * connected, "Clone a repository…" offers to connect it instead.
 */
export function withRepositories(
  groups: readonly RowGroup[],
  text: string,
  options: { repositories: readonly { nameWithOwner: string; private: boolean }[]; parent: string | null; cloning: boolean; connected: boolean | null }
): RowGroup[] {
  const typed = text.trim()
  if (isFolderPath(typed) || (!typed && !options.cloning)) return [...groups]
  let group: RowGroup | null = null
  if (options.connected === false) {
    // Clone a repository… with nothing typed, or a repository typed: its clone needs GitHub connected.
    if ((options.cloning && !typed) || githubRepository(typed)) group = { label: 'GitHub', rows: [{ kind: 'connect-github' }] }
  } else {
    const matches = repositoryMatches(typed, options.repositories, options.cloning && !typed ? 8 : 5)
    if (matches.length > 0) {
      group = {
        label: 'Your repositories',
        rows: matches.map((repository) => {
          const name = repository.nameWithOwner.split('/')[1]!
          return { kind: 'clone', repository: repository.nameWithOwner, name, destination: options.parent ? joinFolder(options.parent, name) : null, owned: { private: repository.private } }
        })
      }
    }
  }
  if (!group) return [...groups]
  return options.cloning ? [group, ...groups] : [...groups, group]
}

/**
 * The rows for what is typed. On this computer: Start from (empty); a GitHub repository clones, or names a new
 * project; a path adds that folder; a name makes a new project. On another computer only a folder that is already
 * there can be added, by its path; the folders its projects are in are offered as starting points.
 */
export function newProjectRows(text: string, where: { remote: false; parent: string | null } | { remote: true; folders: readonly string[]; computer: string; parent?: string | null }): RowGroup[] {
  const typed = text.trim()
  const into = (name: string) => (where.parent ? joinFolder(where.parent, name) : null)
  if (where.remote) {
    const lower = typed.toLowerCase()
    const folders = where.folders.filter((folder) => folder.toLowerCase().startsWith(lower) && folder.toLowerCase() !== lower)
    const suggestions: RowGroup[] = folders.length > 0 ? [{ label: `Folders with projects on ${where.computer}`, rows: folders.map((path) => ({ kind: 'suggest', path })) }] : []
    if (!typed) return [{ label: 'Start from', rows: [{ kind: 'clone-hint' }] }, ...suggestions]
    const repository = githubRepository(typed)
    if (repository) {
      const name = repository.split('/')[1]!
      return [{ label: `Clone on ${where.computer}`, rows: [{ kind: 'clone', repository, name, destination: into(name) }] }]
    }
    if (!isFolderPath(typed)) return []
    return [{ label: `On ${where.computer}`, rows: [{ kind: 'add-path', path: typed }] }, ...suggestions]
  }
  if (!typed) return [{ label: 'Start from', rows: [{ kind: 'open-folder' }, { kind: 'clone-hint' }, { kind: 'new-hint' }] }]
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

/**
 * The rows of the folder browser: Use this folder (once a folder is shown), the folder above it, then the folders in it
 * that match what is typed.
 */
export function browseRows(view: { path: string | null; parent: string | null; folders: readonly { name: string; path: string }[] }, text: string, computer: string): RowGroup[] {
  const typed = text.trim().toLowerCase()
  const rows: NewProjectRow[] = []
  if (view.path) rows.push({ kind: 'browse-use', path: view.path })
  if (view.parent && !typed) rows.push({ kind: 'browse-open', name: '..', path: view.parent, up: true })
  for (const folder of view.folders) if (!typed || folder.name.toLowerCase().includes(typed)) rows.push({ kind: 'browse-open', name: folder.name, path: folder.path })
  return [{ label: view.path ?? `Folders on ${computer}`, rows }]
}

/** A project of this computer that another computer is asked to have: what is known of it here. */
export interface AddToComputer {
  name: string
  computer: string
  /** Its GitHub repository (`owner/name`); without one it can only be picked from a folder there. */
  repository?: string
  /** The branch its checkout here is on; a clone there checks it out when GitHub has it. */
  branch?: string
  /** Where clones go on that computer, when known. */
  parent: string | null
  /** That computer's projects that look like this one (`sameAs`, `similarTo`). */
  matches: readonly { id: string; name: string; path: string }[]
}

/**
 * Adding a project to another computer: its checkouts there that are already projects, a clone of its GitHub
 * repository there (on the same branch), and a folder there picked by browsing, for a checkout that is not a project yet.
 */
export function addToComputerRows(add: AddToComputer): RowGroup[] {
  const groups: RowGroup[] = []
  if (add.matches.length > 0) {
    groups.push({ label: `On ${add.computer}`, rows: add.matches.map((project) => ({ kind: 'existing', projectId: project.id, name: project.name, path: project.path })) })
  }
  if (add.repository) {
    const name = add.repository.split('/')[1]!
    groups.push({
      label: `Clone on ${add.computer}`,
      rows: [{ kind: 'clone', repository: add.repository, name, destination: add.parent ? joinFolder(add.parent, name) : null, ...(add.branch ? { branch: add.branch } : {}) }]
    })
  }
  groups.push({ label: add.repository ? 'Already there' : `On ${add.computer}`, rows: [{ kind: 'pick-checkout', name: add.name }] })
  return groups
}
