/**
 * A scheduled run of a saved agent asks a person before a tool its grants hold back (plan §2.11, #1449):
 * the card waits as long as the person needs, and stopping the run withdraws it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeHostBindings } from '../src/shared/agents/execution'
import { canonicalJson, sha256Hex } from '../src/shared/agents/hashes'
import { createScheduledAgentRunner } from '../src/mms/automations/scheduledAgent'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'

vi.mock('../src/mms/agentDefinitions/runtimePolicy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/mms/agentDefinitions/runtimePolicy')>()),
  assertRuntimeSettingsSupported: () => undefined
}))

const ARGS = { command: 'make deploy' }

/** A runner whose saved agent asks once for a shell command and reports the decision as its text. */
function runner(questions: UserQuestionService) {
  const settings = { identity: { name: 'Builder' }, memory: { scope: 'thread' } }
  return createScheduledAgentRunner({
    services: {
      profileId: 'p',
      questions,
      orchestrator: {
        runAgentDefinition: async ({ host, threadId }: { host: AgentRuntimeHostBindings; threadId: string }) => {
          const decision = await host.approveToolRequest!({
            runId: 'run-1', profileId: 'p', threadId, definitionId: 'd', definitionRevision: 'r1', toolName: 'shell', canonicalToolName: 'shell',
            classification: 'execute', arguments: ARGS, argumentDigest: sha256Hex(canonicalJson(ARGS)), workspacePaths: ['/work']
          } as Parameters<NonNullable<AgentRuntimeHostBindings['approveToolRequest']>>[0])
          return { status: 'completed', text: decision.status }
        }
      }
    } as never,
    registry: { get: () => ({ flags: { enabled: true, archived: false }, published: { revision: 'r1' }, settings, runtimeKind: 'native' }) } as never,
    resolverFor: async () => ({ resolve: () => ({ revision: 'r1', settings }) }) as never
  })
}

describe('a scheduled agent\'s approval', () => {
  afterEach(() => { vi.useRealTimers() })

  it('waits for the person past any old limit, and the answer reaches the agent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const questions = new UserQuestionService()
    const result = runner(questions)({ definitionId: 'd', threadId: 't', workspaceRoot: '/work', prompt: 'deploy', runId: 'run-1', signal: new AbortController().signal })
    await vi.waitFor(() => expect(questions.listPendingForThread('t')).toHaveLength(1))

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    const [card] = questions.listPendingForThread('t')
    expect(card).toBeDefined()
    expect(questions.settle(card!.requestId, { approval: 'approve' }, { kind: 'user', via: 'gui' })).toMatchObject({ ok: true })
    expect(await result).toMatchObject({ status: 'completed', text: 'approved' })
  })

  it('is withdrawn when the run is stopped, and the tool does not run', async () => {
    const questions = new UserQuestionService()
    const stop = new AbortController()
    const result = runner(questions)({ definitionId: 'd', threadId: 't', workspaceRoot: '/work', prompt: 'deploy', runId: 'run-1', signal: stop.signal })
    await vi.waitFor(() => expect(questions.listPendingForThread('t')).toHaveLength(1))

    stop.abort()
    expect(questions.listPendingForThread('t')).toEqual([])
    expect(await result).toMatchObject({ status: 'completed', text: 'cancelled' })
  })
})
