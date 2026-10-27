import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { q, remoteCommand } from '../../../src/mms/net/ssh/shellQuote'
import {
  assetUrl,
  configureAddonScript,
  fetchScript,
  joinScript,
  launcherContent,
  launcherOwner,
  parseSections,
  probeScript,
  reconcileInstallScript,
  removeInstallScript,
  removeLauncherScript,
  uploadScript,
  verifyExtractScript,
  writeLauncherScript
} from '../../../src/mms/net/ssh/scripts'

const hasSh = (() => {
  try {
    return spawnSync('sh', ['-c', 'exit 0']).status === 0
  } catch {
    return false
  }
})()

/** What `sh -c` makes of `exec /bin/sh -c <word>` when the first shell is also `sh`. */
function viaShell(value: string): string {
  const result = spawnSync('sh', ['-c', `printf %s ${q(value)}`], { encoding: 'utf8' })
  return result.stdout
}

const hostile = [
  "it's",
  "'; touch pwned; '",
  '$(touch pwned)',
  '`touch pwned`',
  'a;b&c|d',
  '-oProxyCommand=x',
  '--',
  'two  spaces',
  'multi\nline',
  '"double"',
  '*?[x]',
  '~',
  'ünïcode ✓'
]

describe('q', () => {
  it('writes an embedded apostrophe without a backslash', () => {
    expect(q("it's")).toBe(`'it'"'"'s'`)
    for (const value of hostile) expect(q(value)).not.toContain('\\')
  })

  it('refuses a backslash and a NUL byte', () => {
    expect(() => q('a\\b')).toThrow()
    expect(() => q('a\0b')).toThrow()
    expect(() => remoteCommand('echo \\n')).toThrow()
  })

  it.skipIf(!hasSh)('keeps every hostile value literal through the real sh', () => {
    for (const value of hostile) expect(viaShell(value)).toBe(value)
  })

  it.skipIf(!hasSh)(
    'keeps the value literal when the script is itself quoted for the login shell',
    () => {
      for (const value of hostile) {
        const script = `printf %s ${q(value)}`
        const result = spawnSync('sh', ['-c', remoteCommand(script).replace(/^exec /, '')], {
          encoding: 'utf8'
        })
        expect(result.stdout).toBe(value)
      }
    }
  )
})

describe('remote scripts', () => {
  const scripts: Record<string, string> = {
    probe: probeScript(),
    fetch: fetchScript({
      directory: '/home/me/.local/share/mousse/cli/0.1.2',
      asset: 'a.AppImage',
      url: assetUrl('0.1.2')
    }),
    upload: uploadScript({ directory: '/home/me/x', asset: 'a.AppImage' }),
    verify: verifyExtractScript({ directory: '/home/me/x', asset: 'a.AppImage' }),
    launcher: writeLauncherScript('/home/me/.local/bin/mousse-cli'),
    join: joinScript({
      cli: '/home/me/.local/bin/mousse-cli',
      name: "it's $(x)",
      via: 'ws://127.0.0.1:41000/mousse-net'
    }),
    configure: configureAddonScript({ cli: '/opt/it s/mousse-cli', disable: true }),
    remove: removeLauncherScript('/home/me/.local/bin/mousse-cli', 'ssh_abc'),
    reconcile: reconcileInstallScript({
      launcher: '/home/me/.local/bin/mousse-cli',
      manifestId: 'ssh_abc',
      directory: '/home/me/x'
    })
  }

  it('are one `exec /bin/sh -c` word with no backslash, each named on its first line', () => {
    for (const [name, script] of Object.entries(scripts)) {
      expect(script.startsWith('# mousse:'), name).toBe(true)
      const command = remoteCommand(script)
      expect(command.startsWith("exec /bin/sh -c '"), name).toBe(true)
      expect(command, name).not.toContain('\\')
    }
  })

  it('pass the invitation and settings on stdin, never as an argument or file', () => {
    expect(scripts.join).not.toContain('invite-file')
    expect(scripts.join).not.toMatch(/mj1_/)
    expect(scripts.join).toContain(q("it's $(x)"))
    expect(scripts.configure).toContain('--settings-file "$f"')
    expect(scripts.configure).toContain('mktemp')
    expect(scripts.configure).toContain('umask 077')
  })

  it('fetch only over https and name the asset with the published pattern', () => {
    expect(scripts.fetch).toContain("--proto '=https'")
    expect(assetUrl('0.1.2')).toBe(
      'https://github.com/mousse-agent/mousse/releases/download/v0.1.2/mousse-cli-0.1.2-linux-x86_64.AppImage'
    )
  })

  it('writes a launcher that carries the sandbox opt-out and a marker', () => {
    const text = launcherContent('ssh_abc', '/home/me/.local/share/mousse/cli/0.1.2')
    expect(text).toContain('export ELECTRON_DISABLE_SANDBOX=1')
    expect(text).toContain(
      'exec "/home/me/.local/share/mousse/cli/0.1.2/squashfs-root/mousse-cli" "$@"'
    )
    // No display: Electron would stop at "Missing X server"; the switches are added only then.
    expect(text).toContain('if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then')
    expect(text).toContain(
      'set -- "$@" --ozone-platform=headless --disable-gpu --password-store=gnome-libsecret'
    )
    expect(launcherOwner(text)).toBe('ssh_abc')
    expect(launcherOwner('#!/bin/sh\necho mine\n')).toBeUndefined()
  })

  it('removes the install directory and then only empty parents', () => {
    const script = removeInstallScript('/home/me/.local/share/mousse/cli/0.1.2')
    expect(script).toContain("rm -rf -- '/home/me/.local/share/mousse/cli/0.1.2'")
    expect(script).toContain("rmdir -- '/home/me/.local/share/mousse/cli' 2>/dev/null || true")
    expect(script).toContain("rmdir -- '/home/me/.local/share/mousse' 2>/dev/null || true")
    expect(script).not.toContain('rm -rf -- /home/me/.local/share/mousse/cli/')
  })

  it('splits probe output into sections', () => {
    const sections = parseSections('@@uname\nLinux x86_64\n@@home\n/home/me\n@@end\n')
    expect(sections.get('uname')).toBe('Linux x86_64')
    expect(sections.get('home')).toBe('/home/me')
  })

  it.skipIf(!hasSh)('parse as POSIX sh', () => {
    for (const [name, script] of Object.entries(scripts)) {
      const result = spawnSync('sh', ['-n', '-c', script], { encoding: 'utf8' })
      expect(result.status, `${name}: ${result.stderr}`).toBe(0)
    }
  })
})
