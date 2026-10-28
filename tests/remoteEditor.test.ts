import { describe, expect, it } from 'vitest'
import { remoteEditorPath } from '../src/shared/bridge/editorFolder'
import {
  checkedFolder,
  encodeUriPath,
  isBatchLauncher,
  isJetBrainsIde,
  JETBRAINS_IDE_HINTS,
  remoteExtensionHint,
  parseSshTarget,
  RemoteOpenError,
  remoteLaunchArguments,
  sshRemoteAuthority,
  supportsRemoteFolders,
  type RemoteHost
} from '../src/main/remoteEditor'
import { opensOnOwner } from '../src/shared/remoteEditor'

const hex = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('hex')
const approved = (endpoint: string): RemoteHost => ({ kind: 'ssh', target: parseSshTarget(endpoint)! })
const mousse = (alias: string): RemoteHost => ({ kind: 'mousse', alias })
const folderOf = (path: string, style: 'posix' | 'windows' = 'posix', platform?: string) => ({ path, style, uriPath: remoteEditorPath(path, style), ...(platform ? { platform } : {}) })
const launch = (editorId: string, host: RemoteHost, folder: unknown) => remoteLaunchArguments({ editorId, host, folder })

describe('which editors open a folder of another computer', () => {
  it('lists the editors with SSH support of their own and leaves out the rest', () => {
    for (const id of ['vscode', 'vscode-insiders', 'cursor', 'windsurf', 'vscodium', 'zed', 'idea', 'webstorm', 'pycharm', 'goland', 'rustrover', 'clion', 'rider', 'phpstorm']) {
      expect(supportsRemoteFolders(id), id).toBe(true)
    }
    for (const id of ['files', 'android-studio', 'sublime', 'xcode', 'nova', 'kiro', 'trae', 'antigravity', 'nope', '', 'toString', '__proto__']) expect(supportsRemoteFolders(id), id).toBe(false)
    expect(isJetBrainsIde('idea')).toBe(true)
    for (const id of ['zed', 'vscode', 'android-studio', 'toString', 'constructor']) expect(isJetBrainsIde(id), id).toBe(false)
  })

  it('refuses an editor that cannot', () => {
    expect(() => launch('sublime', approved('box'), folderOf('/srv/app'))).toThrow('That editor cannot open a folder on another computer.')
    expect(() => launch('files', approved('box'), folderOf('/srv/app'))).toThrow(RemoteOpenError)
  })

  it('leaves Zed out for a Windows computer and Windsurf out for any but Linux', () => {
    expect(opensOnOwner('zed', 'linux')).toBe(true)
    expect(opensOnOwner('zed', 'darwin')).toBe(true)
    expect(opensOnOwner('zed', 'win32')).toBe(false)
    expect(opensOnOwner('windsurf', 'linux')).toBe(true)
    expect(opensOnOwner('windsurf', 'darwin')).toBe(false)
    expect(opensOnOwner('windsurf', 'win32')).toBe(false)
    for (const id of ['vscode', 'cursor', 'vscodium', 'idea']) for (const platform of ['linux', 'darwin', 'win32']) expect(opensOnOwner(id, platform)).toBe(true)
    // Not known yet: not filtered here; the folder's answer decides.
    expect(opensOnOwner('zed', undefined)).toBe(true)
    expect(opensOnOwner('toString', 'win32')).toBe(true)
  })

  it('refuses Zed for a Windows folder and Windsurf for a Mac, from the folder the computer answered', () => {
    expect(() => launch('zed', mousse('mousse-w-aaaaaa'), folderOf('C:\\work', 'windows'))).toThrow('That editor cannot open a folder on that computer.')
    expect(() => launch('zed', mousse('mousse-w-aaaaaa'), folderOf('C:\\work', 'windows', 'win32'))).toThrow(RemoteOpenError)
    expect(() => launch('windsurf', mousse('mousse-m-aaaaaa'), folderOf('/Users/me/app', 'posix', 'darwin'))).toThrow(RemoteOpenError)
    expect(launch('windsurf', mousse('mousse-l-aaaaaa'), folderOf('/home/me/app', 'posix', 'linux')).kind).toBe('command')
    expect(launch('zed', mousse('mousse-m-aaaaaa'), folderOf('/Users/me/app', 'posix', 'darwin')).kind).toBe('command')
    // VS Code opens every system.
    expect(launch('vscode', mousse('mousse-w-aaaaaa'), folderOf('C:\\work', 'windows', 'win32')).kind).toBe('command')
  })
})

