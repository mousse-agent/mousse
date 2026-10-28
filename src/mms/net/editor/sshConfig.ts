import { randomBytes } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, delimiter, dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path'
import type {
  EditorSshComputer,
  EditorSshProblemCode,
  EditorSshResult,
  EditorSshStatus
} from '../../../shared/net/local'
import { isId, type NodeId } from '../../../shared/net'
import { parseKnownHosts, removeTrustedName } from '../ssh/knownHosts'
import { runProcess } from '../ssh/runner'
import { q } from '../ssh/shellQuote'

/**
 * Mousse's own ssh configuration for editors.
 *
 * Editors reach another computer by running the system `ssh` against a host name, and `ssh` reads
 * `~/.ssh/config`. Mousse keeps one file of its own (`<mousse home>/ssh/config`) with one `Host`
 * block per paired computer of every profile, and puts a single `Include` line for that file in the
 * user's `~/.ssh/config`. Nothing else in the user's file is read for meaning, rewritten or
 * reformatted.
 *
 * The rule that rules the rest: Mousse never makes the user's other `ssh` commands fail. A file
 * that `ssh` cannot read (a loose ACL on Windows, a parse error in an old client) breaks every
 * `ssh` invocation, not only the alias, because included files are read for every host. So
 * - Mousse's folder gets a private ACL (`0700` / owner, SYSTEM and Administrators) before anything
 *   is written into it;
 * - the line is added only after the system `ssh` has read a scratch config that holds just that
 *   line, and is checked again on the user's real file afterwards; if that fails the file is put
 *   back exactly as it was.
 *
 * Where the line goes: `ssh` takes the first value it finds for each option, and an `Include` that
 * follows a `Host` or `Match` line is only read for that block. The line therefore goes at the very
 * top of the file, ahead of every other line, so nothing above it can override an alias and it
 * applies to every host. Undo removes exactly that line.
 *
 * The user's file is changed in place, so its owner, ACL, mode, links and extended attributes stay.
 * Mousse refuses to touch a file this user cannot write or (on macOS and Linux) does not own.
 *
 * Mousse writes the user's file only when `prepare` (first use) or `enable` adds the line and when
 * `disable` removes it. Every other call touches only files under the Mousse home.
 */

/** The notice shown once, the first time the line is added. */
export const EDITOR_SSH_NOTICE =
  'Mousse added an Include line to ~/.ssh/config so your editor can reach your other computers. You can remove it in Settings.'
const USER_CONFIG_LABEL = '~/.ssh/config'
const BOM = '\xEF\xBB\xBF'
const MAX_CONFIG_BYTES = 4 * 1024 * 1024
const STATE_VERSION = 1
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
/** A host name that exists nowhere, for checking that an unrelated host still resolves. */
const CHECK_HOST = 'mousse-check.invalid'
const HOST_KEY_TYPE =
  /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/u
const HOST_KEY_BASE64 = /^[A-Za-z0-9+/]{16,8192}={0,2}$/u

/** A failure the caller can show; `code` says what to tell the person. */
export class EditorSshError extends Error {
  constructor(
    readonly code: EditorSshProblemCode,
    message: string
  ) {
    super(message)
    this.name = 'EditorSshError'
  }
}

export interface EditorSshPaths {
  home: string
  /** `~/.ssh` */
  sshDir: string
  /** The user's `~/.ssh/config` (it may be a symbolic link). */
  userConfig: string
  /** `<mousse home>/ssh`, private to the user. */
  dir: string
  /** Mousse's config file, the one the Include line names. */
  config: string
  /** The host keys Mousse pinned, one line per alias. */
  knownHosts: string
  /** What is shared by every profile: whether the feature is on, and the notice. */
  state: string
  /** One file per profile with its computers and aliases. */
  profiles: string
}

function pathModule(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix
}

export function editorSshPaths(input: {
  home: string
  mousseHome: string
  platform?: NodeJS.Platform
}): EditorSshPaths {
  const p = pathModule(input.platform ?? process.platform)
  const dir = p.join(input.mousseHome, 'ssh')
  const sshDir = p.join(input.home, '.ssh')
  return {
    home: input.home,
    sshDir,
    userConfig: p.join(sshDir, 'config'),
    dir,
    config: p.join(dir, 'config'),
    knownHosts: p.join(dir, 'known_hosts'),
    state: p.join(dir, 'state.json'),
    profiles: p.join(dir, 'profiles')
  }
}

// ---------------------------------------------------------------------------------------------
// Text of the user's file. It is handled as Latin-1 so that every byte survives unchanged, also
// bytes that are not valid UTF-8; only the line Mousse adds is encoded as UTF-8.
// ---------------------------------------------------------------------------------------------

interface Line {
  body: string
  /** `\n`, `\r\n`, or empty for a last line without a terminator. */
  eol: string
}

function splitLines(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    if (newline < 0) {
      lines.push({ body: text.slice(start), eol: '' })
      break
    }
    const crlf = newline > start && text[newline - 1] === '\r'
    lines.push({
      body: text.slice(start, crlf ? newline - 1 : newline),
      eol: crlf ? '\r\n' : '\n'
    })
    start = newline + 1
  }
  return lines
}

const joinLines = (lines: Line[]) => lines.map((line) => line.body + line.eol).join('')
const toRaw = (value: string) => Buffer.from(value, 'utf8').toString('latin1')
const BLOCK_START = /^\s*(?:host|match)(?:\s|=|$)/iu

interface IncludeLine {
  index: number
  /** The line sits after a `Host` or `Match` line, so `ssh` reads it for that block only. */
  scoped: boolean
  /** The line names Mousse's file and nothing else, so it is ours to remove. */
  onlyOurs: boolean
}

