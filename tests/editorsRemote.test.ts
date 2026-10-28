import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getFileIcon: vi.fn() }, nativeImage: { createThumbnailFromPath: vi.fn() }, shell: { openPath: vi.fn() } }))

import {
  builtInExtensionDirectories,
  detectEditors,
  editorLaunchEnvironment,
  openRemoteInEditor,
  planRemoteOpen,
  remoteEditorCommand,
  remoteLauncher,
  type DetectedEditor,
  type EditorDetectionEnv,
  type RemoteOpenIo
} from '../src/main/editors'
import { newId } from '../src/shared/net'
import { qualifyId } from '../src/shared/threadRef'

const env = (patch: Partial<EditorDetectionEnv> & { files?: string[]; commands?: Record<string, string> }): EditorDetectionEnv => {
  const files = new Set(patch.files ?? [])
  const commands = patch.commands ?? {}
  return {
    platform: 'darwin',
    home: '/Users/me',
    exists: (path) => files.has(path),
    findOnPath: (name) => commands[name] ?? null,
    ...patch
  }
}

describe('VSCodium', () => {
  it('is detected like the other VS Code editors', () => {
    expect(detectEditors(env({ platform: 'linux', commands: { codium: '/usr/bin/codium' } }))).toEqual([{ id: 'vscodium', label: 'VSCodium', launcherPath: '/usr/bin/codium' }])
    const local = 'C:\\Users\\me\\AppData\\Local'
    const exe = win32.join(local, 'Programs', 'VSCodium', 'VSCodium.exe')
    expect(detectEditors(env({ platform: 'win32', localAppData: local, files: [exe] }))).toEqual([{ id: 'vscodium', label: 'VSCodium', launcherPath: exe }])
  })
})

