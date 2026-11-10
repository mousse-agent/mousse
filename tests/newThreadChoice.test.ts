import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { migrateWorktreeDefaultSetting } from '../src/mms/data/newThreadChoice'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'
import type { ModelOverride } from '../src/shared/providerInstances'
import type { Thread } from '../src/shared/types'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mousse-new-thread-choice-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

const OPUS: ModelOverride = { instanceId: 'claude', llmProvider: 'claude-code', model: 'claude-opus-5-5', effort: 'high' }
const LAST_USED = { instanceId: 'codex', llmProvider: 'codex', model: 'gpt-6.1' }

/** A daemon context over a real project store and an in-memory thread store; `usable` decides which instances still work. */
function daemon(options: { clientType?: 'gui' | 'cli' | 'bridge'; bridgeCaller?: object; usable?: (model: ModelOverride) => boolean } = {}) {
  const projects = new ProjectManager(home)
  const threads = new Map<string, Thread>()
  let counter = 0
  const usable = options.usable ?? (() => true)
  const emitEvent = vi.fn()
  const mms = {
    projects,
    threads: {
      createThread: (name: string, projectId?: string, _path?: string, opts: { worktreeEnabled?: boolean } = {}) => {
        const thread = { id: `t${++counter}`, name, projectId, createdAt: '', updatedAt: '', ...(opts.worktreeEnabled !== undefined ? { worktreeEnabled: opts.worktreeEnabled } : {}) } as Thread
        threads.set(thread.id, thread)
        return thread
      },
      getThread: (id: string) => threads.get(id),
      updateThreadMeta: (id: string, patch: Partial<Thread>) => { const next = { ...threads.get(id)!, ...patch }; threads.set(id, next); return next },
      setThreadWorktreeEnabled: (id: string, worktreeEnabled: boolean) => { const next = { ...threads.get(id)!, worktreeEnabled }; threads.set(id, next); return next },
      getThreadDir: (id: string) => join(home, 'threads', id),
      listAllThreads: () => [...threads.values()]
    },
    orchestrator: {
      setThreadPermissionMode: (id: string, permissionMode: Thread['permissionMode']) => { const next = { ...threads.get(id)!, permissionMode }; threads.set(id, next); return next },
      setThreadModelOverride: (id: string, model: ModelOverride | undefined) => { threads.set(id, { ...threads.get(id)!, modelOverride: model }); return model }
    },
    providerInstances: {
      migrate: (model: ModelOverride) => model,
      overrideFor: (model: ModelOverride) => {
        if (!usable(model)) throw new Error(`Provider instance "${model.instanceId}" is turned off`)
        return { instanceId: model.instanceId!, llmProvider: model.llmProvider, model: model.model, ...(model.effort ? { effort: model.effort } : {}) }
      }
    },
    settings: { get: () => ({ provider: LAST_USED }), set: vi.fn() }
  }
  const ctx = {
    mms,
    globalSequence: () => 1,
    emitEvent,
    connection: { clientType: options.clientType ?? 'gui', ...(options.bridgeCaller ? { bridgeCaller: options.bridgeCaller } : {}) }
  } as unknown as HandlerContext
  const project = projects.openProject(join(home, 'app'))
  const call = <T>(method: string, params: Record<string, unknown>) => dispatchMethod(ctx, method, params) as Promise<T>
  // A new chat of the window, as the sidebar's New thread asks for one.
  const create = async (params: Record<string, unknown> = {}) => (await call<{ thread: Thread }>('threads.create', { name: 'New Chat', projectId: project.id, rememberedChoices: true, ...params })).thread
  return { ctx, projects, project, threads, emitEvent, call, create, remembered: () => projects.getProject(project.id)?.newThread }
}

