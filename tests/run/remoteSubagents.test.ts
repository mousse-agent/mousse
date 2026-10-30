/**
 * Issue #469: an agent starts and manages a subagent on another of the user's computers. A real
 * `OrchestratorService`, Run Engine and effect worker (`useSubagentWorld`); the other computer is a fake
 * Bridge port that answers the routed calls the way an owner does. The service's background passes are
 * stopped, so each test moves the tasks along with `pass()`.
 */
import { describe, expect, it } from 'vitest'
import { DomainRpcError } from '../../src/mms/protocol/domainRegistry'
import type { RemoteComputer, RemoteComputersPort } from '../../src/mms/protocol/remoteComputersPort'
import type { RemoteSubagents } from '../../src/mms/orchestrator/RemoteSubagents'
import { useSubagentWorld, type Json } from './subagentWorld'
import { waitFor } from './phase6Fixture'

const MAC = 'node-mac'

/** One computer that runs threads, scripted per test. */
class FakeComputer implements RemoteComputersPort {
  readonly calls: Array<{ method: string; params: Record<string, unknown>; idem?: string }> = []
  online = true
  allowed: RemoteComputer[] = [{ node: MAC, name: 'Studio Mac', online: true }]
  farRun: Json = { status: 'running', userMessageId: 'far-user-1' }
  pending: unknown[] = []
  finalText = 'All 40 tests pass on macOS.'
  match: { projectId: string; weak: boolean } | null = { projectId: 'far-project', weak: false }
  /** Refuses the method with this code. */
  refuse: Record<string, string> = {}
  /** The most this computer lets the caller's device set. */
  limit = 'accept_edits'
  private threads = 0
  private runs = 0

  computers(): RemoteComputer[] {
    return this.allowed.map((computer) => ({ ...computer, online: this.online && computer.online }))
  }

  async matchProject(): Promise<{ projectId: string; weak: boolean } | null> {
    if (!this.online) throw new DomainRpcError('computer_offline', 'Studio Mac is offline.')
    return this.match
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
      case 'threads.delete':
        return {}
      case 'orchestrator.send':
        return { runId: `far-run-${++this.runs}`, accepted: true }
      case 'runs.get':
        return { run: { runId: params.runId, ...this.farRun } }
      case 'orchestrator.pendingQuestions':
        return { pending: this.pending }
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
  const remoteWorld = (options: { allow?: boolean } = {}) => {
    const w = world()
    const mac = new FakeComputer()
    w.d.settings.agentAccess = { level: 'lineage', projectIds: [], answerApprovals: false, computers: options.allow === false ? [] : [MAC] }
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
    // Created in the same repository there, in its own worktree, no looser than Auto-accept edits.
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

  it('refuses before anything exists: a computer the user did not allow, an unknown one, one that is offline', async () => {
    const { d, parent, steps, out, say, mac, startOnMac } = remoteWorld({ allow: false })
    steps['go'] = async (tools) => {
      out.notAllowed = await startOnMac(tools, 'A')
      d.settings.agentAccess = { ...d.settings.agentAccess, computers: [MAC] }
      out.unknown = await startOnMac(tools, 'B', { computer: 'Windows box' })
      mac.online = false
      out.offline = await startOnMac(tools, 'C')
      mac.online = true
      out.half = await startOnMac(tools, 'E', { model: 'opus' })
    }
    await say('go')
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

  it('continues on the same thread there once the last task finished, and never merges here', async () => {
    const { d, steps, out, say, mac, service, startOnMac } = remoteWorld()
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester') }
    steps['busy'] = async (tools) => { out.busy = await tools.continueSubagent({ subagent: 'Mac tester', prompt: 'And iOS?' }, { toolCallId: 'c0' }) as Json }
    steps['more'] = async (tools) => {
      out.more = await tools.continueSubagent({ subagent: 'Mac tester', prompt: 'And iOS?' }, { toolCallId: 'c1' }) as Json
      out.merge = await tools.integrateDelegation({ subagent: 'Mac tester' }, { toolCallId: 'i1' }) as Json
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
    expect(mac.methods().filter((method) => method === 'threads.create')).toHaveLength(1)
    expect(out.merge).toMatchObject({ code: 'remote_integration_unsupported' })
    expect(d.engine.remoteSubagents.get(out.more.delegationId)).toMatchObject({ remoteThreadId: 'far-thread-1', remoteRunId: 'far-run-2', state: 'running' })
  })

  it('narrows the mode to the limit that computer set for this one, which it would refuse to exceed', async () => {
    const { steps, out, say, mac, startOnMac } = remoteWorld()
    mac.limit = 'ask'
    steps['go'] = async (tools) => { out.started = await startOnMac(tools, 'Mac tester') }
    await say('go')
    expect(mac.calls.find((call) => call.method === 'threads.setPermissionMode')!.params.mode).toBe('ask')
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

  it('without Bridge an agent is told how to connect its computers', async () => {
    const w = world()
    w.d.settings.agentAccess = { level: 'lineage', projectIds: [], answerApprovals: false, computers: [MAC] }
    w.steps['go'] = async (tools) => { w.out.started = await w.start(tools, 'Mac tester', { computer: MAC, workspace: 'isolated', role: 'implement' }) }
    await w.say('go')
    expect(w.out.started).toMatchObject({ started: false, code: 'remote_unavailable' })
  })
})
