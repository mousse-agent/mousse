import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import type { MmsProfileServices } from '../src/mms/MmsProfileServices'
import { ERROR_INFO_CAPABILITY } from '../src/shared/errors'
import type { Thread } from '../src/shared/types'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'

/** Puts a file only this thread has in its scratch folder: unpublished work a purge may discard only with consent. */
function soleCopy(services: MmsProfileServices, threadId: string): string {
  const path = services.threads.getThreadDir(threadId)
  mkdirSync(join(path, 'terminal-workspace'), { recursive: true })
  writeFileSync(join(path, 'terminal-workspace', 'sole-copy.txt'), 'retained output')
  writeFileSync(join(path, 'terminal-workspace.json'), JSON.stringify({ schemaVersion: 1, kind: 'task-terminal-scratch', threadId, workspaceRelativePath: 'terminal-workspace' }))
  return path
}
const subagentOf = (parentThreadId: string, rootThreadId = parentThreadId) => ({ parentThreadId, rootThreadId, relationship: 'subagent' as const })

/** Archive first, then delete: only an archived thread is deleted, for good, with its subagent threads. */
describe('threads.delete', () => {
  it('refuses a thread that is not archived, from any client, and leaves it as it was', async () => {
    const f = await lifecycleHarness()
    try {
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'still in use' })
      const folder = f.services.threads.getThreadDir(thread.id)
      for (const client of [f.rpc, cli]) {
        await expect(client.request('threads.delete', { threadId: thread.id })).rejects.toMatchObject({ code: 'thread_not_archived', message: 'Archive the thread before deleting it.' })
      }
      expect(f.services.threads.getThread(thread.id)?.settledAt).toBeUndefined()
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
      expect(existsSync(join(folder, 'meta.json'))).toBe(true)
    } finally { await f.close() }
  })

  it('deletes an archived thread and its subagent threads for good, with no trash left behind', async () => {
    const f = await lifecycleHarness()
    try {
      const subagentOf = (parentThreadId: string, rootThreadId = parentThreadId) => ({ parentThreadId, rootThreadId, relationship: 'subagent' as const })
      const parent = f.services.threads.createThread('Archived parent')
      const child = f.services.threads.createThread('Its subagent', undefined, undefined, { lineage: subagentOf(parent.id) })
      const grandchild = f.services.threads.createThread('Its nested subagent', undefined, undefined, { lineage: subagentOf(child.id, parent.id) })
      const folders = [parent, child, grandchild].map((thread) => f.services.threads.getThreadDir(thread.id))
      await f.rpc.request('threads.settle', { threadId: parent.id, settled: true })
      const reply = await f.rpc.request<{ threads: Thread[]; lifecycle: { state: string } }>('threads.delete', { threadId: parent.id })
      expect(reply.lifecycle.state).toBe('purged')
      const ids = new Set(reply.threads.map((thread) => thread.id))
      for (const thread of [parent, child, grandchild]) {
        expect(ids.has(thread.id), thread.name).toBe(false)
        expect(f.services.threads.getThread(thread.id), thread.name).toBeUndefined()
      }
      expect(f.services.threads.lifecycleStore.require(parent.id).state).toBe('purged')
      for (const folder of folders) expect(existsSync(folder), folder).toBe(false)
      // Nothing waits in a trash: the inventory lists no thread that could be restored.
      const inventory = await f.rpc.request<{ lifecycles: Array<{ taskId: string; state: string }> }>('threads.inventory', {})
      expect(inventory.lifecycles.filter((record) => record.state === 'trashed')).toEqual([])
    } finally { await f.close() }
  })

  it('discards unpublished work only for the app; anyone else is refused and the thread goes back to Archived', async () => {
    const f = await lifecycleHarness()
    try {
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'sole copy scratch' })
      const path = f.services.threads.getThreadDir(thread.id)
      mkdirSync(join(path, 'terminal-workspace'), { recursive: true })
      writeFileSync(join(path, 'terminal-workspace', 'sole-copy.txt'), 'retained output')
      writeFileSync(join(path, 'terminal-workspace.json'), JSON.stringify({ schemaVersion: 1, kind: 'task-terminal-scratch', threadId: thread.id, workspaceRelativePath: 'terminal-workspace' }))
      await f.rpc.request('threads.settle', { threadId: thread.id, settled: true })

      // The CLI asks to discard too, but only a person in the app may: refused, and nothing is lost.
      await expect(cli.request('threads.delete', { threadId: thread.id, discard: true })).rejects.toMatchObject({ code: 'thread_has_unpublished_work' })
      const kept = f.services.threads.getThread(thread.id)
      expect(kept?.settledAt).toBeTruthy()
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
      expect(readFileSync(join(f.services.threads.getThreadDir(thread.id), 'terminal-workspace', 'sole-copy.txt'), 'utf8')).toBe('retained output')

      // The app asks after its confirmation; the thread and its only copy go for good.
      await f.rpc.request('threads.delete', { threadId: thread.id, discard: true })
      expect(f.services.threads.getThread(thread.id)).toBeUndefined()
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('purged')
      expect(existsSync(path)).toBe(false)
    } finally { await f.close() }
  })

  it('checks the whole family before purging anything: a refusal on the thread or a subagent thread leaves all of them', async () => {
    const f = await lifecycleHarness()
    try {
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      for (const unpublished of ['parent', 'child'] as const) {
        const parent = f.services.threads.createThread(`Parent, ${unpublished} has unpublished work`)
        const child = f.services.threads.createThread('Its subagent', undefined, undefined, { lineage: subagentOf(parent.id) })
        soleCopy(f.services, unpublished === 'parent' ? parent.id : child.id)
        await f.rpc.request('threads.settle', { threadId: parent.id, settled: true })
        await expect(cli.request('threads.delete', { threadId: parent.id })).rejects.toMatchObject({ code: 'thread_has_unpublished_work' })
        for (const thread of [parent, child]) {
          expect(f.services.threads.getThread(thread.id), `${unpublished}: ${thread.name}`).toBeTruthy()
          expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
        }
        expect(f.services.threads.getThread(parent.id)?.settledAt).toBeTruthy()
      }
    } finally { await f.close() }
  })

  it('finishes a delete whose purge failed when Delete is pressed again', async () => {
    const f = await lifecycleHarness()
    try {
      const thread = f.services.threads.createThread('Held by an editor')
      const folder = f.services.threads.getThreadDir(thread.id)
      await f.rpc.request('threads.settle', { threadId: thread.id, settled: true })
      const purge = vi.spyOn(f.services.lifecycle.cleanup, 'purge').mockRejectedValueOnce(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }))
      await expect(f.rpc.request('threads.delete', { threadId: thread.id })).rejects.toThrow()
      // Not listed while the delete waits, and not "not found": the same Delete finishes it.
      expect(f.services.threads.getThread(thread.id)).toBeUndefined()
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('trashed')
      purge.mockRestore()
      await f.rpc.request('threads.delete', { threadId: thread.id })
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('purged')
      expect(existsSync(folder)).toBe(false)
    } finally { await f.close() }
  })

  it('finishes at the next start a delete that stopped between the trash and the purge', async () => {
    const f = await lifecycleHarness()
    let restarted: MousseMainService | undefined
    try {
      const thread = f.services.threads.createThread('Cut short')
      const folder = soleCopy(f.services, thread.id)
      await f.rpc.request('threads.settle', { threadId: thread.id, settled: true })
      // The process ends after the trash: the purge never runs.
      vi.spyOn(f.services.lifecycle.cleanup, 'purge').mockRejectedValueOnce(new Error('the process ended'))
      await expect(f.rpc.request('threads.delete', { threadId: thread.id, discard: true })).rejects.toThrow()
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('trashed')
      await f.main.stop()
      restarted = await MousseMainService.create({ homeDir: f.home, repoRoot: f.root, requireOwnership: false, headless: true })
      const services = await restarted.getProfileServices(f.alice.id)
      // The app's delete was confirmed with its unpublished work, so the start finishes it as asked.
      expect(services.threads.lifecycleStore.require(thread.id).state).toBe('purged')
      expect(existsSync(folder)).toBe(false)
    } finally { await restarted?.stop(); await f.close() }
  })

  it('puts a thread left in the trash without consent to discard its unpublished work back in Archived', async () => {
    const f = await lifecycleHarness()
    try {
      const thread = f.services.threads.createThread('Trashed by a script')
      soleCopy(f.services, thread.id)
      f.services.threads.setThreadSettled(thread.id, true)
      await f.services.trashThread(thread.id)
      expect(await f.services.finishCutShortDeletes()).toEqual([{ taskId: thread.id, outcome: 'archived' }])
      expect(f.services.threads.getThread(thread.id)?.settledAt).toBeTruthy()
      expect(readFileSync(join(f.services.threads.getThreadDir(thread.id), 'terminal-workspace', 'sole-copy.txt'), 'utf8')).toBe('retained output')
    } finally { await f.close() }
  })

  it('never purges a thread in the trash with no recorded delete: it goes back to Archived', async () => {
    const f = await lifecycleHarness()
    try {
      // An older build's trash, left in progress at the upgrade: nothing to discard, and no delete was asked for here.
      const thread = f.services.threads.createThread('Left in the old trash')
      await f.services.trashThread(thread.id)
      expect(await f.services.finishCutShortDeletes()).toEqual([{ taskId: thread.id, outcome: 'archived' }])
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
      expect(f.services.threads.getThread(thread.id)?.settledAt).toBeTruthy()
    } finally { await f.close() }
  })

  it("drops a delete's consent when its thread is restored, so a later trash cannot reuse it", async () => {
    const f = await lifecycleHarness()
    try {
      const thread = f.services.threads.createThread('Restored after a cut-short delete')
      soleCopy(f.services, thread.id)
      await f.rpc.request('threads.settle', { threadId: thread.id, settled: true })
      vi.spyOn(f.services.lifecycle.cleanup, 'purge').mockRejectedValueOnce(new Error('the process ended'))
      await expect(f.rpc.request('threads.delete', { threadId: thread.id, discard: true })).rejects.toThrow()
      const intents = join(f.services.threads.lifecycleStore.root, 'delete-intents.json')
      expect(JSON.parse(readFileSync(intents, 'utf8'))[thread.id]).toMatchObject({ human: true, discard: true })
      await f.services.restoreThread(thread.id)
      expect(JSON.parse(readFileSync(intents, 'utf8'))[thread.id]).toBeUndefined()
      // Trashed again without a delete: the start puts it back, its only copy kept.
      await f.services.trashThread(thread.id)
      expect(await f.services.finishCutShortDeletes()).toEqual([{ taskId: thread.id, outcome: 'archived' }])
      expect(readFileSync(join(f.services.threads.getThreadDir(thread.id), 'terminal-workspace', 'sole-copy.txt'), 'utf8')).toBe('retained output')
    } finally { await f.close() }
  })

  it("keeps Mousse's own delete of a thread with unpublished work in Archived instead of failing", async () => {
    const f = await lifecycleHarness()
    try {
      const thread = f.services.threads.createThread('A failed start')
      soleCopy(f.services, thread.id)
      await f.services.deleteThreadForGood(thread.id, { human: false, discard: false, internal: true })
      expect(f.services.threads.getThread(thread.id)?.settledAt).toBeTruthy()
      const plain = f.services.threads.createThread('Nothing unpublished')
      await f.services.deleteThreadForGood(plain.id, { human: false, discard: false, internal: true })
      expect(f.services.threads.lifecycleStore.require(plain.id).state).toBe('purged')
    } finally { await f.close() }
  })
})

