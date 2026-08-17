import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'

describe('MMS startup without a default Git project', () => {
  let home: string | undefined
  let mms: MousseMainService | undefined
  let previousHome: string | undefined

  afterEach(async () => {
    await mms?.stop()
    if (home) rmSync(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
  })

  it('starts when the launch directory is not a Git repository', async () => {
    previousHome = process.env.MOUSSE_HOME
    home = mkdtempSync(join(tmpdir(), 'mousse-startup-'))
    const launchDirectory = mkdtempSync(join(tmpdir(), 'mousse-launch-'))

    try {
      mms = await MousseMainService.create({
        homeDir: home,
        repoRoot: launchDirectory,
        headless: true,
        ownerKind: 'daemon'
      })
      await mms.start()

      expect(mms.worktrees.getRepoRoot()).toBe(launchDirectory)
    } finally {
      rmSync(launchDirectory, { recursive: true, force: true })
    }
  })
})
