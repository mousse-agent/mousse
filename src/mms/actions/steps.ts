import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync, type Stats } from 'node:fs'
import { access, copyFile, lstat, mkdir, open, readdir, readFile, readlink, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'

/**
 * Code that reads and changes a folder through Git and the disk, written once and run two ways. Each call that can
 * wait on the folder's volume is a step that knows how to answer itself at once ({@link runSync}, for callers that
 * cannot wait yet) and without blocking the daemon ({@link runAsync}). Both runners take the same steps in the same
 * order and hand back the same answers and errors, so the code behaves the same either way: only whether the daemon
 * waits differs.
 *
 * A function written this way is a generator: it `yield*`s each step (`yield* gitStep(...)`) and returns its
 * result. A failed step throws inside the generator, where `try`, `catch` and `finally` work as usual.
 */
export interface Step {
  sync(): unknown
  async(): Promise<unknown>
}

export type Steps<T> = Generator<Step, T, unknown>

/** One step: `sync` answers at once, `async` without blocking, with the same answer. */
export function* step<T>(sync: () => T, async: () => Promise<T>): Steps<T> {
  return (yield { sync, async }) as T
}

/** Runs `steps` answering each at once. */
export function runSync<T>(steps: Steps<T>): T {
  let next = steps.next()
  while (!next.done) {
    let answer: unknown
    try {
      answer = next.value.sync()
    } catch (error) {
      next = steps.throw(error)
      continue
    }
    next = steps.next(answer)
  }
  return next.value
}

/** Runs `steps` without blocking the daemon: each step's answer is awaited. */
export async function runAsync<T>(steps: Steps<T>): Promise<T> {
  let next = steps.next()
  while (!next.done) {
    let answer: unknown
    try {
      answer = await next.value.async()
    } catch (error) {
      next = steps.throw(error)
      continue
    }
    next = steps.next(answer)
  }
  return next.value
}

/** The disk, as steps. Each answers as the synchronous call it stands for. */
export const files = {
  /** `existsSync`: anything there that can be reached. */
  exists: (path: string): Steps<boolean> => step(() => existsSync(path), () => access(path).then(() => true, () => false)),
  lstat: (path: string): Steps<Stats> => step(() => lstatSync(path), () => lstat(path)),
  readdir: (path: string): Steps<string[]> => step(() => readdirSync(path), () => readdir(path)),
  readText: (path: string): Steps<string> => step(() => readFileSync(path, 'utf8'), () => readFile(path, 'utf8')),
  readBytes: (path: string): Steps<Buffer> => step(() => readFileSync(path), () => readFile(path)),
  readlink: (path: string): Steps<string> => step(() => readlinkSync(path), () => readlink(path)),
  /** `realpathSync.native`, which `fs/promises`' `realpath` answers like. */
  realpathNative: (path: string): Steps<string> => step(() => realpathSync.native(path), () => realpath(path)),
  mkdir: (path: string): Steps<void> => step(() => { mkdirSync(path, { recursive: true }) }, async () => { await mkdir(path, { recursive: true }) }),
  /** Removes a file, if it is there. */
  remove: (path: string): Steps<void> => step(() => rmSync(path, { force: true }), () => rm(path, { force: true })),
  copyFile: (from: string, to: string): Steps<void> => step(() => copyFileSync(from, to), () => copyFile(from, to)),
  /** The first `bytes` of a file, or fewer when it is shorter. */
  readHead: (path: string, bytes: number): Steps<Buffer> => step(() => {
    const fd = openSync(path, 'r')
    try { const buffer = Buffer.alloc(bytes); return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0)) } finally { closeSync(fd) }
  }, async () => {
    const handle = await open(path, 'r')
    try { const buffer = Buffer.alloc(bytes); return buffer.subarray(0, (await handle.read(buffer, 0, bytes, 0)).bytesRead) } finally { await handle.close() }
  }),
  /** Gives `to` the access and modification times of `from`. */
  copyTimes: (from: string, to: string): Steps<void> => step(() => { const at = statSync(from); utimesSync(to, at.atime, at.mtime) }, async () => { const at = await stat(from); await utimes(to, at.atime, at.mtime) }),
  writeText: (path: string, text: string): Steps<void> => step(() => writeFileSync(path, text), () => writeFile(path, text))
}
