import { describe, expect, it } from 'vitest'
import { isMousseControlFile } from '../src/mms/worktree/GitStateInspector'

describe('agent worktree readiness', () => {
  it('treats the managed task-progress path as control state', () => {
    expect(isMousseControlFile('.mousse/task-progress.json')).toBe(true)
    expect(isMousseControlFile('src/task-progress.json')).toBe(false)
  })
})
