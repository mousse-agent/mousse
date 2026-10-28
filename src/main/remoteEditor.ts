/**
 * Opening a folder of another computer in an editor installed on this one, through the editor's own
 * SSH support: Remote - SSH in the VS Code family, Zed's own, and JetBrains Toolbox for the JetBrains IDEs.
 * This module only builds the command or the link; `editors.ts` runs it.
 *
 * Everything that reaches the command comes from outside this process and is treated as untrusted:
 * - the folder is what another computer answered to `editor.folder`; it is worked out again from its
 *   own `path` and refused when the answer does not agree with itself;
 * - the host is either the SSH address this computer approved for that computer (a record on this
 *   computer, checked again against the shape SSH setup accepts) or one of Mousse's own SSH names.
 * The command is an argument array. Nothing goes through a shell, no key or secret is passed, and a host
 * and a path are written into the address only after the checks below.
 */
import { editorFolderStyleOf, remoteEditorPath, type EditorFolderStyle } from '../shared/bridge/editorFolder'
import { opensOnOwner } from '../shared/remoteEditor'

/** The VS Code family: they open a folder over their own Remote - SSH, with `--folder-uri`. */
export const VSCODE_FAMILY_IDS = ['vscode', 'cursor', 'windsurf', 'vscodium', 'vscode-insiders'] as const
type VscodeFamilyId = (typeof VSCODE_FAMILY_IDS)[number]

/**
 * The product code JetBrains Toolbox installs on the other computer (`ideHint`), for each JetBrains IDE of the
 * catalog in `editors.ts`. The paid editions, since remote development needs them. Android Studio has none.
 */
export const JETBRAINS_IDE_HINTS = {
  idea: 'IU',
  webstorm: 'WS',
  pycharm: 'PY',
  goland: 'GO',
  rustrover: 'RR',
  clion: 'CL',
  rider: 'RD',
  phpstorm: 'PS'
} as const satisfies Record<string, string>
type JetBrainsId = keyof typeof JETBRAINS_IDE_HINTS

/** The editors that open a folder of another computer. */
export const REMOTE_EDITOR_IDS = [...VSCODE_FAMILY_IDS, 'zed', ...(Object.keys(JETBRAINS_IDE_HINTS) as JetBrainsId[])] as const
export type RemoteEditorId = (typeof REMOTE_EDITOR_IDS)[number]

export function supportsRemoteFolders(editorId: string): editorId is RemoteEditorId {
  return (REMOTE_EDITOR_IDS as readonly string[]).includes(editorId)
}

/** A JetBrains IDE, which opens a remote folder through JetBrains Toolbox and not a command of its own. */
export function isJetBrainsIde(editorId: string): editorId is JetBrainsId {
  return Object.hasOwn(JETBRAINS_IDE_HINTS, editorId)
}

const isVscodeFamily = (editorId: string): editorId is VscodeFamilyId => (VSCODE_FAMILY_IDS as readonly string[]).includes(editorId)

/** Why a folder cannot be opened, with a message that is shown to the person as it is. */
export class RemoteOpenError extends Error {
  constructor(
    readonly reason:
      | 'editor_missing'
      | 'folder_not_openable'
      | 'no_route',
    message: string
  ) {
    super(message)
    this.name = 'RemoteOpenError'
  }
}

export interface SshTarget {
  user?: string
  host: string
  port?: number
}

/**
 * `[user@]host[:port]`: no spaces, no `/`, no leading `-`, no shell metacharacters. The same shape SSH
 * setup stores (`src/mms/net/transports/ssh.ts`), so an alias from `~/.ssh/config` passes.
 */
