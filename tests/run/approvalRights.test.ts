import { describe, expect, it } from 'vitest'
import type { PermissionAction, PermissionMode } from '../../src/shared/permissionMode'
import { canAnswerApproval, type Answerer, type LineageLookup } from '../../src/mms/run/approvalRights'
import { UserQuestionService, type ApprovalTag } from '../../src/mms/orchestrator/UserQuestionService'

const lineage: LineageLookup = (threadId) => {
  if (threadId === 'child') return { parentThreadId: 'parent', relationship: 'subagent' }
  if (threadId === 'grandchild') return { parentThreadId: 'child', relationship: 'subagent' }
  if (threadId === 'fork') return { parentThreadId: 'parent', relationship: 'fork' }
  return null
}

const agent = (threadId: string, permissionMode: PermissionMode): Answerer => ({ kind: 'agent', threadId, runId: `run-${threadId}`, permissionMode })
const request = (threadId: string, action: PermissionAction) => ({ threadId, action, permissionKey: `test:${action}` })
const once = { decision: 'allow' as const, scope: 'once' as const }

describe('canAnswerApproval', () => {
  it('lets the user answer anything, through any client', () => {
    for (const via of ['gui', 'cli', 'bridge'] as const)
      expect(canAnswerApproval(request('child', 'command'), { kind: 'user', via }, { decision: 'allow', scope: 'always' }, lineage)).toEqual({ ok: true })
  })

  it.each([
    ['full', 'command', true], ['full', 'edit', true], ['full', 'tool', true],
    ['accept_edits', 'edit', true], ['accept_edits', 'command', false], ['accept_edits', 'tool', false],
    ['ask', 'edit', false], ['ask', 'command', false], ['ask', 'tool', false]
  ] as const)('a parent in %s mode answering its child\'s %s: %s', (mode, action, allowed) => {
    expect(canAnswerApproval(request('child', action), agent('parent', mode), once, lineage)).toEqual(allowed ? { ok: true } : { ok: false, code: 'mode_forbids' })
  })

  it('refuses an agent that answers its own request, a grandparent, a sibling and a fork', () => {
    expect(canAnswerApproval(request('parent', 'edit'), agent('parent', 'full'), once, lineage)).toEqual({ ok: false, code: 'own_request' })
    expect(canAnswerApproval(request('grandchild', 'edit'), agent('parent', 'full'), once, lineage)).toEqual({ ok: false, code: 'not_parent' })
    expect(canAnswerApproval(request('child', 'edit'), agent('sibling', 'full'), once, lineage)).toEqual({ ok: false, code: 'not_parent' })
    expect(canAnswerApproval(request('fork', 'edit'), agent('parent', 'full'), once, lineage)).toEqual({ ok: false, code: 'not_parent' })
    expect(canAnswerApproval(request('unknown', 'edit'), agent('parent', 'full'), once, lineage)).toEqual({ ok: false, code: 'not_parent' })
  })

  it('never lets an agent create a standing rule, and lets it reject within its mode', () => {
    expect(canAnswerApproval(request('child', 'edit'), agent('parent', 'full'), { decision: 'allow', scope: 'always' }, lineage)).toEqual({ ok: false, code: 'agent_no_standing_grant' })
    expect(canAnswerApproval(request('child', 'edit'), agent('parent', 'full'), { decision: 'reject' }, lineage)).toEqual({ ok: true })
    expect(canAnswerApproval(request('child', 'command'), agent('parent', 'accept_edits'), { decision: 'reject' }, lineage)).toEqual({ ok: false, code: 'mode_forbids' })
  })
})

