import { describe, expect, it } from 'vitest'
import { ownerUpdateLaunch } from '../../src/mms/harness/ownerUpdate'

const noPath = { env: { PATH: '' }, searchPath: [] }

describe('owner update command', () => {
  it('runs the CLI\'s own updater with the executable the instance runs, not another copy on PATH', () => {
    // `node` stands in for the CLI: its executable is the resolved binary.
    const resolved = ownerUpdateLaunch('node update --yes', { path: process.execPath }, noPath)
    expect(resolved?.launch.command).toBe(process.execPath)
    expect(resolved?.args).toEqual(['update', '--yes'])
  })

  it('finds nothing to run when the owner\'s program is not on PATH', () => {
    expect(ownerUpdateLaunch('mousse-no-such-updater upgrade x', { path: process.execPath }, noPath)).toBeUndefined()
    expect(ownerUpdateLaunch('  ', undefined, noPath)).toBeUndefined()
  })
})
