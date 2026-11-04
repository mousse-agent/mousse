import { createHash } from 'node:crypto'
import { rmdirSync, unlinkSync, type Stats } from 'node:fs'
import { lstat, readdir, rmdir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { assertFoldersUnchanged, assertFrozenEntryUnchanged, identityOf, proveFrozenContentEntryAsync, recordFoldersAboveAsync, type FrozenEntryProof } from '../lifecycle/verifiedDelete'

/**
 * How a Discard removes files: Mousse removes only bytes the kept copy proves it holds, and Git only creates.
 *
 * After `keepCopy`, every entry the discard would remove (the file at a path, a folder standing where HEAD has a file
 * with everything in it, a file or link standing where HEAD needs a folder) is read again and compared with the digest
 * the copy recorded for it ({@link removeProvenAsync}). Each is then removed deepest first, with nothing awaited between
 * its last synchronous check (the folders above it are the ones first seen, and no link; its `lstat` is unchanged) and
 * the `unlink`. An entry that changed after the copy, or appeared since, is left, and so is everything under it and the
 * path that needed it gone. Git then writes HEAD's version only where nothing is ({@link createOnlyAsync}:
 * `checkout-index` without `--force`), so a file saved at an emptied path meanwhile stays as it is too.
 */

/** A discarded path left as it is: something at it changed after the person pressed Discard. */
export interface LeftAsItIs {
  /** The path the discard was for. */
  path: string
  /** What changed: the path itself, a file inside the folder in its place, or a file in the way above it. */
  changed: string
}

/** How a caller runs one of its Git commands with standard input: its exit status and Git's messages. */
export type DiscardGit = (args: string[], input?: string) => Promise<{ status: number | null; stderr: string }>

/** Paths whose entries are walked and proven together. */
const BATCH = 64
/** Paths emptied between two turns of the event loop. */
const UNLINK_BATCH = 256
/** How deep a folder in the way is walked; deeper counts as changed, and stays. */
const MAX_DEPTH = 64

type Planned = { kind: 'file' | 'link'; rel: string; proof: FrozenEntryProof } | { kind: 'directory'; rel: string }

/** What stands at one place the discard empties, proven against the copy. */
interface Victim {
  rel: string
  /** In walk order: every folder before what is in it. */
  entries: Planned[]
  /** The identity of every folder from the repository's top down to and inside the victim. */
  folders: Map<string, string>
  /** The first entry found changed; then nothing of the victim is removed. */
  changed?: string
}

class Changed extends Error {
  constructor(readonly rel: string) { super(`${rel} changed`) }
}

const gone = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')
const absolute = (top: string, rel: string): string => join(top, ...rel.split('/'))

/**
 * What the discard of `path` removes, as a path relative to `top`: for a path HEAD's version goes back at (`write`), the
 * first file or link above it (Git removes it to make the folder), else the path itself. Undefined when nothing is there,
 * or (a path nothing goes back at) when a folder above it is a link or missing, so the file does not stand there.
 */
async function victimOf(top: string, path: string, write: boolean): Promise<string | undefined> {
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
    const above = path.slice(0, slash)
    const stat = await lstat(absolute(top, above)).catch((error: unknown) => { if (gone(error)) return undefined; throw error })
    if (!stat) return undefined
    if (stat.isDirectory()) continue
    return write ? above : undefined
  }
  const stat = await lstat(absolute(top, path)).catch((error: unknown) => { if (gone(error)) return undefined; throw error })
  return stat ? path : undefined
}

/** Walks `rel` by `lstat` (never through a link) and proves each file and link against `digests`. */
async function proveVictim(top: string, rel: string, digests: ReadonlyMap<string, string>): Promise<Victim | undefined> {
  const victim: Victim = { rel, entries: [], folders: new Map() }
  try {
    await recordFoldersAboveAsync(top, absolute(top, rel), victim.folders)
  } catch {
    return { ...victim, changed: rel }
  }
  const visit = async (at: string, stat: Stats, depth: number): Promise<void> => {
    const path = absolute(top, at)
    if (stat.isSymbolicLink() || stat.isFile()) {
      const digest = digests.get(at)
      if (digest === undefined) throw new Changed(at)
      const kind = stat.isSymbolicLink() ? 'link' : 'file'
      let proof: FrozenEntryProof
      try {
        proof = await proveFrozenContentEntryAsync(top, { path: at, kind, digest, bytes: stat.size, mode: stat.mode }, { otherLinks: true })
      } catch {
        throw new Changed(at)
      }
      victim.entries.push({ kind, rel: at, proof })
      return
    }
    if (!stat.isDirectory() || depth > MAX_DEPTH) throw new Changed(at)
    victim.folders.set(resolve(path), identityOf(stat))
    victim.entries.push({ kind: 'directory', rel: at })
    const names = (await readdir(path).catch(() => { throw new Changed(at) })).sort()
    // A repository of its own appeared in the folder since the copy refused one: its history is never removed.
    if (names.includes('.git')) throw new Changed(`${at}/.git`)
    for (const name of names) {
      const inner = `${at}/${name}`
      const innerStat = await lstat(absolute(top, inner)).catch(() => { throw new Changed(inner) })
      await visit(inner, innerStat, depth + 1)
    }
  }
  try {
    const stat = await lstat(absolute(top, rel)).catch((error: unknown) => { if (gone(error)) return undefined; throw new Changed(rel) })
    // Gone since it was looked at: nothing of it is left to remove.
    if (!stat) return undefined
    await visit(rel, stat, 0)
  } catch (error) {
    if (error instanceof Changed) return { ...victim, entries: [], changed: error.rel }
    throw error
  }
  return victim
}

