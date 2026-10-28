/**
 * Opening a folder of another computer in an editor installed on this one, through the editor's own
 * Remote - SSH support. This module only builds the command; `editors.ts` runs it.
 *
 * Everything that reaches the command comes from outside this process and is treated as untrusted:
 * - the folder is what another computer answered to `editor.folder`; it is worked out again from its
 *   own `path` and refused when the answer does not agree with itself;
 * - the host is either the SSH address this computer approved for that computer (a record on this
 *   computer, checked again against the shape SSH setup accepts) or one of Mousse's own SSH names.
 * The command is an argument array. Nothing goes through a shell, no key or secret is passed, and a host
 * and a path are written into the address only after the checks below.
 */
import { remoteEditorPath, type EditorFolderStyle } from '../shared/bridge/editorFolder'

/** The editors that open a folder over their own Remote - SSH, in the order the picker lists them. */
export const REMOTE_EDITOR_IDS = ['vscode', 'cursor', 'windsurf', 'vscodium', 'vscode-insiders'] as const
export type RemoteEditorId = (typeof REMOTE_EDITOR_IDS)[number]

export function supportsRemoteFolders(editorId: string): editorId is RemoteEditorId {
  return (REMOTE_EDITOR_IDS as readonly string[]).includes(editorId)
}

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
  const { path, uriPath, style } = answer as Record<string, unknown>
  if (style !== 'posix' && style !== 'windows') return refuse()
  const derived = remoteEditorPath(path, style)
  if (!derived || derived !== uriPath) return refuse()
  return { style, path: path as string, uriPath: derived }
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

export interface RemoteLaunch {
  args: string[]
  /** The address the editor is given, for tests and logs. Holds no secret. */
  uri: string
}

/** The arguments that open `folder` on `host` in the editor, or a refusal. */
export function remoteLaunchArguments(input: { editorId: string; host: RemoteHost; folder: unknown }): RemoteLaunch {
  if (!supportsRemoteFolders(input.editorId)) {
    throw new RemoteOpenError('editor_missing', 'That editor cannot open a folder on another computer. Choose VS Code, Cursor, Windsurf or VSCodium.')
  }
  const folder = checkedFolder(input.folder)
  const uri = `vscode-remote://ssh-remote+${sshRemoteAuthority(input.host)}${encodeUriPath(folder)}`
  return { args: ['--folder-uri', uri], uri }
}

/** Whether a program is a Windows batch file, which `cmd.exe` would read the arguments of. */
export const isBatchLauncher = (command: string): boolean => /\.(?:cmd|bat)$/iu.test(command.trim())

/** The Remote - SSH extension of an editor, and where the editor keeps its extensions under the home folder. */
const REMOTE_EXTENSIONS: Record<RemoteEditorId, { directory: string; id: string; label: string }> = {
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
  if (!supportsRemoteFolders(editorId)) return undefined
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
