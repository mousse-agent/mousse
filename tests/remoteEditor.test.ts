import { describe, expect, it } from 'vitest'
import { remoteEditorPath } from '../src/shared/bridge/editorFolder'
import {
  checkedFolder,
  encodeUriPath,
  missingRemoteExtension,
  parseSshTarget,
  RemoteOpenError,
  remoteLaunchArguments,
  sshRemoteAuthority,
  supportsRemoteFolders,
  type RemoteHost
} from '../src/main/remoteEditor'

const hex = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('hex')
const approved = (endpoint: string): RemoteHost => ({ kind: 'ssh', target: parseSshTarget(endpoint)! })
const mousse = (alias: string): RemoteHost => ({ kind: 'mousse', alias })
const folderOf = (path: string, style: 'posix' | 'windows' = 'posix') => ({ path, style, uriPath: remoteEditorPath(path, style) })
const launch = (editorId: string, host: RemoteHost, folder: unknown) => remoteLaunchArguments({ editorId, host, folder })

describe('which editors open a folder of another computer', () => {
  it('lists the editors with Remote - SSH of their own and leaves out the rest', () => {
    for (const id of ['vscode', 'vscode-insiders', 'cursor', 'windsurf', 'vscodium']) expect(supportsRemoteFolders(id)).toBe(true)
    for (const id of ['files', 'zed', 'idea', 'webstorm', 'sublime', 'xcode', 'nova', 'kiro', 'trae', 'antigravity', 'nope', '']) expect(supportsRemoteFolders(id)).toBe(false)
  })

  it('refuses an editor that cannot, naming those that can', () => {
    expect(() => launch('idea', approved('box'), folderOf('/srv/app'))).toThrow(/VS Code, Cursor, Windsurf or VSCodium/)
    expect(() => launch('files', approved('box'), folderOf('/srv/app'))).toThrow(RemoteOpenError)
  })
})

describe('the address of a remote folder', () => {
  it('uses --folder-uri with the SSH name as the host, for every editor that supports it', () => {
    for (const id of ['vscode', 'vscode-insiders', 'cursor', 'windsurf', 'vscodium']) {
      expect(launch(id, mousse('mousse-workbox-3fa2c1'), folderOf('/home/me/app'))).toEqual({
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

describe('the answer of the computer that runs the thread is checked, not trusted', () => {
  it('accepts an answer that agrees with itself', () => {
    expect(checkedFolder(folderOf('/home/me/app'))).toEqual({ style: 'posix', path: '/home/me/app', uriPath: '/home/me/app' })
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

  it('refuses anything that is not an object with those three fields', () => {
    for (const answer of [null, undefined, 'x', 3, [], {}, { path: '/x' }, { path: '/x', uriPath: '/x' }, { path: '/x', uriPath: '/x', style: 'dos' }, { path: 7, uriPath: '/x', style: 'posix' }]) {
      expect(() => checkedFolder(answer)).toThrow(RemoteOpenError)
    }
  })

  it('keeps the owner path out of the way of the command line: nothing in the address is a flag or a shell word', () => {
    const attacks = ['/srv/app --new-window', '/srv/app;id', '/srv/$(id)', '/srv/`id`', "/srv/'x'", '/srv/a"b', '/srv/a|b', '/srv/a&b', '/srv/a b%00']
    for (const path of attacks) {
      const { args, uri } = launch('vscode', mousse('mousse-w-aaaaaa'), folderOf(path))
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

describe('the Remote - SSH extension', () => {
  const list = (entries: string[] | undefined) => (path: string) => (path.endsWith('/extensions') ? entries : undefined)

  it('names the extension to install when the extensions folder is readable and does not have it', () => {
    expect(missingRemoteExtension('vscode', '/home/me', list(['ms-python.python-2024.1.0']))).toBe(
      'Install the Remote - SSH extension (ms-vscode-remote.remote-ssh) in VS Code, then open this folder again.'
    )
    expect(missingRemoteExtension('cursor', '/home/me', list([]))).toContain('anysphere.remote-ssh')
    expect(missingRemoteExtension('vscodium', '/home/me', list([]))).toContain('jeanp413.open-remote-ssh')
    expect(missingRemoteExtension('windsurf', '/home/me', list([]))).toContain('codeium.windsurf-remote-openssh')
    expect(missingRemoteExtension('vscode-insiders', '/home/me', list([]))).toContain('VS Code Insiders')
  })

  it('stays quiet when the extension is there, and when the folder cannot be read', () => {
    expect(missingRemoteExtension('vscode', '/home/me', list(['ms-vscode-remote.remote-ssh-0.110.0']))).toBeUndefined()
    expect(missingRemoteExtension('vscode', '/home/me', list(['MS-VSCODE-REMOTE.REMOTE-SSH-0.110.0']))).toBeUndefined()
    expect(missingRemoteExtension('vscode', '/home/me', list(undefined))).toBeUndefined()
    // A different extension that only shares the start of the name does not count.
    expect(missingRemoteExtension('vscode', '/home/me', list(['ms-vscode-remote.remote-ssh-edit-0.86.0']))).toContain('Install the Remote - SSH extension')
    expect(missingRemoteExtension('idea', '/home/me', list([]))).toBeUndefined()
  })

  it('looks in the editor\u2019s own folder under the home folder', () => {
    const seen: string[] = []
    missingRemoteExtension('vscodium', 'C:\\Users\\me\\', (path) => (seen.push(path), undefined))
    expect(seen).toEqual(['C:\\Users\\me/.vscode-oss/extensions'])
  })
})
