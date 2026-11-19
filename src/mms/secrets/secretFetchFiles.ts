import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { join } from 'node:path'

/** Only these daemon-created names may be pruned; directory contents are never trusted. */
const responses = new Map<string, { dev: number; ino: number; names: string[] }>()
const same = (a: Pick<Stats, 'dev' | 'ino'>, b: Pick<Stats, 'dev' | 'ino'>): boolean => a.dev === b.dev && a.ino === b.ino

export class SecretFetchFileError extends Error {
  constructor(readonly unsafe = false) {
    super(unsafe
      ? 'The fetch folder changed or is unavailable. The response was not saved; try again after restoring your work folder.'
      : 'The response could not be saved on this computer. Check the available space and folder permissions before retrying.')
  }
}

/** Pin the Linux parent and the new file before writing. Other systems compare the open file and checked directory identities. */
export function saveSecretFetchResponse(scratch: string, bytes: Buffer): string {
  const folder = join(scratch, 'fetches')
  let directoryFd: number | undefined, fileFd: number | undefined
  let created: string | undefined, finished = false
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const expected = join(realpathSync(scratch), 'fetches')
    const checked = lstatSync(folder)
    if (!checked.isDirectory() || checked.isSymbolicLink()) throw new SecretFetchFileError(true)
    // On Windows opening a directory is unsupported. O_EXCL still refuses existing final components,
    // and the newly opened file is compared to its entry inside the checked directory before writing.
    if (process.platform !== 'win32') {
      try {
        directoryFd = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      } catch {
        throw new SecretFetchFileError(true)
      }
      if (!same(fstatSync(directoryFd), checked)) throw new SecretFetchFileError(true)
    }
    const pinned = process.platform === 'linux' ? `/proc/self/fd/${directoryFd}` : folder
    const unchanged = (): boolean => {
      try {
        const current = lstatSync(folder)
        return current.isDirectory() && !current.isSymbolicLink() && same(current, checked)
          && (directoryFd === undefined || same(fstatSync(directoryFd), checked))
          && (process.platform !== 'linux' || realpathSync(pinned) === expected)
      } catch { return false }
    }
    if (!unchanged()) throw new SecretFetchFileError(true)
    const name = randomUUID()
    const file = join(folder, name)
    created = join(pinned, name)
    fileFd = openSync(created, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    const opened = fstatSync(fileFd)
    const entry = lstatSync(created)
    const inCheckedFolder = process.platform === 'linux'
      ? realpathSync(`/proc/self/fd/${fileFd}`) === join(expected, name)
      : same(opened, entry)
    if (!opened.isFile() || !inCheckedFolder || !unchanged()) throw new SecretFetchFileError(true)
    // No pathname resolution after this point can redirect the bytes to another inode.
    writeFileSync(fileFd, bytes)
    finished = true

    // Drop records for ended runs. Nothing is removed from disk while forgetting their names.
    for (const [path, record] of responses) {
      try { if (!same(lstatSync(path), record)) responses.delete(path) }
      catch { responses.delete(path) }
    }
    let record = responses.get(folder)
    if (!record || !same(record, checked)) {
      record = { dev: checked.dev, ino: checked.ino, names: [] }
      responses.set(folder, record)
    }
    record.names.push(name)
    while (record.names.length > 20) {
      if (!unchanged()) throw new SecretFetchFileError(true)
      const old = record.names.shift()!
      try {
        // Linux resolves this against the held directory, even if a bot swaps its path now.
        // unlink removes a replacement symlink itself; it never follows the link's target.
        unlinkSync(join(pinned, old))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return file
  } catch (error) {
    throw error instanceof SecretFetchFileError ? error : new SecretFetchFileError()
  } finally {
    if (fileFd !== undefined) {
      const opened = fstatSync(fileFd)
      closeSync(fileFd)
      if (!finished && created && opened.size === 0) {
        try {
          const entry = lstatSync(created)
          if (entry.isFile() && entry.size === 0 && same(entry, opened)) unlinkSync(created)
        } catch { /* Only our still-empty file is eligible for cleanup. */ }
      }
    }
    if (directoryFd !== undefined) closeSync(directoryFd)
  }
}
