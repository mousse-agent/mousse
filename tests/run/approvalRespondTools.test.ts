/**
 * `approval_respond` through the registry's central check (docs/run-engine/SPEC.md §15.1): who may call it, what
 * the tool refuses before anything is settled, and how each outcome of the settlement is told to the agent.
 * The settlement itself is the host's (`tests/run/approvalRespondDaemon.test.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../src/shared/types'
import type { AgentApprovalResult, ApprovalRequestInfo, McpCallRequest } from '../../src/mms/run/mcp/appTools'
import { describeApprovalRefusal, type ApprovalRefusal } from '../../src/mms/run/approvalRights'
import { appToolRegistry, appTurn, denied as refusalIn, fakeAppToolHost, refusalOf } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const NOW = '2026-10-12T00:00:00.000Z'
const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({ id, name: `Thread ${id}`, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1', ...patch }) as Thread

/** A pending command approval of `target` with the options the card offers, "always" included. */
const approval = (patch: Partial<ApprovalRequestInfo> = {}): ApprovalRequestInfo => ({
  requestId: 'req-1',
  threadId: 'target',
  status: 'pending',
  approval: true,
  questions: [{
    id: 'permission',
    prompt: 'Allow Claude Code to run a command (Bash)?\nnpm test',
    options: [
      { id: 'allow', label: 'Allow once', decision: 'allow', scope: 'once' },
      { id: 'allow_always', label: 'Always for this thread', decision: 'allow', scope: 'always' },
      { id: 'reject', label: 'Reject', decision: 'reject' }
    ]
  }],
  ...patch
})
const ANSWER = { threadId: 'target', requestId: 'req-1', answers: { permission: 'allow' } }

