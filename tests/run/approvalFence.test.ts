/**
 * The fence (docs/plans/tool-api.md §2.5, rule 5 of #1454): an approval asked before a person's correction reached its
 * thread never releases the action. It is checked when the answer settles and again right before the answer reaches the
 * provider, whoever answers. Real run engine and question service; the provider is the `requestAnswers` promise.
 *
 * Inputs: when the correction lands (before the answer, between answer and dispatch, before the request was asked), who
 * answers (the person, the parent agent), the answer (allow, reject), the path (live, a grant carried across a restart),
 * and whether the correction reached the thread (a subagent of the corrected thread, a thread of another tree, the
 * corrected thread itself).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { UserQuestionService, type ApprovalTag } from '../../src/mms/orchestrator/UserQuestionService'
import { FENCED_FEEDBACK } from '../../src/mms/run/delegation/approvalFence'
import { reviseTree } from '../../src/mms/run/delegation/treeCorrection'
import type { Answerer } from '../../src/mms/run/approvalRights'
import type { PendingUserQuestions, UserQuestionAnswers } from '../../src/shared/types'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const QUESTIONS: PendingUserQuestions['questions'] = [
  { id: 'permission', prompt: 'Run a command?\nnpm publish', options: [{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }] }
]
const TAG: ApprovalTag = { action: 'command', permissionKey: 'pi:command', options: [{ id: 'allow', decision: 'allow', scope: 'once' }, { id: 'reject', decision: 'reject' }] }
const ALLOW = { permission: 'allow' }
const USER: Answerer = { kind: 'user', via: 'gui' }

describe('an approval from before a correction cannot release its action', () => {
  let f: DelegationFixture
  afterEach(() => f?.dispose())

  /** `parent` with its running subagent `child`, and `stranger`: a running subagent of another tree. */
  const setup = async () => {
    f = delegationFixture()
    const parentRun = await f.runningRun('parent')
    const otherRun = await f.runningRun('other')
    const running = async (runId: string, key: string) => {
      const delegated = await f.delegate(runId, key, { title: key })
      f.engine.markStarting(delegated.childRunId)
      f.engine.markRunning(delegated.childRunId)
      return delegated.childThreadId
    }
    const child = await running(parentRun.runId, 'child')
    const stranger = await running(otherRun.runId, 'stranger')
    const questions = new UserQuestionService()
    questions.setLineageSource((threadId) => f.engine.delegations.getLineage(threadId))
    questions.setApprovalStore({
      store: f.engine.approvals,
      context: (threadId) => {
        const run = f.engine.getActiveRun(threadId)
        return run ? { runId: run.runId, instanceId: 'pi', provider: 'pi', origin: 'delegated', permissionMode: 'ask', approvals: 'ask', startedByPerson: false } : null
      },
      // Settling only writes `request.respond`; `deliver` is the dispatch, run when each test says.
      effectDelivery: () => true,
      continuationDue: () => undefined
    })
    /** Asks as the provider does: the promise is what the provider is answered with. */
    const ask = (threadId: string): { answered: Promise<UserQuestionAnswers>; requestId: string } => {
      const answered = questions.requestAnswers(QUESTIONS, threadId, { approval: TAG })
      return { answered, requestId: f.engine.approvals.listPending(threadId).at(-1)!.requestId }
    }
    const correct = (text: string) => reviseTree(f.engine, {
      threadId: 'parent', text, clientRequestId: `correct:${text}`,
      titleOf: () => 'Lead', strategyOf: () => 'interrupt_restart',
      waitsOnPerson: (id) => f.engine.approvals.listPending(id).length > 0
    })
    return { parentRun, child, stranger, questions, ask, correct }
  }

  it('a correction that lands after the answer, before dispatch: the provider is told no, and why', async () => {
    const { child, questions, ask, correct } = await setup()
    const { answered, requestId } = ask(child)
    expect(questions.settle(requestId, ALLOW, USER)).toEqual({ ok: true, decision: 'allow' })
    f.advance(1_000)
    await correct('Do not publish; only build.')

    expect(questions.deliver(requestId)).toBe(true)
    expect(await answered).toEqual({ permission: 'reject', feedback: FENCED_FEEDBACK })
    expect(f.engine.approvals.get(requestId)).toMatchObject({ decision: 'reject', feedback: FENCED_FEEDBACK })
  })

  it('a grant carried across a restart is fenced at dispatch: the action asks again', async () => {
    const { child, correct } = await setup()
    const runId = f.engine.getActiveRun(child)!.runId
    f.engine.approvals.create({ requestId: 'kept', threadId: child, runId, instanceId: 'pi', provider: 'pi', action: 'command', permissionKey: 'pi:command', fingerprint: 'fp', answerPath: 'continue', questions: [{ id: 'permission', prompt: 'Run it?', options: [{ id: 'allow', label: 'Allow once', decision: 'allow', scope: 'once' }] }] })
    expect(f.engine.approvals.settle('kept', ALLOW, USER)).toMatchObject({ ok: true, decision: 'allow' })
    f.engine.approvals.bindDelivery(['kept'], runId)
    f.advance(1_000)
    await correct('Do not publish; only build.')
    expect(f.engine.approvals.consumeContinuationGrant(child, runId, 'fp')).toBe(false)
  })

  it.each([
    ['the person', (): Answerer => USER],
    ['the parent agent', (): Answerer => ({ kind: 'agent', threadId: 'parent', runId: f.engine.getActiveRun('parent')!.runId, permissionMode: 'full' })]
  ])('an allow from %s after the correction settles as fenced, and the card said "correction arrived"', async (_who, answerer) => {
    const { child, questions, ask, correct } = await setup()
    const { answered, requestId } = ask(child)
    f.advance(1_000)
    const { revision } = await correct('Do not publish; only build.')

    const shown: Array<{ requestId: string; approval?: { correctionArrived?: true } }> = []
    questions.on('updated', (view) => shown.push(view))
    questions.correctionArrived(revision.deliveries.map((entry) => entry.threadId))
    expect(shown).toEqual([expect.objectContaining({ requestId, approval: expect.objectContaining({ correctionArrived: true }) })])
    expect(questions.listPendingForThread(child)[0]?.approval?.correctionArrived).toBe(true)

    expect(questions.settle(requestId, ALLOW, answerer())).toEqual({ ok: true, decision: 'reject', fenced: true })
    questions.deliver(requestId)
    expect(await answered).toEqual({ permission: 'reject', feedback: FENCED_FEEDBACK })
  })

  it('a rejection of a fenced request is an ordinary rejection', async () => {
    const { child, questions, ask, correct } = await setup()
    const { answered, requestId } = ask(child)
    await correct('Do not publish; only build.')
    expect(questions.settle(requestId, { permission: 'reject' }, USER)).toEqual({ ok: true, decision: 'reject' })
    questions.deliver(requestId)
    expect(await answered).toEqual({ permission: 'reject' })
  })

  it('leaves alone a thread the correction did not reach, the corrected thread itself, and a request asked after it', async () => {
    const { child, stranger, questions, ask, correct } = await setup()
    const elsewhere = ask(stranger)
    const own = ask('parent')
    f.advance(1_000)
    await correct('Do not publish; only build.')
    f.advance(1_000)
    // The child asks again once it has the correction: that request is not fenced.
    const again = ask(child)

    for (const request of [elsewhere, own, again]) {
      expect(questions.getPending(request.requestId)?.approval?.correctionArrived).toBeUndefined()
      expect(questions.settle(request.requestId, ALLOW, USER)).toEqual({ ok: true, decision: 'allow' })
      questions.deliver(request.requestId)
      expect(await request.answered).toEqual(ALLOW)
    }
  })
})