/** Which lines of the file are `Include` lines for Mousse's file. */
function findIncludes(lines: Line[], spellings: readonly string[], platform: NodeJS.Platform) {
  const fold = (value: string) => (platform === 'win32' ? value.toLowerCase() : value)
  const ours = new Set(spellings.map((value) => fold(toRaw(value))))
  const found: IncludeLine[] = []
  let scoped = false
  lines.forEach((line, index) => {
    const body = index === 0 ? line.body.replace(BOM, '') : line.body
    if (BLOCK_START.test(body)) {
      scoped = true
      return
    }
    const match = /^\s*include(?:\s*=\s*|\s+)(.*?)\s*$/iu.exec(body)
    if (!match) return
    const tokens = [...match[1]!.matchAll(/"([^"]*)"|(\S+)/gu)].map(
      (token) => token[1] ?? token[2]!
    )
    if (!tokens.some((token) => ours.has(fold(token)))) return
    found.push({ index, scoped, onlyOurs: tokens.length === 1 })
  })
  return found
}

/** How the text relates to Mousse's file: in force, below a Host line only, edited, or absent. */
export function inspectInclude(
  text: string,
  spellings: readonly string[],
  platform: NodeJS.Platform = process.platform
) {
  const found = findIncludes(splitLines(text), spellings, platform)
  return {
    inForce: found.some((entry) => !entry.scoped),
    scopedOnly: found.length > 0 && found.every((entry) => entry.scoped),
    removable: found.filter((entry) => entry.onlyOurs).length,
    /** Lines that name Mousse's file together with something else; Mousse leaves them. */
    edited: found.filter((entry) => !entry.onlyOurs).length
  }
}

/** The file with the Include line in front of everything else (after a byte order mark). */
export function insertInclude(
  text: string,
  line: string,
  spellings: readonly string[],
  platform: NodeJS.Platform = process.platform
): { text: string; added: boolean } {
  const lines = splitLines(text)
  if (findIncludes(lines, spellings, platform).some((entry) => !entry.scoped))
    return { text, added: false }
  const bom = text.startsWith(BOM) ? BOM : ''
  const rest = text.slice(bom.length)
  const eol = lines.find((entry) => entry.eol)?.eol ?? '\n'
  return { text: bom + toRaw(line) + eol + rest, added: true }
}

/** The file without the lines that name only Mousse's file. Every other byte stays. */
export function removeInclude(
  text: string,
  spellings: readonly string[],
  platform: NodeJS.Platform = process.platform
): { text: string; removed: number } {
  const lines = splitLines(text)
  const drop = new Set(
    findIncludes(lines, spellings, platform)
      .filter((entry) => entry.onlyOurs)
      .map((entry) => entry.index)
  )
  if (!drop.size) return { text, removed: 0 }
  const bom = text.startsWith(BOM) && drop.has(0) ? BOM : ''
  const kept = lines.filter((_, index) => !drop.has(index))
  return { text: bom + joinLines(kept), removed: drop.size }
}

// ---------------------------------------------------------------------------------------------
// The Include line and the Host blocks
// ---------------------------------------------------------------------------------------------

/**
 * A path as one `ssh_config` word. Refused: characters `ssh` would read as a token (`%`, `${`), a
 * glob (`*?[`) or an escape (`\`, `"`), because versions disagree on them and no single escaping
 * suits every client.
 */
