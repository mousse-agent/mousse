import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Context } from '@earendil-works/pi-ai'
import type { Thread } from '../src/shared/types'
import type { AgentEpisode, AgentEpisodeState } from '../src/shared/agentEpisodes'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'
import { checkoutStorageSnapshot, createQualificationRepository, primaryCheckoutSnapshot } from './fixtures/resource-lifecycle-qualification'
import { providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'

it('refuses obsolete named context after actual Undo and an equal-length replacement parent turn, then accepts explicit fresh context', async () => {
  const f = await lifecycleHarness()
  try {
    const repo = createQualificationRepository(f.root), primary = primaryCheckoutSnapshot(repo)
    const { project } = await f.rpc.request<{ project: { id: string } }>('projects.open', { path: repo })
    const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'context divergence', projectId: project.id })
    const models = f.services.providerAuth.models
    const provider = models.getProviders().find((entry) => models.getModels(entry.id).length > 0)!
    const model = models.getModels(provider.id)[0]
    vi.spyOn(f.services.providerAuth, 'has').mockReturnValue(true)
    vi.spyOn(models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
    const captured: Context[] = [], responses = ['OLD_PARENT_INSTRUCTION_521', 'NAMED_PRIVATE_MEMORY_638', 'NEW_PARENT_INSTRUCTION_952', 'Fresh reply']
    vi.spyOn(models, 'streamSimple').mockImplementation((_model, context) => {
      captured.push(structuredClone(context))
      const next = responses.shift(); if (!next) throw new Error('Unexpected model invocation during context qualification')
      return streamOf(providerResponse([{ type: 'text', text: next }], 'stop')) as never
    })
    f.services.settings.set({ provider: { llmProvider: provider.id, model: model.id } })
    await f.rpc.request('orchestrator.send', { threadId: thread.id, content: 'Old parent request', mode: 'agent' })
    const originalLength = f.services.orchestrator.getNativeContext(thread.id).messages.length
    expect(originalLength).toBeGreaterThan(0)
    await f.rpc.request('agents.createNamed', { threadId: thread.id, name: 'Rememberer', task: 'Remember your current instructions', operationId: 'context-create' })
    let named!: AgentEpisodeState
    await vi.waitFor(async () => { named = await f.rpc.request('agents.listNamed', { threadId: thread.id }); expect(named.episodes[0].state).toBe('completed') }, { timeout: 10_000 })
    const recall = { threadId: thread.id, agent: named.identities[0].id, expectedAgentGeneration: 1, task: 'Continue your prior instructions' }
    await f.rpc.request('actions.undoLatest', { threadId: thread.id })
    expect(f.services.orchestrator.getNativeContext(thread.id).messages.length).toBeLessThan(originalLength)
    await expect(f.rpc.request('agents.recallNamed', { ...recall, operationId: 'after-undo' })).rejects.toThrow(/diverged|fresh context/i)
    expect(captured).toHaveLength(2)
    await f.rpc.request('orchestrator.send', { threadId: thread.id, content: 'New parent request', mode: 'agent' })
    expect(f.services.orchestrator.getNativeContext(thread.id).messages).toHaveLength(originalLength)
    await expect(f.rpc.request('agents.recallNamed', { ...recall, operationId: 'equal-length-prefix' })).rejects.toThrow(/diverged|fresh context/i)
    expect(captured).toHaveLength(3)
    await f.rpc.request('agents.recallNamed', { ...recall, operationId: 'explicit-fresh', contextMode: 'fresh' })
    await vi.waitFor(async () => { named = await f.rpc.request('agents.listNamed', { threadId: thread.id }); expect(named.episodes.find((entry) => entry.id === 'explicit-fresh')?.state).toBe('completed') }, { timeout: 10_000 })
    expect(named.episodes).toHaveLength(2)
    expect(named.identities[0].contextGeneration).toBe(2)
    expect(JSON.stringify(captured[3].messages)).not.toContain('NAMED_PRIVATE_MEMORY_638')
    expect(JSON.stringify(captured[3].messages)).not.toContain('OLD_PARENT_INSTRUCTION_521')
    expect(primaryCheckoutSnapshot(repo)).toEqual(primary)
  } finally { await f.close(); vi.restoreAllMocks() }
}, 45_000)

it('runs two simultaneous shared readers without extra checkouts and distinguishes their moving view from an isolated pinned snapshot', async () => {
  const f = await lifecycleHarness()
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  try {
    const repo = createQualificationRepository(f.root), primary = primaryCheckoutSnapshot(repo)
    const { project } = await f.rpc.request<{ project: { id: string } }>('projects.open', { path: repo })
    const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'simultaneous readers', projectId: project.id })
    const models = f.services.providerAuth.models
    const provider = models.getProviders().find((entry) => models.getModels(entry.id).length > 0)!
    const model = models.getModels(provider.id)[0]
    vi.spyOn(f.services.providerAuth, 'has').mockReturnValue(true)
    vi.spyOn(models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
    let entered = 0
    vi.spyOn(models, 'streamSimple').mockImplementation(() => {
      entered++
      return { async *[Symbol.asyncIterator]() { await held }, result: async () => providerResponse([{ type: 'text', text: 'Observed' }], 'stop') } as never
    })
    f.services.settings.set({ provider: { llmProvider: provider.id, model: model.id } })
    const shared = await Promise.all(['A', 'B'].map((name) => f.rpc.request<{ episode: AgentEpisode }>('agents.createNamed', { threadId: thread.id, name, task: 'Hold shared observation', operationId: `reader-${name}` })))
    await vi.waitFor(() => expect(entered).toBe(2), { timeout: 10_000 })
    expect(new Set(shared.map((entry) => entry.episode.binding.worktreePath)).size).toBe(1)
    expect(shared.every((entry) => entry.episode.binding.consistency === 'moving')).toBe(true)
    expect(checkoutStorageSnapshot(repo).materializedCheckouts).toBe(1)
    const snapshot = await f.rpc.request<{ episode: AgentEpisode }>('agents.createNamed', { threadId: thread.id, name: 'Exact', task: 'Hold exact snapshot', operationId: 'reader-exact', workspace: 'isolated', access: 'read-only' })
    await vi.waitFor(() => expect(entered).toBe(3), { timeout: 10_000 })
    expect(snapshot.episode.binding.consistency).toBe('snapshot')
    expect(checkoutStorageSnapshot(repo).materializedCheckouts).toBe(2)
    const filename = 'PRIMARY.txt'
    const original = readFileSync(join(snapshot.episode.binding.worktreePath, filename), 'utf8')
    await f.rpc.request('files.write', { threadId: thread.id, path: filename, content: 'parent changed while readers run\n' })
    for (const entry of shared) expect(readFileSync(join(entry.episode.binding.worktreePath, filename), 'utf8')).toBe('parent changed while readers run\n')
    expect(readFileSync(join(snapshot.episode.binding.worktreePath, filename), 'utf8')).toBe(original)
    release()
    await vi.waitFor(async () => {
      const state = await f.rpc.request<AgentEpisodeState>('agents.listNamed', { threadId: thread.id })
      expect(state.episodes.every((episode) => episode.state === 'completed')).toBe(true)
      expect(existsSync(snapshot.episode.binding.worktreePath)).toBe(false)
    }, { timeout: 15_000 })
    expect(checkoutStorageSnapshot(repo).materializedCheckouts).toBe(1)
    expect(primaryCheckoutSnapshot(repo)).toEqual(primary)
  } finally { release(); await f.close(); vi.restoreAllMocks() }
}, 45_000)

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
