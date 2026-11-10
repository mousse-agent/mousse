import { win32 } from 'node:path'

/**
 * The path to give SQLite (`new DatabaseSync`) for a database file. On Windows, SQLite cannot open a file whose
 * path, with the `-journal` it may add, reaches 260 characters, even when Windows long paths are enabled. A thread's
 * database sits deep in the Mousse home (`profiles/<id>/thread-data/repositories/<id>/<id>/`), and its temporary
 * names are longer still, so a long home path (a dev home inside a worktree) put it past that. A `\\?\` path has no
 * such limit. Every path gets it on Windows, not just long ones, so all connections to one file use the same name.
 * Other platforms get the path unchanged.
 */
export function sqliteFilePath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || path === '' || path === ':memory:' || path.startsWith('file:')) return path
  return win32.toNamespacedPath(win32.resolve(path))
}
