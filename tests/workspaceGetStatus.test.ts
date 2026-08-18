import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import type { WorkspaceExecutionContext } from '../src/shared/workspace'

describe('workspace.getStatus', () => {
  let home: string
  let mms: MousseMainService

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-ws-status-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
  })

  afterEach(async () => {
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('returns unbound execution instead of throwing when the thread has no project', async () => {
    const thread = mms.threads.createThread('Standalone')
    const result = (await dispatchMethod(
      { mms, globalSequence: () => 0 },
      'workspace.getStatus',
      { threadId: thread.id }
    )) as {
      metadata?: unknown
      execution: WorkspaceExecutionContext
      journalGeneration: number
    }

    expect(result.metadata).toBeUndefined()
    expect(result.journalGeneration).toBe(0)
    expect(result.execution.lifecycle).toBe('unprovisioned')
    expect(result.execution.projectPath).toBe('')
    expect(result.execution.capability.gitBacked).toBe(false)
    expect(result.execution.capability.unavailableReason).toBe('Thread has no project workspace')
  })

  it('still rejects mutating workspace ops without a project', async () => {
    const thread = mms.threads.createThread('Standalone')
    await expect(
      dispatchMethod(
        { mms, globalSequence: () => 0 },
        'workspace.restore',
        { threadId: thread.id }
      )
    ).rejects.toThrow(`Thread has no project workspace: ${thread.id}`)
  })
})
