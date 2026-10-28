import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, posix, resolve, win32 } from 'node:path'
import type {
  EditorSshComputer,
  EditorSshProblemCode,
  EditorSshResult,
  EditorSshStatus
} from '../../../shared/net/local'
import { isId, type NodeId } from '../../../shared/net'
import { parseKnownHosts, removeTrustedName, writeTrustedKey } from '../ssh/knownHosts'
import { q } from '../ssh/shellQuote'

/**
 * Mousse's own ssh configuration for editors.
 *
 * Editors reach another computer by running the system `ssh` against a host name, and `ssh` reads
 * `~/.ssh/config`. Mousse keeps one file of its own (`<mousse home>/ssh/config`) with one `Host`
 * block per paired computer, and puts a single `Include` line for that file in the user's
 * `~/.ssh/config`. Nothing else in the user's file is read for meaning, rewritten or reformatted.
 *
 * Where the line goes: `ssh` takes the first value it finds for each option, and an `Include` that
 * follows a `Host` or `Match` line is only read for that block. The line therefore goes at the very
 * top of the file, ahead of every other line, so nothing above it can override an alias and it
 * applies to every host. Undo removes exactly that line.
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
  /** `<mousse home>/ssh` */
  dir: string
  /** Mousse's config file, the one the Include line names. */
  config: string
  /** The host keys Mousse pinned, one line per alias. */
  knownHosts: string
  state: string
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
    state: p.join(dir, 'state.json')
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
 * The Include line and every spelling of the path that counts as Mousse's. The preferred spelling
 * is `~/…` when the Mousse home is under the home directory: OpenSSH on macOS and Linux, Win32-OpenSSH
 * and the OpenSSH in Git for Windows all read it, while a drive letter path is read by Win32-OpenSSH
 * only and a `/c/…` path by Git for Windows only.
 */