function configWord(value: string, what: string): string {
  if (/[\x00-\x1f\x7f"\\%*?[\]{}]|\$\{/u.test(value))
    throw new EditorSshError(
      'unsafe_path',
      `${what} contains a character that ssh cannot take in its configuration: ${value}`
    )
  return /[\s#=]/u.test(value) ? `"${value}"` : value
}

/**
 * Every spelling of a file under the Mousse home. `~/…` comes first when the file is under the home
 * directory: OpenSSH on macOS and Linux, Win32-OpenSSH and the OpenSSH in Git for Windows all read
 * it (each expands it to its own form of the path), while a drive letter path is read by
 * Win32-OpenSSH only and a `/c/…` path by Git for Windows only. The last spelling is absolute.
 */
function spellingsOf(paths: EditorSshPaths, file: string, platform: NodeJS.Platform): string[] {
  const p = pathModule(platform)
  const forward = (value: string) => (platform === 'win32' ? value.replace(/\\/gu, '/') : value)
  const inside = p.relative(paths.home, file)
  const underHome = inside && !inside.startsWith('..') && !p.isAbsolute(inside)
  const spellings = [...(underHome ? [`~/${forward(inside)}`] : []), forward(file)]
  // Every spelling must be usable, also the ones that are only recognised, never written.
  for (const spelling of spellings) configWord(spelling, 'The Mousse folder')
  return spellings
}

/** The Include line and every spelling of the path that counts as Mousse's. */
export function includeSpellings(
  paths: EditorSshPaths,
  platform: NodeJS.Platform = process.platform
): { line: string; spellings: string[] } {
  const spellings = spellingsOf(paths, paths.config, platform)
  return { line: `Include ${configWord(spellings[0]!, 'The Mousse folder')}`, spellings }
}

/** The word for a path inside a `ProxyCommand`, which `ssh` hands to a shell after `%` expansion. */
function shellWord(path: string, platform: NodeJS.Platform): string {
  if (/[\x00-\x1f\x7f]/u.test(path))
    throw new EditorSshError('unsafe_path', 'The mousse-cli path is not valid.')
  const escaped = path.replace(/%/gu, '%%')
  const plain = /^[A-Za-z0-9_@+=:,./%-]+$/u
  if (platform === 'win32') {
    // Forward slashes survive the shell that Git for Windows' ssh uses and are read by Win32-OpenSSH.
    const value = escaped.replace(/\\/gu, '/')
    if (/["$`]/u.test(value))
      throw new EditorSshError(
        'unsafe_path',
        'The mousse-cli path contains a character ssh cannot take.'
      )
    return plain.test(value) ? value : `"${value}"`
  }
  if (plain.test(escaped)) return escaped
  if (path.includes('\\'))
    throw new EditorSshError('unsafe_path', 'The mousse-cli path contains a backslash.')
  return q(escaped)
}

/** The program a ProxyCommand starts, and the arguments that put it in command-line mode. */
export interface ProxyProgram {
  program: string
  args?: readonly string[]
}

export function proxyCommand(
  cli: string | ProxyProgram,
  node: NodeId,
  profile: string,
  platform: NodeJS.Platform = process.platform
) {
  if (!isId('node', node)) throw new EditorSshError('bad_value', 'A device identity is required.')
  if (!PROFILE_ID.test(profile)) throw new EditorSshError('bad_value', 'A profile id is required.')
  const { program, args = [] } = typeof cli === 'string' ? { program: cli } : cli
  return [
    shellWord(program, platform),
    ...args.map((value) => shellWord(value, platform)),
    'net',
    'ssh-proxy',
    node,
    '--profile',
    profile
  ].join(' ')
}

/**
 * A login name as an `ssh_config` word, or undefined when it cannot be written safely. The set is
 * deliberately small: Windows 10's ssh (8.1) splits a value at `=` and reads other punctuation
 * differently from newer clients, and a parse error in an included file fails every `ssh`.
 */
const USER_NAME = /^[A-Za-z0-9_.@+][A-Za-z0-9_.@+ -]{0,63}$/u
export function userWord(user: string | undefined): string | undefined {
  const value = user?.trim()
  if (!value || !USER_NAME.test(value)) return undefined
  return value.includes(' ') ? `"${value}"` : value
}

export function isHostKey(value: unknown): value is { type: string; key: string } {
  if (!value || typeof value !== 'object') return false
  const { type, key } = value as { type?: unknown; key?: unknown }
  return (
    typeof type === 'string' &&
    HOST_KEY_TYPE.test(type) &&
    typeof key === 'string' &&
    HOST_KEY_BASE64.test(key)
  )
}

/** A name for the alias: lowercase letters, digits and single dashes, at most 20 characters. */
function slug(name: string): string {
  const value = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 20)
    .replace(/-+$/u, '')
  return value || 'computer'
}

function mintAlias(name: string, node: NodeId, taken: ReadonlySet<string>): string {
  const body = node.slice(node.indexOf('_') + 1)
  for (let length = 6; length <= body.length; length += 2) {
    const alias = `mousse-${slug(name)}-${body.slice(0, length)}`
    if (!taken.has(alias)) return alias
  }
  return `mousse-${slug(name)}-${body}`
}

export interface RenderedComputer {
  node: NodeId
  alias: string
  name: string
  user?: string
  /** The profile whose Mousse Net reaches the computer; the proxy needs it. */
  profile: string
}

/** The text of Mousse's config file: one block per computer, sorted so equal input gives equal text. */
export function renderConfig(
  computers: readonly RenderedComputer[],
  context: {
    /** The word for the known_hosts path, from `knownHostsWord`. */
    knownHosts: string
    cli: string | ProxyProgram
    platform?: NodeJS.Platform
  }
): string {
  const platform = context.platform ?? process.platform
  const out = [
    '# Managed by Mousse. It rewrites this file when your computers change, so edit nothing here.',
    '# Your ~/.ssh/config includes it with one line; remove that line in Mousse Settings.'
  ]
  for (const computer of [...computers].sort((a, b) => a.alias.localeCompare(b.alias))) {
    const user = userWord(computer.user)
    out.push(
      '',
      `# ${computer.name
        .replace(/[\x00-\x1f\x7f]+/gu, ' ')
        .trim()
        .slice(0, 80)}`,
      `Host ${computer.alias}`,
      // The ProxyCommand reaches the computer; the name is only for tools that print it.
      '  HostName 127.0.0.1',
      ...(user ? [`  User ${user}`] : []),
      `  ProxyCommand ${proxyCommand(context.cli, computer.node, computer.profile, platform)}`,
      `  HostKeyAlias ${computer.alias}`,
      `  UserKnownHostsFile ${context.knownHosts}`,
      '  StrictHostKeyChecking yes',
      '  CheckHostIP no',
      '  UpdateHostKeys no',
      '  VerifyHostKeyDNS no',
      '  ForwardAgent no',
      '  ForwardX11 no',
      '  ControlMaster no'
    )
  }
  return out.join('\n') + '\n'
}

/** The known_hosts path as one config word: `~/…` under the home directory, else absolute. */
export function knownHostsWord(
  paths: EditorSshPaths,
  platform: NodeJS.Platform = process.platform
): string {
  return configWord(spellingsOf(paths, paths.knownHosts, platform)[0]!, 'The Mousse folder')
}

/**
 * The program a ProxyCommand starts, found per platform and, where the installed folder changes,
 * by a path that stays put:
 * - Windows: `mousse-cli.cmd` next to the app binary.
 * - macOS: `Contents/Resources/mousse-cli` (the app binary is in `Contents/MacOS`).
 * - Linux AppImage: the `.AppImage` file itself, started with `--cli`, because the folder the
 *   launcher sits in is a new `/tmp/.mount_*` on every start.
 * - Otherwise the launcher next to the binary, and last `mousse-cli` from PATH.
 */
export function defaultProxyProgram(
  platform: NodeJS.Platform = process.platform,
  options: {
    execPath?: string
    env?: NodeJS.ProcessEnv
    exists?: (path: string) => boolean
  } = {}
): ProxyProgram {
  const p = pathModule(platform)
  const execPath = options.execPath ?? process.execPath
  const exists = options.exists ?? existsSync
  const appImage = options.env?.APPIMAGE ?? process.env.APPIMAGE
  const beside = p.join(p.dirname(execPath), platform === 'win32' ? 'mousse-cli.cmd' : 'mousse-cli')
  const candidates =
    platform === 'darwin'
      ? [p.resolve(p.dirname(execPath), '..', 'Resources', 'mousse-cli'), beside]
      : [beside]
  if (platform === 'linux' && appImage && p.isAbsolute(appImage) && exists(appImage))
    return { program: appImage, args: ['--cli'] }
  const found = candidates.find((candidate) => exists(candidate))
  return { program: found ?? 'mousse-cli' }
}

// ---------------------------------------------------------------------------------------------
// Checking with the system ssh
// ---------------------------------------------------------------------------------------------

export type SshVerdict =
  { ok: true } | { ok: false; code: 'ssh_check_failed' | 'no_ssh'; detail: string }

/**
 * Reads `config` with the system `ssh` for each of `hosts`. A config that includes a file `ssh`
 * dislikes fails here exactly as it would for the user.
 */
export type SshVerifier = (input: { config: string; hosts: string[] }) => Promise<SshVerdict>

/** The `ssh` programs an editor might run: the ones on PATH and, on Windows, the two usual installs. */
export function findSshClients(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const name = platform === 'win32' ? 'ssh.exe' : 'ssh'
  const found: string[] = []
  const add = (candidate: string) => {
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate
    if (
      existsSync(candidate) &&
      !found.some((row) => (platform === 'win32' ? row.toLowerCase() : row) === key)
    )
      found.push(candidate)
  }
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) if (dir) add(join(dir, name))
  if (platform === 'win32') {
    const root = env.SystemRoot ?? 'C:\\Windows'
    add(join(root, 'System32', 'OpenSSH', name))
    for (const base of [
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')
    ])
      if (base) add(join(base, 'Git', 'usr', 'bin', name))
  }
  return found.slice(0, 4)
}

export function systemSshVerifier(platform: NodeJS.Platform = process.platform): SshVerifier {
  return async ({ config, hosts }) => {
    const clients = findSshClients(platform)
    if (!clients.length)
      return {
        ok: false,
        code: 'no_ssh',
        detail: 'The ssh command was not found on this computer.'
      }
    for (const client of clients)
      for (const host of hosts) {
        const run = await runProcess(client, ['-F', config, '-G', host], {
          timeoutMs: 10_000,
          maxBytes: 64 * 1024
        }).catch((error: Error) => ({
          code: -1,
          stdout: '',
          stderr: error.message,
          timedOut: false,
          missing: false
        }))
        if (run.missing) continue
        if (run.timedOut || run.code !== 0 || !/^hostname /mu.test(run.stdout)) {
          const last = run.stderr
            .replace(/[^\x20-\x7e\n]/gu, ' ')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .pop()
          return {
            ok: false,
            code: 'ssh_check_failed',
            detail:
              `${basename(client)}: ${run.timedOut ? 'timed out' : (last ?? `exit code ${run.code}`)}`.slice(
                0,
                300
              )
          }
        }
      }
    return { ok: true }
  }
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

/** Follows symbolic links so that a write reaches the file they lead to, not the link. */
async function writeTarget(file: string): Promise<string> {
  let current = file
  for (let hop = 0; hop < 16; hop++) {
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return current
      throw error
    }
    if (!info.isSymbolicLink()) return current
    const link = await readlink(current)
    current = isAbsolute(link) ? link : resolve(dirname(current), link)
  }
  throw new EditorSshError('unwritable', `${file} is a chain of symbolic links that is too long.`)
}

/** Writes beside the target and renames over it. Only for files Mousse owns. */
async function writeAtomic(file: string, data: string | Buffer, mode: number): Promise<void> {
  const temporary = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, data, { mode, flag: 'wx' })
    await chmod(temporary, mode).catch(() => {})
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function readOptional(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}

async function ownFile(file: string, text: string): Promise<boolean> {
  if ((await readOptional(file))?.toString('utf8') === text) return false
  await writeAtomic(file, text, 0o600)
  return true
}

/** Windows folders restricted in this process; the ACL is set once, when Mousse first uses a folder. */
const restricted = new Set<string>()

/**
 * Takes every inherited access entry off `dir` and grants full control to the current user, SYSTEM
 * and Administrators, which are the accounts Win32-OpenSSH accepts on a file it reads. Files made
 * in the folder afterwards inherit exactly that. Without this a file would inherit the Mousse home's
 * ACL, which can carry other accounts, and Win32-OpenSSH would refuse to run any `ssh` at all.
 */
async function restrictWindowsFolder(dir: string): Promise<void> {
  const key = dir.toLowerCase()
  if (restricted.has(key)) return
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  const fail = (why: string): never => {
    throw new EditorSshError(
      'unwritable',
      `Mousse could not make its ssh folder private (${why}), so it changed nothing.`
    )
  }
  const who = await runProcess(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    timeoutMs: 15_000,
    env: process.env
  }).catch(() => undefined)
  const sid = /"(S-1-[0-9-]+)"/u.exec(who?.stdout ?? '')?.[1]
  if (!sid) fail('the current user could not be identified')
  const run = await runProcess(
    join(system, 'icacls.exe'),
    [
      dir,
      '/inheritance:r',
      '/grant:r',
      `*${sid}:(OI)(CI)F`,
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F'
    ],
    { timeoutMs: 30_000, env: process.env }
  ).catch(() => undefined)
  if (!run || run.code !== 0) fail('icacls failed')
  restricted.add(key)
}

/** One queue per Mousse folder, shared by the services of every profile in this process. */
const queues = new Map<string, Promise<unknown>>()
function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).then(work)
  const tail = result.then(
    () => {},
    () => {}
  )
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return result
}