describe('the address of a remote folder', () => {
  it('uses --folder-uri with the SSH name as the host, for every editor that supports it', () => {
    for (const id of ['vscode', 'vscode-insiders', 'cursor', 'windsurf', 'vscodium']) {
      expect(launch(id, mousse('mousse-workbox-3fa2c1'), folderOf('/home/me/app'))).toEqual({
        kind: 'command',
        args: ['--folder-uri', 'vscode-remote://ssh-remote+mousse-workbox-3fa2c1/home/me/app'],
        uri: 'vscode-remote://ssh-remote+mousse-workbox-3fa2c1/home/me/app'
      })
    }
  })

  it('writes an approved address with a user, a port or an upper-case letter as the hex of the host record', () => {
    expect(launch('vscode', approved('build-box'), folderOf('/srv/app')).uri).toBe('vscode-remote://ssh-remote+build-box/srv/app')
    expect(launch('vscode', approved('me@box.example.com:2222'), folderOf('/srv/app')).uri).toBe(
      `vscode-remote://ssh-remote+${hex({ hostName: 'box.example.com', user: 'me', port: 2222 })}/srv/app`
    )
    expect(launch('cursor', approved('me@box'), folderOf('/srv/app')).uri).toBe(`vscode-remote://ssh-remote+${hex({ hostName: 'box', user: 'me' })}/srv/app`)
    expect(launch('windsurf', approved('Build-Box'), folderOf('/srv/app')).uri).toBe(`vscode-remote://ssh-remote+${hex({ hostName: 'Build-Box' })}/srv/app`)
    expect(launch('vscode', approved('box:2200'), folderOf('/srv/app')).uri).toBe(`vscode-remote://ssh-remote+${hex({ hostName: 'box', port: 2200 })}/srv/app`)
    expect(sshRemoteAuthority(approved('10.0.0.7'))).toBe('10.0.0.7')
    expect(sshRemoteAuthority(approved('me@[::1]'))).toBe(hex({ hostName: '::1', user: 'me' }))
  })

  it('writes a Windows folder from its drive', () => {
    expect(launch('vscode', mousse('mousse-w-aaaaaa'), folderOf('C:\\Users\\me\\My App', 'windows')).uri).toBe(
      'vscode-remote://ssh-remote+mousse-w-aaaaaa/C:/Users/me/My%20App'
    )
    expect(launch('cursor', mousse('mousse-w-aaaaaa'), folderOf('d:/work', 'windows')).uri).toBe('vscode-remote://ssh-remote+mousse-w-aaaaaa/d:/work')
    expect(launch('vscode', mousse('mousse-w-aaaaaa'), folderOf('E:\\', 'windows')).uri).toBe('vscode-remote://ssh-remote+mousse-w-aaaaaa/E:/')
  })

  it('encodes each segment, so `#`, `?`, `%`, spaces and quotes stay part of the name', () => {
    const encoded = (path: string) => encodeUriPath(checkedFolder(folderOf(path)))
    expect(encoded('/home/me/My Project/caf\u00e9 #1')).toBe('/home/me/My%20Project/caf%C3%A9%20%231')
    expect(encoded('/srv/100%/what?/a?b#c')).toBe('/srv/100%25/what%3F/a%3Fb%23c')
    expect(encoded("/srv/it's (1)!*")).toBe('/srv/it%27s%20%281%29%21%2A')
    // A backslash is an ordinary character in a posix name; it is encoded, not read as a separator.
    expect(encoded('/srv/a\\b')).toBe('/srv/a%5Cb')
    // A slash cannot appear inside a segment, so a name cannot climb out of its folder.
    expect(launch('vscode', mousse('mousse-w-aaaaaa'), folderOf('/srv/a%2Fb')).uri).toBe('vscode-remote://ssh-remote+mousse-w-aaaaaa/srv/a%252Fb')
    expect(launch('vscode', mousse('mousse-w-aaaaaa'), folderOf('/srv//app/./x/')).uri).toBe('vscode-remote://ssh-remote+mousse-w-aaaaaa/srv/app/x')
  })
})