export function includeSpellings(
  paths: EditorSshPaths,
  platform: NodeJS.Platform = process.platform
): { line: string; spellings: string[] } {
  const p = pathModule(platform)
  const forward = (value: string) => (platform === 'win32' ? value.replace(/\\/gu, '/') : value)
  const inside = p.relative(paths.home, paths.config)
  const underHome = inside && !inside.startsWith('..') && !p.isAbsolute(inside)
  const absolute = forward(paths.config)
  const spellings = [...(underHome ? [`~/${forward(inside)}`] : []), absolute]
  const preferred = spellings[0]!
  // Every spelling must be usable, also the ones that are only recognised, never written.
  for (const spelling of spellings) configWord(spelling, 'The Mousse folder')
  return { line: `Include ${configWord(preferred, 'The Mousse folder')}`, spellings }
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

export function proxyCommand(
  cli: string,
  node: NodeId,
  platform: NodeJS.Platform = process.platform
) {
  if (!isId('node', node)) throw new EditorSshError('bad_value', 'A device identity is required.')
  return `${shellWord(cli, platform)} net ssh-proxy ${node}`
}

const USER_NAME = /^[^"'\\%$`#\x00-\x1f\x7f\s-][^"'\\%$`#\x00-\x1f\x7f]{0,63}$/u

/** The login name as an `ssh_config` word, or undefined when it cannot be written safely. */
export function userWord(user: string | undefined): string | undefined {
  const value = user?.trim()
  if (!value || !USER_NAME.test(value)) return undefined
  return /\s/u.test(value) ? `"${value}"` : value
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
}

/** The text of Mousse's config file: one block per computer, sorted so equal input gives equal text. */
export function renderConfig(
  computers: readonly RenderedComputer[],
  context: { knownHosts: string; cli: string; platform?: NodeJS.Platform }
): string {
  const platform = context.platform ?? process.platform
  const knownHosts = configWord(
    platform === 'win32' ? context.knownHosts.replace(/\\/gu, '/') : context.knownHosts,
    'The Mousse folder'
  )
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
      // A Port set for every host further down the user's file would change the known_hosts name.
      '  Port 22',
      ...(user ? [`  User ${user}`] : []),
      `  ProxyCommand ${proxyCommand(context.cli, computer.node, platform)}`,
      `  HostKeyAlias ${computer.alias}`,
      `  UserKnownHostsFile ${knownHosts}`,
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

/**
 * The program a ProxyCommand starts: the launcher next to the app binary, or `mousse-cli` from PATH.
 * The entry point it starts is `net ssh-proxy`.
 */
export function defaultProxyProgram(platform: NodeJS.Platform = process.platform): string {
  const p = pathModule(platform)
  const candidate = p.join(
    p.dirname(process.execPath),
    platform === 'win32' ? 'mousse-cli.cmd' : 'mousse-cli'
  )
  return existsSync(candidate) ? candidate : 'mousse-cli'
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

/** Follows symbolic links so that a rename replaces the file they lead to, not the link. */
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

/**
 * Writes beside the target and renames over it, so a reader sees the old or the new file and never
 * half of one. `unchanged` runs just before the rename; when it is false another program changed the
 * file in the meantime and nothing is replaced.
 */
async function writeAtomic(
  file: string,
  data: string | Buffer,
  options: { mode: number; unchanged?: () => Promise<boolean> }
): Promise<boolean> {
  const target = await writeTarget(file)
  let mode = options.mode
  try {
    mode = (await stat(target)).mode & 0o7777
  } catch {
    // A new file takes the default mode.
  }
  const temporary = resolve(
    dirname(target),
    `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`
  )
  try {
    await writeFile(temporary, data, { mode, flag: 'wx' })
    await chmod(temporary, mode).catch(() => {})
    if (options.unchanged && !(await options.unchanged())) {
      await rm(temporary, { force: true })
      return false
    }
    await rename(temporary, target)
    return true
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

async function ownFile(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  if ((await readOptional(file))?.toString('utf8') === text) return
  await writeAtomic(file, text, { mode: 0o600 })
}

// ---------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------

interface StoredComputer {
  alias: string
  name: string
  user?: string
}
interface EditorSshState {
  version: typeof STATE_VERSION
  /** False after the person turned the feature off; nothing turns it on again except `enable`. */
  enabled: boolean
  includeAddedAt?: number
  noticePending: boolean
  computers: Record<string, StoredComputer>
}
const freshState = (): EditorSshState => ({
  version: STATE_VERSION,
  enabled: true,
  noticePending: false,
  computers: {}
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
  /** The program ProxyCommand starts. */
  cli?: string
  platform?: NodeJS.Platform
  now?: () => number
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

export class EditorSshConfig {
  readonly paths: EditorSshPaths
  private readonly platform: NodeJS.Platform
  private readonly cli: string
  private readonly now: () => number
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: EditorSshOptions) {
    this.platform = options.platform ?? process.platform
    this.paths = editorSshPaths({ ...options, platform: this.platform })
    this.cli = options.cli ?? defaultProxyProgram(this.platform)
    this.now = options.now ?? Date.now
  }

  /** One change at a time in this process. */
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work)
    this.queue = result.then(
      () => {},
      () => {}
    )
    return result
  }

  private async readState(): Promise<{ state: EditorSshState; exists: boolean }> {
    const bytes = await readOptional(this.paths.state)
    if (!bytes) return { state: freshState(), exists: false }
    try {
      const value = JSON.parse(bytes.toString('utf8')) as Partial<EditorSshState>
      if (
        value.version !== STATE_VERSION ||
        typeof value.computers !== 'object' ||
        !value.computers
      )
        return { state: freshState(), exists: true }
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
      return {
        exists: true,
        state: {
          version: STATE_VERSION,
          enabled: value.enabled !== false,
          noticePending: value.noticePending === true,
          ...(typeof value.includeAddedAt === 'number'
            ? { includeAddedAt: value.includeAddedAt }
            : {}),
          computers
        }
      }
    } catch {
      // A damaged file is the same as none: aliases are minted again and the config is rewritten.
      return { state: freshState(), exists: true }
    }
  }

  private async writeState(state: EditorSshState): Promise<void> {
    await ownFile(this.paths.state, JSON.stringify(state, null, 2) + '\n')
  }

  /** Aliases stay with the computer: a rename changes the comment, never the `Host` name. */
  private reconcile(state: EditorSshState, live: readonly LiveComputer[]): string[] {
    const taken = new Set(Object.values(state.computers).map((row) => row.alias))
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

  private renderedComputers(state: EditorSshState): RenderedComputer[] {
    return Object.entries(state.computers).map(([node, row]) => ({ node: node as NodeId, ...row }))
  }

  /** Rewrites Mousse's own files for `state`; the user's file is not touched. */
  private async writeOwnFiles(state: EditorSshState, gone: readonly string[]): Promise<void> {
    await ownFile(
      this.paths.config,
      renderConfig(this.renderedComputers(state), {
        knownHosts: this.paths.knownHosts,
        cli: this.cli,
        platform: this.platform
      })
    )
    for (const alias of gone) await removeTrustedName(this.paths.knownHosts, alias)
  }

  private async readUserConfig(): Promise<string | undefined> {
    let bytes: Buffer | undefined
    try {
      bytes = await readOptional(this.paths.userConfig)
    } catch (error) {
      throw new EditorSshError(
        'unreadable',
        `Mousse could not read ${USER_CONFIG_LABEL}: ${(error as Error).message}`
      )
    }
    if (!bytes) return undefined
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
    return bytes.toString('latin1')
  }

  /**
   * Changes the user's file with `mutate`, which returns the new text or undefined for no change.
   * The file is re-read just before the rename; if another program changed it meanwhile, the
   * change is made again on the new text.
   */
  private async updateUserConfig(mutate: (text: string) => string | undefined): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.readUserConfig()
      const next = mutate(before ?? '')
      if (next === undefined || next === (before ?? '')) return false
      if (before === undefined) await this.ensureSshDirectory()
      try {
        const done = await writeAtomic(this.paths.userConfig, Buffer.from(next, 'latin1'), {
          mode: 0o600,
          unchanged: async () => {
            const now = await readOptional(this.paths.userConfig)
            return now === undefined ? before === undefined : now.toString('latin1') === before
          }
        })
        if (done) return true
      } catch (error) {
        throw new EditorSshError(
          'unwritable',
          `Mousse could not write ${USER_CONFIG_LABEL}: ${(error as Error).message}`
        )
      }
    }
    throw new EditorSshError(
      'unwritable',
      `${USER_CONFIG_LABEL} kept changing while Mousse updated it. Try again.`
    )
  }

  private async ensureSshDirectory(): Promise<void> {
    try {
      await mkdir(this.paths.sshDir, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new EditorSshError(
        'unwritable',
        `Mousse could not create ~/.ssh: ${(error as Error).message}`
      )
    }
  }

  private include() {
    return includeSpellings(this.paths, this.platform)
  }

  // ------------------------------------------------------------------------------------------

  async status(): Promise<EditorSshStatus> {
    return this.locked(() => this.readStatus())
  }

  private async readStatus(): Promise<EditorSshStatus> {
    const { state } = await this.readState()
    let included = false,
      scoped = false,
      found: { code: EditorSshProblemCode; message: string } | undefined
    let line = ''
    try {
      const include = this.include()
      line = include.line
      const text = await this.readUserConfig()
      const entries = text ? findIncludes(splitLines(text), include.spellings, this.platform) : []
      included = entries.some((entry) => !entry.scoped)
      scoped = !included && entries.length > 0
    } catch (error) {
      if (!(error instanceof EditorSshError)) throw error
      found ??= { code: error.code, message: error.message }
    }
    const pinned = new Set(
      parseKnownHosts((await readOptional(this.paths.knownHosts))?.toString('utf8') ?? '').map(
        (row) => row.names
      )
    )
    const computers: EditorSshComputer[] = Object.entries(state.computers).map(([node, row]) => ({
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
   * notice once. Refused while the person has the feature off.
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
      const { state } = await this.readState()
      if (!state.enabled && !turnOn)
        return {
          ok: false,
          code: 'off',
          message: 'Editor connections through ssh are off. Turn them on in Settings.',
          status: await this.readStatus()
        }
      const include = this.include()
      state.enabled = true
      const gone = this.reconcile(state, live)
      await this.writeOwnFiles(state, gone)
      // The line goes in last, so it never names a file that is not there yet.
      let added = false
      await this.updateUserConfig((text) => {
        const result = insertInclude(text, include.line, include.spellings, this.platform)
        added = result.added
        return result.added ? result.text : undefined
      })
      if (added) {
        state.includeAddedAt = this.now()
        state.noticePending = true
      }
      await this.writeState(state)
      return { ok: true, added, status: await this.readStatus() }
    } catch (error) {
      return this.fail(error)
    }
  }

  /**
   * Undo. Removes the lines that name only Mousse's file from the user's file and leaves every other
   * line as it was, then turns the feature off until `enable`. If the line cannot be removed the
   * feature stays as it was, so the person can try again.
   */
  disable(): Promise<EditorSshResult> {
    return this.locked(async () => {
      try {
        const include = this.include()
        let removed = 0
        await this.updateUserConfig((text) => {
          const result = removeInclude(text, include.spellings, this.platform)
          removed = result.removed
          return result.removed ? result.text : undefined
        })
        const { state } = await this.readState()
        state.enabled = false
        state.noticePending = false
        delete state.includeAddedAt
        await this.writeState(state)
        return { ok: true, added: false, removed, status: await this.readStatus() }
      } catch (error) {
        return this.fail(error)
      }
    })
  }

  /** The person has seen the notice. */
  acknowledgeNotice(): Promise<EditorSshStatus> {
    return this.locked(async () => {
      const { state, exists } = await this.readState()
      if (exists && state.noticePending) {
        state.noticePending = false
        await this.writeState(state)
      }
      return this.readStatus()
    })
  }

  /**
   * Keeps Mousse's own files in step with the computers paired now: a new computer gets an alias, a
   * revoked one loses its alias and its pinned key. Does nothing until the feature has been used or
   * while it is off, and never touches the user's file.
   */
  syncIfPrepared(live: () => readonly LiveComputer[]): Promise<void> {
    return this.locked(async () => {
      const { state, exists } = await this.readState()
      if (!exists || !state.enabled) return
      const before = JSON.stringify(state.computers)
      const gone = this.reconcile(state, live())
      if (JSON.stringify(state.computers) === before && !gone.length) return
      await this.writeOwnFiles(state, gone)
      await this.writeState(state)
    })
  }

  /**
   * Pins the host key a computer vouched for over Mousse Net under its alias. `ssh` then checks the
   * key strictly and never asks. A key of the same type that was pinned before is replaced.
   */
  pinHostKey(
    node: NodeId,
    key: { type: string; key: string }
  ): Promise<'added' | 'present' | 'replaced'> {
    return this.locked(async () => {
      if (!isHostKey(key)) throw new EditorSshError('bad_value', 'The host key is not valid.')
      const { state } = await this.readState()
      const alias = state.computers[node]?.alias
      if (!alias)
        throw new EditorSshError('unknown_computer', 'This computer has no editor alias yet.')
      return writeTrustedKey(this.paths.knownHosts, { name: alias, ...key }, true)
    })
  }
}