/**
 * Removes what stands at each discarded path, as far as the kept copy holds it (`digests`, the SHA-256 of each working
 * version as `keepCopy` read it). `restore` are paths HEAD's version goes back at: a file or link above one, in the way
 * of its folder, goes too. `remove` are paths nothing goes back at. `cleared` are the paths emptied; `left` the ones left
 * as they are, naming what changed. `beforeUnlink` is a test seam: it runs right before each entry's last check.
 */
export async function removeProvenAsync(input: {
  top: string
  restore: readonly string[]
  remove: readonly string[]
  digests: ReadonlyMap<string, string>
  beforeUnlink?: (path: string) => void
}): Promise<{ cleared: string[]; left: LeftAsItIs[] }> {
  const top = resolve(input.top)
  const writes = new Set(input.restore)
  const paths = [...new Set([...input.restore, ...input.remove])]
  // Which place each path empties: several paths below one file in the way share it.
  const victimFor = new Map<string, string | undefined>()
  for (let start = 0; start < paths.length; start += BATCH) {
    const batch = paths.slice(start, start + BATCH)
    const found = await Promise.all(batch.map((path) => victimOf(top, path, writes.has(path))))
    batch.forEach((path, index) => victimFor.set(path, found[index]))
  }
  // A place inside another (a file in a folder that stands where HEAD has a file) goes with the outer one.
  const found = new Set([...victimFor.values()].filter((rel): rel is string => rel !== undefined))
  const places = [...found].filter((rel) => !under(rel, found))
  for (const [path, rel] of victimFor) if (rel !== undefined && under(rel, found)) victimFor.set(path, places.find((outer) => rel.startsWith(`${outer}/`)))
  const victims = new Map<string, Victim | undefined>()
  for (let start = 0; start < places.length; start += BATCH) {
    const batch = places.slice(start, start + BATCH)
    const proven = await Promise.all(batch.map((rel) => proveVictim(top, rel, input.digests)))
    batch.forEach((rel, index) => victims.set(rel, proven[index]))
  }

  // Deepest first within each place; between the last check of an entry and its removal nothing is awaited.
  let removed = 0
  for (const victim of victims.values()) {
    if (!victim || victim.changed) continue
    for (const entry of [...victim.entries].reverse()) {
      const path = absolute(top, entry.rel)
      input.beforeUnlink?.(path)
      try {
        if (entry.kind === 'directory') {
          assertFoldersUnchanged(top, path, victim.folders)
          rmdirSync(path)
        } else {
          assertFoldersUnchanged(top, dirname(path), victim.folders)
          assertFrozenEntryUnchanged(entry.proof)
          unlinkSync(path)
        }
      } catch {
        // Changed since it was proven, or something new in a folder: it stays, with what is left above it.
        victim.changed = entry.rel
        break
      }
      if (++removed % UNLINK_BATCH === 0) await nextTurn()
    }
  }

  const cleared: string[] = []
  const left: LeftAsItIs[] = []
  for (const path of paths) {
    const place = victimFor.get(path)
    const changed = place === undefined ? undefined : victims.get(place)?.changed
    if (changed === undefined) cleared.push(path)
    else left.push({ path, changed })
  }
  // Like `git clean -d` and `git rm`: a folder a removed path leaves empty goes too.
  await removeEmptiedFolders(top, cleared.filter((path) => !writes.has(path)))
  return { cleared, left }
}

/** Removes the folders above `paths` that are now empty, deepest first; a folder with anything in it stays. */
async function removeEmptiedFolders(top: string, paths: readonly string[]): Promise<void> {
  const root = resolve(top)
  const folders = new Set<string>()
  for (const path of paths) {
    for (let folder = dirname(absolute(root, path)); folder !== root && folder.startsWith(`${root}${sep}`) && !folders.has(folder); folder = dirname(folder)) folders.add(folder)
  }
  for (const folder of [...folders].sort((a, b) => b.split(sep).length - a.split(sep).length)) await rmdir(folder).catch(() => undefined)
}

