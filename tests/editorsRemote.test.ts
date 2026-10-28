import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getFileIcon: vi.fn() }, nativeImage: { createThumbnailFromPath: vi.fn() }, shell: { openPath: vi.fn() } }))

import {
  builtInExtensionDirectories,
  detectEditors,
  detectToolbox,
  EDITOR_CATALOG,
  editorLaunchEnvironment,
  openRemoteInEditor,
  opensRemoteFolders,
  planRemoteOpen,
  remoteEditorCommand,
  remoteLauncher,
  type DetectedEditor,
  type EditorDetectionEnv,
  type RemoteOpenIo
} from '../src/main/editors'
import { JETBRAINS_IDE_HINTS } from '../src/main/remoteEditor'
import type { SshProbeOutcome } from '../src/main/remoteEditorFlow'
import { newId } from '../src/shared/net'
import type { EditorProbeResult } from '../src/shared/net/local'
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

describe('Zed and the JetBrains IDEs', () => {
  it('has a JetBrains Toolbox product code for every JetBrains IDE of the catalog but Android Studio', () => {
    const jetbrains = ['idea', 'webstorm', 'pycharm', 'goland', 'rustrover', 'clion', 'rider', 'phpstorm']
    for (const id of jetbrains) expect(EDITOR_CATALOG.some((definition) => definition.id === id), id).toBe(true)
    expect(Object.keys(JETBRAINS_IDE_HINTS).sort()).toEqual([...jetbrains].sort())
  })

  it('finds JetBrains Toolbox where it installs itself', () => {
    expect(detectToolbox(env({ files: ['/Users/me/Applications/JetBrains Toolbox.app'] }))).toBe('/Users/me/Applications/JetBrains Toolbox.app')
    const local = 'C:\\Users\\me\\AppData\\Local'
    const exe = win32.join(local, 'JetBrains', 'Toolbox', 'bin', 'jetbrains-toolbox.exe')
    expect(detectToolbox(env({ platform: 'win32', localAppData: local, files: [exe] }))).toBe(exe)
    expect(detectToolbox(env({ platform: 'linux', home: '/home/me', files: ['/home/me/.local/share/JetBrains/Toolbox/bin/jetbrains-toolbox'] }))).toBe(
      '/home/me/.local/share/JetBrains/Toolbox/bin/jetbrains-toolbox'
    )
    expect(detectToolbox(env({ platform: 'linux', commands: { 'jetbrains-toolbox': '/usr/bin/jetbrains-toolbox' } }))).toBe('/usr/bin/jetbrains-toolbox')
    expect(detectToolbox(env({ platform: 'linux' }))).toBeUndefined()
  })

  it('lists a JetBrains IDE for a remote folder only with Toolbox, and Zed always', () => {
    const toolbox = '/Applications/JetBrains Toolbox.app'
    const files = ['/Applications/IntelliJ IDEA.app', '/Applications/Zed.app', '/Applications/Android Studio.app']
    const withToolbox = detectEditors(env({ files: [...files, toolbox] }))
    expect(withToolbox).toEqual([
      { id: 'zed', label: 'Zed', appPath: '/Applications/Zed.app' },
      { id: 'idea', label: 'IntelliJ IDEA', appPath: '/Applications/IntelliJ IDEA.app', toolboxPath: toolbox },
      { id: 'android-studio', label: 'Android Studio', appPath: '/Applications/Android Studio.app' }
    ])
    expect(withToolbox.map(opensRemoteFolders)).toEqual([true, true, false])
    const without = detectEditors(env({ files }))
    expect(without.map(opensRemoteFolders)).toEqual([true, false, false])
  })

  it('starts Zed with its own command: the app’s cli on macOS, bin\\zed.exe on Windows', () => {
    const app = '/Applications/Zed.app'
    expect(remoteLauncher({ id: 'zed', label: 'Zed', appPath: app }, env({ files: [`${app}/Contents/MacOS/cli`] }))).toBe(`${app}/Contents/MacOS/cli`)
    expect(remoteLauncher({ id: 'zed', label: 'Zed', appPath: app }, env({ commands: { zed: '/usr/local/bin/zed' } }))).toBe('/usr/local/bin/zed')
    const exe = 'C:\\Users\\me\\AppData\\Local\\Programs\\Zed\\Zed.exe'
    const cli = 'C:\\Users\\me\\AppData\\Local\\Programs\\Zed\\bin\\zed.exe'
    expect(remoteLauncher({ id: 'zed', label: 'Zed', launcherPath: exe }, env({ platform: 'win32', files: [cli] }))).toBe(cli)
    expect(remoteLauncher({ id: 'zed', label: 'Zed', launcherPath: exe }, env({ platform: 'win32' }))).toBe(exe)
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

    function fixture(patch: { approval?: string; detected?: DetectedEditor[]; exists?: boolean | ((path: string) => boolean); folders?: Record<string, string[]>; processEnv?: NodeJS.ProcessEnv; proxyReady?: boolean; answer?: object } = {}) {
      const launched: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = []
      const links: string[] = []
      const asked: string[] = []
      const signedIn: string[] = []
      const io: RemoteOpenIo = {
        detected: async () => patch.detected ?? [code],
        env: () => ({ ...env({ platform: 'linux', home: nowhere }), exists: typeof patch.exists === 'function' ? patch.exists : () => (patch.exists as boolean | undefined) ?? true }),
        launch: async (command, args, launchEnv) => {
          launched.push({ command, args, env: launchEnv })
        },
        openLink: async (link) => {
          links.push(link)
        },
        list: (path) => patch.folders?.[path],
        processEnv: () => patch.processEnv ?? { PATH: '/usr/bin' },
        forgetDetected: () => {},
        proxyReady: patch.proxyReady ?? false,
        sshProbe: async (alias) => {
          signedIn.push(alias)
          return { ok: true }
        },
        signedIn: new Set()
      }
      const ask = async (method: string) => {
        asked.push(method)
        if (method === 'net.ssh.target') return patch.approval ? { endpoint: patch.approval } : {}
        if (method === 'editor.folder') return patch.answer ?? answer
        throw new Error(`unexpected ${method}`)
      }
      return { io, ask, launched, links, asked, signedIn }
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
      expect(await openRemoteInEditor('sublime', threadId, f.ask, f.io)).toMatchObject({ ok: false, reason: 'editor_missing' })
      expect(await openRemoteInEditor('cursor', threadId, f.ask, f.io)).toEqual({ ok: false, reason: 'editor_missing', message: 'That editor is not installed.' })
      expect(f.launched).toEqual([])
      expect(f.asked).toEqual([])
    })

    it('says the editor is gone when its command no longer exists', async () => {
      const f = fixture({ approval: 'box', exists: false })
      expect(await openRemoteInEditor('vscode', threadId, f.ask, f.io)).toEqual({ ok: false, reason: 'editor_missing', message: 'VS Code is no longer installed.' })
      expect(f.launched).toEqual([])
    })

    it('does not check an approved address: a sign-in proved it when it was approved', async () => {
      const f = fixture({ approval: 'me@box.example.com' })
      expect(await openRemoteInEditor('vscode', threadId, f.ask, f.io)).toEqual({ ok: true })
      expect(f.asked).not.toContain('net.editor.probe')
      expect(f.signedIn).toEqual([])
    })

    const zed: DetectedEditor = { id: 'zed', label: 'Zed', launcherPath: '/usr/bin/zed' }
    const toolbox = '/nonexistent/home/.local/share/JetBrains/Toolbox/bin/jetbrains-toolbox'
    const idea: DetectedEditor = { id: 'idea', label: 'IntelliJ IDEA', launcherPath: '/usr/bin/idea', toolboxPath: toolbox }

    it('starts Zed with an ssh:// address', async () => {
      const f = fixture({ approval: 'me@box.example.com:2222', detected: [zed] })
      expect(await openRemoteInEditor('zed', threadId, f.ask, f.io)).toEqual({ ok: true })
      expect(f.launched).toEqual([{ command: '/usr/bin/zed', args: ['ssh://me@box.example.com:2222/home/me/app'], env: { PATH: '/usr/bin' } }])
      expect(f.links).toEqual([])
    })

    it('does not start Zed for a folder of a Windows computer', async () => {
      const f = fixture({ approval: 'box', detected: [zed], answer: { path: 'C:\\work', uriPath: '/C:/work', style: 'windows', platform: 'win32', kind: 'project' } })
      expect(await openRemoteInEditor('zed', threadId, f.ask, f.io)).toEqual({ ok: false, reason: 'editor_missing', message: 'That editor cannot open a folder on that computer.' })
      expect(f.launched).toEqual([])
    })

    it('hands a JetBrains IDE’s folder to JetBrains Toolbox as a link, and starts no command', async () => {
      const f = fixture({ approval: 'me@box.example.com:2222', detected: [idea] })
      expect(await openRemoteInEditor('idea', threadId, f.ask, f.io)).toEqual({ ok: true })
      expect(f.links).toEqual(['jetbrains://gateway/ssh/environment?h=box.example.com&u=me&p=2222&launchIde=true&ideHint=IU&projectHint=/home/me/app'])
      expect(f.launched).toEqual([])
    })

    it('opens nothing for a JetBrains IDE without JetBrains Toolbox, or when Toolbox is gone', async () => {
      const none = fixture({ approval: 'box', detected: [{ ...idea, toolboxPath: undefined }] })
      expect(await openRemoteInEditor('idea', threadId, none.ask, none.io)).toEqual({ ok: false, reason: 'editor_missing', message: 'IntelliJ IDEA needs JetBrains Toolbox to open this folder.' })
      expect(none.asked).toEqual([])
      const gone = fixture({ approval: 'box', detected: [idea], exists: (path) => path !== toolbox })
      expect(await openRemoteInEditor('idea', threadId, gone.ask, gone.io)).toEqual({ ok: false, reason: 'editor_missing', message: 'JetBrains Toolbox is no longer installed.' })
      expect([...none.links, ...gone.links, ...none.launched, ...gone.launched]).toEqual([])
    })
  })

  describe('over one of Mousse’s own SSH names, the check before the editor starts', () => {
    const node = newId('node')
    const threadId = qualifyId(node, 't1')
    const code: DetectedEditor = { id: 'vscode', label: 'VS Code', launcherPath: '/usr/bin/code' }
    const answer = { path: '/home/me/app', uriPath: '/home/me/app', style: 'posix', platform: 'linux', kind: 'project' }

    // A fake daemon for a computer reached through Mousse's own name for it, and a fake `ssh`.
    function setup(mousse: { probe?: EditorProbeResult | Error; ssh?: SshProbeOutcome | Error; folder?: Error; platform?: NodeJS.Platform; prepare?: unknown; alias?: unknown; detected?: DetectedEditor[] } = {}) {
      const launched: string[][] = []
      const asked: string[] = []
      const signedIn: Array<{ alias: string; config: string; env: NodeJS.ProcessEnv }> = []
      const io: RemoteOpenIo = {
        detected: async () => mousse.detected ?? [code],
        env: () => ({ ...env({ platform: mousse.platform ?? 'linux', home: nowhere }), exists: () => true }),
        launch: async (_command, args) => {
          launched.push(args)
        },
        openLink: async (link) => {
          launched.push([link])
        },
        list: () => undefined,
        processEnv: () => ({ PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' }),
        forgetDetected: () => {},
        proxyReady: true,
        sshProbe: async (alias, config, probeEnv) => {
          signedIn.push({ alias, config, env: probeEnv })
          if (mousse.ssh instanceof Error) throw mousse.ssh
          return mousse.ssh ?? { ok: true }
        },
        signedIn: new Set()
      }
      const computers = [{ node, alias: 'mousse-workbox-3fa2c1', name: 'Workbox', hostKeyPinned: true }]
      const status = { includeLine: 'Include ~/.mousse/ssh/config', mousseConfig: '/h/.mousse/ssh/config', computers }
      const ask = async (method: string) => {
        asked.push(method)
        if (method === 'net.ssh.target') return {}
        if (method === 'editor.folder') {
          if (mousse.folder) throw mousse.folder
          return answer
        }
        if (method === 'net.editor.ssh.status') return { available: true }
        if (method === 'net.editor.alias') return mousse.alias ?? { ok: true, added: false, status }
        if (method === 'net.editor.ssh.prepare') return mousse.prepare ?? { ok: true, added: true, status }
        if (method === 'net.editor.probe') {
          const probe = mousse.probe ?? { ok: true, path: 'direct', transport: 'direct' }
          if (probe instanceof Error) throw probe
          return probe
        }
        throw new Error(`unexpected ${method}`)
      }
      return { io, ask, launched, asked, signedIn }
    }
    const refused = (reason: EditorProbeResult & { ok: false }) => reason
    const router = (code: string, details?: unknown) => Object.assign(new Error(`router: ${code}`), { code, details })

    it('checks the connection, adds the Include line only then, and starts the editor, saying how it runs', async () => {
      const f = setup({ probe: { ok: true, path: 'relay', transport: 'plus-relay' } })
      expect(await openRemoteInEditor('vscode', threadId, f.ask, f.io)).toEqual({ ok: true, via: { path: 'relay', transport: 'plus-relay' } })
      expect(f.asked).toEqual(['net.ssh.target', 'net.editor.ssh.status', 'editor.folder', 'net.editor.alias', 'net.editor.probe', 'net.editor.ssh.prepare'])
      expect(f.launched).toEqual([['--folder-uri', 'vscode-remote://ssh-remote+mousse-workbox-3fa2c1/home/me/app']])
    })

    it('opens Zed and a JetBrains IDE over the same check and the same SSH name', async () => {
      const editors: DetectedEditor[] = [
        { id: 'zed', label: 'Zed', launcherPath: '/usr/bin/zed' },
        { id: 'pycharm', label: 'PyCharm', launcherPath: '/usr/bin/pycharm', toolboxPath: '/opt/toolbox/jetbrains-toolbox' }
      ]
      for (const [id, opened] of [
        ['zed', 'ssh://mousse-workbox-3fa2c1/home/me/app'],
        ['pycharm', 'jetbrains://gateway/ssh/environment?h=mousse-workbox-3fa2c1&launchIde=true&ideHint=PY&projectHint=/home/me/app']
      ] as const) {
        const f = setup({ detected: editors })
        expect(await openRemoteInEditor(id, threadId, f.ask, f.io), id).toEqual({ ok: true, via: { path: 'direct', transport: 'direct' } })
        expect(f.asked, id).toEqual(['net.ssh.target', 'net.editor.ssh.status', 'editor.folder', 'net.editor.alias', 'net.editor.probe', 'net.editor.ssh.prepare'])
        expect(f.launched, id).toEqual([[opened]])
        const off = setup({ detected: editors, probe: refused({ ok: false, reason: 'editor_off', message: 'off' }) })
        expect(await openRemoteInEditor(id, threadId, off.ask, off.io), id).toMatchObject({ ok: false, failure: 'editor_off' })
        expect(off.launched, id).toEqual([])
      }
    })

    it.each([
      ['editor_off', 'editor connections are off'],
      ['no_ssh_server', 'no SSH server'],
      ['no_host_key', 'no host key'],
      ['host_untrusted', 'not the system’s own'],
      ['limit', 'all it may have'],
      ['rate_limited', 'too fast'],
      ['blocked', 'blocked'],
      ['setting_off', 'switched off'],
      ['capability', 'no grant'],
      ['net_off', 'net off'],
      ['offline', 'offline'],
      ['unsupported', 'too old'],
      ['timeout', 'did not answer']
    ] as const)('%s: starts no editor and leaves the user’s ~/.ssh/config alone', async (reason, message) => {
      const f = setup({ probe: refused({ ok: false, reason, message }) })
      expect(await openRemoteInEditor('vscode', threadId, f.ask, f.io)).toEqual({ ok: false, reason: 'connection', failure: reason, message })
      expect(f.launched).toEqual([])
      // The Include line is added by prepare, which a refused open never reaches; the sign-in is not tried either.
      expect(f.asked).not.toContain('net.editor.ssh.prepare')
      expect(f.signedIn).toEqual([])
    })

    it('says this computer’s own settings were not ready, with the code the window words', async () => {
      const f = setup({ probe: { ok: false, reason: 'ssh_settings', code: 'unknown_computer', message: 'No alias yet.' } })
      expect(await openRemoteInEditor('vscode', threadId, f.ask, f.io)).toEqual({ ok: false, reason: 'ssh_settings', code: 'unknown_computer', message: 'No alias yet.' })
      expect(f.launched).toEqual([])
      expect(f.asked).not.toContain('net.editor.ssh.prepare')
    })

    it('gives the plain refusal of the Include line, after the check, when it cannot be added', async () => {
      const f = setup({ prepare: { ok: false, code: 'unwritable', message: 'detail', status: { includeLine: 'Include ~/.mousse/ssh/config', computers: [] } } })
      expect(await openRemoteInEditor('vscode', threadId, f.ask, f.io)).toMatchObject({ ok: false, reason: 'ssh_settings', code: 'unwritable', includeLine: 'Include ~/.mousse/ssh/config' })
      expect(f.launched).toEqual([])
    })

    it('checks with ssh from Mousse’s own file of names, in the environment the editor starts with', async () => {
      const f = setup()
      await openRemoteInEditor('vscode', threadId, f.ask, f.io)
      expect(f.signedIn).toEqual([{ alias: 'mousse-workbox-3fa2c1', config: '/h/.mousse/ssh/config', env: { PATH: '/usr/bin' } }])
    })

    it('starts the editor whatever the sign-in check found: it is advice and never a gate', async () => {
      for (const stderr of ['dev@x: Permission denied (publickey,password).', 'Permission denied (publickey).', 'ssh did not finish signing in.', 'Host key verification failed.']) {
        const f = setup({ ssh: { ok: false, stderr } })
        const result = await openRemoteInEditor('vscode', threadId, f.ask, f.io)
        expect(result, stderr).toMatchObject({ ok: true })
        expect(f.launched, stderr).toHaveLength(1)
      }
      const broken = setup({ ssh: new Error('spawn failed') })
      expect(await openRemoteInEditor('vscode', threadId, broken.ask, broken.io)).toMatchObject({ ok: true })
      expect(broken.launched).toHaveLength(1)
    })

    it('does not advise for a computer that takes a password, and advises for one that takes keys alone', async () => {
      const password = setup({ ssh: { ok: false, stderr: 'dev@x: Permission denied (publickey,password).' } })
      expect(await openRemoteInEditor('vscode', threadId, password.ask, password.io)).not.toHaveProperty('advice')
      const keys = setup({ ssh: { ok: false, stderr: 'Permission denied (publickey).' } })
      expect(await openRemoteInEditor('vscode', threadId, keys.ask, keys.io)).toMatchObject({ ok: true, advice: { failure: 'key_refused', command: 'ssh-copy-id mousse-workbox-3fa2c1' } })
      const windows = setup({ platform: 'win32', ssh: { ok: false, stderr: 'Permission denied (publickey).' } })
      expect(await openRemoteInEditor('vscode', threadId, windows.ask, windows.io)).toMatchObject({ ok: true, advice: { failure: 'key_refused' } })
      const other = setup({ ssh: { ok: false, stderr: 'Warning: x\nConnection reset by peer' } })
      expect(await openRemoteInEditor('vscode', threadId, other.ask, other.io)).toMatchObject({ ok: true, advice: { failure: 'ssh_failed', message: 'Connection reset by peer' } })
    })

    it('opens without the sign-in check when this computer has no ssh to ask', async () => {
      const f = setup({ ssh: { skipped: true } })
      const result = await openRemoteInEditor('vscode', threadId, f.ask, f.io)
      expect(result).toMatchObject({ ok: true })
      expect(result).not.toHaveProperty('advice')
      expect(f.launched).toHaveLength(1)
    })

    it('looks at the connection every time, and signs in with ssh once for each computer in a run', async () => {
      const f = setup()
      await openRemoteInEditor('vscode', threadId, f.ask, f.io)
      await openRemoteInEditor('vscode', threadId, f.ask, f.io)
      expect(f.asked.filter((method) => method === 'net.editor.probe')).toHaveLength(2)
      expect(f.signedIn).toHaveLength(1)
      expect(f.launched).toHaveLength(2)
    })

    it('says a computer that stopped allowing editor connections is refused, also when an earlier open went through', async () => {
      const f = setup()
      expect(await openRemoteInEditor('vscode', threadId, f.ask, f.io)).toMatchObject({ ok: true })
      const off = setup({ probe: refused({ ok: false, reason: 'editor_off', message: 'off' }) })
      off.io.signedIn.add(node)
      expect(await openRemoteInEditor('vscode', threadId, off.ask, off.io)).toMatchObject({ ok: false, failure: 'editor_off' })
      expect(off.launched).toEqual([])
    })

    it('says the route of this open, not of an earlier one', async () => {
      const relay = setup({ probe: { ok: true, path: 'relay', transport: 'relay' } })
      expect(await openRemoteInEditor('vscode', threadId, relay.ask, relay.io)).toMatchObject({ via: { path: 'relay' } })
      const direct = setup({ probe: { ok: true, path: 'direct', transport: 'tailscale' } })
      direct.io.signedIn.add(node)
      expect(await openRemoteInEditor('vscode', threadId, direct.ask, direct.io)).toMatchObject({ via: { path: 'direct', transport: 'tailscale' } })
    })

    it('says the computer is offline, blocked this one, or runs a Mousse too old, from the words of the router', async () => {
      for (const [error, failureReason] of [
        [router('computer_offline'), 'offline'],
        [router('computer_forbidden', { reason: 'blocked' }), 'blocked'],
        [router('computer_forbidden', { reason: 'setting_off' }), 'setting_off'],
        [router('computer_forbidden', { reason: 'capability' }), 'capability'],
        [router('computer_outdated'), 'unsupported'],
        [router('rate_limited'), 'rate_limited'],
        [router('deadline_exceeded'), 'timeout']
      ] as const) {
        const f = setup({ folder: error })
        expect(await openRemoteInEditor('vscode', threadId, f.ask, f.io), failureReason).toMatchObject({ ok: false, reason: 'connection', failure: failureReason })
        expect(f.launched).toEqual([])
      }
      // Other words of the router are shown as they are.
      const other = setup({ folder: router('not_available_remotely') })
      expect(await openRemoteInEditor('vscode', threadId, other.ask, other.io)).toMatchObject({ ok: false, reason: 'failed' })
    })
  })
})
