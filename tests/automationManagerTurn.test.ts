/**
 * `automations.manager.turn`: how one of the Automation manager's turns stands, read by its run id. The composer's send
 * answers once its run is committed (`await: 'ack'`), and the page reads the outcome here when no turn event told it.
 */
import { describe, expect, it, vi } from 'vitest'
import { registerAutomationMethods } from '../src/mms/automations/registerMethods'
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
      ['queued', 'working'], ['starting', 'working'], ['running', 'working'], ['finalizing', 'working'],
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
