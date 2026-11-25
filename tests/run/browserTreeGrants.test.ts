/**
 * Browser grants for person-started task trees (docs/plans/tool-api.md §2.6): who gets a browser binding, which tab
 * each agent drives, and what a turn that only reads pages may call.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MmsProfileServices } from '../../src/mms/MmsProfileServices'
import { BrowserArtifactService } from '../../src/mms/browser/BrowserArtifactService'
import { MmsBrowserService } from '../../src/mms/browser/MmsBrowserService'
import { BrowserSessionManager } from '../../src/mms/browser/automation/BrowserSessionManager'
import { BrowserToolDispatcher } from '../../src/mms/browser/automation/BrowserToolDispatcher'
import { ExecutionPolicyService } from '../../src/mms/execution/ExecutionPolicyService'
import { mainBrowserBinding } from '../../src/mms/platform/mainBrowserBinding'
import { BROWSER_AUTOMATION_TOOLS, type BrowserToolOutput } from '../../src/shared/browser/automation'
import type { BrowserRuntimePort } from '../../src/shared/browser/runtime'
import type { ExecutionContext, ExecutionPolicySnapshot } from '../../src/shared/execution/types'
import { makeBrowserCommandTempRoot, removeBrowserCommandTempRoot } from '../fixtures/agent-platform/browser-command-transport/ownedTemp'
import { appToolRegistry, appTurn, fakeAppToolHost, refusalOf } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const PROFILE = '33333333-3333-4333-8333-333333333333'

let fx: DelegationFixture | undefined
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  fx?.dispose()
  fx = undefined
  while (cleanups.length) await cleanups.pop()!()
})

/** Profile services over the fixture's run engine; threads in `readOnly` are read-only subagents. */
function profileServices(f: DelegationFixture, readOnly: ReadonlySet<string> = new Set()): MmsProfileServices {
  return {
    profileId: PROFILE,
    runEngine: f.engine,
    settings: { get: () => ({ integrations: { tools: { enabled: true, enabledTools: [...BROWSER_AUTOMATION_TOOLS] } } }) },
    threads: {
      getThread: (id: string) => ({ id, projectId: undefined, ...(readOnly.has(id) ? { workspaceBinding: { policy: 'shared', access: 'read-only' } } : {}) })
    },
    projects: { getProject: () => undefined },
    modeRegistry: { getModeSync: () => undefined }
  } as unknown as MmsProfileServices
}

/** A run in `running`, as the turn executor leaves it. */
function started(f: DelegationFixture, runId: string) {
  if (f.engine.getRun(runId)!.status === 'queued') f.engine.markStarting(runId)
  if (f.engine.getRun(runId)!.status === 'starting') f.engine.markRunning(runId)
  return f.engine.getRun(runId)!
}

async function sendRun(f: DelegationFixture, threadId: string, source: string) {
  const sent = await f.engine.dispatch({ kind: 'send', threadId, clientRequestId: `send:${threadId}:${randomUUID()}`, source } as never)
  if (sent.status !== 'accepted') throw new Error(`send rejected: ${JSON.stringify(sent)}`)
  return started(f, sent.runId)
}

