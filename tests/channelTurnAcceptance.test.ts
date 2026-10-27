/**
 * runChannelTurn tells its caller once the user's message is stored, on an ordinary turn and on a
 * slash-workflow admission. A turn that never stores the message does not report acceptance, and a
 * throwing observer cannot abort a turn whose message is already stored.
 */
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { OrchestratorService } from '../src/mms/orchestrator/OrchestratorService'
import type { WorkflowChatRun } from '../src/shared/workflowChat'
import { createOrchestrator } from './run/phase6Fixture'

describe('channel turn input acceptance', () => {
  let home: string
  let store: ThreadDataStore
  let orch: OrchestratorService
  let chatCalls: number

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-accept-')))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    orch = createOrchestrator(home, store)
    chatCalls = 0
    ;(orch as any).llm = {
      getSelectedModelContextLimit: () => ({ limit: 128_000, modelName: 'probe' }),
      getContextInputs: async () => ({ systemPromptText: '', mcpToolsText: '', otherToolsText: '', signature: 'probe-sig' }),
      chat: async () => {
        chatCalls += 1
        return {
          text: 'reply', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, modelName: 'probe',
          totalResponseTimeMs: 1, totalTokensUsed: 2, tokensPerSecond: undefined,
          contextInputs: { signature: 'probe-sig' }, toolEvents: [], aborted: false, nativeMessages: []
        }
      }
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  function stubWorkflowChat(threadId: string) {
    const run: WorkflowChatRun = {
      invocationId: 'invocation-1', profileId: 'p', threadId, definitionId: 'd',
      revisionId: 'r', runId: 'run-1', title: 'Review', state: 'succeeded'
    }
    ;(orch as any).workflowChat = {
      prepare: async (_thread: string, input: { content: string }) => ({
        content: input.content, workflowInvocationId: 'invocation-1'
      }),
      execute: async () => run,
      observe: async () => ({ snapshot: { manifest: { state: 'succeeded' } }, aborted: false }),
      abandon: () => undefined
    }
    ;(orch as any).persistBackgroundWorkflowObservation = async () => undefined
  }

  it('reports acceptance once for an ordinary turn', async () => {
    const thread = store.createThread('Ordinary')
    const accepted = vi.fn(() => {
      // The message is already on the thread when the observer runs.
      expect(orch.getMessages(thread.id).map((m) => m.content)).toContain('hello')
    })
    const result = await orch.runChannelTurn(thread.id, 'hello', store, { onUserInputAccepted: accepted })
    expect(result.error).toBeUndefined()
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(chatCalls).toBe(1)
  }, 30_000)

  it('reports acceptance once when a slash workflow is admitted', async () => {
    const thread = store.createThread('Workflow')
    stubWorkflowChat(thread.id)
    const accepted = vi.fn()
    const result = await orch.runChannelTurn(thread.id, '/review', store, {
      hostIngress: { platform: 'telegram', chatId: '1', messageId: 'm1' } as never,
      onUserInputAccepted: accepted
    })
    expect(result.error).toBeUndefined()
    expect(result.transcriptWritten).toBe(true)
    expect(orch.getMessages(thread.id).filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['/review'])
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(chatCalls).toBe(0)
  }, 30_000)

  it('does not report acceptance when the thread does not exist or the turn is cancelled first', async () => {
    const accepted = vi.fn()
    expect(
      await orch.runChannelTurn('missing', 'hello', store, { onUserInputAccepted: accepted })
    ).toMatchObject({ error: expect.stringMatching(/not found/i) })

    const thread = store.createThread('Cancelled')
    const cancelled = new AbortController()
    cancelled.abort()
    const result = await orch.runChannelTurn(thread.id, 'hello', store, {
      signal: cancelled.signal,
      onUserInputAccepted: accepted
    })
    expect(result).toMatchObject({ aborted: true })
    expect(orch.getMessages(thread.id)).toEqual([])
    expect(accepted).not.toHaveBeenCalled()
  }, 30_000)

  it('keeps running an ordinary turn when the observer throws', async () => {
    const thread = store.createThread('Throwing')
    const accepted = vi.fn(() => { throw new Error('observer failed') })
    const result = await orch.runChannelTurn(thread.id, 'hello', store, { onUserInputAccepted: accepted })
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(result.error).toBeUndefined()
    expect(chatCalls).toBe(1)
    expect(orch.getMessages(thread.id).map((m) => m.role)).toEqual(['user', 'assistant'])
  }, 30_000)

  it('keeps a workflow admission going when the observer throws', async () => {
    const thread = store.createThread('Throwing workflow')
    stubWorkflowChat(thread.id)
    const accepted = vi.fn(() => { throw new Error('observer failed') })
    const result = await orch.runChannelTurn(thread.id, '/review', store, {
      hostIngress: { platform: 'telegram', chatId: '1', messageId: 'm1' } as never,
      onUserInputAccepted: accepted
    })
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(result.error).toBeUndefined()
    expect(result.transcriptWritten).toBe(true)
    expect(orch.getMessages(thread.id).some((m) => m.workflowRun?.runId === 'run-1')).toBe(true)
  }, 30_000)
})
