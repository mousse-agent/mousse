/**
 * The Windows launchers in `%MOUSSE_HOME%\bin` (1b §3.3): another computer's SSH session runs
 * `.\.mousse\bin\mousse-cli.cmd net-engine ssh` or `.\.mousse\bin\mousse-helper.cmd pipe --profile <selector>` in
 * the profile folder. The text is checked on every OS; on Windows the generated files also run under `cmd.exe`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cliCommand, cmdPath, SshRemote, windowsLauncherText } from '../../src/mms/netEngine/ssh/remote'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const ENV = { USERPROFILE: 'C:\\Users\\J\u00fcrgen', LOCALAPPDATA: 'C:\\Users\\J\u00fcrgen\\AppData\\Local' }
const CRLF = (lines: string[]) => [...lines, ''].join('\r\n')

describe('Windows SSH launchers', () => {
  it('writes MOUSSE_HOME and the target relative to the profile folders, so a non-ASCII user name is fine', () => {
    expect(
      windowsLauncherText(
        'C:\\Users\\J\u00fcrgen\\.mousse',
        ['C:\\Users\\J\u00fcrgen\\AppData\\Local\\Programs\\Mousse\\resources\\net-helper\\mousse-helper.exe'],
        ENV
      )
    ).toBe(
      CRLF([
        '@echo off',
        'setlocal DisableDelayedExpansion',
        'set "MOUSSE_HOME=%USERPROFILE%\\.mousse"',
        '"%LOCALAPPDATA%\\Programs\\Mousse\\resources\\net-helper\\mousse-helper.exe" %*',
        'exit /b %ERRORLEVEL%'
      ])
    )
  })

  it("calls the app's own mousse-cli.cmd, so control and its exit code come back", () => {
    const text = windowsLauncherText(
      'C:\\Users\\J\u00fcrgen\\.mousse',
      ['C:\\Users\\J\u00fcrgen\\AppData\\Local\\Programs\\Mousse\\mousse-cli.cmd'],
      ENV
    )
    expect(text).toContain('\r\ncall "%LOCALAPPDATA%\\Programs\\Mousse\\mousse-cli.cmd" %*\r\n')
  })

  it('writes other ASCII paths literally: % doubled, or doubled twice on a call line', () => {
    expect(cmdPath('D:\\Apps (x86) & 100%\\Mousse.exe', ENV)).toBe('D:\\Apps (x86) & 100%%\\Mousse.exe')
    expect(cmdPath('D:\\100%\\mousse-cli.cmd', ENV, true)).toBe('D:\\100%%%%\\mousse-cli.cmd')
    // Only the exact folder counts: a sibling with a longer name is written literally.
    expect(cmdPath('C:\\Users\\J\u00fcrgen2\\x.exe', ENV)).toBeUndefined()
    expect(cmdPath('C:\\Users\\Jo2\\x.exe', { USERPROFILE: 'C:\\Users\\Jo' })).toBe('C:\\Users\\Jo2\\x.exe')
  })

  it('writes no launcher for a path a .cmd file cannot hold', () => {
    for (const bad of ['D:\\M\u00f6usse\\mousse-helper.exe', 'D:\\a"b\\x.exe', 'D:\\a\nb\\x.exe'])
      expect(windowsLauncherText('C:\\Users\\J\u00fcrgen\\.mousse', [bad], ENV)).toBeUndefined()
    expect(windowsLauncherText('D:\\h\u00f6me\\.mousse', ['D:\\x.exe'], ENV)).toBeUndefined()
    // `call` doubles carets, and expands a `%` in a folder's value once more.
    expect(cmdPath('D:\\a^b\\mousse-cli.cmd', ENV, true)).toBeUndefined()
    expect(cmdPath('C:\\Users\\100%\\x.cmd', { USERPROFILE: 'C:\\Users\\100%' }, true)).toBe('C:\\Users\\100%%%%\\x.cmd')
  })

  it('finds the CLI beside the app: mousse-cli.cmd on Windows; MOUSSE_NET_ENGINE_CLI wins', () => {
    const seen: string[] = []
    const exists = (path: string) => (seen.push(path), true)
    expect(cliCommand({}, 'C:\\Programs\\Mousse\\Mousse.exe', 'win32', exists)).toEqual([
      'C:\\Programs\\Mousse\\mousse-cli.cmd'
    ])
    expect(cliCommand({}, '/opt/Mousse/mousse', 'linux', exists)).toEqual(['/opt/Mousse/mousse-cli'])
    expect(cliCommand({}, '/A/Mousse.app/Contents/MacOS/Mousse', 'darwin', exists)).toEqual([
      '/A/Mousse.app/Contents/Resources/mousse-cli'
    ])
    expect(cliCommand({ MOUSSE_NET_ENGINE_CLI: 'node C:\\m\\out\\cli\\index.js' }, 'x', 'win32', () => false)).toEqual([
      'node',
      'C:\\m\\out\\cli\\index.js'
    ])
    expect(cliCommand({}, 'C:\\P\\Mousse.exe', 'win32', () => false)).toBeUndefined()
  })

  it.runIf(process.platform === 'win32')(
    'runs under cmd.exe from the profile folder: MOUSSE_HOME, the arguments and the exit code come through',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'mousse-cmd-launcher-'))
      cleanups.push(() => rmSync(root, { recursive: true, force: true }))
      const profile = join(root, 'J\u00fcrgen & (home)')
      const local = join(profile, 'AppData', 'Local')
      const home = join(profile, '.mousse')
      // The program: prints MOUSSE_HOME and its arguments, then exits with the first argument after them.
      // Non-ASCII only in the profile folder, as with a user name: the launcher reaches it through the variables.
      const app = join(local, 'Programs (x86) & Mousse')
      mkdirSync(app, { recursive: true })
      const script = join(app, 'echo.cjs')
      writeFileSync(
        script,
        'process.stdout.write(JSON.stringify({home: process.env.MOUSSE_HOME, args: process.argv.slice(2)}));process.exit(Number(process.argv[2] === "net-engine" ? 7 : 3))'
      )
      // The app's own mousse-cli.cmd, which the CLI launcher calls.
      writeFileSync(
        join(app, 'mousse-cli.cmd'),
        `@echo off\r\nsetlocal\r\n"${process.execPath}" "%~dp0echo.cjs" %*\r\nexit /b %ERRORLEVEL%\r\n`
      )
      const env = { ...process.env, USERPROFILE: profile, LOCALAPPDATA: local, MOUSSE_HOME: '' }
      const folders = { USERPROFILE: profile, LOCALAPPDATA: local }
      mkdirSync(join(home, 'bin'), { recursive: true })
      const cliText = windowsLauncherText(home, [join(app, 'mousse-cli.cmd')], folders)!
      expect(cliText).toContain('call "%LOCALAPPDATA%\\Programs (x86) & Mousse\\mousse-cli.cmd" %*')
      // Non-ASCII is never written: cmd reads the file in the OEM code page.
      expect(/^[\x00-\x7f]*$/.test(cliText)).toBe(true)
      writeFileSync(join(home, 'bin', 'mousse-cli.cmd'), cliText)

      const run = (command: string) =>
        spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/c', command], {
          cwd: profile,
          env,
          encoding: 'utf8',
          windowsVerbatimArguments: true
        })
      const cli = run('.\\.mousse\\bin\\mousse-cli.cmd net-engine ssh')
      expect(cli.status, cli.stderr).toBe(7)
      expect(JSON.parse(cli.stdout)).toEqual({ home, args: ['net-engine', 'ssh'] })

      // A target that is not a .cmd file runs directly.
      writeFileSync(
        join(home, 'bin', 'mousse-helper.cmd'),
        windowsLauncherText(home, [process.execPath, script], folders)!
      )
      const helper = run('.\\.mousse\\bin\\mousse-helper.cmd pipe --profile abcdefghijklmnopqrstuvwx23')
      expect(helper.status, helper.stderr).toBe(3)
      expect(JSON.parse(helper.stdout)).toEqual({ home, args: ['pipe', '--profile', 'abcdefghijklmnopqrstuvwx23'] })
    }
  )

  it.runIf(process.platform === 'win32')(
    'writes the .cmd launchers at start, and removes one whose target a .cmd file cannot hold',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'mousse-launchers-'))
      cleanups.push(() => rmSync(root, { recursive: true, force: true }))
      const home = join(root, '.mousse')
      const remote = new SshRemote({
        home,
        profiles: () => [],
        engine: async () => {
          throw new Error('unused')
        },
        createProfile: async () => '',
        startsAtLogin: () => false
      })
      const saved = process.env.MOUSSE_NET_ENGINE_CLI
      cleanups.push(() => {
        if (saved === undefined) delete process.env.MOUSSE_NET_ENGINE_CLI
        else process.env.MOUSSE_NET_ENGINE_CLI = saved
      })
      const path = join(home, 'bin', 'mousse-cli.cmd')
      process.env.MOUSSE_NET_ENGINE_CLI = 'node C:\\mousse\\out\\cli\\index.js'
      remote.writeLaunchers()
      expect(readFileSync(path, 'utf8')).toBe(
        windowsLauncherText(home, ['node', 'C:\\mousse\\out\\cli\\index.js'], process.env)
      )
      process.env.MOUSSE_NET_ENGINE_CLI = 'D:\\M\u00f6usse\\mousse-cli.cmd'
      remote.writeLaunchers()
      expect(existsSync(path)).toBe(false)
    }
  )
})
