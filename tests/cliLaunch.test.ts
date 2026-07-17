import { describe, expect, it } from 'vitest'
import {
  detectCliMode,
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

  it('resolves node-style invocation when not in electron main', () => {
    // Under vitest we run as plain node (no electron versions.electron in typical CI).
    if (process.versions.electron) return
    const inv = resolveCliInvocation('/tmp/mousse/out/cli/index.js')
    expect(inv.command).toBe(process.execPath)
    expect(inv.argsPrefix).toEqual(['/tmp/mousse/out/cli/index.js'])
  })
})
