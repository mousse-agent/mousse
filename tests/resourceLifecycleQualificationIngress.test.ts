import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Thread } from '../src/shared/types'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'
import { createQualificationRepository, primaryCheckoutSnapshot } from './fixtures/resource-lifecycle-qualification'

it('provisions first-use task PTY in its owned checkout and fences other writers until terminal settlement', async () => {
  const f = await lifecycleHarness()
  let ptyId: string | undefined
  try {
    const repo = createQualificationRepository(f.root), primary = primaryCheckoutSnapshot(repo)
    const { project } = await f.rpc.request<{ project: { id: string } }>('projects.open', { path: repo })
    const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'first terminal', projectId: project.id })
    const directory = f.services.threads.getThreadDir(thread.id), manager = new ThreadWorkspaceManager(directory)
    expect(manager.load()).toBeUndefined()
    const script = join(f.root, 'terminal-writer.cjs')
    writeFileSync(script, 'require("node:fs").writeFileSync("terminal-owned.txt", "terminal result\\n");setInterval(()=>{},1000)')
    const quote = (value: string) => process.platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'"'"'`)}'`
    const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(script)}`
    const created = await f.rpc.request<{ ptyId: string }>('pty.create', { threadId: thread.id, agentId: 'qualification-terminal', cwd: repo, command })
    ptyId = created.ptyId
    const workspace = manager.load()!.worktreePath
    expect(workspace).not.toBe(repo)
    await vi.waitFor(() => expect(existsSync(join(workspace, 'terminal-owned.txt'))).toBe(true), { timeout: 10_000 })
    expect(existsSync(join(directory, 'execution.lease'))).toBe(true)
    let editorSettled = false, commitSettled = false
    const editor = f.rpc.request('files.write', { threadId: thread.id, path: 'editor-after-terminal.txt', content: 'serialized editor\n' })
      .then((value) => ({ value }), (error: Error) => ({ error })).finally(() => { editorSettled = true })
    const commit = f.rpc.request('git.commit', { threadId: thread.id, message: 'serialized terminal commit' })
      .then((value) => ({ value }), (error: Error) => ({ error })).finally(() => { commitSettled = true })
    // These public writers may queue or reject on the task lease, but neither
    // may mutate while the terminal process still owns it.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(editorSettled).toBe(false); expect(commitSettled).toBe(false)
    expect(existsSync(join(workspace, 'editor-after-terminal.txt'))).toBe(false)
    expect(primaryCheckoutSnapshot(repo)).toEqual(primary)
    const stoppedId = ptyId
    await f.rpc.request('pty.kill', { ptyId }); ptyId = undefined
    const outcomes = await Promise.all([editor, commit])
    for (const outcome of outcomes) if ('error' in outcome) expect(outcome.error.message).toMatch(/busy|revision|journal|nothing to commit|stale|changed/i)
    await vi.waitFor(() => expect(existsSync(join(directory, 'execution.lease')), JSON.stringify({ lookup: f.services.ptyManager.lookup(stoppedId), active: f.services.ptyManager.getActiveCount(), lease: existsSync(join(directory, 'execution.lease')) ? readFileSync(join(directory, 'execution.lease'), 'utf8') : null })).toBe(false), { timeout: 10_000 })
    expect(readFileSync(join(workspace, 'terminal-owned.txt'), 'utf8')).toBe('terminal result\n')
    const journal = await f.rpc.request<{ actions: Array<{ actor?: { kind: string }; status: string }> }>('actions.list', { threadId: thread.id })
    expect(journal.actions.length).toBeGreaterThan(0)
    await f.rpc.request('files.write', { threadId: thread.id, path: 'terminal-owned.txt', content: 'settled editor\n' })
    expect(readFileSync(join(workspace, 'terminal-owned.txt'), 'utf8')).toBe('settled editor\n')
    expect(primaryCheckoutSnapshot(repo)).toEqual(primary)
  } finally { if (ptyId) await f.rpc.request('pty.kill', { ptyId }).catch(() => undefined); await f.close() }
}, 45_000)