describe('the steps of a delete', () => {
  it('are not protocol methods: no client can trash, restore, purge or set an automatic emptying', async () => {
    const f = await lifecycleHarness()
    try {
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'in use' })
      f.services.threads.setThreadSettled(thread.id, true)
      for (const client of [f.rpc, cli]) {
        for (const method of ['threads.trash', 'threads.restore', 'threads.purge']) await expect(client.request(method, { threadId: thread.id })).rejects.toThrow()
        await expect(client.request('threads.configureTrash', { graceDays: 1, automaticPurge: true })).rejects.toThrow()
      }
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
      expect(f.services.lifecycle.cleanup.policy().automaticPurge).toBe(false)
    } finally { await f.close() }
  })
})

describe('the move of the old trash to Archived', () => {
  it("brings back a bot's execution thread that was deleted before its home thread, with the real restore", async () => {
    const f = await lifecycleHarness()
    try {
      const home = f.services.threads.createThread('Bot home')
      const execution = f.services.threads.createThread('Bot run', undefined, undefined, { ownerThreadId: home.id })
      // As an older build left it: the run's thread trashed on its own, then its home thread.
      await f.services.trashThread(execution.id)
      await f.services.trashThread(home.id)
      rmSync(join(f.services.threads.lifecycleStore.root, 'trash-returned-to-archive.json'), { force: true })
      expect(await f.services.returnTrashToArchive()).toMatchObject({ done: true, restored: [home.id, execution.id], failed: [] })
      expect(f.services.threads.lifecycleStore.require(home.id).state).toBe('active')
      expect(f.services.threads.lifecycleStore.require(execution.id).state).toBe('active')
      expect(f.services.threads.getThread(home.id)?.settledAt).toBeTruthy()
      // A thread another owns is not archived on its own.
      expect(f.services.threads.getThread(execution.id)?.settledAt).toBeUndefined()
    } finally { await f.close() }
  })
})
