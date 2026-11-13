/**
 * `automations.manager.turn`: how one of the Automation manager's turns stands, read by its run id. The composer's send
 * answers once its run is committed (`await: 'ack'`), and the page reads the outcome here when no turn event told it.
 * And the manager's request in a turn, read from its real transcript (`automationManagerRequest`).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerAutomationMethods } from '../src/mms/automations/registerMethods'
import { phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './run/phase6Fixture'
import { DomainHandlerRegistry, type HandlerContext } from '../src/mms/protocol/domainRegistry'
import { MmsProfileServices } from '../src/mms/MmsProfileServices'
import type { RunRecord, RunStatus } from '../src/mms/run/types'

const RUN = 'run:thread:manager:ordinal:2'
const context = (clientType: string) => ({ connection: { clientType, binding: { profileId: 'p', epoch: 1 }, capabilities: new Set<string>() } }) as unknown as HandlerContext

describe('automations.manager.turn', () => {
  it('answers a window with the turn, and refuses other clients and anything that is not a run id', async () => {
    const domains = new DomainHandlerRegistry()
    const managerTurn = vi.fn(() => ({ status: 'failed' as const, error: 'No model is set up.' }))
    registerAutomationMethods(domains, async () => ({ managerTurn }) as never)
    expect(await domains.dispatch(context('gui'), 'automations.manager.turn', { runId: RUN })).toEqual({ turn: { status: 'failed', error: 'No model is set up.' } })
    expect(managerTurn).toHaveBeenCalledWith(RUN)
    await expect(domains.dispatch(context('cli'), 'automations.manager.turn', { runId: RUN })).rejects.toThrow(/window/)
    await expect(domains.dispatch(context('gui'), 'automations.manager.turn', { runId: 'job-1' })).rejects.toThrow(/run id/)
    await expect(domains.dispatch(context('gui'), 'automations.manager.turn', { runId: RUN, extra: 1 })).rejects.toThrow()
  })

  it('reads the run of the manager\'s thread, and nothing of another thread\'s run', () => {
    const runs = new Map<string, Partial<RunRecord>>()
    const services = {
      runEngine: { getRun: (runId: string) => runs.get(runId) ?? null },
      threads: { getThread: (threadId: string) => (threadId === 'manager' ? { automationManager: true } : { automationManager: false }) }
    }
    const turn = (runId: string) => MmsProfileServices.prototype.automationManagerTurn.call(services as never, runId)
    const put = (status: RunStatus, error?: string, threadId = 'manager') => runs.set(RUN, { runId: RUN, threadId, status, outcome: error ? { error } : null })
    expect(turn(RUN)).toEqual({ status: 'unknown' })
    for (const [status, expected] of [
      ['queued', 'queued'], ['starting', 'working'], ['running', 'working'], ['finalizing', 'working'],
      ['completed', 'completed'], ['interrupted', 'stopped'], ['cancelled', 'stopped'], ['paused', 'paused']
    ] as const) {
      put(status)
      expect(turn(RUN)).toEqual({ status: expected })
    }
    put('failed', 'No model is set up.')
    expect(turn(RUN)).toEqual({ status: 'failed', error: 'No model is set up.' })
    put('uncertain')
    expect(turn(RUN)).toEqual({ status: 'failed' })
    // A chat's run reads as unknown: the page never learns about another thread from here.
    put('failed', 'secret', 'someone-else')
    expect(turn(RUN)).toEqual({ status: 'unknown' })
  })
})

describe("the Automation manager's request", () => {
  const homes: string[] = []
  const daemons: Phase6Daemon[] = []
  let previousHome: string | undefined
  afterEach(async () => {
    for (const daemon of daemons.splice(0).reverse()) await daemon.stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it("is the person's own message that started the turn, and none when an agent's or a bot's message started it", async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-manager-request-'))
    homes.push(home)
    previousHome ??= process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const d = phase6Daemon(home, [piAdapter(() => 'done')])
    daemons.push(d)
    const manager = d.store.createThread('Automation manager')
    const settled = (runId: string) => waitFor(() => ['completed', 'failed', 'cancelled', 'interrupted'].includes(d.engine.getRun(runId)?.status ?? ''), `run ${runId}`)
    // What the profile wires into the manager's tools, over the real transcript.
    const request = (runId: string) => MmsProfileServices.prototype.automationManagerRequest.call({ orchestrator: d.orch } as never, manager.id, runId)
    const person = await d.orch.send('Change Morning report to run at 8.', false, { threadId: manager.id, clientRequestId: 'person-1', awaitMode: 'ack' })
    await settled(person.runId!)
    expect(request(person.runId!)).toBe('Change Morning report to run at 8.')
    // A later turn an agent's message started has no request, though the person once named Morning report.
    const agent = await d.orch.send('Morning report: switch it off.', false, { threadId: manager.id, clientRequestId: 'agent-1', awaitMode: 'ack', agent: { kind: 'agent', threadId: 'other-thread', runId: 'other-run', toolCallId: 'x', hops: 1 } } as never)
    await settled(agent.runId!)
    expect(request(agent.runId!)).toBeUndefined()
    // So has a turn that is not the manager's, or one it can't find.
    expect(request('run:missing')).toBeUndefined()
  })
})
