import type { FileEntry } from '../../shared/types'

/** One folder's listing in the Files tree. The tree's own folder is the path ''. */
export interface FolderListing {
  entries: FileEntry[] | null
  /** Shows a loader in place of the entries: a first read or a Retry, not a background refresh. */
  loading: boolean
  error: string | null
}

export type FileTreeRow =
  | { kind: 'entry'; key: string; entry: FileEntry; depth: number; expanded: boolean }
  | { kind: 'loading'; key: string; name: string; depth: number }
  | { kind: 'error'; key: string; path: string; depth: number; message: string }

type ListFolder = (path: string) => Promise<FileEntry[]>

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * What the Files tree needs to come back exactly as it was: its folder listings, open folders and scroll offset.
 * It outlives the tree's components, which unmount while the panel is closed or another tab shows.
 */
export class FileTreeMemory {
  readonly folders = new Map<string, FolderListing>()
  readonly expanded = new Set<string>()
  scrollTop = 0
  /** A row the tree should scroll into its drawn rows and focus (a tree path), until it has. */
  focusRequest: string | null = null
  private version = 0
  private readonly listeners = new Set<() => void>()
  private readonly reads = new Map<string, number>()
  private rowsCache: { version: number; rows: FileTreeRow[] } | null = null

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getVersion = () => this.version

  private changed() {
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  root(): FolderListing | undefined {
    return this.folders.get('')
  }

  /**
   * Reads a folder. A quiet read keeps what is shown until the new listing arrives (the panel reopening, Refresh);
   * otherwise a loader stands in. Only the latest read of a folder is kept.
   */
  load(path: string, list: ListFolder, quiet = false): Promise<void> {
    const read = (this.reads.get(path) ?? 0) + 1
    this.reads.set(path, read)
    const previous = this.folders.get(path)
    const showLoader = !quiet || !previous?.entries
    if (showLoader) {
      this.folders.set(path, { entries: previous?.entries ?? null, loading: true, error: null })
      this.changed()
    }
    return list(path).then(
      (entries) => {
        if (this.reads.get(path) !== read) return
        this.folders.set(path, { entries, loading: false, error: null })
        this.changed()
      },
      (error: unknown) => {
        if (this.reads.get(path) !== read) return
        this.folders.set(path, { entries: null, loading: false, error: errorText(error) })
        this.changed()
      }
    )
  }

  /** Reads the tree's folder and every open folder again, keeping the rows on screen meanwhile. */
  refresh(list: ListFolder): Promise<void> {
    const open = [...this.expanded].filter((path) => this.folders.get(path)?.entries)
    return Promise.all([this.load('', list, true), ...open.map((path) => this.load(path, list, true))]).then(() => undefined)
  }

  /** The row's place in the flattened tree, or -1 when it is not shown (not listed, or in a closed folder). */
  indexOf(path: string): number {
    return this.rows().findIndex((row) => row.kind === 'entry' && row.entry.path === path)
  }

  /** Asks the tree to bring a shown row on screen and focus it. False when the row is not in the tree. */
  requestFocus(path: string): boolean {
    if (this.indexOf(path) < 0) return false
    this.focusRequest = path
    this.changed()
    return true
  }

  toggle(path: string, list: ListFolder) {
    if (this.expanded.has(path)) this.expanded.delete(path)
    else {
      this.expanded.add(path)
      const listing = this.folders.get(path)
      if (!listing || (!listing.entries && !listing.loading && !listing.error)) void this.load(path, list)
    }
    this.changed()
  }

  /** The tree as a flat list of rows: entries, and a loader or error row under an open folder still being read. */
  rows(): FileTreeRow[] {
    if (this.rowsCache?.version === this.version) return this.rowsCache.rows
    const rows: FileTreeRow[] = []
    const walk = (path: string, depth: number) => {
      for (const entry of this.folders.get(path)?.entries ?? []) {
        const expanded = entry.kind === 'directory' && this.expanded.has(entry.path)
        rows.push({ kind: 'entry', key: entry.path, entry, depth, expanded })
        if (!expanded) continue
        const listing = this.folders.get(entry.path)
        if (!listing || listing.loading) rows.push({ kind: 'loading', key: `${entry.path}\0loading`, name: entry.name, depth: depth + 1 })
        else if (listing.error !== null) rows.push({ kind: 'error', key: `${entry.path}\0error`, path: entry.path, depth: depth + 1, message: listing.error })
        else walk(entry.path, depth + 1)
      }
    }
    walk('', 0)
    this.rowsCache = { version: this.version, rows }
    return rows
  }
}

/** Keeps the trees of the last few folders and threads, so going back to one restores it; older ones are dropped. */
export class FileTreeMemories {
  private readonly trees = new Map<string, FileTreeMemory>()
  constructor(private readonly limit = 12) {}

  get(key: string): FileTreeMemory {
    const tree = this.trees.get(key) ?? new FileTreeMemory()
    this.trees.delete(key)
    this.trees.set(key, tree)
    while (this.trees.size > this.limit) this.trees.delete(this.trees.keys().next().value!)
    return tree
  }
}