const ENDPOINT =
  /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@)?(?:[A-Za-z0-9][A-Za-z0-9._-]*|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/u

export function parseSshTarget(value: unknown): SshTarget | undefined {
  if (typeof value !== 'string' || value.length > 253 || !ENDPOINT.test(value)) return undefined
  const at = value.indexOf('@')
  const user = at < 0 ? undefined : value.slice(0, at)
  let host = value.slice(at + 1)
  let port: number | undefined
  const colon = host.endsWith(']') ? -1 : host.lastIndexOf(':')
  if (colon >= 0) {
    port = Number(host.slice(colon + 1))
    host = host.slice(0, colon)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  }
  if (host.startsWith('[')) host = host.slice(1, -1)
  return { ...(user ? { user } : {}), host, ...(port !== undefined ? { port } : {}) }
}

/** The shape of one of Mousse's own SSH names (`src/mms/net/editor/sshConfig.ts`). */
const MOUSSE_ALIAS = /^mousse-[a-z0-9-]{1,80}$/u

/** Where the editor connects: an address this computer approved, or one of Mousse's own SSH names. */
export type RemoteHost = { kind: 'ssh'; target: SshTarget } | { kind: 'mousse'; alias: string }

/**
 * What follows `ssh-remote+` in a VS Code remote address. A lowercase alias or host name is written as it
 * is. Anything else (a user, a port, an upper-case letter) is the hex of `{"hostName", "user", "port"}`,
 * the form Remote - SSH writes itself, because an address's host part is lower-cased and has no field for
 * a port.
 */
export function sshRemoteAuthority(host: RemoteHost): string {
  if (host.kind === 'mousse') {
    if (!MOUSSE_ALIAS.test(host.alias)) throw new RemoteOpenError('no_route', 'The SSH name for that computer is not valid.')
    return host.alias
  }
  const { target } = host
  if (!target.user && target.port === undefined && /^[a-z0-9][a-z0-9._-]*$/u.test(target.host)) return target.host
  const json = JSON.stringify({
    hostName: target.host,
    ...(target.user ? { user: target.user } : {}),
    ...(target.port !== undefined ? { port: target.port } : {})
  })
  return Buffer.from(json, 'utf8').toString('hex')
}

/** What `editor.folder` answered, after the checks: the path of the address, from the root. */
export interface CheckedFolder {
  style: EditorFolderStyle
  /** The folder as the owner's system writes it. Kept so that a checked folder can be checked again. */
  path: string
  /** Slashes only, not encoded: `/home/me/app`, `/C:/Users/me/app`. */
  uriPath: string
  /** The owner's system as it reported it (`linux`, `darwin`, `win32`), when it did. Only picks which editors may open it. */
  platform?: string
}

/**
 * The owner's answer, trusted only as far as it agrees with itself: `uriPath` must be what this side
 * works out from `path` and `style`. A value of the wrong shape, or one that differs, is refused.
 */
export function checkedFolder(answer: unknown): CheckedFolder {
  const refuse = (): never => {
    throw new RemoteOpenError('folder_not_openable', 'This folder cannot be opened in an editor from another computer.')
  }
  if (!answer || typeof answer !== 'object') return refuse()
  const { path, uriPath, style, platform } = answer as Record<string, unknown>
  if (style !== 'posix' && style !== 'windows') return refuse()
  const derived = remoteEditorPath(path, style)
  if (!derived || derived !== uriPath) return refuse()
  // A platform that disagrees with the style is left out: the style, checked against the path, wins.
  const known = typeof platform === 'string' && /^[a-z0-9]{1,16}$/u.test(platform) && editorFolderStyleOf(platform) === style
  return { style, path: path as string, uriPath: derived, ...(known ? { platform } : {}) }
}

/** `encodeURIComponent` leaves these alone; they are encoded too so the path holds nothing but unreserved characters. */
const EXTRA_ENCODED = /[!'()*]/gu

/** Encodes each segment; the drive of a Windows path (`C:`) stays as written. */
export function encodeUriPath(folder: CheckedFolder): string {
  return folder.uriPath
    .split('/')
    .map((segment, index) =>
      folder.style === 'windows' && index === 1
        ? segment
        : encodeURIComponent(segment).replace(EXTRA_ENCODED, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    )
    .join('/')
}

/**
 * How the editor is given the folder: arguments to its own command, or a link the system hands to the program
 * that registered its scheme (JetBrains Toolbox for `jetbrains://`).
 */
export type RemoteLaunch =
  | {
      kind: 'command'
      args: string[]
      /** The address the editor is given, for tests and logs. Holds no secret. */
      uri: string
    }
  | { kind: 'link'; uri: string }

/** The start of every link Mousse hands to JetBrains Toolbox. Nothing else is opened through the system. */
export const JETBRAINS_LINK_PREFIX = 'jetbrains://gateway/ssh/environment?'

/** `[user@]host[:port]` of an `ssh://` address. A Mousse name is checked like the VS Code authority. */
function sshUrlAuthority(host: RemoteHost): string {
  if (host.kind === 'mousse') return sshRemoteAuthority(host)
  const { user, host: name, port } = host.target
  const bracketed = name.includes(':') ? `[${name}]` : name
  return `${user ? `${encodeURIComponent(user)}@` : ''}${bracketed}${port !== undefined ? `:${port}` : ''}`
}

/** `zed ssh://<host><path>`. */
function zedLaunch(host: RemoteHost, folder: CheckedFolder): RemoteLaunch {
  const uri = `ssh://${sshUrlAuthority(host)}${encodeUriPath(folder)}`
  return { kind: 'command', args: [uri], uri }
}

/**
 * `jetbrains://gateway/ssh/environment?h=<host>&launchIde=true&ideHint=<code>&projectHint=<path>`. An approved address
 * adds its user (`u`) and port (`p`); one of Mousse's names carries them in its own `Host` block. The path is the
 * owner's own form with slashes (`/home/me/app`, `C:/Users/me/app`), each segment encoded.
 */
function jetbrainsLaunch(editorId: JetBrainsId, host: RemoteHost, folder: CheckedFolder): RemoteLaunch {
  const query: Array<[string, string]> = []
  if (host.kind === 'mousse') query.push(['h', sshRemoteAuthority(host)])
  else {
    query.push(['h', host.target.host])
    if (host.target.user) query.push(['u', host.target.user])
    if (host.target.port !== undefined) query.push(['p', String(host.target.port)])
  }
  const encoded = encodeUriPath(folder)
  const projectHint = folder.style === 'windows' ? encoded.slice(1) : encoded
  const pairs = [...query, ['launchIde', 'true'], ['ideHint', JETBRAINS_IDE_HINTS[editorId]]].map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
  return { kind: 'link', uri: `${JETBRAINS_LINK_PREFIX}${[...pairs, `projectHint=${projectHint}`].join('&')}` }
}

/** The arguments or the link that open `folder` on `host` in the editor, or a refusal. */
export function remoteLaunchArguments(input: { editorId: string; host: RemoteHost; folder: unknown }): RemoteLaunch {
  const { editorId } = input
  if (!supportsRemoteFolders(editorId)) {
    throw new RemoteOpenError('editor_missing', 'That editor cannot open a folder on another computer.')
  }
  const folder = checkedFolder(input.folder)
  if (!opensOnOwner(editorId, folder.platform ?? (folder.style === 'windows' ? 'win32' : undefined))) {
    throw new RemoteOpenError('editor_missing', 'That editor cannot open a folder on that computer.')
  }
  if (editorId === 'zed') return zedLaunch(input.host, folder)
  if (isJetBrainsIde(editorId)) return jetbrainsLaunch(editorId, input.host, folder)
  const uri = `vscode-remote://ssh-remote+${sshRemoteAuthority(input.host)}${encodeUriPath(folder)}`
  return { kind: 'command', args: ['--folder-uri', uri], uri }
}

/** Whether a program is a Windows batch file, which `cmd.exe` would read the arguments of. */
export const isBatchLauncher = (command: string): boolean => /\.(?:cmd|bat)$/iu.test(command.trim())

/** The Remote - SSH extension of an editor, and where the editor keeps its extensions under the home folder. */
const REMOTE_EXTENSIONS: Record<VscodeFamilyId, { directory: string; id: string; label: string }> = {
  vscode: { directory: '.vscode', id: 'ms-vscode-remote.remote-ssh', label: 'VS Code' },
  'vscode-insiders': { directory: '.vscode-insiders', id: 'ms-vscode-remote.remote-ssh', label: 'VS Code Insiders' },
  cursor: { directory: '.cursor', id: 'anysphere.remote-ssh', label: 'Cursor' },
  windsurf: { directory: '.windsurf', id: 'codeium.windsurf-remote-openssh', label: 'Windsurf' },
  vscodium: { directory: '.vscode-oss', id: 'jeanp413.open-remote-ssh', label: 'VSCodium' }
}

/** Names, lower-cased, that mark a Remote - SSH extension shipped inside an editor's app. */
const BUILT_IN_SSH = /remote-?(?:open)?ssh/u

/**
 * A short hint naming the extension to install, for an editor whose Remote - SSH extension cannot be found;
 * undefined when it is found, and when it cannot be told. It is only a hint: the open goes ahead either way,
 * and the editor asks for the extension itself when it is really missing.
 * - `home`'s `<editor folder>/extensions` is where a person's own installs go;
 * - `builtInDirectories` are the extension folders inside the editor's app (`resources/app/extensions`),
 *   where some editors (Windsurf, Antigravity) ship it. Any entry named like a Remote - SSH extension counts.
 * Nothing found because no folder could be read is "cannot be told".
 */
export function remoteExtensionHint(
  editorId: string,
  home: string,
  builtInDirectories: readonly string[],
  listDirectory: (path: string) => string[] | undefined
): string | undefined {
  // Zed has its SSH support built in, and JetBrains Toolbox installs what it needs itself.
  if (!isVscodeFamily(editorId)) return undefined
  const extension = REMOTE_EXTENSIONS[editorId]
  const prefix = `${extension.id}-`
  const own = listDirectory(`${home.replace(/[\\/]+$/u, '')}/${extension.directory}/extensions`)
  if (own?.some((entry) => entry.toLowerCase().startsWith(prefix) && /^\d/u.test(entry.slice(prefix.length)))) return undefined
  let read = own !== undefined
  for (const directory of builtInDirectories) {
    const entries = listDirectory(directory)
    if (!entries) continue
    read = true
    if (entries.some((entry) => BUILT_IN_SSH.test(entry.toLowerCase()))) return undefined
  }
  if (!read) return undefined
  return `If ${extension.label} asks for the Remote - SSH extension, install ${extension.id}, then open this folder again.`
}
