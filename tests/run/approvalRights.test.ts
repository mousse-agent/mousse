import { describe, expect, it } from 'vitest'
import type { PermissionAction, PermissionMode } from '../../src/shared/permissionMode'
import { canAnswerApproval, describeApprovalRefusal, startedByPerson, type AgentApprovalAccess, type Answerer, type LineageLookup } from '../../src/mms/run/approvalRights'
import { UserQuestionService, type ApprovalTag } from '../../src/mms/orchestrator/UserQuestionService'

const lineage: LineageLookup = (threadId) => {
  if (threadId === 'child') return { parentThreadId: 'parent', relationship: 'subagent' }
  if (threadId === 'grandchild') return { parentThreadId: 'child', relationship: 'subagent' }
  if (threadId === 'fork') return { parentThreadId: 'parent', relationship: 'fork' }
  if (threadId === 'child2') return { parentThreadId: 'parent', relationship: 'subagent' }
  if (threadId === 'grandchild2') return { parentThreadId: 'child2', relationship: 'subagent' }
  return null
}

const agent = (threadId: string, permissionMode: PermissionMode): Answerer => ({ kind: 'agent', threadId, runId: `run-${threadId}`, permissionMode })
const request = (threadId: string, action: PermissionAction, reason?: string) => ({ threadId, action, permissionKey: `test:${action}`, ...(reason ? { reason } : {}) })
const once = { decision: 'allow' as const, scope: 'once' as const }

