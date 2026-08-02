import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { GitService } from '../src/mms/git/GitService'

describe('GitService stale cwd handling', () => {
  it('returns empty read snapshots when a removed worktree path is requested', async () => {
    const missing = join(tmpdir(), `missing-mousse-worktree-${crypto.randomUUID()}`)
    const service = new GitService()

    await expect(service.getStatus(missing)).resolves.toEqual({
      isRepo: false, branch: null, ahead: 0, behind: 0, changes: []
    })
    await expect(service.getDiffStats(missing)).resolves.toEqual({
      additions: 0, deletions: 0, filesChanged: 0
    })
    await expect(service.getBranches(missing)).resolves.toEqual({ current: null, branches: [] })
    await expect(service.getLog(missing)).resolves.toEqual([])
    await expect(service.getDiff(missing, 'gone.txt', false)).resolves.toBe('')
  })
})
