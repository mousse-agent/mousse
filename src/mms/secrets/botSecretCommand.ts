import { existsSync, lstatSync, readlinkSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { LINUX_RUN_KEPT_OPEN, LINUX_SYSTEM_FOLDERS } from '../harness/linuxFolders'
import { lockedEnv } from '../harness/env'

/**
 * How a personal bot's `secret_run` runs (bot/thread parity, the bot's "use secrets you give it"). A thread's agent runs
 * its secret command as its own commands run. A bot's commands run inside its runtime (Claude Code's sandbox, Codex's
 * profile, Pi's bash), which Mousse can't run a command in from the service, so a bot's secret command runs as the bot's
 * background commands do (`watch_start`), never with the service's environment. It needs "run commands", so it never
 * reaches more than the owner allowed that bot's commands:
 *
 * - **Environment.** The bot's locked command environment (`lockedEnv`, as a Pi bot's commands and its background
 *   commands get: the platform's own variables and proxies, `TMPDIR` in its scratch folder), plus only the secrets the
 *   call names. No ambient credential or other variable of the owner's comes through.
 * - **Folders and network, where Mousse has a sandbox** (Linux with bubblewrap): the system's own folders read-only
 *   (`LINUX_SYSTEM_FOLDERS`, as Claude Code's sandbox opens them), the bot's files and scratch folders writable, a private
 *   `/tmp`, nothing else (no home folder, `/mnt`, `/media`, `/opt`, `/var`, `/run`), no network, and its own process
 *   namespace.
 * - **Elsewhere** (Windows, macOS, Linux without bubblewrap): as the bot's other commands run there, in a shell from its
 *   files folder, in its own process group where there is one, reaching what the owner's account can (docs/bots.md,
 *   "Where commands aren't held").
 */
export type BotSecretContainment =
  | { sandbox: 'bubblewrap'; program: string; args(command: string, input: { cwd: string; writable: readonly string[]; readOnly: readonly string[] }): string[] }
  | { sandbox: 'none' }

/** The bubblewrap program on `path`, else undefined. */
export function findBubblewrap(path = process.env.PATH ?? '', exists: (file: string) => boolean = isFile): string | undefined {
  for (const folder of ['/usr/bin', '/bin', ...path.split(delimiter)]) {
    if (!folder) continue
    const candidate = join(folder, 'bwrap')
    if (exists(candidate)) return candidate
  }
  return undefined
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** How this computer holds a bot's secret command (`BotSecretContainment`): bubblewrap on Linux where it can run. */
export function botSecretContainment(platform: NodeJS.Platform = process.platform, find: () => string | undefined = findBubblewrap): BotSecretContainment {
  const bubblewrap = platform === 'linux' ? find() : undefined
  if (!bubblewrap) return { sandbox: 'none' }
  return { sandbox: 'bubblewrap', program: bubblewrap, args: (command, input) => bubblewrapArgs(command, input) }
}

/**
 * bubblewrap's arguments for one command: the system's own folders read-only (a symbolic link such as `/bin` →
 * `usr/bin` stays a link), `/proc`, `/dev` and a private `/tmp`, `writable` bound read-write and `readOnly` (the private
 * folder of its secret files) read-only, run from `cwd` in new network, process, IPC and host-name namespaces, ended
 * with Mousse, in a session of its own (no terminal to type into). Nothing else of this computer is there.
 */
export function bubblewrapArgs(
  command: string,
  input: { cwd: string; writable: readonly string[]; readOnly: readonly string[] },
  fs: { exists(path: string): boolean; link(path: string): string | undefined } = { exists: existsSync, link: symbolicLink }
): string[] {
  const args = ['--die-with-parent', '--new-session', '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts']
  const special = new Set(['/proc', '/dev', '/sys', '/tmp'])
  for (const folder of [...LINUX_SYSTEM_FOLDERS.filter((path) => !special.has(path)), ...LINUX_RUN_KEPT_OPEN]) {
    if (!fs.exists(folder)) continue
    const target = fs.link(folder)
    if (target !== undefined) args.push('--symlink', target, folder)
    else args.push('--ro-bind', folder, folder)
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp')
  for (const folder of input.writable) args.push('--bind', folder, folder)
  for (const folder of input.readOnly) args.push('--ro-bind', folder, folder)
  args.push('--chdir', input.cwd, '/bin/sh', '-c', command)
  return args
}

function symbolicLink(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined
  } catch {
    return undefined
  }
}

/**
 * The environment of a bot's secret command: its locked command environment, as its background commands get it
 * (`BotEngine.startWatcher`), `TMPDIR` in its scratch folder. The secrets are added by `runWithSecrets`.
 */
export function botSecretEnv(base: NodeJS.ProcessEnv, scratch: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  return lockedEnv({ platform, base, driver: 'pi', credential: 'api_key', scratch })
}