describe('which runs a browser grant covers', () => {
  it('a person\'s run roots a grant; its subagents at any depth, their result wake and a resume join it', async () => {
    fx = delegationFixture()
    const services = profileServices(fx)
    const bind = (threadId: string, runId: string, source: string) => mainBrowserBinding(services, { threadId, turnId: `turn:${runId}`, runId, source, mode: 'agent' })

    const root = await fx.runningRun('root')
    const rootBinding = bind('root', root.runId, 'gui')
    expect(rootBinding?.execution).toMatchObject({ source: 'gui', browserGrant: { rootThreadId: 'root', lease: true } })
    const grantId = rootBinding!.execution.browserGrant!.grantId

    const child = await fx.delegate(root.runId, 'call-1')
    started(fx, child.childRunId)
    const childBinding = bind(child.childThreadId, child.childRunId, 'delegation')
    // The tree's backend, and a tab lease of the child's own.
    expect(childBinding?.execution).toMatchObject({ threadId: child.childThreadId, source: 'gui', browserGrant: { grantId, rootThreadId: 'root', lease: true } })

    const grandchild = await fx.delegate(child.childRunId, 'call-2')
    expect(bind(grandchild.childThreadId, grandchild.childRunId, 'delegation')?.execution.browserGrant?.grantId).toBe(grantId)

    // The child's result wakes the root once the root's run ended: the wake joins while the result waits.
    fx.finish(grandchild.childRunId)
    fx.finish(child.childRunId)
    fx.engine.markTerminal(root.runId, 'completed')
    const wakeRunId = fx.reconciler.runOnce().wakes.wakes[0]
    expect(wakeRunId).toBeDefined()
    expect(bind('root', wakeRunId, 'wake')?.execution.browserGrant?.grantId).toBe(grantId)

    // The timer's resume of a run in the tree joins while the tree still works.
    const resume = fx.store.createRun({ threadId: 'root', source: 'resume', outcome: { continuationOf: wakeRunId } })
    expect(bind('root', resume.runId, 'resume')?.execution.browserGrant?.grantId).toBe(grantId)
  })

  it('a read-only subagent holds browser.read only: read tools, no tab lease', async () => {
    fx = delegationFixture()
    const root = await fx.runningRun('root')
    const child = await fx.delegate(root.runId, 'call-1')
    const services = profileServices(fx, new Set([child.childThreadId]))
    mainBrowserBinding(services, { threadId: 'root', turnId: 't-root', runId: root.runId, source: 'gui', mode: 'agent' })
    const binding = mainBrowserBinding(services, { threadId: child.childThreadId, turnId: 't-child', runId: child.childRunId, source: 'delegation', mode: 'agent' })
    expect(binding?.execution.browserGrant).toMatchObject({ rootThreadId: 'root', lease: false })
    expect(binding?.policy.allowedTools).toEqual(expect.arrayContaining(['browser_tabs', 'browser_observe', 'browser_find', 'browser_extract', 'browser_wait']))
    expect(binding?.policy.allowedTools).not.toEqual(expect.arrayContaining(['browser_open']))
    expect(binding?.policy.allowedTools).not.toEqual(expect.arrayContaining(['browser_act']))
    expect(binding?.policy.allowedEffects).toEqual(['read'])
  })

  it('schedules, remote origins and what they cause get no browser, even on a thread whose tree holds a grant', async () => {
    fx = delegationFixture()
    const services = profileServices(fx)
    const bind = (threadId: string, runId: string, source: string) => mainBrowserBinding(services, { threadId, turnId: `turn:${runId}`, runId, source, mode: 'agent' })
    const root = await fx.runningRun('root')
    expect(bind('root', root.runId, 'gui')).toBeDefined()

    const scheduled = await sendRun(fx, 'scheduled', 'schedule')
    expect(bind('scheduled', scheduled.runId, 'schedule')).toBeUndefined()
    const scheduledChild = await fx.delegate(scheduled.runId, 'call-s')
    expect(bind(scheduledChild.childThreadId, scheduledChild.childRunId, 'delegation')).toBeUndefined()

    // A schedule's run queued on the root's own thread joins nothing either.
    const onRoot = fx.store.createRun({ threadId: 'root', source: 'schedule' })
    expect(bind('root', onRoot.runId, 'schedule')).toBeUndefined()
    for (const source of ['remote', 'webhook', 'integration', 'steer-followup'])
      expect(bind('root', fx.store.createRun({ threadId: 'root', source }).runId, source)).toBeUndefined()
  })

  it('the grant ends with its tree: a later resume joins nothing, and the person\'s next run roots a new grant', async () => {
    fx = delegationFixture()
    const services = profileServices(fx)
    const bind = (threadId: string, runId: string, source: string) => mainBrowserBinding(services, { threadId, turnId: `turn:${runId}`, runId, source, mode: 'agent' })
    const root = await fx.runningRun('root')
    const first = bind('root', root.runId, 'gui')!.execution.browserGrant!.grantId
    fx.finish(root.runId)

    const late = fx.store.createRun({ threadId: 'other', source: 'resume', outcome: { continuationOf: root.runId } })
    expect(bind('other', late.runId, 'resume')).toBeUndefined()

    const next = await fx.runningRun('root')
    const second = bind('root', next.runId, 'gui')!.execution.browserGrant!.grantId
    expect(second).not.toBe(first)
  })

  it('a tree rooted from the command line gives its subagents the managed browser', async () => {
    fx = delegationFixture()
    const services = profileServices(fx)
    const root = await sendRun(fx, 'root', 'cli')
    expect(mainBrowserBinding(services, { threadId: 'root', turnId: 't-root', runId: root.runId, source: 'cli', mode: 'agent' })?.execution.source).toBe('cli')
    const child = await fx.delegate(root.runId, 'call-1')
    expect(mainBrowserBinding(services, { threadId: child.childThreadId, turnId: 't-child', runId: child.childRunId, source: 'delegation', mode: 'agent' })?.execution.source).toBe('cli')
  })

  it('a person\'s run at the window right after a command-line run on the same thread drives the in-app browser', async () => {
    fx = delegationFixture()
    const services = profileServices(fx)
    const bind = (runId: string, source: string) => mainBrowserBinding(services, { threadId: 'root', turnId: `turn:${runId}`, runId, source, mode: 'agent' })
    const cli = await sendRun(fx, 'root', 'cli')
    expect(bind(cli.runId, 'cli')?.execution.source).toBe('cli')
    fx.finish(cli.runId)
    const gui = await sendRun(fx, 'root', 'gui')
    expect(bind(gui.runId, 'gui')?.execution.source).toBe('gui')
    const child = await fx.delegate(gui.runId, 'call-1')
    expect(mainBrowserBinding(services, { threadId: child.childThreadId, turnId: 't-child', runId: child.childRunId, source: 'delegation', mode: 'agent' })?.execution.source).toBe('gui')
  })
})