// ---------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------

interface StoredComputer {
  alias: string
  name: string
  user?: string
}
/** Shared by every profile. */
interface GlobalState {
  version: typeof STATE_VERSION
  /** False after the person turned the feature off; nothing turns it on again except `enable`. */
  enabled: boolean
  /** Set when Mousse added the line. A line missing after that was removed by hand. */
  includeAddedAt?: number
  noticePending: boolean
}
interface ProfileState {
  version: typeof STATE_VERSION
  computers: Record<string, StoredComputer>
}
const freshGlobal = (): GlobalState => ({
  version: STATE_VERSION,
  enabled: true,
  noticePending: false
})

/** A computer that is paired now. `user` is its login name once the computer has said it. */
export interface LiveComputer {
  node: NodeId
  name: string
  user?: string
}

export interface EditorSshOptions {
  /** The user's home directory (never read for anything but `.ssh/config`). */
  home: string
  mousseHome: string
  /** The profile whose computers this service lists; the proxy is told which one to use. */
  profile?: string
  /** The program ProxyCommand starts. */
  cli?: string | ProxyProgram
  platform?: NodeJS.Platform
  now?: () => number
  /** Replaces the check with the system ssh; tests only. */
  verify?: SshVerifier
  /** Tests only: runs between reading the user's file and writing it. */
  afterRead?: (attempt: number) => void | Promise<void>
}

/** The status of a service that has no home directory to write to. */
export function unavailableEditorSsh(): EditorSshStatus {
  return {
    available: false,
    enabled: false,
    included: false,
    includeLine: '',
    userConfig: USER_CONFIG_LABEL,
    mousseConfig: '',
    knownHosts: '',
    noticePending: false,
    computers: [],
    problem: {
      code: 'unavailable',
      message: 'Editor connections are not available in this build.'
    }
  }
}