describe('opening a folder of another computer', () => {
  const nowhere = '/nonexistent/home'
  const host = { kind: 'mousse', alias: 'mousse-studio-3fa2c1' } as const
  const folder = { path: '/home/me/app', uriPath: '/home/me/app', style: 'posix' }
  const uri = 'vscode-remote://ssh-remote+mousse-studio-3fa2c1/home/me/app'

  it('runs the command inside the macOS app bundle with the remote folder address, never a shell string', () => {
    const app = '/Applications/Visual Studio Code.app'
    const bundled = `${app}/Contents/Resources/app/bin/code`
    const plan = planRemoteOpen({ id: 'vscode', label: 'VS Code', appPath: app }, { host, folder }, env({ home: nowhere, files: [bundled] }))
    expect(plan).toEqual({ command: bundled, args: ['--folder-uri', uri] })
  })

  it('uses the launcher found on Linux and Windows', () => {
    const linux = planRemoteOpen({ id: 'cursor', label: 'Cursor', launcherPath: '/usr/bin/cursor' }, { host, folder }, env({ platform: 'linux', home: nowhere }))
    expect(linux).toEqual({ command: '/usr/bin/cursor', args: ['--folder-uri', uri] })
    const exe = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
    const windows = planRemoteOpen(
      { id: 'vscode', label: 'VS Code', launcherPath: exe },
      { host, folder: { path: 'D:\\work\\app', uriPath: '/D:/work/app', style: 'windows' } },
      env({ platform: 'win32', home: nowhere })
    )
    expect(windows).toEqual({ command: exe, args: ['--folder-uri', 'vscode-remote://ssh-remote+mousse-studio-3fa2c1/D:/work/app'] })
  })

  it('finds the bundled command of VSCodium, falls back to the command on PATH, and to nothing otherwise', () => {
    const codium = '/Applications/VSCodium.app'
    const bundled = `${codium}/Contents/Resources/app/bin/codium`
    expect(remoteLauncher({ id: 'vscodium', label: 'VSCodium', appPath: codium }, env({ files: [bundled] }))).toBe(bundled)
    const app = '/Applications/Cursor.app'
    expect(remoteLauncher({ id: 'cursor', label: 'Cursor', appPath: app }, env({ commands: { cursor: '/usr/local/bin/cursor' } }))).toBe('/usr/local/bin/cursor')
    expect(remoteLauncher({ id: 'cursor', label: 'Cursor', appPath: app }, env({}))).toBeNull()
    expect(() => remoteEditorCommand({ id: 'cursor', label: 'Cursor', appPath: app }, env({ home: nowhere }))).toThrow('Could not find the command that starts Cursor.')
  })

  it('refuses a crafted folder or host before it gives a command', () => {
    const editor = { id: 'vscode', label: 'VS Code', launcherPath: '/usr/bin/code' }
    const linux = env({ platform: 'linux', home: nowhere })
    for (const path of ['/srv/app\n--new-window', '/srv/../etc', 'relative']) {
      expect(() => planRemoteOpen(editor, { host, folder: { path, uriPath: path, style: 'posix' } }, linux)).toThrow(/cannot be opened in an editor/)
    }
    // A name with shell words is a legal folder name. It reaches the editor encoded, as one argument.
    const odd = planRemoteOpen(editor, { host, folder: { path: '/srv/app; id', uriPath: '/srv/app; id', style: 'posix' } }, linux)
    expect(odd.args).toEqual(['--folder-uri', 'vscode-remote://ssh-remote+mousse-studio-3fa2c1/srv/app%3B%20id'])
    expect(() => planRemoteOpen(editor, { host: { kind: 'mousse', alias: '-oProxyCommand=id' }, folder }, linux)).toThrow(/not valid/)
  })

  it('finds the bundled script of VS Code Insiders under either name, then the command on PATH', () => {
    const app = '/Applications/Visual Studio Code - Insiders.app'
    const insiders = { id: 'vscode-insiders', label: 'VS Code Insiders', appPath: app }
    expect(remoteLauncher(insiders, env({ files: [`${app}/Contents/Resources/app/bin/code`] }))).toBe(`${app}/Contents/Resources/app/bin/code`)
    expect(remoteLauncher(insiders, env({ files: [`${app}/Contents/Resources/app/bin/code-insiders`] }))).toBe(`${app}/Contents/Resources/app/bin/code-insiders`)
    expect(remoteLauncher(insiders, env({ commands: { 'code-insiders': '/usr/local/bin/code-insiders' } }))).toBe('/usr/local/bin/code-insiders')
  })

  it('never uses a batch file as the launcher on Windows', () => {
    const editor = { id: 'vscode', label: 'VS Code', launcherPath: 'C:\\Tools\\code.cmd' }
    expect(() => remoteEditorCommand(editor, env({ platform: 'win32' }))).toThrow('Could not find the command that starts VS Code.')
    expect(() => remoteEditorCommand({ ...editor, launcherPath: 'C:\\Tools\\code.BAT' }, env({ platform: 'win32' }))).toThrow(/Could not find/)
    expect(remoteEditorCommand({ ...editor, launcherPath: 'C:\\Tools\\Code.exe' }, env({ platform: 'win32' }))).toBe('C:\\Tools\\Code.exe')
  })

  it('looks for the editor’s own extensions inside its app', () => {
    expect(builtInExtensionDirectories({ id: 'windsurf', label: 'Windsurf', appPath: '/Applications/Windsurf.app' })).toEqual(['/Applications/Windsurf.app/Contents/Resources/app/extensions'])
    expect(builtInExtensionDirectories({ id: 'vscode', label: 'VS Code', launcherPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe' })).toEqual([
      'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\resources\\app\\extensions'
    ])
    // A Linux launcher is usually a link: the folder is found from where it leads.
    const dirs = builtInExtensionDirectories({ id: 'vscode', label: 'VS Code', launcherPath: '/usr/bin/code' }, () => '/usr/share/code/bin/code')
    expect(dirs).toContain('/usr/share/code/resources/app/extensions')
  })

  it('takes out of the environment what would send the editor’s command elsewhere', () => {
    const clean = editorLaunchEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/me',
      VSCODE_IPC_HOOK_CLI: '/tmp/vscode-ipc.sock',
      VSCODE_GIT_ASKPASS_NODE: '/x',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      NODE_OPTIONS: '--require /tmp/x.js',
      node_options: 'x'
    })
    expect(clean).toEqual({ PATH: '/usr/bin', HOME: '/home/me' })
  })

  describe('the whole open, with a fake daemon and a fake launcher', () => {
    const node = newId('node')
    const threadId = qualifyId(node, 't1')
    const code: DetectedEditor = { id: 'vscode', label: 'VS Code', launcherPath: '/usr/bin/code' }
    const answer = { path: '/home/me/app', uriPath: '/home/me/app', style: 'posix', platform: 'linux', kind: 'project' }

    function fixture(patch: { approval?: string; detected?: DetectedEditor[]; exists?: boolean; folders?: Record<string, string[]>; processEnv?: NodeJS.ProcessEnv; proxyReady?: boolean } = {}) {
      const launched: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = []
      const asked: string[] = []
      const io: RemoteOpenIo = {
        detected: async () => patch.detected ?? [code],
        env: () => ({ ...env({ platform: 'linux', home: nowhere }), exists: () => patch.exists ?? true }),
        launch: async (command, args, launchEnv) => {
          launched.push({ command, args, env: launchEnv })
        },
        list: (path) => patch.folders?.[path],
        processEnv: () => patch.processEnv ?? { PATH: '/usr/bin' },
        forgetDetected: () => {},
        proxyReady: patch.proxyReady ?? false
      }
      const ask = async (method: string) => {
        asked.push(method)
        if (method === 'net.ssh.target') return patch.approval ? { endpoint: patch.approval } : {}
        if (method === 'editor.folder') return answer
        throw new Error(`unexpected ${method}`)
      }
      return { io, ask, launched, asked }
    }

    it('starts the editor with the approved address and the owner\u2019s folder', async () => {
      const f = fixture({ approval: 'me@box.example.com:2222' })
      expect(await openRemoteInEditor('vscode', threadId, f.ask, f.io)).toEqual({ ok: true })
      const hex = Buffer.from('{"hostName":"box.example.com","user":"me","port":2222}').toString('hex')
      expect(f.launched).toEqual([{ command: '/usr/bin/code', args: ['--folder-uri', `vscode-remote://ssh-remote+${hex}/home/me/app`], env: { PATH: '/usr/bin' } }])
    })

    it('opens a computer with an approved address over that address, whatever the owner’s editor switch says, once Mousse’s own names are on', async () => {
      // The approved address is the person's own SSH: no tunnel, no owner switch, no Include line.
      const f = fixture({ approval: 'me@box.example.com:2222', proxyReady: true })
      expect(await openRemoteInEditor('vscode', threadId, f.ask, f.io)).toEqual({ ok: true })
      const hex = Buffer.from('{"hostName":"box.example.com","user":"me","port":2222}').toString('hex')
      expect(f.launched[0].args).toEqual(['--folder-uri', `vscode-remote://ssh-remote+${hex}/home/me/app`])
      expect(f.asked).toEqual(['net.ssh.target', 'editor.folder'])
    })

    it('starts the editor without the variables that would send it to another window', async () => {
      const f = fixture({ approval: 'box', processEnv: { PATH: '/usr/bin', VSCODE_IPC_HOOK_CLI: '/tmp/x.sock', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' } })
      await openRemoteInEditor('vscode', threadId, f.ask, f.io)
      expect(f.launched[0].env).toEqual({ PATH: '/usr/bin' })
    })

    it('opens anyway when the Remote - SSH extension cannot be found, and hints at it', async () => {
      const f = fixture({ approval: 'box', folders: { '/nonexistent/home/.vscode/extensions': ['ms-python.python-1.0.0'] } })
      const result = await openRemoteInEditor('vscode', threadId, f.ask, f.io)
      expect(result).toEqual({ ok: true, hint: 'If VS Code asks for the Remote - SSH extension, install ms-vscode-remote.remote-ssh, then open this folder again.' })
      expect(f.launched).toHaveLength(1)
    })

    it('gives no hint when the extension is built into the editor', async () => {
      const f = fixture({
        approval: 'box',
        detected: [{ id: 'windsurf', label: 'Windsurf', launcherPath: '/opt/windsurf/bin/windsurf' }],
        folders: { '/nonexistent/home/.windsurf/extensions': [], '/opt/windsurf/resources/app/extensions': ['windsurf-remote-openssh'] }
      })
      expect(await openRemoteInEditor('windsurf', threadId, f.ask, f.io)).toEqual({ ok: true })
      expect(f.launched).toHaveLength(1)
    })

    it('starts nothing and asks the owner nothing without an SSH route', async () => {
      const f = fixture()
      expect(await openRemoteInEditor('vscode', threadId, f.ask, f.io)).toEqual({ ok: false, reason: 'no_route' })
      expect(f.launched).toEqual([])
      expect(f.asked).toEqual(['net.ssh.target'])
    })

    it('refuses an editor that cannot open remote folders, and one that is not installed', async () => {
      const f = fixture({ approval: 'box' })
      expect(await openRemoteInEditor('zed', threadId, f.ask, f.io)).toMatchObject({ ok: false, reason: 'editor_missing' })
      expect(await openRemoteInEditor('cursor', threadId, f.ask, f.io)).toEqual({ ok: false, reason: 'editor_missing', message: 'That editor is not installed.' })
      expect(f.launched).toEqual([])
      expect(f.asked).toEqual([])
    })

    it('says the editor is gone when its command no longer exists', async () => {
      const f = fixture({ approval: 'box', exists: false })
      expect(await openRemoteInEditor('vscode', threadId, f.ask, f.io)).toEqual({ ok: false, reason: 'editor_missing', message: 'VS Code is no longer installed.' })
      expect(f.launched).toEqual([])
    })
  })
})