describe('new threads remember the choices last made in their project', () => {
  it('a project with no choice starts on the profile defaults', async () => {
    const { create } = daemon()
    const thread = await create()
    expect(thread.modelOverride).toEqual(LAST_USED)
    expect(thread.permissionMode).toBeUndefined()
    expect(thread.worktreeEnabled).toBeUndefined()
  })

  it('a pick in a window is remembered, and the next new thread in the project starts with it', async () => {
    const { create, call, remembered, emitEvent, project } = daemon()
    const first = await create()
    await call('threads.setModel', { threadId: first.id, model: OPUS })
    await call('threads.setPermissionMode', { threadId: first.id, mode: 'full' })
    await call('threads.setWorktreeEnabled', { threadId: first.id, enabled: false, picked: true })
    expect(remembered()).toEqual({ model: OPUS, permissionMode: 'full', worktreeEnabled: false })
    // Windows hear about it, so a new chat's composer shows it before its thread exists.
    expect(emitEvent).toHaveBeenCalledWith('projects.updated', { projects: [expect.objectContaining({ id: project.id, newThread: remembered() })] })

    const next = await create()
    expect(next.modelOverride).toEqual(OPUS)
    expect(next.permissionMode).toBe('full')
    expect(next.worktreeEnabled).toBe(false)
  })

  it('a checkout picked for a new thread is remembered and wins over the remembered one; one only shown is not remembered', async () => {
    const { create, remembered, call } = daemon()
    expect((await create({ worktreeEnabled: false, picked: ['worktreeEnabled'] })).worktreeEnabled).toBe(false)
    expect(remembered()).toEqual({ worktreeEnabled: false })
    expect((await create({ worktreeEnabled: true })).worktreeEnabled).toBe(true)
    expect(remembered()).toEqual({ worktreeEnabled: false })
    // A send recording the shown checkout on a reused thread is no pick either.
    const reused = await create({ worktreeEnabled: false })
    await call('threads.setWorktreeEnabled', { threadId: reused.id, enabled: true })
    expect(remembered()).toEqual({ worktreeEnabled: false })
    await expect(call('threads.create', { name: 'New Chat', projectId: reused.projectId, picked: ['everything'] })).rejects.toThrow(/picked/)
  })

  it('a remembered model that can no longer be used falls back to the profile default, and the rest still applies', async () => {
    let claudeOn = true
    const { create, call } = daemon({ usable: (model) => model.instanceId !== 'claude' || claudeOn })
    const first = await create()
    await call('threads.setModel', { threadId: first.id, model: OPUS })
    await call('threads.setPermissionMode', { threadId: first.id, mode: 'ask' })
    claudeOn = false
    const next = await create()
    expect(next.modelOverride).toEqual(LAST_USED)
    expect(next.permissionMode).toBe('ask')
  })

  it('when the profile default is that same unusable model, the thread gets no model of its own', async () => {
    let claudeOn = true
    const { create, call, ctx } = daemon({ usable: (model) => model.instanceId !== 'claude' || claudeOn })
    const first = await create()
    await call('threads.setModel', { threadId: first.id, model: OPUS })
    ;(ctx.mms.settings as unknown as { get: () => unknown }).get = () => ({ provider: OPUS })
    claudeOn = false
    expect((await create()).modelOverride).toBeUndefined()
  })

  it('only a new chat a window asks for gets the remembered choices: the CLI, scripts and other computers get the defaults', async () => {
    const gui = daemon()
    const first = await gui.create()
    await gui.call('threads.setPermissionMode', { threadId: first.id, mode: 'full' })
    await gui.call('threads.setModel', { threadId: first.id, model: OPUS })
    expect(gui.remembered()).toEqual({ permissionMode: 'full', model: OPUS })
    const defaults = (thread: Thread) => {
      expect(thread.permissionMode).toBeUndefined()
      expect(thread.modelOverride).toEqual(LAST_USED)
    }
    // The CLI (or any script on the protocol) never inherits Full access, even when it asks.
    const cli = { ...gui.ctx, connection: { clientType: 'cli' } } as unknown as HandlerContext
    defaults((await dispatchMethod(cli, 'threads.create', { name: 'New Chat', projectId: gui.project.id }) as { thread: Thread }).thread)
    const asked = (await dispatchMethod(cli, 'threads.create', { name: 'New Chat', projectId: gui.project.id, rememberedChoices: true }) as { thread: Thread }).thread
    defaults(asked)
    // It keeps what it passes.
    expect((await dispatchMethod(cli, 'threads.create', { name: 'New Chat', projectId: gui.project.id, worktreeEnabled: true }) as { thread: Thread }).thread.worktreeEnabled).toBe(true)
    // A window's create that does not ask (the composer, which sets what it shows itself) gets the defaults too.
    defaults((await gui.call<{ thread: Thread }>('threads.create', { name: 'New Chat', projectId: gui.project.id })).thread)
    // The CLI's changes are not a person's pick in a window.
    await dispatchMethod(cli, 'threads.setPermissionMode', { threadId: asked.id, mode: 'ask' })
    expect(gui.remembered()).toEqual({ permissionMode: 'full', model: OPUS })
  })

  it('a project another computer or an agent works in neither remembers its picks nor hands them out', async () => {
    const gui = daemon()
    const first = await gui.create()
    await gui.call('threads.setPermissionMode', { threadId: first.id, mode: 'full' })
    expect(gui.remembered()).toEqual({ permissionMode: 'full' })

    // Another computer (a routed call) creates threads on the profile defaults and its picks are not remembered.
    const routed = { ...gui.ctx, connection: { clientType: 'bridge', bridgeCaller: { node: 'n1', user: 'u', maxPermissionMode: 'full' } } } as unknown as HandlerContext
    const remote = (await dispatchMethod(routed, 'threads.create', { name: 'New Chat', projectId: gui.project.id, rememberedChoices: true }) as { thread: Thread }).thread
    expect(remote.permissionMode).toBeUndefined()
    await dispatchMethod(routed, 'threads.setPermissionMode', { threadId: remote.id, mode: 'ask' })
    expect(gui.remembered()).toEqual({ permissionMode: 'full' })

    // A subagent's thread is an agent's, not a person's pick.
    gui.threads.set(first.id, { ...gui.threads.get(first.id)!, lineage: { parentThreadId: 'p' } as Thread['lineage'] })
    await gui.call('threads.setPermissionMode', { threadId: first.id, mode: 'ask' })
    expect(gui.remembered()).toEqual({ permissionMode: 'full' })
  })
})