interface Snapshot {
  target: string
  /** Absent when the file does not exist yet. */
  bytes?: Buffer
}

export class EditorSshConfig {
  readonly paths: EditorSshPaths
  readonly profile: string
  private readonly platform: NodeJS.Platform
  private readonly cli: string | ProxyProgram
  private readonly now: () => number
  private readonly verifier: SshVerifier
  private readonly afterRead?: EditorSshOptions['afterRead']
  private readonly lockKey: string

  constructor(options: EditorSshOptions) {
    this.platform = options.platform ?? process.platform
    this.profile = options.profile ?? 'default'
    if (!PROFILE_ID.test(this.profile))
      throw new EditorSshError('bad_value', 'The profile id is not valid.')
    this.paths = editorSshPaths({ ...options, platform: this.platform })
    this.cli = options.cli ?? defaultProxyProgram(this.platform)
    this.now = options.now ?? Date.now
    this.verifier = options.verify ?? systemSshVerifier(this.platform)
    this.afterRead = options.afterRead
    this.lockKey = this.platform === 'win32' ? this.paths.dir.toLowerCase() : this.paths.dir
  }

  /** One change at a time for the whole Mousse folder, across profiles. */
  private locked<T>(work: () => Promise<T>): Promise<T> {
    return serialize(this.lockKey, work)
  }

  // --- state ---------------------------------------------------------------------------------

  private async readGlobal(): Promise<{ state: GlobalState; exists: boolean }> {
    const bytes = await readOptional(this.paths.state)
    if (!bytes) return { state: freshGlobal(), exists: false }
    try {
      const value = JSON.parse(bytes.toString('utf8')) as Partial<GlobalState>
      if (value.version !== STATE_VERSION) return { state: freshGlobal(), exists: true }
      return {
        exists: true,
        state: {
          version: STATE_VERSION,
          enabled: value.enabled !== false,
          noticePending: value.noticePending === true,
          ...(typeof value.includeAddedAt === 'number'
            ? { includeAddedAt: value.includeAddedAt }
            : {})
        }
      }
    } catch {
      // A damaged file is the same as none.
      return { state: freshGlobal(), exists: true }
    }
  }

  private async writeGlobal(state: GlobalState): Promise<void> {
    await ownFile(this.paths.state, JSON.stringify(state, null, 2) + '\n')
  }

  private profileFile(profile: string): string {
    return join(this.paths.profiles, `${profile}.json`)
  }

  private async readProfile(profile: string): Promise<ProfileState | undefined> {
    const bytes = await readOptional(this.profileFile(profile))
    if (!bytes) return undefined
    try {
      const value = JSON.parse(bytes.toString('utf8')) as Partial<ProfileState>
      if (
        value.version !== STATE_VERSION ||
        !value.computers ||
        typeof value.computers !== 'object'
      )
        return undefined
      const computers: Record<string, StoredComputer> = {}
      for (const [node, row] of Object.entries(value.computers)) {
        if (
          isId('node', node) &&
          row &&
          typeof row.alias === 'string' &&
          /^mousse-[a-z0-9-]{1,80}$/u.test(row.alias) &&
          typeof row.name === 'string'
        )
          computers[node] = {
            alias: row.alias,
            name: row.name,
            ...(typeof row.user === 'string' ? { user: row.user } : {})
          }
      }
      return { version: STATE_VERSION, computers }
    } catch {
      // Aliases are minted again and the config is rewritten.
      return undefined
    }
  }

  /** Every profile's computers; `own` replaces this profile's file with what is about to be written. */
  private async readAllProfiles(own?: ProfileState): Promise<Map<string, ProfileState>> {
    const all = new Map<string, ProfileState>()
    let names: string[] = []
    try {
      names = await readdir(this.paths.profiles)
    } catch {
      // No profile has used the feature yet.
    }
    for (const name of names) {
      const profile = name.endsWith('.json') ? name.slice(0, -5) : undefined
      if (!profile || !PROFILE_ID.test(profile) || profile === this.profile) continue
      const state = await this.readProfile(profile)
      if (state) all.set(profile, state)
    }
    const mine = own ?? (await this.readProfile(this.profile))
    if (mine) all.set(this.profile, mine)
    return all
  }

  /**
   * Aliases stay with the computer: a rename changes the comment, never the `Host` name. Names are
   * unique across profiles. Returns the aliases of this profile's computers that are gone.
   */
  private reconcile(
    state: ProfileState,
    live: readonly LiveComputer[],
    others: ReadonlySet<string>
  ): string[] {
    const taken = new Set([...others, ...Object.values(state.computers).map((row) => row.alias)])
    const next: Record<string, StoredComputer> = {}
    for (const computer of live) {
      if (!isId('node', computer.node)) continue
      const previous = state.computers[computer.node]
      const name = computer.name.trim() || previous?.name || 'computer'
      const user = userWord(computer.user) ? computer.user!.trim() : previous?.user
      const alias = previous?.alias ?? mintAlias(name, computer.node, taken)
      taken.add(alias)
      next[computer.node] = { alias, name, ...(user ? { user } : {}) }
    }
    const gone = Object.entries(state.computers)
      .filter(([node]) => !next[node])
      .map(([, row]) => row.alias)
    state.computers = next
    return gone
  }

  private aliasesOf(all: Map<string, ProfileState>, except?: string): Set<string> {
    const aliases = new Set<string>()
    for (const [profile, state] of all)
      if (profile !== except)
        for (const row of Object.values(state.computers)) aliases.add(row.alias)
    return aliases
  }

  // --- Mousse's own files --------------------------------------------------------------------

  /** Creates the folder with a private ACL before any file goes into it. */
  private async ensureOwnDirectory(): Promise<void> {
    try {
      await mkdir(this.paths.profiles, { recursive: true, mode: 0o700 })
      if (process.platform === 'win32') await restrictWindowsFolder(this.paths.dir)
      else {
        await chmod(this.paths.dir, 0o700)
        await chmod(this.paths.profiles, 0o700)
      }
    } catch (error) {
      if (error instanceof EditorSshError) throw error
      throw new EditorSshError(
        'unwritable',
        `Mousse could not prepare its ssh folder: ${(error as Error).message}`
      )
    }
  }