/** Whether `path` lies inside one of `folders` (paths relative to the top, with `/`). */
function under(path: string, folders: ReadonlySet<string>): boolean {
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) if (folders.has(path.slice(0, slash))) return true
  return false
}

/**
 * Has Git write the index's version of `paths` only where nothing is: `checkout-index` without `--force` leaves an
 * existing file or folder as it is (exit 1). Paths below one of `skipped` are not asked for: a file there stays in the
 * way. A path in the way of another's folder stops a run of many, so then each path is asked for alone. Returns the
 * paths Git did not write.
 */
export async function createOnlyAsync(top: string, paths: readonly string[], run: DiscardGit, skipped: ReadonlySet<string> = new Set()): Promise<string[]> {
  const notWritten = new Set(paths.filter((path) => under(path, skipped)))
  // Something already there, or a file or link in the way of its folder: saved after the path was emptied, it stays.
  for (let start = 0; start < paths.length; start += BATCH) {
    const batch = paths.slice(start, start + BATCH)
    const blocked = await Promise.all(batch.map((path) => notWritten.has(path) || standsInTheWay(top, path)))
    batch.forEach((path, index) => { if (blocked[index]) notWritten.add(path) })
  }
  const asked = paths.filter((path) => !notWritten.has(path))
  if (!asked.length) return paths.filter((path) => notWritten.has(path))
  const existed = new Set<string>()
  const ask = async (batch: readonly string[]): Promise<number | null> => {
    const ran = await run(['checkout-index', '-u', '-z', '--stdin'], `${batch.join('\0')}\0`)
    // `<path> already exists, no checkout`, for each path Git left alone.
    for (const line of ran.stderr.split('\n')) {
      const match = /^(?:git checkout-index: )?(.*) already exists(?:, no checkout)?$/.exec(line.trim())
      if (match) existed.add(match[1]!)
    }
    return ran.status
  }
  const status = await ask(asked)
  // A run that stopped (a folder Git could not make) is finished one path at a time, for the paths still empty.
  if (status !== 0 && status !== 1) {
    for (const path of asked) if (!await exists(top, path)) await ask([path])
  }
  for (const path of asked) if (existed.has(path) || !await exists(top, path)) notWritten.add(path)
  return paths.filter((path) => notWritten.has(path))
}

const exists = (top: string, path: string): Promise<boolean> => lstat(absolute(top, path)).then(() => true, () => false)

/** Whether something stands at `path`, or a file or link stands where a folder above it goes. */
async function standsInTheWay(top: string, path: string): Promise<boolean> {
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
    const stat = await lstat(absolute(top, path.slice(0, slash))).catch(() => undefined)
    if (!stat) return false
    if (!stat.isDirectory()) return true
  }
  return exists(top, path)
}

/**
 * The index's entries (`ls-files -s -z`: mode, object, stage and path) as one digest each, by path: compared before and
 * after the files go, so an entry staged by someone else meanwhile is not reset. Stat data is left out, so Git
 * refreshing the index changes nothing here.
 */
export function stagedEntryDigests(listing: readonly string[]): Map<string, string> {
  const lines = new Map<string, string[]>()
  for (const line of listing) {
    const path = line.slice(line.indexOf('\t') + 1)
    lines.set(path, [...(lines.get(path) ?? []), line])
  }
  return new Map([...lines].map(([path, entries]) => [path, createHash('sha256').update(entries.join('\0')).digest('hex')]))
}

/** The mode of each path's index entry (`ls-files -s -z` lines), by path. */
export function stagedModes(listing: readonly string[]): Map<string, string> {
  return new Map(listing.map((line) => [line.slice(line.indexOf('\t') + 1), line.slice(0, line.indexOf(' '))]))
}

/** The paths whose index entries differ between two {@link stagedEntryDigests}, among `paths`. */
export function stagedSince(before: ReadonlyMap<string, string>, now: ReadonlyMap<string, string>, paths: readonly string[]): string[] {
  return paths.filter((path) => before.get(path) !== now.get(path))
}

/** How many paths a "left as it is" line names before it says "and N more". */
const NAMED = 3

/**
 * The line a result shows for paths a discard left as they are, or undefined when there are none:
 * "base.txt changed after you pressed Discard, so it was left as it is."
 */
export function leftAsItIsText(left: readonly LeftAsItIs[]): string | undefined {
  const paths = [...new Set(left.map((item) => item.path))]
  if (!paths.length) return undefined
  const named = paths.slice(0, NAMED)
  const list = paths.length > NAMED ? `${named.join(', ')} and ${paths.length - NAMED} more` : named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0]!
  return paths.length === 1
    ? `${list} changed after you pressed Discard, so it was left as it is.`
    : `${list} changed after you pressed Discard, so they were left as they are.`
}
