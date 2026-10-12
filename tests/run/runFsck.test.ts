import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RunFsck } from '../../src/mms/run/fsck/RunFsck'

describe('RunFsck', () => {
  let profileHome: string | undefined

  afterEach(() => {
    if (profileHome) rmSync(profileHome, { recursive: true, force: true })
    profileHome = undefined
  })

  it('reports no findings for an empty profile home', () => {
    profileHome = mkdtempSync(join(tmpdir(), 'mousse-fsck-'))
    expect(new RunFsck({ profileHome }).check()).toEqual([])
  })
})
