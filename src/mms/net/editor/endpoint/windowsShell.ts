import { execFile } from 'node:child_process'
import { win32 } from 'node:path'

/**
 * The shell a session starts on Windows, and the command line it is started with, the way Win32-OpenSSH's sshd
 * does both: editors send commands written for that server, so they must reach the shell the same way.
 *
 * - The shell is `cmd.exe`, unless the owner set OpenSSH's `DefaultShell` (with `DefaultShellCommandOption` and
 *   `DefaultShellEscapeArguments`) under `HKLM\SOFTWARE\OpenSSH`, which is honoured as sshd honours it.
 * - A shell request runs `"<shell>"`.
 * - An exec runs `"<shell>" /c "<command>"` for cmd: the command is put in quotes as it is, with no `/s`. cmd then
 *   strips the outer quotes, except when the command is exactly one quoted program path, which it runs as it is,
 *   as under sshd. For PowerShell, bash and other shells the command is one argument, quoted by the usual rules.
 * - With a terminal, an exec runs `"<shell>" <option> <command>`, the command unquoted, as sshd does.
 */

export interface WindowsShell {
  /** The program a session starts. */
  path: string
  /** What precedes an exec's command: `/c` for cmd, `-c` for other shells, or the owner's own. */
  option: string
  /** For a shell sshd does not know: whether the command is quoted as one argument (the default) or left as it is. */
  escape: boolean
}

type ShellKind = 'cmd' | 'powershell' | 'shellhost' | 'bash' | 'cygwin' | 'other'

/** Which shell a path is, by the names sshd looks for in it (here without regard to case). */
export function shellKind(path: string): ShellKind {
  const text = path.toLowerCase()
  if (text.includes('system32\\cmd')) return 'cmd'
  if (text.includes('powershell')) return 'powershell'
  if (text.includes('ssh-shellhost')) return 'shellhost'
  if (text.includes('\\bash')) return 'bash'
  if (text.includes('cygwin')) return 'cygwin'
  return 'other'
}

/** `cmd.exe` in the system folder, as sshd's default shell. */
export function defaultWindowsShell(systemRoot = 'C:\\Windows'): WindowsShell {
  return { path: win32.join(systemRoot, 'System32', 'cmd.exe'), option: '/c', escape: true }
}

/**
 * One argument as the C runtime reads it back: quoted when it holds a space, a tab or a quote (or is empty), a
 * quote escaped with a backslash, and backslashes doubled where they come before a quote.
 */
export function quoteArgument(text: string): string {
  if (text !== '' && !/[\s"]/u.test(text)) return text
  let out = '"'
  let backslashes = 0
  for (const character of text) {
    if (character === '\\') {
      backslashes++
      continue
    }
    if (character === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
    } else {
      out += '\\'.repeat(backslashes) + character
    }
    backslashes = 0
  }
  return out + '\\'.repeat(backslashes * 2) + '"'
}

/** The command line of a session: a shell request when `command` is undefined. */
export function windowsCommandLine(
  shell: WindowsShell,
  command: string | undefined,
  terminal: boolean
): string {
  const program = `"${shell.path}"`
  if (command === undefined) return program
  if (terminal) return `${program} ${shell.option} ${command}`
  const kind = shellKind(shell.path)
  const escaped =
    kind === 'powershell' ||
    kind === 'bash' ||
    kind === 'cygwin' ||
    (kind === 'other' && shell.escape)
  return escaped
    ? `${program} ${shell.option} ${quoteArgument(command)}`
    : `${program} ${shell.option} "${command}"`
}

/** The values of `reg.exe query` output: `    Name    REG_TYPE    data` lines. */
export function parseRegistryValues(text: string): Map<string, { type: string; data: string }> {
  const values = new Map<string, { type: string; data: string }>()
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s{4}(\S(?:.*?\S)?)\s{4}(REG_[A-Z_]+)\s{4}(.*)$/u.exec(line)
    if (match) values.set(match[1]!.toLowerCase(), { type: match[2]!, data: match[3]! })
  }
  return values
}

/** The shell from OpenSSH's registry values, or the default for any that is not set. */
export function shellFromRegistry(
  values: Map<string, { type: string; data: string }>,
  systemRoot: string
): WindowsShell {
  const fallback = defaultWindowsShell(systemRoot)
  const expand = (text: string): string =>
    text.replace(/%(SystemRoot|windir)%/giu, () => systemRoot).trim()
  const path = values.get('defaultshell')
  const shell = path && expand(path.data) ? expand(path.data) : fallback.path
  const option = values.get('defaultshellcommandoption')?.data.trim()
  const escape = values.get('defaultshellescapearguments')
  return {
    path: shell,
    option: option || (shellKind(shell) === 'cmd' ? '/c' : '-c'),
    escape: escape ? Number(escape.data) !== 0 : true
  }
}

/** Reads the owner's OpenSSH shell settings; a computer without them gets cmd. Never blocks the thread. */
export function readOpenSshShell(systemRoot: string): Promise<WindowsShell> {
  return new Promise((resolve) => {
    execFile(
      win32.join(systemRoot, 'System32', 'reg.exe'),
      ['query', 'HKLM\\SOFTWARE\\OpenSSH'],
      { windowsHide: true, timeout: 5_000 },
      (error, stdout) => {
        if (error) return resolve(defaultWindowsShell(systemRoot))
        resolve(shellFromRegistry(parseRegistryValues(String(stdout)), systemRoot))
      }
    )
  })
}

/** `read`, kept for `ttlMs` so a session start does not wait on the registry each time. */
export function cachedShell(
  read: () => Promise<WindowsShell>,
  ttlMs = 30_000,
  now: () => number = Date.now
): () => Promise<WindowsShell> {
  let held: { at: number; value: Promise<WindowsShell> } | undefined
  return () => {
    if (!held || now() - held.at > ttlMs) held = { at: now(), value: read() }
    return held.value
  }
}