describe('in-app tabs under a grant', () => {
  async function browserService() {
    const root = makeBrowserCommandTempRoot()
    const artifacts = new BrowserArtifactService({ profileId: PROFILE, profileRoot: root, workerArtifactRoot: join(root, 'browser', 'worker-artifacts') })
    const service = new MmsBrowserService({ profileId: PROFILE, profileRoot: root, workerArtifactRoot: join(root, 'browser', 'worker-artifacts'), artifacts,
      installationBrowserRoot: join(root, 'browser-binaries'), threadExists: () => true })
    const owner = { connectionId: 'conn_1', profileId: PROFILE, profileEpoch: 1 }
    const registrations: Array<ReturnType<MmsBrowserService['registerAttachment']>> = []
    cleanups.push(async () => {
      for (const registration of registrations) service.unregisterAttachment(registration, owner)
      await service.dispose()
      await artifacts.dispose()
      removeBrowserCommandTempRoot(root)
    })
    await service.setAccess(true)
    const register = (uiTabId: string, threadId?: string) => registrations.push(service.registerAttachment({ registrationId: randomUUID(), registrationEpoch: 1,
      closureToken: randomBytes(32).toString('base64url'), uiTabId, ...(threadId ? { threadId } : {}) }, owner))
    return { service, register }
  }

  const execution = (threadId: string, lease = true): ExecutionContext => ({
    profileId: PROFILE, threadId, turnId: `turn-${threadId}`, actor: { kind: 'main' }, policySnapshotId: 'policy', source: 'gui',
    cancellationId: `cancel-${threadId}`, browserGrant: { grantId: 'grant-1', rootThreadId: 'root', lease }
  })

  it('only the root may take a free tab; a subagent waits for a tab of its own and then drives it', async () => {
    const { service, register } = await browserService()
    register('free_tab')
    // The subagent asks first and still leaves the free tab to the root.
    expect(service.targetFor(execution('child'))).toBeUndefined()
    expect(service.targetFor(execution('root'))).toEqual({ backend: 'electron-attached', uiTabId: 'free_tab' })

    const opening = service.requestAccess(execution('child'))
    await vi.waitFor(() => expect(service.accessStatus().tabRequests.map((request) => request.threadId)).toEqual(['child']))
    register('child_tab', 'child')
    await expect(opening).resolves.toBeDefined()
    expect(service.targetFor(execution('child'))).toEqual({ backend: 'electron-attached', uiTabId: 'child_tab' })
  })

  it('a run with no tree grant (an editor try-run, a workflow the app started) never takes a free tab: it waits for its own', async () => {
    const { service, register } = await browserService()
    register('free_tab')
    const tryRun: ExecutionContext = { ...execution('try_run'), browserGrant: undefined }
    expect(service.targetFor(tryRun)).toBeUndefined()
    const opening = service.requestAccess(tryRun)
    await vi.waitFor(() => expect(service.accessStatus().tabRequests.map((request) => request.threadId)).toEqual(['try_run']))
    register('try_run_tab', 'try_run')
    await expect(opening).resolves.toBeDefined()
    expect(service.targetFor(tryRun)).toEqual({ backend: 'electron-attached', uiTabId: 'try_run_tab' })
    // The free tab is still there for the root of a person's tree.
    expect(service.targetFor(execution('root'))).toEqual({ backend: 'electron-attached', uiTabId: 'free_tab' })
  })

  it('a run with no tree grant never inherits the shared tab a person\'s run on its thread borrowed', async () => {
    const { service, register } = await browserService()
    register('free_tab')
    expect(service.targetFor(execution('root'))).toEqual({ backend: 'electron-attached', uiTabId: 'free_tab' })
    const tryRun: ExecutionContext = { ...execution('root'), browserGrant: undefined }
    expect(service.targetFor(tryRun)).toBeUndefined()
    // A tab of its own thread is the one it gets.
    register('root_tab', 'root')
    expect(service.targetFor(tryRun)).toEqual({ backend: 'electron-attached', uiTabId: 'root_tab' })
  })

  it('a reader gets no tab of its own and is told so at once', async () => {
    const { service, register } = await browserService()
    register('free_tab')
    await expect(service.requestAccess(execution('reader', false))).rejects.toMatchObject({ code: 'setup_required', message: expect.stringContaining('only reads pages') })
    expect(service.accessStatus().tabRequests).toEqual([])
  })
})

