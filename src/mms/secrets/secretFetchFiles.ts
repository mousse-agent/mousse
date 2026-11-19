import { saveSecretFetchAtCwd } from './secretFetchFileWorker'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { join } from 'node:path'

/** Only these daemon-created names may be pruned; directory contents are never trusted. */
const responses = new Map<string, { dev: number; ino: number; names: string[] }>()
const same = (a: Pick<Stats, 'dev' | 'ino'>, b: Pick<Stats, 'dev' | 'ino'>): boolean =>
  a.dev === b.dev && a.ino === b.ino

export class SecretFetchFileError extends Error {
  constructor(readonly unsafe = false) {
    super(
      unsafe
        ? 'The fetch folder changed or is unavailable. The response was not saved; try again after restoring your work folder.'
        : 'The response could not be saved on this computer. Check the available space and folder permissions before retrying.'
    )
  }
}

/** Pin the parent and new file before writing; Linux uses directory fds, other systems a pinned child cwd. */
export function saveSecretFetchResponse(scratch: string, bytes: Buffer): string {
  const folder = join(scratch, 'fetches')
  let directoryFd: number | undefined, fileFd: number | undefined
  let created: string | undefined,
    finished = false,
    writing = false
  let failure: SecretFetchFileError | undefined
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const expected = join(realpathSync(scratch), 'fetches')
    const checked = lstatSync(folder)
    if (!checked.isDirectory() || checked.isSymbolicLink()) throw new SecretFetchFileError(true)
    // Non-Linux Node cannot locate a file's parent through its fd. A child pins cwd instead;
    // merely comparing the bot-controlled path before/after open would leave another race.
    if (process.platform !== 'linux') {
      let record = responses.get(folder)
      if (!record || !same(record, checked))
        record = { dev: checked.dev, ino: checked.ino, names: [] }
      const name = randomUUID()
      const prune = record.names.slice(0, Math.max(0, record.names.length - 19))
      const result = saveSecretFetchAtCwd({
        folder,
        dev: checked.dev,
        ino: checked.ino,
        name,
        prune,
        bytes
      })
      if (result !== 'saved') throw new SecretFetchFileError(result === 'unsafe')
      record.names = [...record.names.slice(prune.length), name]
      responses.set(folder, record)
      return join(folder, name)
    }
    try {
      directoryFd = openSync(
        folder,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      )
    } catch {
      throw new SecretFetchFileError(true)
    }
    if (!same(fstatSync(directoryFd), checked)) throw new SecretFetchFileError(true)
    const pinned = `/proc/self/fd/${directoryFd}`
    const unchanged = (): boolean => {
      try {
        const current = lstatSync(folder)
        return (
          current.isDirectory() &&
          !current.isSymbolicLink() &&
          same(current, checked) &&
          same(fstatSync(directoryFd!), checked) &&
          realpathSync(pinned) === expected
        )
      } catch {
        return false
      }
    }
    if (!unchanged()) throw new SecretFetchFileError(true)
    const name = randomUUID()
    const file = join(folder, name)
    created = join(pinned, name)
    fileFd = openSync(
      created,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    )
    const opened = fstatSync(fileFd)
    const entry = lstatSync(created)
    const inCheckedFolder =
      same(opened, entry) && realpathSync(`/proc/self/fd/${fileFd}`) === join(expected, name)
    if (!opened.isFile() || !inCheckedFolder || !unchanged()) throw new SecretFetchFileError(true)
    // No pathname resolution after this point can redirect the bytes to another inode.
    writing = true
    writeFileSync(fileFd, bytes)
    if (!unchanged()) throw new SecretFetchFileError(true)

    // Drop records for ended runs. Nothing is removed from disk while forgetting their names.
    for (const [path, record] of responses) {
      try {
        if (!same(lstatSync(path), record)) responses.delete(path)
      } catch {
        responses.delete(path)
      }
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
    finished = true
    return file
  } catch (error) {
    failure =
      error instanceof SecretFetchFileError
        ? error
        : new SecretFetchFileError(
            ['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')
          )
    throw failure
  } finally {
    let closeFailed = false
    if (fileFd !== undefined) {
      let opened: Stats | undefined
      try {
        opened = fstatSync(fileFd)
      } catch {
        closeFailed = true
      }
      try {
        closeSync(fileFd)
      } catch {
        closeFailed = true
      }
      if (!finished && created && opened && (writing || opened.size === 0)) {
        try {
          const entry = lstatSync(created)
          if (entry.isFile() && same(entry, opened) && (writing || entry.size === 0))
            unlinkSync(created)
        } catch {
          /* Only our exclusive inode is eligible; before writing, it must still be empty. */
        }
      }
    }
    if (directoryFd !== undefined) {
      try {
        closeSync(directoryFd)
      } catch {
        closeFailed = true
      }
    }
    if (closeFailed && !failure) throw new SecretFetchFileError()
  }
}
