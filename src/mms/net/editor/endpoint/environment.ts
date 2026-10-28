import { readFile, stat } from 'node:fs/promises'

/**
 * The environment of what an editor starts on this computer.
 *
 * The daemon's own environment is never passed on: it can hold provider keys, Mousse's own variables and
 * whatever the app that started it set. A program the editor starts gets what a fresh login of the user would
 * get under OpenSSH's `sshd`, built from nothing, and the shell then reads the user's own profile on top, as it
 * does under `sshd`. The only things read from the daemon are the time zone and, on macOS, the per-user temp
 * folder.
 */

/** The variable that marks a program as started for one device (see `scope.ts`). */
export const SCOPE_VARIABLE = 'MOUSSE_EDITOR_SCOPE'

/**
 * Variables a client may set with an SSH `env` request: OpenSSH's usual `AcceptEnv LANG LC_*` and a few that
 * editors send. `PATH`, `LD_*`, `SHELL` and the rest are refused.
 */
const ACCEPTED_NAME = /^(?:LANG|LC_[A-Z_]+|LANGUAGE|COLORTERM|TERM_PROGRAM|TERM_PROGRAM_VERSION)$/u
/** At most this many accepted variables per session. */
export const ENV_REQUESTS_MAX = 32

export function acceptsEnvironmentRequest(name: unknown, value: unknown): value is string {
  return (
    typeof name === 'string' &&
    ACCEPTED_NAME.test(name) &&
    typeof value === 'string' &&
    value.length <= 256 &&
    !/[\0\r\n]/u.test(value)
  )
}

const STANDARD_PATH: Readonly<Record<string, string>> = {
  linux: '/usr/local/bin:/usr/bin:/bin:/usr/games',
  darwin: '/usr/bin:/bin:/usr/sbin:/sbin'
}

export interface UnixLoginInput {
  platform: NodeJS.Platform
  user: string
  home: string
  shell: string
  /** `<client address> <client port> <server address> <server port>`, as `SSH_CONNECTION` holds it. */
  sshConnection: string
  /** The terminal's name when the session has one. */
  term?: string
  /** What `/etc/environment` gives a login (Linux). */
  system?: Readonly<Record<string, string>>
  /** The per-user runtime folder, when it exists (Linux). */
  runtimeDir?: string
  /** The only two values taken from the daemon's own environment. */
  daemon?: { TZ?: string | undefined; TMPDIR?: string | undefined }
  /** Accepted `env` requests. */
  requested: Readonly<Record<string, string>>
  scope: string
}

/** What `sshd` sets for a login on Linux or macOS, plus the marker of the device's scope. */
export function unixLoginEnvironment(input: UnixLoginInput): Record<string, string> {
  const env: Record<string, string> = {}
  Object.assign(env, input.system ?? {})
  env.USER = input.user
  env.LOGNAME = input.user
  env.HOME = input.home
  env.SHELL = input.shell
  env.PATH =
    (input.platform === 'linux' && env.PATH) ||
    STANDARD_PATH[input.platform] ||
    '/usr/bin:/bin:/usr/sbin:/sbin'
  env.MAIL = `/var/mail/${input.user}`
  if (input.daemon?.TZ) env.TZ = input.daemon.TZ
  // A launchd job has a per-user temp folder and an `sshd` session does not; the programs of an editor are
  // started by the job, so they get the same folder (it is the user's own).
  if (input.platform === 'darwin' && input.daemon?.TMPDIR) env.TMPDIR = input.daemon.TMPDIR
  // PAM gives a login on Linux its runtime folder; VS Code keeps its sockets there.
  if (input.platform === 'linux' && input.runtimeDir) env.XDG_RUNTIME_DIR = input.runtimeDir
  const [clientAddress = '127.0.0.1', clientPort = '0'] = input.sshConnection.split(' ')
  env.SSH_CLIENT = `${clientAddress} ${clientPort} 22`
  env.SSH_CONNECTION = input.sshConnection
  if (input.term !== undefined) env.TERM = input.term
  for (const [name, value] of Object.entries(input.requested)) env[name] = value
  env[SCOPE_VARIABLE] = input.scope
  return env
}

export interface WindowsSessionInput {
  user: string
  home: string
  /** The shell sessions start, as `SHELL`. */
  shell: string
  /** The computer's name, for the prompt sshd sets. */
  computer: string
  /** The home is not the user's profile (tests): the profile variables point at it too. */
  homeIsProfile: boolean
  sshConnection: string
  term?: string
  requested: Readonly<Record<string, string>>
  scope: string
}

/**
 * Windows: what a session gets on top of the logon environment. The helper builds that environment itself from
 * the registry, as a logon does (machine variables, the user's, then the per-logon ones, `Path` joined as
 * machine;user), so nothing here comes from the daemon's own environment: these are the variables sshd sets for a
 * session, the client's accepted `env` requests and the device's marker.
 */
export function windowsSessionEnvironment(input: WindowsSessionInput): Record<string, string> {
  const env: Record<string, string> = {}
  env.USER = input.user
  env.LOGNAME = input.user
  env.HOME = input.home
  env.SHELL = input.shell
  if (input.homeIsProfile) {
    const root = /^[A-Za-z]:/u.exec(input.home)?.[0]
    env.USERPROFILE = input.home
    if (root) {
      env.HOMEDRIVE = root
      env.HOMEPATH = input.home.slice(root.length) || '\\'
    }
  }
  // cmd's prompt, `user@COMPUTER path>`; a `$` in a name is doubled so the prompt does not read it.
  env.PROMPT = `${`${input.user}@${input.computer}`.replace(/\$/gu, '$$$$')} $P$G`
  const [clientAddress = '127.0.0.1', clientPort = '0'] = input.sshConnection.split(' ')
  env.SSH_CLIENT = `${clientAddress} ${clientPort} 22`
  env.SSH_CONNECTION = input.sshConnection
  if (input.term !== undefined) env.TERM = input.term
  for (const [name, value] of Object.entries(input.requested)) env[name] = value
  env[SCOPE_VARIABLE] = input.scope
  return env
}

/** `KEY=value` lines of `/etc/environment`, which `pam_env` gives to a login on Linux. Unreadable means none. */
export async function readSystemEnvironment(
  file = '/etc/environment'
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n').slice(0, 512)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line)
    if (match)
      out[match[1]!] = match[2]!
        .trim()
        .replace(/^"(.*)"$/u, '$1')
        .replace(/^'(.*)'$/u, '$1')
  }
  return out
}

/**
 * What `pam_env` gives a login: `/etc/default/locale` (Debian and Ubuntu keep the language there; a client that
 * sends no `LANG`, such as Windows' OpenSSH, would otherwise get the C locale) and then `/etc/environment`, which wins.
 */
export async function readSystemEnvironments(
  files: readonly string[] = ['/etc/default/locale', '/etc/environment']
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const file of files) Object.assign(out, await readSystemEnvironment(file))
  return out
}

/** `/run/user/<uid>` when it exists and is a folder. */
export async function runtimeDirectory(uid: number | undefined): Promise<string | undefined> {
  if (uid === undefined || uid < 0) return undefined
  const path = `/run/user/${uid}`
  return (await stat(path).then(
    (info) => info.isDirectory(),
    () => false
  ))
    ? path
    : undefined
}
