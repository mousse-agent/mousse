import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * Whether a read the agent asks about can be answered without asking anyone: the path it names is confined to the
 * turn's folder, checked when Mousse answers (never cached, so a path that changes is checked again on its next
 * request). Refused (the person is asked) unless every rule holds:
 * - the path is the folder or inside it, written relative to the folder or as an absolute path on the folder's drive
 *   (Windows: no drive-relative `C:x`, root-relative `\x`, UNC or device form, and no other drive);
 * - it exists, and neither it nor any folder between the turn's folder and it is a link or a junction;
 * - its real path is inside the folder's real path;
 * - for a search that walks folders, no link or junction sits anywhere under its root, within a bounded walk
 *   (`WALK_ENTRY_LIMIT` entries): a tree too large to walk asks.
 * What stays open: the agent reads after Mousse answers, so a link put in place between the answer and the read is not
 * seen.
 */

/** A recursive search over more entries than this asks: Mousse does not walk a whole large tree to answer it. */
export const WALK_ENTRY_LIMIT = 20_000

/** The confined real path of `target` (relative to `cwd` or absolute), or undefined when the read must ask. */
export function confinedPath(cwd: string, target: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const lib = platform === 'win32' ? path.win32 : path.posix
  if (!target || target.includes('\0')) return undefined
  if (platform === 'win32') {
    // Drive-relative (`C:x`), root-relative (`\x`), UNC and device paths (`\\server`, `\\?\`) are never confined.
    if (/^[A-Za-z]:(?![\\/])/.test(target) || /^[\\/]/.test(target)) return undefined
  }
  const resolved = lib.resolve(cwd, target)
  if (platform === 'win32' && lib.parse(resolved).root.toLowerCase() !== lib.parse(lib.resolve(cwd)).root.toLowerCase()) return undefined
  const rel = lib.relative(lib.resolve(cwd), resolved)
  if (rel === '..' || rel.startsWith(`..${lib.sep}`) || lib.isAbsolute(rel)) return undefined
  // Every step from the folder down to the target: present, and not a link or a junction.
  let current = lib.resolve(cwd)
  for (const part of rel ? rel.split(lib.sep) : []) {
    current = lib.join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) return undefined
    } catch {
      return undefined
    }
  }
  let real: string
  let root: string
  try {
    real = realpathSync.native(resolved)
    root = realpathSync.native(cwd)
  } catch {
    return undefined
  }
  const realRel = lib.relative(root, real)
  const same = platform === 'win32' ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b
  if (realRel === '..' || realRel.startsWith(`..${lib.sep}`) || lib.isAbsolute(realRel)) return undefined
  if (!same(lib.join(root, realRel), real)) return undefined
  return real
}

/** Whether no link or junction sits under `root` (a confined folder), within `WALK_ENTRY_LIMIT` entries. */
export function linkFreeTree(root: string, limit = WALK_ENTRY_LIMIT): boolean {
  let seen = 0
  const pending = [root]
  while (pending.length) {
    const folder = pending.pop()!
    let entries
    try {
      entries = readdirSync(folder, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      if (++seen > limit) return false
      if (entry.isSymbolicLink()) return false
      if (entry.isDirectory()) {
        const child = path.join(folder, entry.name)
        // `readdir` may not tell a junction from a folder: ask the file itself.
        try {
          if (lstatSync(child).isSymbolicLink()) return false
        } catch {
          return false
        }
        pending.push(child)
      }
    }
  }
  return true
}

/** A read of one file or one folder's names: confined when its path is. */
export function confinedRead(cwd: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  return confinedPath(cwd, target, platform) !== undefined
}

/** A search: confined when its root is, and a folder root has no link anywhere under it. */
export function confinedSearch(cwd: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const real = confinedPath(cwd, target, platform)
  if (real === undefined) return false
  try {
    return lstatSync(real).isDirectory() ? linkFreeTree(real) : true
  } catch {
    return false
  }
}
