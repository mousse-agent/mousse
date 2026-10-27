import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Directories whose files hold secrets or private request data.
 *
 * On POSIX the mode bits do the work (`0700` here, `0600` on the files). On Windows those bits mean nothing and a
 * new folder inherits its parent's access list, which on many drives lets other accounts read or replace files.
 * `ensurePrivateDirectory` removes the inherited entries and grants the folder to the current account (and
 * SYSTEM) only, with inheritance to what is created inside, including the temporary files of a replacement.
 * It throws when that cannot be done, so a caller never stores a secret where others can read it.
 */

const SYSTEM_SID = '*S-1-5-18'
const restricted = new Set<string>()
let currentSid: string | undefined

function systemExecutable(name: string): string {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  if (!/^[a-z]:[\\/]/i.test(windowsRoot)) throw new Error('Windows system directory must be an absolute local path.')
  const system32 = realpathSync.native(join(windowsRoot, 'System32'))
  const executable = realpathSync.native(join(system32, name))
  if (!executable.toLowerCase().startsWith(system32.toLowerCase())) throw new Error('Windows utility is outside the system directory.')
  return executable
}

function currentUserSid(): string {
  if (currentSid) return currentSid
  const out = execFileSync(systemExecutable('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
  const sid = /"(S-1-[\d-]+)"\s*$/m.exec(out.trim())?.[1]
  if (!sid) throw new Error('Could not read the current Windows account.')
  currentSid = sid
  return sid
}

/** Creates `directory` and makes it private to this account. */
export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') return
  const target = resolve(directory)
  if (restricted.has(target)) return
  if (lstatSync(target).isSymbolicLink()) throw new Error(`Private folder is a link: ${target}`)
  try {
    execFileSync(
      systemExecutable('icacls.exe'),
      [target, '/inheritance:r', '/grant:r', `*${currentUserSid()}:(OI)(CI)F`, `${SYSTEM_SID}:(OI)(CI)F`, '/T', '/Q'],
      { windowsHide: true, stdio: 'pipe', timeout: 30_000 }
    )
  } catch (error) {
    throw new Error(`Cannot make ${target} private to this Windows account.`, { cause: error })
  }
  restricted.add(target)
}