describe('a new thread made with the model and mode its creator names', () => {
  const SONNET: ModelOverride = { instanceId: 'claude', llmProvider: 'claude-code', model: 'claude-sonnet-5-5' }

  it('the composer names what it shows: the thread is born with it, only the picked part is remembered, and the model becomes the last-used one', async () => {
    const { call, project, remembered, ctx } = daemon()
    const made = (await call<{ thread: Thread }>('threads.create', { name: 'New Chat', projectId: project.id, worktreeEnabled: false, model: SONNET, permissionMode: 'ask', picked: ['permissionMode'] })).thread
    expect(made.modelOverride).toEqual(SONNET)
    expect(made.permissionMode).toBe('ask')
    expect(made.worktreeEnabled).toBe(false)
    // The model and checkout were only shown (defaults): a default changed later still reaches this project.
    expect(remembered()).toEqual({ permissionMode: 'ask' })
    expect(ctx.mms.settings.set).toHaveBeenCalledWith({ provider: expect.objectContaining({ instanceId: 'claude', model: 'claude-sonnet-5-5' }) })
  })

  it('a named mode wins over the remembered one', async () => {
    const { create, call } = daemon()
    const first = await create()
    await call('threads.setPermissionMode', { threadId: first.id, mode: 'full' })
    expect((await create({ permissionMode: 'ask' })).permissionMode).toBe('ask')
  })

  it('refuses a model it cannot use, or a mode above the device limit, before any thread is made', async () => {
    const { call, project, threads, ctx } = daemon({ usable: (model) => model.instanceId !== 'claude' })
    await expect(call('threads.create', { name: 'New Chat', projectId: project.id, model: SONNET })).rejects.toThrow(/turned off/)
    await expect(call('threads.create', { name: 'New Chat', projectId: project.id, permissionMode: 'root' })).rejects.toThrow(/permissionMode/)
    const routed = { ...ctx, connection: { clientType: 'bridge', bridgeCaller: { node: 'n1', user: 'u', maxPermissionMode: 'ask' } } } as unknown as HandlerContext
    await expect(dispatchMethod(routed, 'threads.create', { name: 'New Chat', projectId: project.id, permissionMode: 'full' })).rejects.toThrow(/at most/)
    expect(threads.size).toBe(0)
  })

  it('the CLI keeps the mode it names, and that is no person\'s pick', async () => {
    const { ctx, project, remembered } = daemon()
    const cli = { ...ctx, connection: { clientType: 'cli' } } as unknown as HandlerContext
    const made = (await dispatchMethod(cli, 'threads.create', { name: 'New Chat', projectId: project.id, permissionMode: 'ask' }) as { thread: Thread }).thread
    expect(made.permissionMode).toBe('ask')
    expect(remembered()).toBeUndefined()
  })
})