describe('the Zed address', () => {
  it('gives Zed one ssh:// argument with the SSH name and the encoded path', () => {
    expect(launch('zed', mousse('mousse-workbox-3fa2c1'), folderOf('/home/me/My App #1'))).toEqual({
      kind: 'command',
      args: ['ssh://mousse-workbox-3fa2c1/home/me/My%20App%20%231'],
      uri: 'ssh://mousse-workbox-3fa2c1/home/me/My%20App%20%231'
    })
  })

  it('writes an approved address with its user and port, and an IPv6 host in brackets', () => {
    expect(launch('zed', approved('me@box.example.com:2222'), folderOf('/srv/app')).uri).toBe('ssh://me@box.example.com:2222/srv/app')
    expect(launch('zed', approved('Build-Box'), folderOf('/srv/app')).uri).toBe('ssh://Build-Box/srv/app')
    expect(launch('zed', approved('me@[::1]:22'), folderOf('/srv/app')).uri).toBe('ssh://me@[::1]:22/srv/app')
  })

  it('refuses a name that is not one of Mousse’s, and keeps shell words out of the argument', () => {
    expect(() => launch('zed', mousse('-oProxyCommand=id'), folderOf('/srv/app'))).toThrow(RemoteOpenError)
    for (const path of ['/srv/app --new-window', '/srv/$(id)', "/srv/'x'", '/srv/a b;c']) {
      const { uri } = launch('zed', mousse('mousse-w-aaaaaa'), folderOf(path))
      expect(uri.slice('ssh://mousse-w-aaaaaa'.length)).not.toMatch(/[\s"'`$;&|<>()\\]/u)
    }
  })
})

describe('the JetBrains Toolbox link', () => {
  const base = 'jetbrains://gateway/ssh/environment?'

  it('names the SSH name, the IDE to start there and the folder', () => {
    expect(launch('idea', mousse('mousse-workbox-3fa2c1'), folderOf('/home/me/app'))).toEqual({
      kind: 'link',
      uri: `${base}h=mousse-workbox-3fa2c1&launchIde=true&ideHint=IU&projectHint=/home/me/app`
    })
  })

  it('gives each JetBrains IDE its own product code', () => {
    const codes = { idea: 'IU', webstorm: 'WS', pycharm: 'PY', goland: 'GO', rustrover: 'RR', clion: 'CL', rider: 'RD', phpstorm: 'PS' }
    expect(JETBRAINS_IDE_HINTS).toEqual(codes)
    for (const [id, code] of Object.entries(codes)) {
      expect(launch(id, mousse('mousse-w-aaaaaa'), folderOf('/srv/app')).uri).toContain(`&ideHint=${code}&`)
    }
  })

  it('adds the user and port of an approved address', () => {
    expect(launch('goland', approved('me@box.example.com:2222'), folderOf('/srv/app')).uri).toBe(
      `${base}h=box.example.com&u=me&p=2222&launchIde=true&ideHint=GO&projectHint=/srv/app`
    )
    expect(launch('goland', approved('[::1]'), folderOf('/srv/app')).uri).toBe(`${base}h=%3A%3A1&launchIde=true&ideHint=GO&projectHint=/srv/app`)
  })

  it('writes a Windows folder from its drive, without the leading slash', () => {
    expect(launch('rider', mousse('mousse-w-aaaaaa'), folderOf('C:\\Users\\me\\My App', 'windows')).uri).toBe(
      `${base}h=mousse-w-aaaaaa&launchIde=true&ideHint=RD&projectHint=C:/Users/me/My%20App`
    )
  })

  it('encodes the path so it cannot add or change a field of the link', () => {
    const { uri } = launch('webstorm', mousse('mousse-w-aaaaaa'), folderOf('/srv/a&h=evil/b?c#d'))
    expect(uri).toBe(`${base}h=mousse-w-aaaaaa&launchIde=true&ideHint=WS&projectHint=/srv/a%26h%3Devil/b%3Fc%23d`)
    const fields = new URL(uri).searchParams
    expect(fields.getAll('h')).toEqual(['mousse-w-aaaaaa'])
    expect(fields.get('projectHint')).toBe('/srv/a&h=evil/b?c#d')
    expect(() => launch('idea', mousse('mousse-a&b'), folderOf('/srv/app'))).toThrow(RemoteOpenError)
  })
})

describe('the answer of the computer that runs the thread is checked, not trusted', () => {
  it('accepts an answer that agrees with itself', () => {
    expect(checkedFolder(folderOf('/home/me/app'))).toEqual({ style: 'posix', path: '/home/me/app', uriPath: '/home/me/app' })
    expect(checkedFolder(folderOf('/home/me/app', 'posix', 'linux'))).toEqual({ style: 'posix', path: '/home/me/app', uriPath: '/home/me/app', platform: 'linux' })
    expect(checkedFolder(folderOf('C:\\Users\\me\\app', 'windows'))).toEqual({
      style: 'windows',
      path: 'C:\\Users\\me\\app',
      uriPath: '/C:/Users/me/app'
    })
    // A folder that was checked once passes again.
    const once = checkedFolder(folderOf('C:\\Users\\me\\app', 'windows'))
    expect(checkedFolder(once)).toEqual(once)
  })

  it('refuses a uriPath that is not what its own path gives', () => {
    const refuse = (answer: unknown) => expect(() => checkedFolder(answer)).toThrow(/cannot be opened in an editor/)
    refuse({ path: '/home/me/app', style: 'posix', uriPath: '/etc' })
    refuse({ path: '/home/me/app', style: 'posix', uriPath: '/home/me/app/../../etc' })
    refuse({ path: '/home/me/app', style: 'posix', uriPath: '/home/me/app/' })
    refuse({ path: 'C:\\Users\\me', style: 'windows', uriPath: '/c:/Users/me' })
    refuse({ path: 'C:\\Users\\me', style: 'posix', uriPath: '/C:/Users/me' })
    // The drive-less form of a Windows path is not an address.
    refuse({ path: '/home/me', style: 'windows', uriPath: '/home/me' })
  })

  it('refuses paths that are not folders to name by path', () => {
    const refuse = (path: string, style: 'posix' | 'windows' = 'posix') => expect(() => checkedFolder({ path, style, uriPath: path })).toThrow(RemoteOpenError)
    refuse('relative/dir')
    refuse('/srv/../etc')
    refuse('/srv/app\n--new-window')
    refuse('/srv/app\u0000')
    refuse('\\\\server\\share\\dir', 'windows')
    refuse('\\\\?\\C:\\dir', 'windows')
    refuse('C:relative', 'windows')
    refuse('')
  })

  it('keeps the system the computer reported only when it agrees with the folder’s style', () => {
    expect(checkedFolder(folderOf('/home/me/app', 'posix', 'win32'))).not.toHaveProperty('platform')
    expect(checkedFolder(folderOf('C:\\x', 'windows', 'linux'))).not.toHaveProperty('platform')
    expect(checkedFolder({ ...folderOf('/home/me/app'), platform: 'linux; id' })).not.toHaveProperty('platform')
    expect(checkedFolder({ ...folderOf('/home/me/app'), platform: 7 })).not.toHaveProperty('platform')
  })

  it('refuses anything that is not an object with those three fields', () => {
    for (const answer of [null, undefined, 'x', 3, [], {}, { path: '/x' }, { path: '/x', uriPath: '/x' }, { path: '/x', uriPath: '/x', style: 'dos' }, { path: 7, uriPath: '/x', style: 'posix' }]) {
      expect(() => checkedFolder(answer)).toThrow(RemoteOpenError)
    }
  })

  it('keeps the owner path out of the way of the command line: nothing in the address is a flag or a shell word', () => {
    const attacks = ['/srv/app --new-window', '/srv/app;id', '/srv/$(id)', '/srv/`id`', "/srv/'x'", '/srv/a"b', '/srv/a|b', '/srv/a&b', '/srv/a b%00']
    for (const path of attacks) {
      const launched = launch('vscode', mousse('mousse-w-aaaaaa'), folderOf(path))
      if (launched.kind !== 'command') throw new Error('expected a command')
      const { args, uri } = launched
      // One flag, one value; the value starts with the scheme and holds no raw space, quote or shell character.
      expect(args).toHaveLength(2)
      expect(args[0]).toBe('--folder-uri')
      expect(uri.startsWith('vscode-remote://ssh-remote+mousse-w-aaaaaa/')).toBe(true)
      expect(uri.slice('vscode-remote://ssh-remote+mousse-w-aaaaaa'.length)).not.toMatch(/[\s"'`$;&|<>()\\]/u)
    }
  })
})

describe('the SSH name an editor connects to', () => {
  it('uses one of Mousse\u2019s own names only in its own shape', () => {
    expect(sshRemoteAuthority(mousse('mousse-workbox-3fa2c1'))).toBe('mousse-workbox-3fa2c1')
    for (const alias of ['workbox', 'Mousse-x', 'mousse-', 'mousse-a b', 'mousse-a/../b', 'mousse-a@b', '-oProxyCommand=id', 'mousse-a;id', 'mousse-' + 'a'.repeat(81)]) {
      expect(() => sshRemoteAuthority(mousse(alias))).toThrow(RemoteOpenError)
    }
  })

  it('reads an approved address in the shape SSH setup stores, and refuses anything that could be an option', () => {
    expect(parseSshTarget('me@box.example.com:2222')).toEqual({ user: 'me', host: 'box.example.com', port: 2222 })
    expect(parseSshTarget('box')).toEqual({ host: 'box' })
    expect(parseSshTarget('[::1]:22')).toEqual({ host: '::1', port: 22 })
    for (const bad of ['-oProxyCommand=id', '-p', 'me@-box', 'box name', 'box;id', 'box$(id)', 'ssh://box', 'box/path', 'box:0', 'box:70000', '', 'a'.repeat(300), 'me@@box', 'box\nHost x', 42, null, undefined]) {
      expect(parseSshTarget(bad)).toBeUndefined()
    }
  })
})

describe('the hint about the Remote - SSH extension', () => {
  /** A disk: folder path to the names inside it; anything else cannot be read. */
  const disk = (folders: Record<string, string[]>) => (path: string) => folders[path]
  const own = (editor: string) => `/home/me/${editor}/extensions`

  it('names the extension when the editor’s own folder is readable and does not have it', () => {
    expect(remoteExtensionHint('vscode', '/home/me', [], disk({ [own('.vscode')]: ['ms-python.python-2024.1.0'] }))).toBe(
      'If VS Code asks for the Remote - SSH extension, install ms-vscode-remote.remote-ssh, then open this folder again.'
    )
    expect(remoteExtensionHint('cursor', '/home/me', [], disk({ [own('.cursor')]: [] }))).toContain('anysphere.remote-ssh')
    expect(remoteExtensionHint('vscodium', '/home/me', [], disk({ [own('.vscode-oss')]: [] }))).toContain('jeanp413.open-remote-ssh')
    expect(remoteExtensionHint('vscode-insiders', '/home/me', [], disk({ [own('.vscode-insiders')]: [] }))).toContain('VS Code Insiders')
  })

  it('stays quiet when the extension is in the person’s own folder', () => {
    expect(remoteExtensionHint('vscode', '/home/me', [], disk({ [own('.vscode')]: ['ms-vscode-remote.remote-ssh-0.110.0'] }))).toBeUndefined()
    expect(remoteExtensionHint('vscode', '/home/me', [], disk({ [own('.vscode')]: ['MS-VSCODE-REMOTE.REMOTE-SSH-0.110.0'] }))).toBeUndefined()
  })

  it('stays quiet when the editor ships it inside its app, as Windsurf and Antigravity do', () => {
    const builtIn = '/opt/windsurf/resources/app/extensions'
    const folders = { [own('.windsurf')]: ['codeium.windsurfpyright-1.0.0'], [builtIn]: ['git', 'windsurf-remote-openssh', 'json'] }
    expect(remoteExtensionHint('windsurf', '/home/me', [builtIn], disk(folders))).toBeUndefined()
    expect(remoteExtensionHint('windsurf', '/home/me', ['/other/extensions', builtIn], disk(folders))).toBeUndefined()
    // The same folder without it: the hint shows.
    expect(remoteExtensionHint('windsurf', '/home/me', [builtIn], disk({ ...folders, [builtIn]: ['git', 'json'] }))).toContain('codeium.windsurf-remote-openssh')
  })

  it('says nothing when no folder can be read, and for an editor without remote support', () => {
    expect(remoteExtensionHint('vscode', '/home/me', ['/app/extensions'], disk({}))).toBeUndefined()
    expect(remoteExtensionHint('idea', '/home/me', [], disk({ [own('.idea')]: [] }))).toBeUndefined()
  })

  it('counts a built-in folder as readable even when the person’s own folder is not', () => {
    expect(remoteExtensionHint('vscode', '/home/me', ['/app/extensions'], disk({ '/app/extensions': ['git'] }))).toContain('ms-vscode-remote.remote-ssh')
  })

  it('looks in the editor’s own folder under the home folder', () => {
    const seen: string[] = []
    remoteExtensionHint('vscodium', 'C:\\Users\\me\\', [], (path) => (seen.push(path), undefined))
    expect(seen).toEqual(['C:\\Users\\me/.vscode-oss/extensions'])
  })
})

describe('batch launchers', () => {
  it('recognises a .cmd or .bat file in any case', () => {
    for (const name of ['C:\\x\\code.cmd', 'code.BAT', ' code.Cmd ']) expect(isBatchLauncher(name)).toBe(true)
    for (const name of ['C:\\x\\Code.exe', '/usr/bin/code', 'code.cmd.exe', 'cmd']) expect(isBatchLauncher(name)).toBe(false)
  })
})