describe('approval_respond (SPEC §15.1)', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  /** `caller` holds a live run; `target` and `elsewhere` are other threads. */
  const world = async (extraHost: Parameters<typeof fakeAppToolHost>[0] = {}) => {
    fx = delegationFixture()
    const callerRun = await fx.runningRun('caller')
    const state = { outcome: { ok: true, decision: 'allow', replayed: false } as AgentApprovalResult }
    const threads = new Map<string, Thread>([
      ['caller', thread('caller')],
      ['target', thread('target')],
      ['elsewhere', thread('elsewhere', { projectId: 'p2' })]
    ])
    const requests = new Map<string, ApprovalRequestInfo>([
      ['req-1', approval()],
      ['req-2', approval({ requestId: 'req-2' })],
      ['req-own', approval({ requestId: 'req-own', threadId: 'caller' })],
      ['req-elsewhere', approval({ requestId: 'req-elsewhere', threadId: 'elsewhere' })],
      ['req-question', approval({ requestId: 'req-question', approval: false })]
    ])
    const ledger = { start: vi.fn(() => 'inv'), commit: vi.fn(), failed: vi.fn() }
    const fake = fakeAppToolHost({
      threadMeta: (id) => threads.get(id),
      toolLedger: () => ledger,
      approvalRequest: vi.fn((requestId) => requests.get(requestId)),
      answerApproval: vi.fn(() => state.outcome),
      ...extraHost
    })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'caller', runId: callerRun.runId }))
    const as = (extra: Partial<Parameters<typeof request>[0]> = {}): McpCallRequest =>
      request({ threadId: 'caller', runId: callerRun.runId, ...extra })
    const call = (args: Record<string, unknown> = ANSWER, extra: Partial<Parameters<typeof request>[0]> = {}) =>
      registry.call('approval_respond', args, as(extra))
    const denied = refusalIn
    const result = async (promise: Promise<{ text: string }>) => JSON.parse((await promise).text)
    return { state, threads, requests, ledger, call, denied, result, callerRun, ...fake }
  }

  describe('who may call it', () => {
    it('a read-only subagent cannot call it', async () => {
      const { call, denied, host } = await world({ readOnlyThread: () => true })
      expect((await denied(call()))!.code).toBe('mousse_read_only')
      expect(host.answerApproval).not.toHaveBeenCalled()
    })
  })

  describe('what it refuses before anything is settled', () => {
    it('its own thread: an error result, and nothing asked', async () => {
      const { call, host } = await world()
      const result = await call({ threadId: 'caller', requestId: 'req-own', answers: { permission: 'allow' } })
      expect(result).toMatchObject({ isError: true, text: expect.stringContaining('answers the approvals of other threads') })
      expect(host.answerApproval).not.toHaveBeenCalled()
    })

    it('a request of another thread than the one named is a conflict, so an agent cannot reach a thread through another\'s id', async () => {
      const { call, denied, host } = await world()
      // The caller's own request named under another thread's id must not slip past the own-thread refusal either.
      for (const requestId of ['req-own', 'req-elsewhere']) {
        const error = await denied(call({ threadId: 'target', requestId, answers: { permission: 'allow' } }))
        expect(error).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'request_not_pending', requestId, threadId: 'target' } })
      }
      expect(host.answerApproval).not.toHaveBeenCalled()
    })

    it('a plain question for the user: only the user answers it', async () => {
      const { call, denied, host } = await world()
      const error = await denied(call({ threadId: 'target', requestId: 'req-question', answers: { permission: 'allow' } }))
      expect(error).toMatchObject({ code: 'mousse_scope_denied' })
      expect(error!.message).toMatch(/not an approval; only the user answers it/)
      expect(host.answerApproval).not.toHaveBeenCalled()
    })

    it('"always for this thread", by its option or by its well-known id, before the settlement is asked', async () => {
      const { call, denied, requests, host } = await world()
      const error = await denied(call({ ...ANSWER, answers: { permission: 'allow_always' } }))
      expect(error).toMatchObject({ code: 'mousse_scope_denied' })
      expect(error!.message).toMatch(/cannot approve "always for this thread"/)
      // A provider's own id for an option that means "always" is refused by what the option means.
      requests.set('req-1', approval({ questions: [{ id: 'permission', prompt: 'Allow?', options: [{ id: 'allow', label: 'Allow', decision: 'allow', scope: 'once' }, { id: 'forever', label: 'Forever', decision: 'allow', scope: 'always' }] }] }))
      expect((await denied(call({ ...ANSWER, answers: { permission: 'forever' } })))!.code).toBe('mousse_scope_denied')
      expect((await denied(call({ ...ANSWER, answers: { permission: ['allow', 'forever'] } })))!.code).toBe('mousse_scope_denied')
      expect(host.answerApproval).not.toHaveBeenCalled()
      // Approving once and rejecting are not refused.
      expect((await call({ ...ANSWER, answers: { permission: 'allow' } })).isError).toBeUndefined()
      expect((await call({ ...ANSWER, answers: { permission: 'reject' } })).isError).toBeUndefined()
    })

    it('a request nobody asked is a value, not an error', async () => {
      const { call, result, host } = await world()
      expect(await result(call({ ...ANSWER, requestId: 'nope' }))).toMatchObject({ ok: false, reason: 'unknown' })
      expect(host.answerApproval).not.toHaveBeenCalled()
    })

    it.each([
      [{ threadId: 'target', requestId: 'req-1' }, /answers must be an object/],
      [{ ...ANSWER, answers: 'allow' }, /answers must be an object/],
      [{ ...ANSWER, answers: [] }, /answers must be an object/],
      [{ ...ANSWER, answers: {} }, /between 1 and 20 questions/],
      [{ ...ANSWER, answers: { permission: 7 } }, /answers.permission must be an option id/],
      [{ ...ANSWER, answers: { permission: ['allow', 3] } }, /answers.permission must be an option id/],
      [{ ...ANSWER, answers: { permission: 'x'.repeat(501) } }, /at most 500 characters/],
      // `request_answer` reads the kind from the id: a call without one is refused before any kind is picked.
      [{ ...ANSWER, requestId: ' ' }, /needs the requestId of the request it answers/]
    ])('invalid input %#: a tool error and no settlement', async (args, message) => {
      const { call, host } = await world()
      const result = await call(args)
      expect(result.isError).toBe(true)
      expect(result.text).toMatch(message)
      expect(host.answerApproval).not.toHaveBeenCalled()
    })

    it('a host that cannot answer says so', async () => {
      const { call } = await world({ answerApproval: undefined })
      expect(refusalOf(await call())).toMatchObject({ message: 'approval_respond is not available in this host.' })
    })

    it('a bot\'s thread cannot be answered from another thread', async () => {
      const { call, denied, host } = await world({ botRole: (threadId) => (threadId === 'target' ? 'activation' : undefined) })
      expect((await denied(call()))!.message).toMatch(/belongs to a bot/)
      expect(host.answerApproval).not.toHaveBeenCalled()
    })
  })

  describe('what the host is asked, and what the agent is told', () => {
    it('asks as the caller: its thread, run and call, and a key scoped to its thread', async () => {
      const { call, host, callerRun } = await world()
      // Over HTTP the server turns the caller's clientRequestId into the call id (`mcp:<id>`) and keeps it out of the arguments.
      await call(ANSWER, { toolCallId: 'mcp:answer-1' })
      expect(host.answerApproval).toHaveBeenLastCalledWith('target', 'req-1', { permission: 'allow' }, {
        clientRequestId: 'approval_respond:caller:mcp:answer-1',
        actor: { kind: 'agent', threadId: 'caller', runId: callerRun.runId, toolCallId: 'mcp:answer-1' }
      })
    })

    it('the answer: ok with the decision, and replayed for a retry that found its own answer', async () => {
      const { call, result, state } = await world()
      expect(await result(call())).toEqual({ ok: true, threadId: 'target', requestId: 'req-1', decision: 'allow' })
      state.outcome = { ok: true, decision: 'allow', replayed: true }
      expect(await result(call())).toEqual({ ok: true, threadId: 'target', requestId: 'req-1', decision: 'allow', replayed: true })
    })

    it('a lost race is a value that says who won and what they decided, never a replay', async () => {
      const { call, result, state, ledger } = await world()
      state.outcome = { ok: false, reason: 'already_answered', decision: 'reject', answeredBy: { kind: 'user', via: 'gui' } }
      const byUser = await result(call())
      expect(byUser).toMatchObject({ ok: false, reason: 'already_answered', decision: 'reject', answeredBy: { kind: 'user', via: 'gui' } })
      expect(byUser.replayed).toBeUndefined()
      // Another agent's call id is no business of this agent.
      state.outcome = { ok: false, reason: 'already_answered', decision: 'allow', answeredBy: { kind: 'agent', threadId: 'other', runId: 'run-9', toolCallId: 'mcp:x' } }
      expect((await result(call())).answeredBy).toEqual({ kind: 'agent', threadId: 'other', runId: 'run-9' })
      // A lost race is no failure of the tool.
      expect(ledger.failed).not.toHaveBeenCalled()
    })

    it('a request closed before it was answered, and one that vanished, are values', async () => {
      const { call, result, state } = await world()
      state.outcome = { ok: false, reason: 'cancelled', cancelReason: 'turn_ended' }
      expect(await result(call())).toMatchObject({ ok: false, reason: 'cancelled', cancelReason: 'turn_ended' })
      state.outcome = { ok: false, reason: 'unknown' }
      expect(await result(call())).toMatchObject({ ok: false, reason: 'unknown' })
    })

    it.each<ApprovalRefusal>(['own_request', 'person_only', 'person_turn', 'not_parent', 'approvals_disabled', 'mode_forbids', 'agent_no_standing_grant', 'bridge_no_standing_grant', 'device_mode_forbids'])(
      'a refusal by the rule (%s) is an error result that says why and leaves the request for the user',
      async (code) => {
        const { call, state, ledger } = await world()
        state.outcome = { ok: false, reason: code }
        const outcome = await call()
        expect(outcome.isError).toBe(true)
        expect(refusalOf(outcome)).toMatchObject({
          message: describeApprovalRefusal(code),
          details: { ok: false, reason: code, threadId: 'target', requestId: 'req-1' },
          refused: { code: 'not_granted', retry: code === 'approvals_disabled' ? 'after_change' : 'never' }
        })
        expect(ledger.failed).toHaveBeenCalledTimes(1)
      }
    )

    it('the same key for another request is a conflict', async () => {
      const { call, denied, state } = await world()
      state.outcome = { ok: false, reason: 'client_request_id_conflict' }
      const error = await denied(call({ ...ANSWER, requestId: 'req-2' }))
      expect(error).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'client_request_id_conflict', requestId: 'req-2' } })
    })
  })
})