describe('ProjectManager.rememberNewThreadChoice', () => {
  it('merges a pick into the project, keeps it after a reload, and reports when nothing changed', () => {
    const projects = new ProjectManager(home)
    const project = projects.openProject(join(home, 'app'))
    expect(projects.rememberNewThreadChoice(project.id, { permissionMode: 'full' })?.newThread).toEqual({ permissionMode: 'full' })
    expect(projects.rememberNewThreadChoice(project.id, { worktreeEnabled: false })?.newThread).toEqual({ permissionMode: 'full', worktreeEnabled: false })
    expect(projects.rememberNewThreadChoice(project.id, { permissionMode: 'full' })).toBeUndefined()
    expect(projects.rememberNewThreadChoice('missing', { permissionMode: 'full' })).toBeUndefined()
    expect(new ProjectManager(home).getProject(project.id)?.newThread).toEqual({ permissionMode: 'full', worktreeEnabled: false })
  })
})

describe('the removed "Start new threads in a worktree" setting', () => {
  const stored = () => (JSON.parse(readFileSync(join(home, 'mousse.conf'), 'utf-8')) as { settings?: { runs?: Record<string, unknown> } }).settings?.runs

  it('turned off on disk, becomes the default checkout of every project with no choice, later ones too, and is removed', () => {
    // As an older build left it in mousse.conf.
    const config = MousseConfigStore.load(home)
    config.updateSettingsSection({ runs: { resumeAfterUsageLimit: true, worktreeByDefault: false } as never })
    const fromDisk = MousseConfigStore.load(home)
    migrateWorktreeDefaultSetting(fromDisk)
    expect(stored()).not.toHaveProperty('worktreeByDefault')
    expect(stored()).toMatchObject({ resumeAfterUsageLimit: true, newThreadWorktree: false })
    expect(new SettingsStore(MousseConfigStore.load(home)).get().runs.newThreadWorktree).toBe(false)
    // No project is written: a project added after the migration takes the same default.
    expect(new ProjectManager(home).listProjects()).toEqual([])
  })

  it('is safe to run again when the key could not be removed, and left on it changes nothing', () => {
    const config = MousseConfigStore.load(home)
    config.updateSettingsSection({ runs: { worktreeByDefault: false } as never })
    const stuck = Object.assign(MousseConfigStore.load(home), { removeRunsKey: () => { throw new Error('read-only') } })
    expect(() => migrateWorktreeDefaultSetting(stuck)).toThrow('read-only')
    expect(stored()).toMatchObject({ worktreeByDefault: false, newThreadWorktree: false })
    migrateWorktreeDefaultSetting(MousseConfigStore.load(home))
    expect(stored()).toMatchObject({ newThreadWorktree: false })
    expect(stored()).not.toHaveProperty('worktreeByDefault')

    rmSync(join(home, 'mousse.conf'), { force: true })
    const on = MousseConfigStore.load(home)
    on.updateSettingsSection({ runs: { worktreeByDefault: true } as never })
    migrateWorktreeDefaultSetting(MousseConfigStore.load(home))
    expect(stored()).not.toHaveProperty('worktreeByDefault')
    expect(new SettingsStore(MousseConfigStore.load(home)).get().runs.newThreadWorktree).toBe(true)
  })
})
