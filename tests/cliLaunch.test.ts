import { describe, expect, it } from 'vitest'
import {
  detectCliMode,
  headlessSwitchesIn,
  resolveCliInvocation,
  stripCliModeArgs
} from '../src/cli/cliLaunch'

describe('cliLaunch', () => {
  it('detects --cli and MOUSSE_CLI', () => {
    expect(detectCliMode(['node', 'app', '--cli', '--version'])).toBe(true)
    const prev = process.env.MOUSSE_CLI
    process.env.MOUSSE_CLI = '1'
    try {
      expect(detectCliMode(['node', 'app'])).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.MOUSSE_CLI
      else process.env.MOUSSE_CLI = prev
    }
    expect(detectCliMode(['node', 'app', '--version'])).toBe(false)
  })

  it('strips only the dual-mode flag', () => {
    expect(stripCliModeArgs(['--cli', 'service', 'status'])).toEqual(['service', 'status'])
    expect(stripCliModeArgs(['service', 'status'])).toEqual(['service', 'status'])
  })

  it('strips the headless display switches so they are not read as flags or values', () => {
    expect(
      stripCliModeArgs([
        'service',
        'status',
        '--json',
        '--ozone-platform=headless',
        '--disable-gpu',
        '--password-store=gnome-libsecret'
      ])
    ).toEqual(['service', 'status', '--json'])
    // A switch given a value of its own is not one of ours and stays.
    expect(stripCliModeArgs(['--ozone-platform=x11', 'service'])).toEqual([
      '--ozone-platform=x11',
      'service'
    ])
  })

  it('keeps the display switches for a daemon it starts', () => {
    expect(headlessSwitchesIn(['app', '--cli', '--disable-gpu', 'service'])).toEqual([
      '--disable-gpu'
    ])
    expect(
      headlessSwitchesIn(['app', '--ozone-platform=headless', '--disable-gpu', 'service', 'run'])
    ).toEqual(['--ozone-platform=headless', '--disable-gpu'])
    expect(headlessSwitchesIn(['app', '--password-store=gnome-libsecret', 'service'])).toEqual([
      '--password-store=gnome-libsecret'
    ])
    expect(headlessSwitchesIn(['app', 'service'])).toEqual([])
  })

  it('resolves node-style invocation when not in electron main', () => {
    // Under vitest we run as plain node (no electron versions.electron in typical CI).
    if (process.versions.electron) return
    const inv = resolveCliInvocation('/tmp/mousse/out/cli/index.js')
    expect(inv.command).toBe(process.execPath)
    expect(inv.argsPrefix).toEqual(['/tmp/mousse/out/cli/index.js'])
  })
})