describe('canAnswerApproval', () => {
  it('lets the user answer anything, through the app or the CLI, and a linked device anything but "always"', () => {
    for (const via of ['gui', 'cli'] as const)
      expect(canAnswerApproval(request('child', 'command'), { kind: 'user', via }, { decision: 'allow', scope: 'always' }, lineage)).toEqual({ ok: true })
    for (const answer of [{ decision: 'allow', scope: 'once' }, { decision: 'reject' }] as const)
      expect(canAnswerApproval(request('child', 'command'), { kind: 'user', via: 'bridge' }, answer, lineage)).toEqual({ ok: true })
    // A linked device cannot list or revoke rules, so it does not make them.
    expect(canAnswerApproval(request('child', 'command'), { kind: 'user', via: 'bridge' }, { decision: 'allow', scope: 'always' }, lineage)).toEqual({ ok: false, code: 'bridge_no_standing_grant' })
  })

  it('lets the user at another of their computers make a rule only for what that computer lets the device run without asking', () => {
    const always = { decision: 'allow' as const, scope: 'always' as const }
    const device = (maxPermissionMode: PermissionMode): Answerer => ({ kind: 'user', via: 'bridge', node: 'nod_laptop', maxPermissionMode })
    // A device limited to Auto-accept edits: a rule for a file edit, not for a command or a tool.
    expect(canAnswerApproval(request('child', 'edit'), device('accept_edits'), always, lineage)).toEqual({ ok: true })
    for (const action of ['command', 'tool'] as const)
      expect(canAnswerApproval(request('child', action), device('accept_edits'), always, lineage)).toEqual({ ok: false, code: 'device_mode_forbids' })
    // A device the owner raised to Full access makes any rule; one limited to Ask makes none.
    for (const action of ['edit', 'command', 'tool'] as const) {
      expect(canAnswerApproval(request('child', action), device('full'), always, lineage)).toEqual({ ok: true })
      expect(canAnswerApproval(request('child', action), device('ask'), always, lineage)).toEqual({ ok: false, code: 'device_mode_forbids' })
    }
    // A device with no recorded limit asks about everything, and a request the provider keeps for a person has no rule at all.
    expect(canAnswerApproval(request('child', 'edit'), { kind: 'user', via: 'bridge', node: 'nod_laptop' }, always, lineage)).toEqual({ ok: false, code: 'device_mode_forbids' })
    expect(canAnswerApproval(request('child', 'edit', 'safety check'), device('full'), always, lineage)).toEqual({ ok: false, code: 'device_mode_forbids' })
    // Allowing or rejecting once is the person's decision on what they see, at any limit.
    for (const answer of [once, { decision: 'reject' as const }])
      expect(canAnswerApproval(request('child', 'command'), device('ask'), answer, lineage)).toEqual({ ok: true })
    // A linked phone (no computer) still makes no rule.
    expect(canAnswerApproval(request('child', 'edit'), { kind: 'user', via: 'bridge' }, always, lineage)).toEqual({ ok: false, code: 'bridge_no_standing_grant' })
    expect(describeApprovalRefusal('device_mode_forbids')).toMatch(/limit/)
  })

  it('counts only a person at the app or the CLI, in a turn of their own, as starting a turn', () => {
    const origins = ['interactive', 'delegated', 'workflow', 'definition', 'bot', 'schedule']
    // `resume_now` is a person's Resume now press; `resume` is the timer's continue turn, which nobody asked for.
    const sources = ['gui', 'cli', 'resume_now', 'resume', 'schedule', 'webhook', 'channel', 'wake', 'delegation', 'internal', 'agent', 'mcp', 'protocol', 'bridge', 'steer-followup', '', undefined, null]
    for (const origin of origins)
      for (const source of sources)
        expect(startedByPerson({ origin, source }), `${origin} / ${source}`).toBe(origin === 'interactive' && (source === 'gui' || source === 'cli' || source === 'resume_now'))
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

/**
 * `approval_respond` (#184): an agent answers a thread outside its lineage only when the profile allows it.
 * The access is what the host read at the moment of the answer.
 */
describe('canAnswerApproval for an agent with access beyond its subagents', () => {
  const access = (patch: Partial<AgentApprovalAccess> = {}): AgentApprovalAccess => ({ level: 'manage', answerApprovals: true, projectAllowed: () => true, ...patch })
  const manager = (threadId: string, mode: PermissionMode, patch: Partial<AgentApprovalAccess> = {}): Answerer => ({ ...agent(threadId, mode), access: access(patch) })
  const answers = (who: Answerer, threadId: string, action: PermissionAction = 'command', answer: Parameters<typeof canAnswerApproval>[2] = once) =>
    canAnswerApproval(request(threadId, action), who, answer, lineage)

  it('answers a thread outside its lineage when it manages, the switch is on and the project is allowed', () => {
    expect(answers(manager('stranger', 'full'), 'unrelated')).toEqual({ ok: true })
    // It can reject as well as approve.
    expect(answers(manager('stranger', 'full'), 'unrelated', 'edit', { decision: 'reject' })).toEqual({ ok: true })
    // A thread that is not a subagent and shares no ancestor with it is outside its lineage.
    expect(answers(manager('parent', 'full'), 'unrelated')).toEqual({ ok: true })
  })

  it('never answers for a subagent of another agent: a subagent is answered by its parent alone', () => {
    expect(answers(manager('stranger', 'full'), 'child')).toEqual({ ok: false, code: 'not_parent' })
    expect(answers(manager('stranger', 'full'), 'grandchild')).toEqual({ ok: false, code: 'not_parent' })
  })

  it('never answers between siblings or cousins, who share an ancestor', () => {
    // Two subagents of one parent, a subagent and a fork of that parent, and cousins two levels down.
    expect(answers(manager('child', 'full'), 'child2')).toEqual({ ok: false, code: 'not_parent' })
    expect(answers(manager('child', 'full'), 'fork')).toEqual({ ok: false, code: 'not_parent' })
    expect(answers(manager('fork', 'full'), 'child')).toEqual({ ok: false, code: 'not_parent' })
    expect(answers(manager('grandchild', 'full'), 'grandchild2')).toEqual({ ok: false, code: 'not_parent' })
    expect(answers(manager('child', 'full'), 'grandchild2')).toEqual({ ok: false, code: 'not_parent' })
  })

  it('refuses every agent without the manage level, whatever else it holds', () => {
    for (const level of ['lineage', 'read'] as const) expect(answers(manager('stranger', 'full', { level }), 'unrelated')).toEqual({ ok: false, code: 'not_parent' })
    expect(answers(agent('stranger', 'full'), 'unrelated')).toEqual({ ok: false, code: 'not_parent' })
  })

  it('needs the profile switch, which is off until the user turns it on', () => {
    expect(answers(manager('stranger', 'full', { answerApprovals: false }), 'unrelated')).toEqual({ ok: false, code: 'approvals_disabled' })
  })

  it('needs the thread\'s project to be one agents may reach, read when the agent answers, and fails closed', () => {
    const asked: string[] = []
    const only = (allowed: string): Partial<AgentApprovalAccess> => ({ projectAllowed: (id) => { asked.push(id); return id === allowed } })
    expect(answers(manager('stranger', 'full', only('listed')), 'listed')).toEqual({ ok: true })
    expect(answers(manager('stranger', 'full', only('listed')), 'other')).toEqual({ ok: false, code: 'project_not_allowed' })
    expect(asked).toEqual(['listed', 'other'])
    expect(answers(manager('stranger', 'full', { projectAllowed: () => { throw new Error('project index unreadable') } }), 'unrelated')).toEqual({ ok: false, code: 'project_not_allowed' })
  })

  it('never answers its own thread, with every switch on', () => {
    expect(answers(manager('stranger', 'full'), 'stranger')).toEqual({ ok: false, code: 'own_request' })
  })

  it('never answers for a thread of its own lineage beyond its direct subagents: not a grandchild, not its parent, not an ancestor', () => {
    // Below it: only the direct parent answers for a child.
    expect(answers(manager('parent', 'full'), 'grandchild')).toEqual({ ok: false, code: 'not_parent' })
    // Above it: a subagent approves nothing for the agent that started it.
    expect(answers(manager('child', 'full'), 'parent')).toEqual({ ok: false, code: 'not_parent' })
    expect(answers(manager('grandchild', 'full'), 'parent')).toEqual({ ok: false, code: 'not_parent' })
    expect(answers(manager('grandchild', 'full'), 'child')).toEqual({ ok: false, code: 'not_parent' })
    // Its direct subagent stays the parent's own business, and the switch does not touch it.
    expect(answers(manager('parent', 'full', { answerApprovals: false }), 'child')).toEqual({ ok: true })
    expect(answers(manager('parent', 'full', { level: 'lineage', projectAllowed: () => false }), 'child')).toEqual({ ok: true })
  })

  it('never approves what its own mode would ask about, so it widens nothing', () => {
    for (const [mode, action, allowed] of [
      ['ask', 'edit', false], ['ask', 'command', false], ['ask', 'tool', false],
      ['accept_edits', 'edit', true], ['accept_edits', 'command', false], ['accept_edits', 'tool', false],
      ['full', 'edit', true], ['full', 'command', true], ['full', 'tool', true]
    ] as const)
      expect(answers(manager('stranger', mode), 'unrelated', action), `${mode} / ${action}`).toEqual(allowed ? { ok: true } : { ok: false, code: 'mode_forbids' })
    // A rejection widens nothing either, so it is held to the same mode as the approval is.
    expect(answers(manager('stranger', 'ask'), 'unrelated', 'command', { decision: 'reject' })).toEqual({ ok: false, code: 'mode_forbids' })
  })

  it('never creates a standing rule, whatever the agent holds', () => {
    expect(answers(manager('stranger', 'full'), 'unrelated', 'edit', { decision: 'allow', scope: 'always' })).toEqual({ ok: false, code: 'agent_no_standing_grant' })
    // Rejecting "always" is no rule: a rejection carries no scope.
    expect(answers(manager('stranger', 'full'), 'unrelated', 'edit', { decision: 'reject' })).toEqual({ ok: true })
  })

  it('checks the access before the mode, and the mode before "always"', () => {
    expect(answers(manager('stranger', 'ask', { answerApprovals: false }), 'unrelated')).toEqual({ ok: false, code: 'approvals_disabled' })
    expect(answers(manager('stranger', 'ask', { projectAllowed: () => false }), 'unrelated')).toEqual({ ok: false, code: 'project_not_allowed' })
    expect(answers(manager('stranger', 'ask'), 'unrelated', 'command', { decision: 'allow', scope: 'always' })).toEqual({ ok: false, code: 'mode_forbids' })
  })

  describe('a request the provider reserves for a person', () => {
    // Claude Code's own safety check under Full access, a path outside the allowed folders, one of the user's own ask
    // rules, and a refusal to be remembered: each is saved as the request's reason and no rule ever answers it.
    const REASONS = [
      'Claude Code asks even in Full access: its own safety check.',
      'Claude Code asks for this itself and does not allow it to be remembered.',
      'Claude Code asks for this itself and does not allow it to be remembered: Path is outside the allowed working directories',
      'Claude Code asks for this itself and does not allow it to be remembered: matched your ask rule Bash(git push:*)'
    ]

    it.each(REASONS)('no agent answers it, of any mode or access: %s', (reason) => {
      const ask = (threadId: string, action: PermissionAction = 'command') => request(threadId, action, reason)
      // Two Full-access agents cannot clear each other's checks.
      expect(canAnswerApproval(ask('unrelated'), manager('a', 'full'), once, lineage)).toEqual({ ok: false, code: 'person_only' })
      expect(canAnswerApproval(ask('a'), manager('unrelated', 'full'), once, lineage)).toEqual({ ok: false, code: 'person_only' })
      // An edit outside the folders, approved by an Accept-edits agent.
      expect(canAnswerApproval(ask('unrelated', 'edit'), manager('a', 'accept_edits'), once, lineage)).toEqual({ ok: false, code: 'person_only' })
      // The direct parent too (`answer_subagent` reaches the same rule), and a rejection as much as an approval.
      expect(canAnswerApproval(ask('child'), agent('parent', 'full'), once, lineage)).toEqual({ ok: false, code: 'person_only' })
      expect(canAnswerApproval(ask('child'), agent('parent', 'full'), { decision: 'reject' }, lineage)).toEqual({ ok: false, code: 'person_only' })
      // The user is unaffected.
      expect(canAnswerApproval(ask('child'), { kind: 'user', via: 'gui' }, once, lineage)).toEqual({ ok: true })
    })

    it('a request with no reason is answered as before, and so is one whose reason is empty', () => {
      expect(canAnswerApproval(request('child', 'command'), agent('parent', 'full'), once, lineage)).toEqual({ ok: true })
      expect(canAnswerApproval({ ...request('child', 'command'), reason: '' }, agent('parent', 'full'), once, lineage)).toEqual({ ok: true })
      expect(canAnswerApproval({ ...request('child', 'command'), reason: null }, agent('parent', 'full'), once, lineage)).toEqual({ ok: true })
    })

    it('is refused at the settlement boundary and stays pending for the user', async () => {
      const questions = new UserQuestionService()
      questions.setLineageSource(lineage)
      const waiter = questions.requestAnswers(
        [{ id: 'permission', prompt: 'Allow?', options: [{ id: 'allow', label: 'Allow' }, { id: 'reject', label: 'Reject' }] }],
        'child',
        { approval: { action: 'command', permissionKey: 'test:command', reason: REASONS[0], options: [{ id: 'allow', ...once }, { id: 'reject', decision: 'reject' }] } }
      )
      const requestId = questions.listPendingForThread('child')[0]!.requestId
      expect(questions.settle(requestId, { permission: 'allow' }, agent('parent', 'full'))).toEqual({ ok: false, reason: 'person_only' })
      expect(questions.settle(requestId, { permission: 'allow' }, manager('stranger', 'full'))).toEqual({ ok: false, reason: 'person_only' })
      expect(questions.dismiss(requestId, agent('parent', 'full'))).toBe(false)
      expect(questions.getPending(requestId)).not.toBeNull()
      expect(questions.settle(requestId, { permission: 'allow' }, { kind: 'user', via: 'gui' })).toEqual({ ok: true, decision: 'allow' })
      await expect(waiter).resolves.toEqual({ permission: 'allow' })
    })
  })

  it('says in plain words why an agent was refused', () => {
    expect(describeApprovalRefusal('approvals_disabled')).toMatch(/not allowed agents to answer approvals on other threads/)
    expect(describeApprovalRefusal('project_not_allowed')).toMatch(/project the user has not given agents access to/)
    expect(describeApprovalRefusal('person_only')).toMatch(/only the user can answer it/)
    expect(describeApprovalRefusal('person_turn')).toMatch(/user started the turn/)
  })

  it('is the same rule at the settlement boundary: a refusal leaves the request pending for the user, and an answer settles it once', async () => {
    const questions = new UserQuestionService()
    questions.setLineageSource(lineage)
    const waiter = questions.requestAnswers(
      [{ id: 'permission', prompt: 'Allow?', options: [{ id: 'allow', label: 'Allow' }, { id: 'allow_always', label: 'Always' }, { id: 'reject', label: 'Reject' }] }],
      'unrelated',
      { approval: { action: 'command', permissionKey: 'test:command', options: [{ id: 'allow', ...once }, { id: 'allow_always', decision: 'allow', scope: 'always' }, { id: 'reject', decision: 'reject' }] } }
    )
    const requestId = questions.listPendingForThread('unrelated')[0]!.requestId
    expect(questions.settle(requestId, { permission: 'allow' }, manager('stranger', 'full', { answerApprovals: false }))).toEqual({ ok: false, reason: 'approvals_disabled' })
    expect(questions.settle(requestId, { permission: 'allow' }, manager('stranger', 'ask'))).toEqual({ ok: false, reason: 'mode_forbids' })
    expect(questions.settle(requestId, { permission: 'allow_always' }, manager('stranger', 'full'))).toEqual({ ok: false, reason: 'agent_no_standing_grant' })
    expect(questions.getPending(requestId)).not.toBeNull()
    expect(questions.settle(requestId, { permission: 'allow' }, manager('stranger', 'full'))).toEqual({ ok: true, decision: 'allow' })
    await expect(waiter).resolves.toEqual({ permission: 'allow' })
    expect(questions.getPending(requestId)).toBeNull()
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
