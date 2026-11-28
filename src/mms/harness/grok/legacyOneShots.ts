import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { removeTree } from '../oneShot/places'

/**
 * What Grok's older single-request route left behind. Before requests ran in places, each Grok single request ran as a
 * headless `grok` in `<profile>/harness/<entry>/one-shot/<request id>/`: `home/` (Mousse's `config.toml` and whatever
 * Grok wrote there), an empty `user/` and `cwd/`, and `prompt.txt`. It removed that folder when the request ended; a
 * crash or a kill left it. That route recorded no process, so a leftover can only be told ended by its age.
 *
 * The sweep (`sweepLegacyGrokOneShots`) removes a folder only when all of this holds:
 * - its name is a request id, and it and its `one-shot` folder are real folders, not links or junctions;
 * - it holds nothing but those four names, and its `home/config.toml` is the one that route wrote (its first line);
 * - it and everything directly in it are older than {@link GROK_LEFTOVER_AGE_MS}.
 * Removal never follows a link or junction inside it (`removeTree`): a link is removed itself, its target kept.
 */

/** A request id: what `randomUUID` gives. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The names the old route created in a request's folder. */
const LEGACY_NAMES = new Set(['home', 'user', 'cwd', 'prompt.txt'])

/** The first line of the `config.toml` the old route wrote into a request's home. */
const LEGACY_CONFIG_HEADER = '# Written by Mousse for one request with no tools.'

/** A request folder this old ended: the old route stopped a request within minutes. */
export const GROK_LEFTOVER_AGE_MS = 30 * 60_000

function names(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

function realFolder(path: string): boolean {
  try {
    const stats = lstatSync(path)
    return stats.isDirectory() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

/** Whether `folder` is clearly one the old route made, and old enough to have ended. */
function legacyLeftover(folder: string, now: number): boolean {
  if (!realFolder(folder)) return false
  const inside = names(folder)
  if (!inside.length || !inside.every((name) => LEGACY_NAMES.has(name))) return false
  const config = join(folder, 'home', 'config.toml')
  try {
    const stats = lstatSync(config)
    if (!stats.isFile() || stats.isSymbolicLink()) return false
    if (readFileSync(config, 'utf8').split(/\r?\n/, 1)[0] !== LEGACY_CONFIG_HEADER) return false
  } catch {
    return false
  }
  for (const path of [folder, ...inside.map((name) => join(folder, name))]) {
    try {
      if (now - lstatSync(path).mtimeMs < GROK_LEFTOVER_AGE_MS) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Removes the old Grok route's leftovers in every entry's folder under `<profileHome>/harness`, by the rules above.
 * Anything else is left. Runs in the places sweep (`schedulePlaceSweep`), never on the start path.
 */
export function sweepLegacyGrokOneShots(profileHome: string, now = Date.now()): void {
  const harness = join(profileHome, 'harness')
  for (const entry of names(harness)) {
    const root = join(harness, entry, 'one-shot')
    if (!realFolder(join(harness, entry)) || !realFolder(root)) continue
    for (const id of names(root)) {
      if (!REQUEST_ID.test(id)) continue
      const folder = join(root, id)
      if (!legacyLeftover(folder, now)) continue
      try {
        removeTree(folder)
      } catch {
        // Changed while it was removed, or still held: the next sweep.
      }
    }
  }
}
