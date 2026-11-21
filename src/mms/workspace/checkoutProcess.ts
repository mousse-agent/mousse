import { lstatSync } from 'node:fs'
import { lstat, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { gitCancellationScope, type GitProcessObserver } from '../git/runGitProcess'
import { anchoredTree, readProcessEntries } from '../git/stoppedGitTree'
import type { WorktreeGit } from '../worktree/worktreeCheckout'

type CheckoutWriter = { kind: 'starting' } | { kind: 'running'; pid: number; at: number } | { kind: 'stopped'; at: number }

/** The operation, Git administration directory identity and most recent Git writer survive a daemon exit. */
export interface CheckoutProcessRecord {
  operationId: string
  registration?: { adminDir: string; identity: string }
  writer?: CheckoutWriter
}

function checkoutProcessPath(directory: string): string {
  return join(directory, 'workspace-checkout.json')
}

export async function checkoutProcessRecordAbsent(directory: string): Promise<boolean> {
  return lstat(checkoutProcessPath(directory)).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
}

export function saveCheckoutProcess(directory: string, record: CheckoutProcessRecord): void {
  atomicWriteJsonSync(checkoutProcessPath(directory), record)
}

export async function readCheckoutProcess(directory: string, operationId: string): Promise<CheckoutProcessRecord | undefined> {
  try {
    const record = JSON.parse(await readFile(checkoutProcessPath(directory), 'utf8')) as CheckoutProcessRecord
    if (record.operationId !== operationId) return undefined
    const writer = record.writer
    if (writer && writer.kind !== 'starting' && !(Number.isFinite(writer.at) &&
      (writer.kind === 'stopped' || writer.kind === 'running' && Number.isSafeInteger(writer.pid) && writer.pid > 0))) return undefined
    return record
  } catch { return undefined }
}

export async function checkoutRegistrationIdentity(adminDir: string): Promise<string> {
  const entry = await lstat(adminDir, { bigint: true })
  if (!entry.isDirectory()) throw new Error('The worktree registration is no longer a directory.')
  return JSON.stringify([adminDir, String(entry.dev), String(entry.ino), String(entry.birthtimeNs)])
}

/** A gap between spawning and recording the PID, or an unreadable process table, keeps the registration intact. */
export async function checkoutWriterGone(record: CheckoutProcessRecord): Promise<boolean> {
  const writer = record.writer
  if (!writer || writer.kind === 'stopped') return true
  if (writer.kind !== 'running' || !Number.isSafeInteger(writer.pid) || writer.pid <= 0 || !Number.isFinite(writer.at)) return false
  const table = await readProcessEntries()
  if (!table || table.some((entry) => entry.pid === writer.pid && !entry.zombie)) return false
  const tree = anchoredTree(table, writer.pid, writer.at)
  return !table.some((entry) => !entry.zombie && (tree.has(entry.pid) ||
    // Windows preserves the parent PID when the parent exits. A child's start time can rule out an older parent.
    process.platform === 'win32' && entry.ppid === writer.pid && (entry.startedMs === undefined || entry.startedMs >= writer.at - 2000)))
}

export async function recoverCheckoutIndex(adminDir: string, record: CheckoutProcessRecord): Promise<boolean> {
  if (record.registration?.identity !== await checkoutRegistrationIdentity(adminDir) || !await checkoutWriterGone(record)) return false
  // Git owns this lock namespace. The current lock can belong to a different process, regardless of its age.
  return lstat(join(adminDir, 'index.lock')).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
}

/** The lock files a checkout writer takes in the worktree's own Git directory (`sparse-checkout set`, then `checkout`). */
const WRITER_LOCKS = ['index.lock', join('info', 'sparse-checkout.lock'), 'config.worktree.lock']

/**
 * A stopped Git cannot remove its lock files. Called once the stopped writer and its descendants have exited: no lock
 * was there when it started (`beforeSpawn`), and the thread's lease and the disk slot kept every other Mousse writer out.
 */
async function removeStoppedWriterLocks(adminDir: string): Promise<void> {
  for (const lock of WRITER_LOCKS) {
    await unlink(join(adminDir, lock)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
  }
}

/**
 * A checkout stopped before Git wrote the worktree's index leaves the files it already wrote untracked, and Git
 * refuses to write over them. Removes those whose content Git reads as exactly the commit's, so the checkout can start
 * again. A file with other content stays, and the checkout keeps refusing.
 */
export async function clearUnindexedCheckoutFiles(worktreePath: string, adminDir: string, git: (args: string[], input?: string) => Promise<string>): Promise<void> {
  if (await lstat(join(adminDir, 'index')).then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT')) return
  const written: Array<{ path: string; oid: string }> = []
  for (const entry of (await git(['ls-tree', '-r', '-z', '--full-tree', 'HEAD'])).split('\0')) {
    const match = /^\d+ blob (\w+)\t([^\n]+)$/.exec(entry)
    if (!match) continue
    const file = await lstat(join(worktreePath, match[2]!)).catch(() => undefined)
    if (file?.isFile()) written.push({ path: match[2]!, oid: match[1]! })
  }
  if (!written.length) return
  const oids = (await git(['hash-object', '--stdin-paths'], written.map((file) => file.path).join('\n') + '\n')).split(/\r?\n/)
  for (const [i, file] of written.entries()) {
    if (oids[i] === file.oid) await unlink(join(worktreePath, file.path))
  }
}

/** Record each command before spawn and keep the writer fenced until its process tree has settled. */
export function trackCheckoutGit(directory: string, record: CheckoutProcessRecord, git: WorktreeGit, signal?: AbortSignal): WorktreeGit {
  return async (cwd, args, input) => {
    const setWriter = (writer: CheckoutWriter | undefined): void => {
      const next = { ...record, writer }
      saveCheckoutProcess(directory, next)
      record.writer = writer
    }
    // The checkout slot stopped this writer and saw it and its descendants exit. The slot process itself, the recorded
    // PID, is still alive until the slot is let go.
    let stopped = false
    const observer: GitProcessObserver = {
      beforeSpawn: () => {
        const adminDir = record.registration?.adminDir
        if (adminDir && WRITER_LOCKS.some((lock) => lstatSync(join(adminDir, lock), { throwIfNoEntry: false }))) {
          throw new Error('The worktree index is already locked.')
        }
        setWriter({ kind: 'starting' })
      },
      spawned: (pid, at) => setWriter({ kind: 'running', pid, at }),
      stopped: () => { stopped = true }
    }
    const scope = signal ? gitCancellationScope(signal) : undefined
    let succeeded = false
    try {
      const work = () => git(cwd, args, input, observer)
      const result = await (scope?.run(work) ?? work())
      succeeded = true
      return result
    } finally {
      await scope?.survivorsGone()
      const writer = record.writer
      if (succeeded && record.writer) setWriter(undefined)
      else if (writer?.kind === 'running' && (stopped || await checkoutWriterGone(record))) {
        // A Git that failed by itself removed its own locks. One the slot stopped could not.
        if (stopped && record.registration) {
          await removeStoppedWriterLocks(record.registration.adminDir).catch((error: unknown) => {
            console.warn('[worktree] a stopped checkout left a Git lock file', { error: error instanceof Error ? error.message : String(error) })
          })
        }
        setWriter({ kind: 'stopped', at: writer.at })
      }
    }
  }
}
