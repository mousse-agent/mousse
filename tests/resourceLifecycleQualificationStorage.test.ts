import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Thread } from '../src/shared/types'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'
import { checkoutStorageSnapshot, createQualificationRepository, measureTree, primaryCheckoutSnapshot } from './fixtures/resource-lifecycle-qualification'

it('repeated multi-task trash and restore retains sole-copy workspace bytes without creating duplicate checkouts', async () => {
  const f = await lifecycleHarness()
  try {
    const repo = createQualificationRepository(f.root)
    const primary = primaryCheckoutSnapshot(repo)
    const { project } = await f.rpc.request<{ project: { id: string } }>('projects.open', { path: repo })
    const tasks: Array<{ id: string; workspace: string; contents: ReturnType<typeof measureTree> }> = []
    for (let index = 0; index < 4; index++) {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: `storage task ${index}`, projectId: project.id })
      const resolved = await new WorkspaceResolver(f.services.threads.getThreadDir(thread.id), thread.id, repo).resolve('agent')
      const workspace = resolved.workspacePath!
      writeFileSync(join(workspace, `unpublished-${index}.bin`), Buffer.alloc(1024 * (index + 1), index + 1))
      tasks.push({ id: thread.id, workspace, contents: measureTree(workspace, new Set(['.git'])) })
    }
    const baseline = checkoutStorageSnapshot(repo)
    expect(baseline.materializedCheckouts).toBe(4)
    expect(baseline.materializedBytes).toBeGreaterThan(10 * 1024)
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const task of tasks) await f.rpc.request('threads.trash', { threadId: task.id })
      for (const task of tasks) {
        expect(measureTree(task.workspace, new Set(['.git']))).toEqual(task.contents)
        await f.rpc.request('threads.restore', { threadId: task.id })
        expect((await f.rpc.request<{ thread: Thread }>('threads.get', { threadId: task.id })).thread.id).toBe(task.id)
      }
      const current = checkoutStorageSnapshot(repo)
      expect(current.materializedCheckouts).toBe(baseline.materializedCheckouts)
      expect(current.materializedBytes).toBe(baseline.materializedBytes)
      expect(primaryCheckoutSnapshot(repo)).toEqual(primary)
    }
  } finally { await f.close() }
}, 90_000)