  private render(all: Map<string, ProfileState>): string {
    const computers: RenderedComputer[] = []
    for (const [profile, state] of all)
      for (const [node, row] of Object.entries(state.computers))
        computers.push({ node: node as NodeId, profile, ...row })
    return renderConfig(computers, {
      knownHosts: knownHostsWord(this.paths, this.platform),
      cli: this.cli,
      platform: this.platform
    })
  }

  /** Rewrites the merged config for `all`. Returns the text it replaced, if the file changed. */
  private async writeOwnConfig(all: Map<string, ProfileState>): Promise<string | undefined> {
    const text = this.render(all)
    const before = (await readOptional(this.paths.config))?.toString('utf8')
    if (before === text) return undefined
    await writeAtomic(this.paths.config, text, 0o600)
    return before ?? ''
  }

  private async writeProfile(state: ProfileState): Promise<void> {
    await ownFile(this.profileFile(this.profile), JSON.stringify(state, null, 2) + '\n')
  }

  // --- the user's file -----------------------------------------------------------------------

  private include() {
    return includeSpellings(this.paths, this.platform)
  }

  /** Reads the file the user's `config` leads to, refusing one Mousse must not write. */
  private async snapshotUserConfig(): Promise<Snapshot> {
    const target = await writeTarget(this.paths.userConfig).catch((error: Error) => {
      if (error instanceof EditorSshError) throw error
      throw new EditorSshError(
        'unreadable',
        `Mousse could not read ${USER_CONFIG_LABEL}: ${error.message}`
      )
    })
    let bytes: Buffer | undefined
    try {
      bytes = await readOptional(target)
    } catch (error) {
      throw new EditorSshError(
        'unreadable',
        `Mousse could not read ${USER_CONFIG_LABEL}: ${(error as Error).message}`
      )
    }
    if (!bytes) return { target }
    // ssh reads one byte per character; a UTF-16 file or a binary file is not one it could read.
    if (
      bytes.length > MAX_CONFIG_BYTES ||
      bytes.includes(0) ||
      (bytes[0] === 0xff && bytes[1] === 0xfe) ||
      (bytes[0] === 0xfe && bytes[1] === 0xff)
    )
      throw new EditorSshError(
        'unreadable',
        `${USER_CONFIG_LABEL} is not a plain text file, so Mousse left it alone.`
      )
    return { target, bytes }
  }

  /** The file must be this user's own and writable, because Mousse changes it in place. */
  private async assertMayWrite(target: string): Promise<void> {
    const info = await stat(target)
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (uid !== undefined && info.uid !== uid)
      throw new EditorSshError(
        'not_owner',
        `${USER_CONFIG_LABEL} belongs to another account, so Mousse left it alone. Add the line yourself if you want editor connections: ${this.include().line}`
      )
    try {
      await access(target, constants.W_OK)
    } catch {
      throw new EditorSshError(
        'unwritable',
        `${USER_CONFIG_LABEL} is read-only for this account, so Mousse left it alone. Add the line yourself if you want editor connections: ${this.include().line}`
      )
    }
  }

