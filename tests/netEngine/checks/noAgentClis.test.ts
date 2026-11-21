/**
 * A check never starts the user's installed agent CLIs (`Fabric`): once a check's fabric exists, a profile finds
 * none, and one started anyway fails the run with `egress_attempted`.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { findOnPath, cliNames, codexStandalonePaths } from '../../../src/mms/harness/env'
import { sharedShellPath } from '../../../src/mms/harness/shellPath'
import { recordHarnessSpawn } from '../../../src/mms/harness/spawn'
import { Fabric, recordedReason } from './harness'

describe('check runs and agent CLIs', () => {
  const fabric = new Fabric()
  afterAll(() => fabric.close())

  it('finds no agent CLI on PATH, in the stored PATH or in the standalone installs', async () => {
    const stored = await sharedShellPath()
    for (const name of ['claude', 'codex', 'gemini', 'grok'])
      expect(
        findOnPath(cliNames(name), {
          env: process.env,
          searchPath: [...stored.entries, ...codexStandalonePaths(process.env)]
        }),
        name
      ).toBeUndefined()
  })

  it('fails the run with egress_attempted when one starts anyway', () => {
    expect(recordedReason()).toBeUndefined()
    recordHarnessSpawn({
      instanceId: 'codex',
      purpose: 'probe',
      command: 'codex',
      args: [],
      env: {}
    })
    expect(recordedReason()).toBe('egress_attempted')
  })
})
