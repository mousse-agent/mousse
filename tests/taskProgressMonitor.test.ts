import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TaskProgressMonitor,
  taskProgressPath
} from '../src/mms/tasks/TaskProgressMonitor'

const tempPaths: string[] = []

afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('TaskProgressMonitor restoration', () => {
  it('immediately reads completed progress without overwriting it', () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'mousse-progress-'))
    tempPaths.push(worktreePath)
    const progressPath = taskProgressPath(worktreePath)
    mkdirSync(join(worktreePath, '.mousse'), { recursive: true })
    const completed = JSON.stringify({
      status: 'completed',
      progress: 100,
      summary: 'Finished while Mousse was unavailable'
    })
    writeFileSync(progressPath, completed)

    const updates: Array<{ status: string; summary?: string }> = []
    const monitor = new TaskProgressMonitor()
    monitor.resume('agent-1', worktreePath, (update) => updates.push(update))

    expect(updates).toEqual([
      { status: 'completed', progress: 100, summary: 'Finished while Mousse was unavailable' }
    ])
    expect(readFileSync(progressPath, 'utf8')).toBe(completed)
    monitor.stopAll()
  })
})