describe('a tab has one driver', () => {
  const policy = (effects: ExecutionPolicySnapshot['allowedEffects']): ExecutionPolicySnapshot => ({
    id: `policy-${effects.join('-')}`, profileId: PROFILE, version: 1,
    allowedTools: ['browser_open', 'browser_tabs', 'browser_observe'], allowedCapabilities: ['browser.session', 'browser.observe'],
    allowedEffects: effects, approvalEffects: [], maxToolCalls: 40, maxElapsedMs: 60_000, maxArtifactBytes: 10_000_000
  })
  const context = (threadId: string, effects: ExecutionPolicySnapshot['allowedEffects'] = ['read', 'external']) => {
    const current = policy(effects)
    return {
      execution: { profileId: PROFILE, threadId, turnId: `turn-${threadId}`, runId: `run-${threadId}`, actor: { kind: 'main' as const }, policySnapshotId: current.id, source: 'cli' as const, cancellationId: `cancel-${threadId}` },
      policy: current, vision: false
    }
  }

  async function dispatcher() {
    const profileRoot = await mkdtemp(join(tmpdir(), 'mousse-tree-tabs-'))
    cleanups.push(() => rm(profileRoot, { recursive: true, force: true }))
    const broker = {
      call: async (request: { id: string; method: string; profileId: string; params: Record<string, unknown> }) => ({
        version: 1 as const, id: request.id, ok: true as const,
        result: request.method === 'session.open'
          ? { session: { id: 'session-1', profileId: request.profileId, threadId: request.params.threadId, runId: request.params.runId, persistent: false, backend: 'managed-chromium',
              browserVersion: 'fixture', generation: 1, lifecycle: 'ready', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }
          : { tabs: [] }
      })
    }
    const manager = new BrowserSessionManager({ profileId: PROFILE, profileRoot, broker })
    return new BrowserToolDispatcher({ sessions: manager })
  }

  it('another agent driving the session is refused browser_busy, naming the owner', async () => {
    const tools = await dispatcher()
    const opened = await tools.invoke('browser_open', {}, context('parent'))
    expect(opened.ok).toBe(true)
    const taken = await tools.invoke('browser_tabs', { sessionId: 'session-1', operation: 'new' }, context('child'))
    expect(taken).toMatchObject({ ok: false, error: { code: 'browser_busy', message: expect.stringContaining('(thread parent)') } })
  })

  it('listing tabs only reads; opening one acts', async () => {
    const tools = await dispatcher()
    expect((await tools.invoke('browser_open', {}, context('parent'))).ok).toBe(true)
    const reads = context('parent', ['read'])
    expect((await tools.invoke('browser_tabs', { sessionId: 'session-1' }, reads)).ok).toBe(true)
    expect(await tools.invoke('browser_tabs', { sessionId: 'session-1', operation: 'new' }, reads)).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
  })
})

describe('what a turn that only reads pages may call', () => {
  it('a Plan turn lists tabs and observes; opening a tab is refused for lacking browser.act', async () => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const dispatched: string[] = []
    const port: BrowserRuntimePort = {
      resolveTarget: () => ({ backend: 'managed-chromium' }),
      requestAccess: vi.fn(async () => 'already-allowed' as const),
      dispatch: async (_context, name) => {
        dispatched.push(name)
        return { tabs: [] } as unknown as BrowserToolOutput
      }
    }
    const fake = fakeAppToolHost({ browserRuntime: () => port })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    const policy = new ExecutionPolicyService().snapshot(PROFILE, {
      allowedTools: [...BROWSER_AUTOMATION_TOOLS], allowedCapabilities: ['browser.session', 'browser.observe'], allowedEffects: ['read', 'external'],
      maxToolCalls: 100, maxElapsedMs: 60_000
    })
    turns.register(appTurn({
      threadId: 'thread-a', runId: run.runId, mode: 'plan', modeFacts: { readOnly: true, agent: false, build: false }, modeCeiling: 'plan',
      browser: { mode: 'structured', vision: false, policy,
        execution: { profileId: PROFILE, threadId: 'thread-a', turnId: run.runId, runId: run.runId, actor: { kind: 'main' }, policySnapshotId: policy.id, source: 'gui', cancellationId: run.runId } }
    }))
    const ctx = () => request({ threadId: 'thread-a', runId: run.runId, modeCeiling: 'plan' })

    expect((await registry.call('browser_tabs', { sessionId: 'session-1' }, ctx())).isError).toBeFalsy()
    expect((await registry.call('browser_observe', { sessionId: 'session-1' }, ctx())).isError).toBeFalsy()
    const opened = refusalOf(await registry.call('browser_tabs', { sessionId: 'session-1', operation: 'new' }, ctx()))
    expect(opened?.refused).toMatchObject({ code: 'lacks_capability', lacks: 'browser.act' })
    expect(refusalOf(await registry.call('browser_open', {}, ctx()))?.refused).toMatchObject({ code: 'lacks_capability', lacks: 'browser.act' })
    expect(dispatched).toEqual(['browser_tabs', 'browser_observe'])
  })
})