  /**
   * Writes in place: the file keeps its owner, ACL, mode, hard links and extended attributes, which
   * a new file renamed over it would lose. A missing file is created with mode 0600.
   */
  private async putUserConfig(snapshot: Snapshot, data: Buffer): Promise<void> {
    try {
      if (snapshot.bytes) {
        await this.assertMayWrite(snapshot.target)
        const handle = await open(snapshot.target, 'r+')
        try {
          let written = 0
          while (written < data.length)
            written += (await handle.write(data, written, data.length - written, written))
              .bytesWritten
          await handle.truncate(data.length)
          await handle.sync()
        } finally {
          await handle.close()
        }
      } else {
        await mkdir(this.paths.sshDir, { recursive: true, mode: 0o700 })
        const handle = await open(snapshot.target, 'wx', 0o600)
        try {
          await handle.writeFile(data)
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    } catch (error) {
      if (error instanceof EditorSshError) throw error
      throw new EditorSshError(
        'unwritable',
        `Mousse could not write ${USER_CONFIG_LABEL}: ${(error as Error).message}`
      )
    }
  }

  /** Puts the file back exactly as the snapshot had it. */
  private async restoreUserConfig(snapshot: Snapshot): Promise<void> {
    if (snapshot.bytes) await this.putUserConfig(snapshot, snapshot.bytes)
    else await rm(snapshot.target, { force: true })
  }

  /**
   * Changes the user's file with `mutate`, which returns the new text or undefined for no change.
   * The file is read again just before the write; if another program changed it meanwhile, the
   * change is made again on the new text, up to three times.
   */
  private async changeUserConfig(
    mutate: (text: string, snapshot: Snapshot) => string | undefined,
    check?: () => Promise<void>
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await this.snapshotUserConfig()
      const before = snapshot.bytes?.toString('latin1')
      await this.afterRead?.(attempt)
      const next = mutate(before ?? '', snapshot)
      if (next === undefined || (before !== undefined && next === before)) return false
      const now = await readOptional(snapshot.target)
      if (now?.toString('latin1') !== before) continue
      await this.putUserConfig(snapshot, Buffer.from(next, 'latin1'))
      if (check)
        try {
          await check()
        } catch (error) {
          await this.restoreUserConfig(snapshot).catch(() => {})
          throw error
        }
      return true
    }
    throw new EditorSshError(
      'unwritable',
      `${USER_CONFIG_LABEL} kept changing while Mousse updated it. Try again.`
    )
  }

  // --- checking with ssh ---------------------------------------------------------------------

  /** Hosts to read: one that exists nowhere, so an unrelated `ssh` is covered, and one alias. */
  private checkHosts(all: Map<string, ProfileState>): string[] {
    const alias = [...this.aliasesOf(all)].sort()[0]
    return alias ? [CHECK_HOST, alias] : [CHECK_HOST]
  }

  /** `outcome` ends the message: what Mousse did, or did not do, because the check failed. */
  private async assertReadable(config: string, hosts: string[], outcome: string): Promise<void> {
    const verdict = await this.verifier({ config, hosts })
    if (!verdict.ok)
      throw new EditorSshError(
        verdict.code,
        verdict.code === 'no_ssh'
          ? `${verdict.detail} ${outcome}`
          : `The ssh on this computer could not read the settings Mousse wrote (${verdict.detail}). ${outcome}`
      )
  }

  /**
   * Before the line goes in: a scratch config that holds only that line (spelled with an absolute
   * path) must be readable by the system ssh. `-F` permission-checks included files, so this
   * catches a loose ACL, a parse error and an option an old client does not know.
   */
  private async checkScratch(all: Map<string, ProfileState>): Promise<void> {
    const dir = await mkdtemp(join(this.paths.dir, 'check-'))
    try {
      const absolute = this.include().spellings.at(-1)!
      const scratch = join(dir, 'config')
      await writeFile(
        scratch,
        `Include ${configWord(absolute, 'The Mousse folder')}\nHost mousse-check-dummy\n  HostName 127.0.0.1\n`,
        { mode: 0o600 }
      )
      await this.assertReadable(
        scratch,
        this.checkHosts(all),
        `Mousse did not change ${USER_CONFIG_LABEL}.`
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  // --- the operations ------------------------------------------------------------------------

  async status(): Promise<EditorSshStatus> {
    return this.locked(() => this.readStatus())
  }

  private async readStatus(): Promise<EditorSshStatus> {
    const { state } = await this.readGlobal()
    const mine = (await this.readProfile(this.profile)) ?? { version: STATE_VERSION, computers: {} }
    let included = false,
      scoped = false,
      edited = false,
      found: { code: EditorSshProblemCode; message: string } | undefined
    let line = ''
    try {
      const include = this.include()
      line = include.line
      const snapshot = await this.snapshotUserConfig()
      const look = inspectInclude(
        snapshot.bytes?.toString('latin1') ?? '',
        include.spellings,
        this.platform
      )
      included = look.inForce
      scoped = look.scopedOnly
      edited = look.inForce && look.removable === 0
      if (included) {
        const all = await this.readAllProfiles()
        await this.assertReadable(
          this.paths.userConfig,
          this.checkHosts(all),
          'Remove the line in Settings, or ssh may fail.'
        ).catch((error: EditorSshError) => {
          found = { code: error.code, message: error.message }
        })
      }
    } catch (error) {
      if (!(error instanceof EditorSshError)) throw error
      found ??= { code: error.code, message: error.message }
    }
    const pinned = new Set(
      parseKnownHosts((await readOptional(this.paths.knownHosts))?.toString('utf8') ?? '').map(
        (row) => row.names
      )
    )
    const computers: EditorSshComputer[] = Object.entries(mine.computers).map(([node, row]) => ({
      node: node as NodeId,
      alias: row.alias,
      name: row.name,
      ...(row.user ? { user: row.user } : {}),
      hostKeyPinned: pinned.has(row.alias)
    }))
    return {
      available: true,
      enabled: state.enabled,
      included,
      ...(scoped ? { scoped } : {}),
      ...(edited ? { edited } : {}),
      includeLine: line,
      userConfig: USER_CONFIG_LABEL,
      mousseConfig: this.paths.config,
      knownHosts: this.paths.knownHosts,
      noticePending: state.noticePending,
      ...(state.noticePending ? { notice: EDITOR_SSH_NOTICE } : {}),
      computers,
      ...(found ? { problem: found } : {})
    }
  }

  private async fail(error: unknown): Promise<EditorSshResult> {
    if (!(error instanceof EditorSshError)) throw error
    return { ok: false, code: error.code, message: error.message, status: await this.readStatus() }
  }

  /**
   * First use. Writes Mousse's files for the computers paired now and, when the user's file does not
   * yet carry the line, adds it. `added` is true on the call that added it; the caller then shows the
   * notice once. Refused while the person has the feature off, and when the line was added before
   * and has since been removed by hand (that is a no). Never leaves `ssh` unable to read its config.
   */
  prepare(live: readonly LiveComputer[]): Promise<EditorSshResult> {
    return this.locked(() => this.apply(live, false))
  }

  /** Turns the feature on again after `disable`, then does what `prepare` does. */
  enable(live: readonly LiveComputer[]): Promise<EditorSshResult> {
    return this.locked(() => this.apply(live, true))
  }

  private async apply(live: readonly LiveComputer[], turnOn: boolean): Promise<EditorSshResult> {
    try {
      const { state } = await this.readGlobal()
      if (!state.enabled && !turnOn)
        return {
          ok: false,
          code: 'off',
          message: 'Editor connections through ssh are off. Turn them on in Settings.',
          status: await this.readStatus()
        }
      const include = this.include()
      await this.ensureOwnDirectory()
      state.enabled = true
      const mine = (await this.readProfile(this.profile)) ?? {
        version: STATE_VERSION,
        computers: {}
      }
      const others = await this.readAllProfiles()
      others.delete(this.profile)
      const gone = this.reconcile(mine, live, this.aliasesOf(others))
      const all = new Map(others).set(this.profile, mine)
      await this.writeOwnConfig(all)
      for (const alias of gone) await removeTrustedName(this.paths.knownHosts, alias)

      const snapshot = await this.snapshotUserConfig()
      const look = inspectInclude(
        snapshot.bytes?.toString('latin1') ?? '',
        include.spellings,
        this.platform
      )
      let added = false
      if (look.scopedOnly) {
        // Not copied to the top: that would be a second line the person did not ask for.
        await this.writeProfile(mine)
        await this.writeGlobal(state)
        return {
          ok: false,
          code: 'scoped',
          message: `The line ${include.line} in ${USER_CONFIG_LABEL} is below a Host or Match line, so ssh reads it for that block only. Move it to the top of the file, then try again.`,
          status: await this.readStatus()
        }
      }
      if (!look.inForce) {
        if (state.includeAddedAt !== undefined && !turnOn) {
          // Mousse added the line before and it is gone: the person removed it, which means no.
          state.enabled = false
          state.noticePending = false
          delete state.includeAddedAt
          await this.writeGlobal(state)
          await this.writeProfile(mine)
          return {
            ok: false,
            code: 'off',
            message: `The ${include.line} line was removed from ${USER_CONFIG_LABEL}, so editor connections are off. Turn them on in Settings to add it again.`,
            status: await this.readStatus()
          }
        }
        await this.checkScratch(all)
        await this.changeUserConfig(
          (text) => {
            const result = insertInclude(text, include.line, include.spellings, this.platform)
            added = result.added
            return result.added ? result.text : undefined
          },
          // And on the real file, so a surprise in the rest of it still cannot break ssh.
          () =>
            this.assertReadable(
              this.paths.userConfig,
              this.checkHosts(all),
              `Mousse put ${USER_CONFIG_LABEL} back as it was.`
            )
        )
        if (added) {
          state.includeAddedAt = this.now()
          state.noticePending = true
        }
      }
      await this.writeProfile(mine)
      await this.writeGlobal(state)
      return { ok: true, added, status: await this.readStatus() }
    } catch (error) {
      return this.fail(error)
    }
  }

  /**
   * Undo. Removes the lines that name only Mousse's file from the user's file and leaves every other
   * line as it was, then turns the feature off until `enable`. A line the person edited (a comment
   * added to it, a second file on the same line) is left, and `leftover` says so. If the line
   * cannot be removed the feature stays as it was, so the person can try again.
   */
  disable(): Promise<EditorSshResult> {
    return this.locked(async () => {
      try {
        const include = this.include()
        let removed = 0
        await this.changeUserConfig((text) => {
          const result = removeInclude(text, include.spellings, this.platform)
          removed = result.removed
          return result.removed ? result.text : undefined
        })
        const snapshot = await this.snapshotUserConfig()
        const look = inspectInclude(
          snapshot.bytes?.toString('latin1') ?? '',
          include.spellings,
          this.platform
        )
        const { state } = await this.readGlobal()
        await this.ensureOwnDirectory()
        state.enabled = false
        state.noticePending = false
        delete state.includeAddedAt
        await this.writeGlobal(state)
        return {
          ok: true,
          added: false,
          removed,
          ...(look.inForce || look.scopedOnly ? { leftover: true } : {}),
          status: await this.readStatus()
        }
      } catch (error) {
        return this.fail(error)
      }
    })
  }

  /** The person has seen the notice. */
  acknowledgeNotice(): Promise<EditorSshStatus> {
    return this.locked(async () => {
      const { state, exists } = await this.readGlobal()
      if (exists && state.noticePending) {
        state.noticePending = false
        await this.writeGlobal(state)
      }
      return this.readStatus()
    })
  }

  /**
   * Keeps Mousse's own files in step with the computers paired now and with this build: a new
   * computer gets an alias, a revoked one loses its alias and its pinned key, a moved launcher is
   * written again. Run at start and on every roster change. Does nothing until the feature has been
   * used or while it is off, and never touches the user's file. Another profile's computers and keys
   * are never touched. If the new text were one the system ssh cannot read, the old text is put back.
   */
  syncIfPrepared(live: () => readonly LiveComputer[]): Promise<void> {
    return this.locked(async () => {
      const { state, exists } = await this.readGlobal()
      if (!exists || !state.enabled) return
      const mine = (await this.readProfile(this.profile)) ?? {
        version: STATE_VERSION,
        computers: {}
      }
      const others = await this.readAllProfiles()
      others.delete(this.profile)
      let gone: string[] = []
      try {
        gone = this.reconcile(mine, live(), this.aliasesOf(others))
      } catch {
        // The device list is not readable yet; the file is still refreshed for this build.
      }
      const all = new Map(others).set(this.profile, mine)
      await this.ensureOwnDirectory()
      const replaced = await this.writeOwnConfig(all)
      if (replaced !== undefined) {
        const snapshot = await this.snapshotUserConfig().catch(() => undefined)
        const include = this.include()
        if (
          snapshot?.bytes &&
          inspectInclude(snapshot.bytes.toString('latin1'), include.spellings, this.platform)
            .inForce
        )
          try {
            await this.assertReadable(
              this.paths.userConfig,
              this.checkHosts(all),
              'Mousse kept the old settings.'
            )
          } catch (error) {
            await writeAtomic(this.paths.config, replaced, 0o600)
            throw error
          }
      }
      for (const alias of gone) await removeTrustedName(this.paths.knownHosts, alias)
      await this.writeProfile(mine)
    })
  }

  /**
   * Pins the host keys a computer vouched for over Mousse Net under its alias. `ssh` then checks the
   * key strictly and never asks. Every key pinned before for that alias is replaced by this set in
   * one write, whatever its type: the computer's own word is the current one. Other aliases, also
   * those of other profiles, are not touched.
   */
  pinHostKeys(
    node: NodeId,
    keys: ReadonlyArray<{ type: string; key: string }>
  ): Promise<'added' | 'present' | 'replaced'> {
    return this.locked(async () => {
      if (!keys.length || keys.length > 8 || !keys.every(isHostKey))
        throw new EditorSshError('bad_value', 'The host keys are not valid.')
      const alias = (await this.readProfile(this.profile))?.computers[node]?.alias
      if (!alias)
        throw new EditorSshError('unknown_computer', 'This computer has no editor alias yet.')
      await this.ensureOwnDirectory()
      const wanted = [...new Set(keys.map((row) => `${alias} ${row.type} ${row.key}`))]
      const text = (await readOptional(this.paths.knownHosts))?.toString('utf8') ?? ''
      const lines = text.split(/\r?\n/u).filter((line) => line.length)
      const isAlias = (line: string) => parseKnownHosts(line)[0]?.names === alias
      const had = lines.filter(isAlias)
      if (had.length === wanted.length && wanted.every((line) => had.includes(line)))
        return 'present'
      await writeAtomic(
        this.paths.knownHosts,
        [...lines.filter((line) => !isAlias(line)), ...wanted].join('\n') + '\n',
        0o600
      )
      return had.length ? 'replaced' : 'added'
    })
  }

  pinHostKey(
    node: NodeId,
    key: { type: string; key: string }
  ): Promise<'added' | 'present' | 'replaced'> {
    return this.pinHostKeys(node, [key])
  }
}
