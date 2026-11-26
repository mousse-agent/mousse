/**
 * Issue #469: an agent starts and manages a subagent on another of the user's computers. A real
 * `OrchestratorService`, Run Engine and effect worker (`useSubagentWorld`); the other computer is a fake
 * Bridge port that answers the routed calls the way an owner does. The service's background passes are
 * stopped, so each test moves the tasks along with `pass()`.
 */
import { describe, expect, it } from 'vitest'
import { DomainRpcError } from '../../src/mms/protocol/domainRegistry'
import type { PermissionMode } from '../../src/shared/permissionMode'
import type { RemoteComputer, RemoteComputersPort } from '../../src/mms/protocol/remoteComputersPort'
import { finalAssistantText, type RemoteSubagents } from '../../src/mms/orchestrator/RemoteSubagents'
import { useSubagentWorld, type Json } from './subagentWorld'
import { waitFor } from './phase6Fixture'
import { dispatchMethod, type HandlerContext } from '../../src/mms/protocol/handlers'

const MAC = 'node-mac'

/** One computer that runs threads, scripted per test. */
class FakeComputer implements RemoteComputersPort {
  readonly calls: Array<{ method: string; params: Record<string, unknown>; idem?: string }> = []
  online = true
  allowed: RemoteComputer[] = [{ node: MAC, name: 'Studio Mac', online: true }]
  farRun: Json = { status: 'running', userMessageId: 'far-user-1' }
  /** What the thread there still runs (`threads.backgroundWork`), and its runs newest first (`runs.list`). */
  farWork: Json = { items: [], providerWork: false, busy: false }
  farRuns: Json[] = []
  pending: unknown[] = []
  finalText = 'All 40 tests pass on macOS.'
  match: { projectId: string; weak: boolean } | null = { projectId: 'far-project', weak: false }
  /** Refuses the method with this code. */
  refuse: Record<string, string> = {}
  /** The most this computer lets the caller's device set. */
  limit = 'accept_edits'
  /** What its model picker offers (`providers.snapshots`). */
  snapshots: Json[] = []
  /** Whether it takes calls marked as an agent's; false is a computer from before the mark. */
  marks = false
  /** How often it was asked. */
  asked = 0
  /** The routed versions it reports; undefined is a computer that reports none. */
  routedVersions: Record<string, number> | undefined
  private threads = 0
  private runs = 0

  computers(): RemoteComputer[] {
    return this.allowed.map((computer) => ({ ...computer, online: this.online && computer.online }))
  }

  async matchProject(): Promise<{ projectId: string; weak: boolean } | null> {
    if (!this.online) throw new DomainRpcError('computer_offline', 'Studio Mac is offline.')
    return this.match
  }

  async takesAgentMark(node: string): Promise<boolean> {
    expect(node).toBe(MAC)
    this.asked += 1
    if (!this.online) throw new DomainRpcError('computer_offline', 'Studio Mac is offline.')
    return this.marks
  }

  async versions(node: string): Promise<Record<string, number> | undefined> {
    expect(node).toBe(MAC)
    return this.routedVersions
  }

  async call(node: string, method: string, params: Record<string, unknown>, options?: { idem?: string }): Promise<unknown> {
    expect(node).toBe(MAC)
    this.calls.push({ method, params, ...(options?.idem ? { idem: options.idem } : {}) })
    if (!this.online) throw new DomainRpcError('computer_offline', 'Studio Mac is offline.')
    if (this.refuse[method]) throw new DomainRpcError(this.refuse[method], `Studio Mac refused ${method}.`)
    switch (method) {
      case 'threads.create':
        return { thread: { id: `far-thread-${++this.threads}` } }
      case 'composer.options':
        return { providers: [], defaultModel: null, permission: { defaultMode: 'accept_edits', limit: this.limit } }
      case 'threads.setPermissionMode':
      case 'threads.setModel':
      case 'threads.archive':
      case 'threads.setExpiry':
        return {}
      case 'orchestrator.send':
        // A computer that takes a running-time limit says so in its answer.
        return { runId: `far-run-${++this.runs}`, accepted: true, ...(params.deadlineMinutes !== undefined ? { deadlineMinutes: params.deadlineMinutes } : {}) }
      case 'runs.get':
        return { run: { runId: params.runId, ...this.farRun } }
      case 'orchestrator.pendingQuestions':
        return { pending: this.pending }
      case 'threads.backgroundWork':
        return { threadId: params.threadId, ...this.farWork }
      case 'runs.list':
        return { runs: this.farRuns.slice(0, Number(params.limit ?? 50)) }
      case 'thread.snapshot':
        return {
          messages: [
            { id: 'far-user-1', role: 'user', content: 'Run the macOS tests' },
            { id: 'far-assistant-1', role: 'assistant', content: this.finalText }
          ]
        }
      case 'workspace.getStatus':
        return { metadata: { branch: 'mousse/thread/far-thread-1', headSha: '0123456789abcdef0123' } }
      case 'orchestrator.abort':
        return { ok: true }
      case 'providers.snapshots':
        return { scope: params.scope, snapshots: this.snapshots }
      default:
        throw new Error(`unexpected call ${method}`)
    }
  }

  methods(): string[] {
    return this.calls.map((call) => call.method)
  }
}

