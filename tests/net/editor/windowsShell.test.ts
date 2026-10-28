import { describe, expect, it } from 'vitest'
import { windowsSessionEnvironment } from '../../../src/mms/net/editor/endpoint/environment'
import { systemProcessHost } from '../../../src/mms/net/editor/endpoint/systemHost'
import { findSshdHelper, jobName } from '../../../src/mms/net/editor/endpoint/windowsHost'
import {
  cachedShell,
  defaultWindowsShell,
  parseRegistryValues,
  quoteArgument,
  shellFromRegistry,
  shellKind,
  windowsCommandLine
} from '../../../src/mms/net/editor/endpoint/windowsShell'

/**
 * How a Windows owner's sessions are started, as Win32-OpenSSH's sshd starts them (its `do_exec_windows`): pure
 * functions, so these run on every system.
 */

const CMD = 'C:\\Windows\\System32\\cmd.exe'

describe('the command line of a session', () => {
  const cmd = defaultWindowsShell('C:\\Windows')

  it('runs cmd by default, and an exec as cmd /c "<command>" with the command as it was sent', () => {
    expect(cmd).toEqual({ path: CMD, option: '/c', escape: true })
    expect(windowsCommandLine(cmd, undefined, false)).toBe(`"${CMD}"`)
    expect(windowsCommandLine(cmd, 'powershell', false)).toBe(`"${CMD}" /c "powershell"`)
    // Quotes and specials pass as they are: cmd strips only the outer pair.
    expect(windowsCommandLine(cmd, '"C:\\a b\\x.exe" "1 2" & echo "q"', false)).toBe(
      `"${CMD}" /c ""C:\\a b\\x.exe" "1 2" & echo "q""`
    )
  })

  it('leaves the command unquoted under a terminal, as sshd does', () => {
    expect(windowsCommandLine(cmd, 'echo hi', true)).toBe(`"${CMD}" /c echo hi`)
  })

  it('passes the command as one quoted argument to PowerShell, bash and other shells', () => {
    const pwsh = { path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', option: '-c', escape: true }
    expect(shellKind(pwsh.path)).toBe('powershell')
    expect(windowsCommandLine(pwsh, 'Write-Output "a b"', false)).toBe(
      `"${pwsh.path}" -c "Write-Output \\"a b\\""`
    )
    const bash = { path: 'C:\\Program Files\\Git\\bin\\bash.exe', option: '-c', escape: true }
    expect(windowsCommandLine(bash, 'echo $HOME', false)).toBe(`"${bash.path}" -c "echo $HOME"`)
    // A shell sshd does not know, with escaping turned off by the owner: the command is quoted as it is.
    const other = { path: 'D:\\tools\\myshell.exe', option: '/run', escape: false }
    expect(windowsCommandLine(other, 'a "b"', false)).toBe(`"${other.path}" /run "a "b""`)
  })

  it('quotes an argument the way the C runtime reads it back', () => {
    expect(quoteArgument('plain')).toBe('plain')
    expect(quoteArgument('')).toBe('""')
    expect(quoteArgument('a b')).toBe('"a b"')
    expect(quoteArgument('say "hi"')).toBe('"say \\"hi\\""')
    expect(quoteArgument('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"')
    expect(quoteArgument('x\\"y')).toBe('"x\\\\\\"y"')
  })
})

describe('the owner’s OpenSSH settings', () => {
  it('reads DefaultShell, DefaultShellCommandOption and DefaultShellEscapeArguments as sshd does', () => {
    const values = parseRegistryValues(
      [
        '',
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH',
        '    DefaultShell    REG_SZ    C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        '    DefaultShellCommandOption    REG_SZ    -Command',
        '    DefaultShellEscapeArguments    REG_DWORD    0x0',
        ''
      ].join('\r\n')
    )
    expect(shellFromRegistry(values, 'C:\\Windows')).toEqual({
      path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      option: '-Command',
      escape: false
    })
  })

  it('keeps cmd, and the option that goes with the shell, when a value is not set', () => {
    expect(shellFromRegistry(new Map(), 'D:\\Win')).toEqual({
      path: 'D:\\Win\\System32\\cmd.exe',
      option: '/c',
      escape: true
    })
    const bash = parseRegistryValues(
      '    DefaultShell    REG_EXPAND_SZ    %SystemRoot%\\System32\\bash.exe'
    )
    expect(shellFromRegistry(bash, 'C:\\Windows')).toEqual({
      path: 'C:\\Windows\\System32\\bash.exe',
      option: '-c',
      escape: true
    })
  })

  it('is read again only after a while', async () => {
    let reads = 0
    let now = 0
    const shell = cachedShell(
      async () => {
        reads++
        return defaultWindowsShell()
      },
      30_000,
      () => now
    )
    await shell()
    await shell()
    expect(reads).toBe(1)
    now = 31_000
    await shell()
    expect(reads).toBe(2)
  })
})

describe('the environment of a Windows session', () => {
  const base = {
    user: 'me',
    home: 'C:\\Users\\me',
    shell: CMD,
    computer: 'BOX',
    homeIsProfile: false,
    sshConnection: '127.0.0.1 50001 127.0.0.1 22',
    requested: { LANG: 'de_DE.UTF-8' },
    scope: 'ab'.repeat(20)
  }

  it('holds what sshd sets for a session and the device’s marker, and nothing of the daemon’s', () => {
    const env = windowsSessionEnvironment(base)
    expect(env).toEqual({
      USER: 'me',
      LOGNAME: 'me',
      HOME: 'C:\\Users\\me',
      SHELL: CMD,
      PROMPT: 'me@BOX $P$G',
      SSH_CLIENT: '127.0.0.1 50001 22',
      SSH_CONNECTION: '127.0.0.1 50001 127.0.0.1 22',
      LANG: 'de_DE.UTF-8',
      MOUSSE_EDITOR_SCOPE: 'ab'.repeat(20)
    })
  })

  it('points the profile variables at a home that is not the profile, and doubles a $ in the prompt', () => {
    const env = windowsSessionEnvironment({
      ...base,
      user: 'a$b',
      home: 'D:\\tmp\\home',
      homeIsProfile: true,
      term: 'xterm'
    })
    expect(env).toMatchObject({
      USERPROFILE: 'D:\\tmp\\home',
      HOMEDRIVE: 'D:',
      HOMEPATH: '\\tmp\\home',
      PROMPT: 'a$$b@BOX $P$G',
      TERM: 'xterm'
    })
  })
})

describe('the helper', () => {
  it('names a device’s job after its marker', () => {
    expect(jobName('ab'.repeat(20))).toBe(`Local\\MousseEditor-${'ab'.repeat(20)}`)
  })

  it('is looked for in the packaged resources, then in a checkout’s build', () => {
    expect(findSshdHelper('/nowhere/at/all', '/no/resources')).toBeUndefined()
  })

  it('without it, a Windows computer has no endpoint and keeps using its own SSH server', () => {
    expect(systemProcessHost('win32', () => undefined)).toBeUndefined()
    expect(systemProcessHost('aix')).toBeUndefined()
  })
})
