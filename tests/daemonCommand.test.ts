import { describe, expect, it } from 'vitest'
import { daemonCommand } from '../src/main/mms/daemonCommand'

const host = { command: '/usr/bin/node', argsPrefix: ['/repo/out/cli/index.js'], env: { MOUSSE_DEV: '1' } }

describe('the program the GUI starts the background service with', () => {
  it('is the AppImage file itself on Linux, so the service does not run from the window\'s mount', () => {
    const started = daemonCommand({
      execPath: '/tmp/.mount_MousseAbc/mousse',
      platform: 'linux',
      electron: true,
      env: { APPIMAGE: '/home/u/Applications/Mousse.AppImage', APPDIR: '/tmp/.mount_MousseAbc', ARGV0: 'Mousse', OWD: '/home/u', HOME: '/home/u' },
      host
    })
    expect(started).toEqual({
      command: '/home/u/Applications/Mousse.AppImage',
      argsPrefix: ['--cli'],
      env: { HOME: '/home/u', MOUSSE_CLI: '1' }
    })
  })

  it('is the app\'s own executable elsewhere, and the CLI host when not packaged', () => {
    expect(
      daemonCommand({ execPath: '/Applications/Mousse.app/Contents/MacOS/Mousse', platform: 'darwin', electron: true, env: { HOME: '/Users/u' }, host })
    ).toEqual({ command: '/Applications/Mousse.app/Contents/MacOS/Mousse', argsPrefix: ['--cli'], env: { HOME: '/Users/u', MOUSSE_CLI: '1' } })
    // A Linux package that is not an AppImage (a .deb, or an unpacked build) has a stable path already.
    expect(
      daemonCommand({ execPath: '/opt/Mousse/mousse', platform: 'linux', electron: true, env: {}, host }).command
    ).toBe('/opt/Mousse/mousse')
    expect(daemonCommand({ execPath: '/usr/bin/electron', platform: 'linux', electron: true, env: { APPIMAGE: '/x.AppImage' }, host })).toBe(host)
  })
})