describe('remote subagents (issue #469)', () => {
  const world = useSubagentWorld()

  /** A world whose parent may start subagents on the fake Mac. */
  const remoteWorld = (options: { on?: boolean; allow?: boolean } = {}) => {
    const w = world()
    const mac = new FakeComputer()
    w.d.settings.agentAccess = { level: 'lineage', projectIds: [], answerApprovals: false, remoteSubagents: options.on !== false, computers: options.allow === false ? [] : [MAC] }
    w.d.orch.setRemoteComputers(mac)
    const service = (w.d.orch as unknown as { remoteSubagents: RemoteSubagents }).remoteSubagents
    // The tests move the tasks along themselves.
    service.pause()
    const startOnMac = (tools: Parameters<typeof w.start>[0], title: string, extra: Json = {}, id = `start:${title}`) =>
      w.start(tools, title, { computer: 'studio mac', workspace: 'isolated', role: 'implement', ...extra }, id)
    return { ...w, mac, service, startOnMac }
  }

  it('starts the subagent on the other computer and brings its result back to the parent', async () => {
    const { d, adapter, parent, steps, out, say, mac, service, reconciler, startOnMac } = remoteWorld()
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester') }
    await say('go')
    expect(out.started).toMatchObject({ title: 'Mac tester', computer: 'Studio Mac' })
    expect(out.started.note).toContain('Started on Studio Mac')
    // Created in the same repository there, in its own worktree, no looser than the parent (Auto-accept edits by default).
    expect(mac.methods()).toEqual(['threads.create', 'composer.options', 'threads.setPermissionMode', 'orchestrator.send'])
    expect(mac.calls[0]).toMatchObject({ params: { name: 'Mac tester', worktreeEnabled: true }, idem: expect.stringContaining('create') })
    expect(mac.calls[2].params).toMatchObject({ threadId: 'far-thread-1' })
    expect(['ask', 'accept_edits']).toContain(mac.calls[2].params.mode)
    const send = mac.calls[3].params
    expect(send).toMatchObject({ threadId: 'far-thread-1', mode: 'agent' })
    expect(String(send.content)).toContain('started by an agent on another of the user\'s computers')
    expect(String(send.content)).toContain('Review Mac tester')

    // Nothing ran here: the stand-in waits, linked to the thread there.
    const child = d.store.getThread(out.started.childThreadId)!
    expect(child.runsOn).toEqual({ node: MAC, computerName: 'Studio Mac', ref: `${MAC}:far-thread-1` })
    expect(adapter.turns.some((turn) => turn.threadId === child.id)).toBe(false)
    expect(d.engine.getRun(out.started.childRunId)!.status).toBe('queued')
    // Lineage shows where it runs and that it is working there.
    await service.pass()
    const row = (d.orch as any).subagentView(parent.id)[0]
    expect(row).toMatchObject({ title: 'Mac tester', state: 'working', computer: { node: MAC, name: 'Studio Mac', online: true, ref: `${MAC}:far-thread-1` } })

    // The run there ends: the task publishes its text and branch, and the parent is woken with it.
    mac.farRun = { status: 'completed', userMessageId: 'far-user-1' }
    await service.pass()
    const task = d.engine.delegations.get(out.started.delegationId)!
    expect(task.result).toMatchObject({ runStatus: 'completed' })
    expect(task.result!.text).toContain('All 40 tests pass on macOS.')
    expect(task.result!.text).toContain('branch mousse/thread/far-thread-1 at 0123456789ab on Studio Mac')
    expect(d.engine.remoteSubagents.get(out.started.delegationId)!.state).toBe('done')
    // The parent's turn ended, so the reconciler wakes it with the notice, as for a local subagent.
    await waitFor(() => d.engine.getActiveRun(parent.id) === null, 'the parent turn to end')
    expect(reconciler.runOnce().wakes.wakes).toHaveLength(1)
    await waitFor(() => adapter.turns.filter((turn) => turn.threadId === parent.id).length >= 2, 'the parent woken with the result')
    expect(adapter.turns.filter((turn) => turn.threadId === parent.id).at(-1)!.prompt).toContain('All 40 tests pass on macOS.')
    // The stand-in's transcript shows what it was asked and what it answered.
    const messages = d.orch.getMessages(child.id)
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  it('refuses before anything exists: the switch off, a computer the user did not allow, an unknown one, one that is offline', async () => {
    const { d, parent, steps, out, say, mac, startOnMac } = remoteWorld({ on: false, allow: false })
    steps['go'] = async (tools) => {
      out.off = await startOnMac(tools, 'O')
      out.offList = await tools.listComputers() as Json
      d.settings.agentAccess = { ...d.settings.agentAccess, remoteSubagents: true }
      out.notAllowed = await startOnMac(tools, 'A')
      d.settings.agentAccess = { ...d.settings.agentAccess, computers: [MAC] }
      out.unknown = await startOnMac(tools, 'B', { computer: 'Windows box' })
      mac.online = false
      out.offline = await startOnMac(tools, 'C')
      mac.online = true
      out.half = await startOnMac(tools, 'E', { model: 'opus' })
    }
    await say('go')
    expect(out.off).toMatchObject({ started: false, code: 'remote_subagents_off' })
    expect(out.off.message).toContain('Settings → Agents → Agent access')
    expect(out.offList).toMatchObject({ computers: [] })
    expect(out.notAllowed).toMatchObject({ started: false, code: 'computer_not_allowed' })
    expect(out.notAllowed.message).toContain('Settings → Agents → Agent access')
    expect(out.unknown).toMatchObject({ started: false, code: 'unknown_computer' })
    expect(out.unknown.message).toContain('Studio Mac')
    expect(out.offline).toMatchObject({ started: false, code: 'computer_offline' })
    expect(out.half).toMatchObject({ started: false, code: 'selection_incomplete' })
    expect(mac.calls).toEqual([])
    expect(d.engine.delegations.listForParentThread(parent.id)).toEqual([])
  })

  it('a refusal on the other computer is the tool result, and the parent gets no notice for it', async () => {
    const { d, parent, steps, out, say, mac, startOnMac } = remoteWorld()
    mac.refuse['threads.create'] = 'computer_forbidden'
    steps['go'] = async (tools) => { out.refused = await startOnMac(tools, 'Mac tester') }
    await say('go')
    expect(out.refused).toMatchObject({ started: false, code: 'computer_forbidden' })
    expect(out.refused.message).toContain('Studio Mac did not start the subagent')
    const [task] = d.engine.delegations.listForParentThread(parent.id)
    expect(task.status).toBe('cancelled')
    expect(d.engine.inbox.listPending(parent.id)).toEqual([])
    // Its title is free again for a new try.
    expect(d.store.getThread(task.childThreadId)!.name).toBe('Mac tester (not started)')
  })

  it('an offline computer does not end the task: it goes on when the computer is back', async () => {
    const { d, parent, steps, out, say, mac, service, startOnMac } = remoteWorld()
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester') }
    await say('go')
    mac.online = false
    mac.farRun = { status: 'completed', userMessageId: 'far-user-1' }
    await service.pass()
    expect(d.engine.delegations.get(out.started.delegationId)!.status).toBe('running')
    const row = (d.orch as any).subagentView(parent.id)[0]
    expect(row.computer).toMatchObject({ online: false, lastError: 'Studio Mac is offline.' })
    expect(row.state).not.toBe('failed')
    mac.online = true
    await service.pass()
    expect(d.engine.delegations.get(out.started.delegationId)!.status).toBe('result_available')
  })

  it('a question waiting there shows as needs input, and the parent is told it is answered there', async () => {
    const { d, parent, steps, out, say, mac, service, startOnMac } = remoteWorld()
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester') }
    steps['answer'] = async (tools) => {
      out.answer = await tools.answerSubagent({ subagent: 'Mac tester', requestId: 'q-1', answers: { a: 'yes' } }) as Json
      out.status = await tools.taskStatus({ subagent: 'Mac tester' }) as Json
      out.again = await tools.continueSubagent({ subagent: 'Mac tester', prompt: 'And iOS?' }, { toolCallId: 'c1' }) as Json
    }
    await say('go')
    mac.pending = [{ requestId: 'q-1', questions: [] }]
    await service.pass()
    // What the app lists (`subagents.list`), as well as what the agent tools read: the parent's card says it needs
    // input there, with the thread there to open, not "Queued".
    const ctx = { mms: { runEngine: d.engine, threads: d.store, questions: d.questions, orchestrator: d.orch }, globalSequence: () => 0 } as unknown as HandlerContext
    const listed = (await dispatchMethod(ctx, 'subagents.list', { threadId: parent.id })) as { subagents: Json[] }
    expect(listed.subagents[0]).toMatchObject({ state: 'needs_input', computer: { name: 'Studio Mac', ref: 'node-mac:far-thread-1' } })
    expect((d.orch as any).subagentView(parent.id)[0].state).toBe('needs_input')
    await say('answer')
    expect(out.answer).toMatchObject({ answered: false, code: 'answer_on_computer' })
    expect(out.status.computer).toMatchObject({ name: 'Studio Mac', waitingForAnswer: true })
    expect(out.again).toMatchObject({ started: false, code: 'needs_answer' })
  })

  it('Stop here stops the run there', async () => {
    const { d, steps, out, say, mac, service, startOnMac } = remoteWorld()
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester') }
    steps['cancel'] = async (tools) => { out.cancelled = await tools.taskCancel({ subagent: 'Mac tester' }) as Json }
    await say('go')
    await say('cancel')
    expect(d.engine.delegations.get(out.started.delegationId)!.status).toBe('cancelled')
    await service.pass()
    const abort = mac.calls.find((call) => call.method === 'orchestrator.abort')
    expect(abort?.params).toMatchObject({ threadId: 'far-thread-1', runId: 'far-run-1' })
    expect(d.engine.remoteSubagents.get(out.started.delegationId)!.state).toBe('done')
  })

  describe('a run there that ended while the thread there still works for the task', () => {
    /** The task's run there ended with an interim answer; its agent left a background command running there. */
    const waiting = async (options: { maxMinutes?: number } = {}) => {
      const w = remoteWorld()
      if (options.maxMinutes) {
        w.mac.marks = true
        w.mac.routedVersions = { 'orchestrator.send': 8 }
      }
      w.steps['go'] = async (tools) => { w.out.started = await w.startOnMac(tools, 'Mac tester', options.maxMinutes ? { maxMinutes: options.maxMinutes } : {}) }
      await w.say('go')
      w.mac.farRun = { status: 'completed', userMessageId: 'far-user-1', ordinal: 1 }
      w.mac.finalText = 'Verify is running in the background; I will continue when it reports back.'
      w.mac.farWork = { items: [{ id: 'bg-1', kind: 'background', description: 'verify' }], providerWork: false, busy: true }
      w.mac.farRuns = [{ runId: 'far-run-1', status: 'completed', ordinal: 1 }]
      await w.service.pass()
      const task = () => w.d.engine.delegations.get(w.out.started.delegationId)!
      return { ...w, task }
    }

    it('the task waits, then publishes the answer of the turn that ended with nothing left', async () => {
      const { d, parent, out, mac, service, task } = await waiting()
      expect(task().status).toBe('running')
      expect(d.engine.inbox.listForThread(parent.id).filter((row) => row.kind === 'child_result')).toEqual([])
      expect(service.overlay(out.started.childThreadId)).toMatchObject({ activity: 'working' })

      // The command ended there and woke the thread: its next turn runs, then ends with the final answer.
      mac.farWork = { items: [], providerWork: false, busy: true }
      mac.farRuns = [{ runId: 'far-run-2', status: 'running', ordinal: 2 }, ...mac.farRuns]
      await service.pass()
      expect(task().status).toBe('running')
      mac.farWork = { items: [], providerWork: false, busy: false }
      mac.farRuns[0] = { runId: 'far-run-2', status: 'completed', ordinal: 2 }
      mac.finalText = 'Verify passed: 812 tests.'
      await service.pass()
      expect(task()).toMatchObject({ status: 'result_available', result: { runStatus: 'completed' } })
      expect(task().result!.text).toContain('Verify passed: 812 tests.')
      expect(task().result!.text).not.toContain('I will continue')
      expect(d.engine.inbox.listForThread(parent.id).filter((row) => row.kind === 'child_result')).toHaveLength(1)
    })

    it('a computer too old to say busy is read by what it lists', async () => {
      const { mac, service, task } = await waiting()
      mac.farWork = { items: [{ id: 'mon-1', kind: 'command', description: 'CI' }], providerWork: false }
      await service.pass()
      expect(task().status).toBe('running')
      // A wake-up set there is not work that runs: with nothing else, the run's end settles the task.
      mac.farWork = { items: [{ id: 'wake-1', kind: 'wake', description: 'later' }], providerWork: false }
      await service.pass()
      expect(task()).toMatchObject({ status: 'result_available', result: { runStatus: 'completed' } })
    })

    it('a read that does not reach that computer settles nothing', async () => {
      const { mac, service, task } = await waiting()
      mac.farWork = { items: [], providerWork: false, busy: false }
      mac.refuse['threads.backgroundWork'] = 'computer_offline'
      await service.pass()
      expect(task().status).toBe('running')
      delete mac.refuse['threads.backgroundWork']
      await service.pass()
      expect(task().status).toBe('result_available')
    })

    it('Stop here stops the thread there, so what it left running ends too', async () => {
      const { d, steps, out, mac, say, service } = await waiting()
      steps['cancel'] = async (tools) => { out.cancelled = await tools.taskCancel({ subagent: 'Mac tester' }) as Json }
      await say('cancel')
      expect(d.engine.delegations.get(out.started.delegationId)!.status).toBe('cancelled')
      await service.pass()
      const abort = mac.calls.find((call) => call.method === 'orchestrator.abort')
      expect(abort?.params).toMatchObject({ threadId: 'far-thread-1' })
      expect(abort?.params).not.toHaveProperty('runId')
    })

    it('a limit that computer counted runs on here as wall time while the task waits, and stops the thread there', async () => {
      const { d, mac, service, out, task } = await waiting({ maxMinutes: 5 })
      expect(d.engine.remoteSubagents.get(out.started.delegationId)).toMatchObject({ limitMinutes: 5, deadlineAt: null })
      expect(task().status).toBe('running')
      ;(service as unknown as { deps: { now: () => number } }).deps.now = () => Date.now() + 6 * 60_000
      await service.pass()
      expect(task().result).toMatchObject({ runStatus: 'interrupted' })
      expect(task().result!.error).toContain('5-minute limit on Studio Mac while it waited on its background work')
      await service.pass()
      const abort = mac.calls.find((call) => call.method === 'orchestrator.abort')
      expect(abort?.params).toMatchObject({ threadId: 'far-thread-1' })
      expect(abort?.params).not.toHaveProperty('runId')
    })
  })

  it('the time limit ends the task here and stops it there', async () => {
    const { d, parent, steps, out, say, mac, service, startOnMac } = remoteWorld()
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester', { maxMinutes: 5 }) }
    await say('go')
    ;(service as unknown as { deps: { now: () => number } }).deps.now = () => Date.now() + 6 * 60_000
    await service.pass()
    const task = d.engine.delegations.get(out.started.delegationId)!
    expect(task.result).toMatchObject({ runStatus: 'interrupted' })
    expect(task.result!.error).toContain('5-minute limit on Studio Mac')
    await service.pass()
    expect(mac.methods()).toContain('orchestrator.abort')
    expect(d.engine.inbox.listPending(parent.id).length + d.engine.inbox.listByStatus(parent.id, 'delivered').length + d.engine.inbox.listByStatus(parent.id, 'acknowledged').length).toBeGreaterThan(0)
  })

  it('has no default time limit and no longest one: without maxMinutes it runs on after days, and a limit past a day is kept as given', async () => {
    const { d, steps, out, say, mac, service, startOnMac } = remoteWorld()
    steps['go'] = async (tools) => {
      out.started = await startOnMac(tools, 'Mac tester')
      out.long = await startOnMac(tools, 'Mac soak', { maxMinutes: 3000 })
    }
    await say('go')
    const clock = (service as unknown as { deps: { now: () => number } }).deps
    clock.now = () => Date.now() + 2 * 24 * 60 * 60_000
    await service.pass()
    expect(d.engine.delegations.get(out.started.delegationId)!.result).toBeFalsy()
    expect(d.engine.delegations.get(out.long.delegationId)!.result).toBeFalsy()
    expect(mac.methods()).not.toContain('orchestrator.abort')
    clock.now = () => Date.now() + 3001 * 60_000
    await service.pass()
    expect(d.engine.delegations.get(out.long.delegationId)!.result!.error).toContain('3000-minute limit on Studio Mac')
    expect(d.engine.delegations.get(out.started.delegationId)!.result).toBeFalsy()
  })

  // Issue #685: the time limit is running time, counted by the computer that runs the task, where that computer can.
  it('a computer that takes a limit on a send gets it as running time, and this one no longer stops the task by the clock', async () => {
    const { d, steps, out, say, mac, service, startOnMac } = remoteWorld()
    mac.marks = true
    mac.routedVersions = { 'orchestrator.send': 8 }
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester', { maxMinutes: 5 }) }
    await say('go')
    expect(mac.calls.find((call) => call.method === 'orchestrator.send')!.params).toMatchObject({ deadlineMinutes: 5 })
    expect(d.engine.remoteSubagents.get(out.started.delegationId)).toMatchObject({ limitMinutes: 5, deadlineAt: null })
    ;(service as unknown as { deps: { now: () => number } }).deps.now = () => Date.now() + 60 * 60_000
    await service.pass()
    expect(d.engine.delegations.get(out.started.delegationId)!.result).toBeFalsy()
    expect(mac.methods()).not.toContain('orchestrator.abort')
  })

  it('an older computer gets no limit on the send, and the task keeps its deadline here', async () => {
    const { d, steps, out, say, mac, startOnMac } = remoteWorld()
    mac.marks = true
    mac.routedVersions = { 'orchestrator.send': 7 }
    steps['go'] = async (tools) => {
      out.started = await startOnMac(tools, 'Mac tester', { maxMinutes: 5 })
      out.free = await startOnMac(tools, 'Mac soak')
    }
    await say('go')
    for (const send of mac.calls.filter((call) => call.method === 'orchestrator.send')) expect(send.params).not.toHaveProperty('deadlineMinutes')
    expect(d.engine.remoteSubagents.get(out.started.delegationId)!.deadlineAt).not.toBeNull()
    expect(d.engine.remoteSubagents.get(out.free.delegationId)).toMatchObject({ limitMinutes: null, deadlineAt: null })
  })

  // Issue #685: a subagent on another computer expires with the thread that started it.
  it('its thread there gets the parent\'s expiry, then every change and the removal, also once that computer is back', async () => {
    const { d, parent, steps, out, say, mac, service, startOnMac } = remoteWorld()
    const inTwoHours = new Date(Date.now() + 2 * 60 * 60_000).toISOString()
    d.store.updateThreadMeta(parent.id, { expiresAt: inTwoHours, expiryStopsRun: true }, { touch: false })
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester') }
    await say('go')
    const expiries = () => mac.calls.filter((call) => call.method === 'threads.setExpiry')
    expect(expiries()).toHaveLength(1)
    expect(expiries()[0]).toMatchObject({ params: { threadId: 'far-thread-1', expiresAt: inTwoHours, stopsRun: true }, idem: expect.stringContaining('remote-expiry:') })

    // Changed while that computer is offline: sent once it answers.
    const inThreeHours = new Date(Date.now() + 3 * 60 * 60_000).toISOString()
    mac.online = false
    d.store.updateThreadMeta(parent.id, { expiresAt: inThreeHours, expiryStopsRun: undefined }, { touch: false })
    d.orch.threadExpiryChanged(parent.id)
    await service.pass()
    expect(d.engine.remoteExpiry.get(out.started.childThreadId)).toMatchObject({ state: 'pending', expiresAt: inThreeHours })
    mac.online = true
    await service.pass()
    expect(expiries().at(-1)!.params).toEqual({ threadId: 'far-thread-1', expiresAt: inThreeHours })
    expect(d.engine.remoteExpiry.get(out.started.childThreadId)).toMatchObject({ state: 'sent', lastError: null })
    const sentSoFar = expiries().length
    // Nothing changed: nothing is sent again.
    d.orch.threadExpiryChanged(parent.id)
    await service.pass()
    expect(expiries()).toHaveLength(sentSoFar)

    // Kept after all: the thread there is kept too.
    d.store.updateThreadMeta(parent.id, { expiresAt: undefined, expiryStopsRun: undefined }, { touch: false })
    d.orch.threadExpiryChanged(parent.id)
    await service.pass()
    expect(expiries().at(-1)!.params).toEqual({ threadId: 'far-thread-1', expiresAt: null })
  })

  it('an expiry that passed while that computer was offline is sent as soon as it takes, so its thread still goes', async () => {
    const { d, parent, steps, out, say, mac, service, startOnMac } = remoteWorld()
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester') }
    await say('go')
    mac.online = false
    d.store.updateThreadMeta(parent.id, { expiresAt: new Date(Date.now() - 60_000).toISOString() }, { touch: false })
    d.orch.threadExpiryChanged(parent.id)
    await service.pass()
    mac.online = true
    await service.pass()
    const sent = mac.calls.filter((call) => call.method === 'threads.setExpiry').at(-1)!
    // That computer refuses an expiry less than a minute away; a minute and a half is the soonest sent.
    expect(Date.parse(String(sent.params.expiresAt))).toBeGreaterThanOrEqual(Date.now() + 60_000)
    expect(Date.parse(String(sent.params.expiresAt))).toBeLessThanOrEqual(Date.now() + 2 * 60_000)
  })

  it('an expiry that computer refuses for good is not asked again; one it cannot be reached for is', async () => {
    const { d, parent, steps, out, say, mac, service, startOnMac } = remoteWorld()
    d.store.updateThreadMeta(parent.id, { expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString() }, { touch: false })
    mac.refuse['threads.setExpiry'] = 'computer_forbidden'
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester') }
    await say('go')
    await service.pass()
    expect(mac.methods().filter((method) => method === 'threads.setExpiry')).toHaveLength(1)
    expect(d.engine.remoteExpiry.get(out.started.childThreadId)).toMatchObject({ state: 'sent', lastError: expect.stringContaining('refused threads.setExpiry') })
  })

  it('a Stop that cannot reach that computer yet shows as Stop requested until it is delivered', async () => {
    const { d, parent, steps, out, say, mac, service, startOnMac } = remoteWorld()
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester') }
    steps['cancel'] = async (tools) => { out.cancelled = await tools.taskCancel({ subagent: 'Mac tester' }) as Json }
    await say('go')
    mac.online = false
    await say('cancel')
    await service.pass()
    await service.pass()
    expect(d.engine.remoteSubagents.get(out.started.delegationId)!.state).toBe('stopping')
    expect((d.orch as any).subagentView(parent.id)[0].computer).toMatchObject({ online: false, stopRequested: true, lastError: 'Studio Mac is offline.' })
    mac.online = true
    await service.pass()
    expect(mac.methods()).toContain('orchestrator.abort')
    expect(d.engine.remoteSubagents.get(out.started.delegationId)!.state).toBe('done')
    expect((d.orch as any).subagentView(parent.id)[0].computer).not.toHaveProperty('stopRequested')
  })

  it('continues on the same thread there once the last task finished, and never merges here', async () => {
    const { d, steps, out, say, mac, service, startOnMac } = remoteWorld()
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester') }
    steps['busy'] = async (tools) => { out.busy = await tools.continueSubagent({ subagent: 'Mac tester', prompt: 'And iOS?' }, { toolCallId: 'c0' }) as Json }
    steps['more'] = async (tools) => {
      out.more = await tools.continueSubagent({ subagent: 'Mac tester', prompt: 'And iOS?' }, { toolCallId: 'c1' }) as Json
      out.merge = await tools.reportResult({ subagent: 'Mac tester' }) as Json
    }
    await say('go')
    await say('busy')
    expect(out.busy).toMatchObject({ started: false, code: 'subagent_busy' })
    mac.farRun = { status: 'completed', userMessageId: 'far-user-1' }
    await service.pass()
    await say('more')
    expect(out.more).toMatchObject({ status: 'started', childThreadId: out.started.childThreadId })
    expect(out.more.delegationId).not.toBe(out.started.delegationId)
    const sends = mac.calls.filter((call) => call.method === 'orchestrator.send')
    expect(sends).toHaveLength(2)
    expect(sends[1].params).toMatchObject({ threadId: 'far-thread-1', content: 'And iOS?' })
    // A follow-up asks that computer to refuse while the thread is paused by a usage limit; the first task never does.
    expect(sends[0].params).not.toHaveProperty('refuseWhilePaused')
    expect(sends[1].params).toMatchObject({ refuseWhilePaused: true })
    expect(mac.methods().filter((method) => method === 'threads.create')).toHaveLength(1)
    expect(out.merge).toMatchObject({ merged: false, note: expect.stringContaining('names the branch its work is on there') })
    expect(d.engine.remoteSubagents.get(out.more.delegationId)).toMatchObject({ remoteThreadId: 'far-thread-1', remoteRunId: 'far-run-2', state: 'running' })
  })

  it('marks every call that changes a thread there as this agent\'s, where that computer knows the mark', async () => {
    const { d, parent, steps, out, say, mac, startOnMac } = remoteWorld()
    mac.marks = true
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester') }
    await say('go')
    expect(mac.methods()).toEqual(['threads.create', 'composer.options', 'threads.setPermissionMode', 'orchestrator.send'])
    const task = d.engine.remoteSubagents.get(out.started.delegationId)!
    expect(task.marked).toBe(true)
    const delegation = d.engine.delegations.get(out.started.delegationId)!
    // The sender is the parent thread and the run that started the task; its mode is the task's own.
    const mark = { thread: parent.id, run: delegation.parentRunId, title: d.store.getThread(parent.id)!.name, hops: 1, mode: task.permissionMode }
    for (const call of mac.calls)
      if (call.method === 'composer.options') expect(call.params).not.toHaveProperty('agent')
      else expect(call.params.agent, call.method).toEqual(mark)
  })

  it('keeps an older computer\'s subagent unmarked for good, even once that computer knows the mark', async () => {
    const { d, steps, out, say, mac, service, startOnMac } = remoteWorld()
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester') }
    steps['more'] = async (tools) => { out.more = await tools.continueSubagent({ subagent: 'Mac tester', prompt: 'And iOS?' }, { toolCallId: 'c1' }) as Json }
    await say('go')
    expect(d.engine.remoteSubagents.get(out.started.delegationId)!.marked).toBe(false)
    expect(mac.calls.every((call) => !('agent' in call.params))).toBe(true)
    // That computer is updated while the subagent lives: its next task, and the stop of this one, keep the form it began
    // with, since the other computer's replay ledger is keyed by method and a switch could send a task twice.
    mac.marks = true
    mac.farRun = { status: 'completed', userMessageId: 'far-user-1' }
    await service.pass()
    await say('more')
    expect(out.more).toMatchObject({ status: 'started' })
    expect(d.engine.remoteSubagents.get(out.more.delegationId)!.marked).toBe(false)
    expect(mac.calls.every((call) => !('agent' in call.params))).toBe(true)
    expect(mac.asked).toBe(1)
  })

  // Issue #1160: the mode there is the narrowest of the parent thread's mode, its run and the limit that computer set
  // for this one, with no fixed cap. A read-only task is still sent in Plan mode.
  const MODE_ROWS: Array<{ name: string; parent: PermissionMode; limit: PermissionMode; workspace?: 'shared'; readOnly?: boolean; mode: PermissionMode; chatMode: 'agent' | 'plan' }> = [
    { name: 'Full access when both sides allow it', parent: 'full', limit: 'full', mode: 'full', chatMode: 'agent' },
    { name: 'the default device limit narrows a Full access parent', parent: 'full', limit: 'accept_edits', mode: 'accept_edits', chatMode: 'agent' },
    { name: 'a lower device limit narrows it', parent: 'full', limit: 'ask', mode: 'ask', chatMode: 'agent' },
    { name: 'a stricter parent narrows a Full access limit', parent: 'accept_edits', limit: 'full', mode: 'accept_edits', chatMode: 'agent' },
    { name: 'a read-only task is still Plan', parent: 'full', limit: 'full', workspace: 'shared', readOnly: true, mode: 'full', chatMode: 'plan' },
    { name: 'a shared task not asked read-only is Agent', parent: 'full', limit: 'full', workspace: 'shared', mode: 'full', chatMode: 'agent' }
  ]
  it.each(MODE_ROWS)('the mode there: $name', async ({ parent: parentMode, limit, workspace, readOnly, mode, chatMode }) => {
    const { d, parent, steps, out, say, mac, startOnMac } = remoteWorld()
    d.orch.setThreadPermissionMode(parent.id, parentMode)
    mac.limit = limit
    steps['go'] = async (tools) => {
      out.started = await startOnMac(tools, 'Mac tester', workspace ? { workspace, role: 'research', ...(readOnly ? { readOnly } : {}) } : {})
    }
    await say('go')
    expect(out.started).toMatchObject({ title: 'Mac tester', computer: 'Studio Mac' })
    expect(mac.calls.find((call) => call.method === 'threads.setPermissionMode')!.params.mode).toBe(mode)
    expect(mac.calls.find((call) => call.method === 'orchestrator.send')!.params.mode).toBe(chatMode)
    // Only a read-only task reads that computer's project folder itself; one that may edit gets a worktree there.
    expect(mac.calls[0]!.params.worktreeEnabled).toBe(!readOnly)
  })

  it('a follow-up runs no looser than the run that sends it', async () => {
    const { d, parent, steps, out, say, mac, service, startOnMac } = remoteWorld()
    d.orch.setThreadPermissionMode(parent.id, 'full')
    mac.limit = 'full'
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester') }
    steps['more'] = async (tools) => { out.more = await tools.continueSubagent({ subagent: 'Mac tester', prompt: 'And iOS?' }, { toolCallId: 'c1' }) as Json }
    await say('go')
    mac.farRun = { status: 'completed', userMessageId: 'far-user-1' }
    await service.pass()
    d.orch.setThreadPermissionMode(parent.id, 'ask')
    await say('more')
    expect(out.more).toMatchObject({ status: 'started' })
    const modes = mac.calls.filter((call) => call.method === 'threads.setPermissionMode').map((call) => call.params.mode)
    expect(modes).toEqual(['full', 'ask'])
  })

  it('a person cannot start a turn on the stand-in here', async () => {
    const { d, steps, out, say, startOnMac } = remoteWorld()
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester') }
    await say('go')
    await expect(d.orch.send('hello', false, { threadId: out.started.childThreadId, clientRequestId: 'person-1' })).rejects.toMatchObject({ code: 'runs_on_other_computer' })
  })

  it('list_computers says which computers can take a subagent', async () => {
    const { steps, out, say, mac } = remoteWorld()
    mac.allowed.push({ node: 'node-win', name: 'Windows box', online: false })
    steps['go'] = async (tools) => { out.list = await tools.listComputers() as Json }
    await say('go')
    expect(out.list.computers).toEqual([
      { id: MAC, name: 'Studio Mac', online: true, allowed: true, repository: 'no_project' },
      { id: 'node-win', name: 'Windows box', online: false, allowed: false, repository: 'no_project' }
    ])
  })

  it('list_models reads what that computer offers; a model it does not offer is refused before anything exists there, and a level travels with the model', async () => {
    const { d, parent, steps, out, say, mac, startOnMac } = remoteWorld()
    mac.snapshots = [{
      instanceId: 'codex', driver: 'codex', displayName: 'Codex', builtIn: true, scope: { kind: 'device' },
      enabled: { device: true, effective: true, setBy: 'device' }, install: { state: 'installed', canInstall: false },
      runs: { state: 'yes' }, auth: { state: 'signed_in' }, compatibility: { state: 'tested' }, caps: { toolControl: 'exact' },
      checkedAt: '2026-11-13T00:00:00.000Z',
      models: { entries: [{ id: 'gpt-6', label: 'GPT-6', source: 'catalog', capabilities: { efforts: ['low', 'high'] }, hidden: false, favorite: false }] }
    }]
    steps['go'] = async (tools) => {
      out.list = await tools.listModels!({ computer: 'studio mac' }) as Json
      out.typo = await startOnMac(tools, 'Typo', { instanceId: 'codex', model: 'gpt-7' })
      out.unknown = await startOnMac(tools, 'Unknown', { instanceId: 'claude', model: 'opus' })
      out.good = await startOnMac(tools, 'Mac reviewer', { instanceId: 'codex', model: 'gpt-6', effort: 'high' })
      d.settings.agentAccess = { ...d.settings.agentAccess, computers: [] }
      out.notAllowed = await tools.listModels!({ computer: 'studio mac' }) as Json
    }
    await say('go')
    expect(out.list).toMatchObject({ computer: 'Studio Mac', entries: [{ instanceId: 'codex', name: 'Codex', ready: true, models: [{ id: 'gpt-6', name: 'GPT-6', efforts: ['low', 'high'] }] }] })
    expect(out.typo).toMatchObject({ started: false, code: 'model_not_offered', message: expect.stringContaining('Codex on Studio Mac does not offer the model "gpt-7"') })
    expect(out.unknown).toMatchObject({ started: false, code: 'unknown_instance', message: expect.stringContaining('Studio Mac offers no "claude"') })
    expect(out.good).toMatchObject({ title: 'Mac reviewer', computer: 'Studio Mac' })
    // Only the good one reached that computer, on the model and level asked for.
    expect(mac.methods().filter((method) => method === 'threads.create')).toHaveLength(1)
    expect(mac.calls.find((call) => call.method === 'threads.setModel')!.params.model).toEqual({ instanceId: 'codex', model: 'gpt-6:high' })
    expect(d.engine.delegations.listForParentThread(parent.id)).toHaveLength(1)
    // A computer the user did not allow is not even asked what it offers.
    expect(out.notAllowed).toMatchObject({ listed: false, code: 'computer_not_allowed' })
    expect(mac.methods().filter((method) => method === 'providers.snapshots')).toHaveLength(4)
  })

  it('without Bridge an agent is told how to connect its computers', async () => {
    const w = world()
    w.d.settings.agentAccess = { level: 'lineage', projectIds: [], answerApprovals: false, remoteSubagents: true, computers: [MAC] }
    w.steps['go'] = async (tools) => { w.out.started = await w.start(tools, 'Mac tester', { computer: MAC, workspace: 'isolated', role: 'implement' }) }
    await w.say('go')
    expect(w.out.started).toMatchObject({ started: false, code: 'remote_unavailable' })
  })
})

describe('a remote subagent\'s result', () => {
  it('names an applet its reply published by one line, not the source its stored reply keeps', () => {
    const reference = { appletId: 'applet_a', revisionId: 'rev_a', sourceHash: 'h', title: 'Costs', description: '' }
    const messages = [
      { id: 'u1', role: 'user', content: 'Chart it' },
      { id: 'a1', role: 'assistant', content: 'Here.\n\n```mousse-applet\n{"schemaVersion":1,"title":"Costs","description":"","html":"<h1>big</h1>","css":"","js":""}\n```', presentationParts: [{ type: 'text', text: 'Here.\n\n' }, { type: 'applet', reference }] }
    ]
    expect(finalAssistantText(messages, 'u1')).toBe('Here.\n\n[Applet: Costs (appletId applet_a, revision rev_a)]')
  })

  it('names an applet that failed to publish too, never passing its source on', () => {
    const fence = '```mousse-applet\n' + JSON.stringify({ schemaVersion: 1, title: 'Chart', description: '', html: '<h1>big</h1>', css: '', js: '' }) + '\n```\n'
    // A publication that failed keeps the fence as the reply's text, with no applet part to name it.
    const content = `Here.\n\n${fence}Done.`
    const messages = [{ id: 'a1', role: 'assistant', content, presentationParts: [{ type: 'text', text: 'Here.\n\n' }, { type: 'text', text: `${fence}\nApplet unavailable: publication failed.\n` }, { type: 'text', text: 'Done.' }] }]
    expect(finalAssistantText(messages, null)).toBe('Here.\n\n[Applet: Chart]\nDone.')
  })
})