describe('the settlement boundary', () => {
  const tag = (action: PermissionAction): ApprovalTag => ({
    action,
    permissionKey: `test:${action}`,
    options: [{ id: 'allow', ...once }, { id: 'allow_always', decision: 'allow', scope: 'always' }, { id: 'reject', decision: 'reject' }]
  })
  const ask = (service: UserQuestionService, threadId: string, action: PermissionAction) => {
    const waiter = service.requestAnswers(
      [{ id: 'permission', prompt: 'Allow?', options: [{ id: 'allow', label: 'Allow' }, { id: 'allow_always', label: 'Always' }, { id: 'reject', label: 'Reject' }] }],
      threadId,
      { approval: tag(action) }
    )
    waiter.catch(() => undefined)
    return { waiter, requestId: service.listPendingForThread(threadId)[0]!.requestId }
  }
  const service = () => {
    const questions = new UserQuestionService()
    questions.setLineageSource(lineage)
    return questions
  }

  it('settles an approval only when the rule allows, and keeps it pending otherwise', async () => {
    const questions = service()
    const { waiter, requestId } = ask(questions, 'child', 'command')
    expect(questions.settle(requestId, { permission: 'allow' }, agent('parent', 'accept_edits'))).toEqual({ ok: false, reason: 'mode_forbids' })
    expect(questions.getPending(requestId)).not.toBeNull()
    expect(questions.settle(requestId, { permission: 'allow' }, agent('parent', 'full'))).toEqual({ ok: true, decision: 'allow' })
    await expect(waiter).resolves.toEqual({ permission: 'allow' })
  })

  it('maps the chosen option to its declared decision, never by its id', () => {
    const questions = service()
    const { requestId } = ask(questions, 'child', 'edit')
    expect(questions.settle(requestId, { permission: 'reject' }, { kind: 'user' })).toEqual({ ok: true, decision: 'reject' })
    const second = ask(questions, 'child', 'edit')
    expect(questions.settle(second.requestId, { permission: 'unlisted' }, { kind: 'user' })).toEqual({ ok: true, decision: 'reject' })
  })

  it('refuses an agent\'s "always" and an unnamed answerer', () => {
    const questions = service()
    const { requestId } = ask(questions, 'child', 'edit')
    expect(questions.settle(requestId, { permission: 'allow_always' }, agent('parent', 'full'))).toEqual({ ok: false, reason: 'agent_no_standing_grant' })
    expect(questions.settle(requestId, { permission: 'allow' })).toEqual({ ok: false, reason: 'answerer_required' })
    expect(questions.getPending(requestId)).not.toBeNull()
  })

  it('treats a dismissal by an agent as a rejection that needs the same rights', () => {
    const questions = service()
    const { waiter, requestId } = ask(questions, 'child', 'command')
    expect(questions.dismiss(requestId, agent('parent', 'ask'))).toBe(false)
    expect(questions.getPending(requestId)).not.toBeNull()
    expect(questions.dismiss(requestId, agent('parent', 'full'))).toBe(true)
    return expect(waiter).rejects.toThrow()
  })

  it('leaves a send\'s denial to those who may answer: an agent that may not, cannot deny either', async () => {
    const questions = service()
    const refused = ask(questions, 'child', 'command')
    expect(questions.autoRejectPendingForThread('child', agent('parent', 'accept_edits'))).toEqual({ answered: 0, dismissed: 0, refused: 1 })
    expect(questions.getPending(refused.requestId)).not.toBeNull()
    expect(questions.autoRejectPendingForThread('child', agent('stranger', 'full'))).toMatchObject({ answered: 0, refused: 1 })
    expect(questions.autoRejectPendingForThread('child')).toEqual({ answered: 1, dismissed: 0, refused: 0 })
    await expect(refused.waiter).resolves.toEqual({ permission: 'reject' })
  })

  it('answers a plain question for whoever answers, as before', async () => {
    const questions = service()
    const waiter = questions.requestAnswers([{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }], 'child')
    const requestId = questions.listPendingForThread('child')[0]!.requestId
    expect(questions.settle(requestId, { q: 'a' }, agent('parent', 'ask'))).toEqual({ ok: true })
    await expect(waiter).resolves.toEqual({ q: 'a' })
  })
})
