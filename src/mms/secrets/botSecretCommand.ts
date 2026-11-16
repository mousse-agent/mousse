import { existsSync, lstatSync, readlinkSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { LINUX_RUN_KEPT_OPEN, LINUX_SYSTEM_FOLDERS } from '../harness/claude/locked'
import { lockedEnv } from '../harness/env'

/**
 * How a personal bot's `secret_run` runs (bot/thread parity, the bot's "use secrets you give it"). A thread's agent runs
 * its secret command as its own commands run. A bot's commands run inside its runtime (Claude Code's sandbox, Codex's
 * profile, Pi's bash), which Mousse can't run a command in from the service, so a bot's secret command gets Mousse's own
 * containment, never looser than a sandboxed bot's shell:
 *
 * - **Environment.** The bot's filtered command environment (`lockedEnv`, as Pi's bot bash gets: the platform's own
 *   variables and proxies, `TMPDIR` in its scratch folder), plus only the secrets the call names. No ambient credential or
 *   other variable of the owner's comes through.
 * - **Folders and network.** On Linux, bubblewrap: the system's own folders read-only (`LINUX_SYSTEM_FOLDERS`, as Claude
 *   Code's sandbox opens them), the bot's files and scratch folders writable, a private `/tmp`, nothing else (no home
 *   folder, `/mnt`, `/media`, `/opt`, `/var`, `/run`), no network, and its own process namespace.
 * - **Elsewhere** (Windows, macOS, Linux without bubblewrap) Mousse has no sandbox to run it in, so a bot's secret command
 *   is refused, never run looser than its shell may run.
 */
export type BotSecretContainment =
  | { ok: true; program: string; args(command: string, input: { cwd: string; writable: readonly string[]; readOnly: readonly string[] }): string[] }
  | { ok: false; reason: string }

/** What a refused bot secret command is told; it names no secret. */
export const BOT_SECRET_COMMAND_UNCONTAINED =
  'A secret command of a bot runs only in a sandbox Mousse keeps it in, and this computer has none for it (it needs Linux with bubblewrap). Nothing ran. Ask your owner to run it in one of their threads, where they can give the secret too.'

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

/** How this computer can hold a bot's secret command (`BotSecretContainment`). */
export function botSecretContainment(platform: NodeJS.Platform = process.platform, find: () => string | undefined = findBubblewrap): BotSecretContainment {
  const bubblewrap = platform === 'linux' ? find() : undefined
  if (!bubblewrap) return { ok: false, reason: BOT_SECRET_COMMAND_UNCONTAINED }
  return { ok: true, program: bubblewrap, args: (command, input) => bubblewrapArgs(command, input) }
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

/** The environment of a bot's secret command: its filtered command environment, `TMPDIR` in its scratch folder. */
export function botSecretEnv(base: NodeJS.ProcessEnv, scratch: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  return lockedEnv({ platform, base, driver: 'pi', credential: 'unknown', scratch })
}
