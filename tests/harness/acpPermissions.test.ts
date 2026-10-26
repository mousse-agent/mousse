/**
 * Permission requests of ACP agents (agent CLIs plan §2): options keep their identity and scope,
 * "always" never passes for once, a stopped turn answers `cancelled`, and the `grants` and `never`
 * policies answer with once-only options.
 */
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import { answerPermission, classifyGenericOption, keepOption, type AcpRequestScope, type PermissionPrompter } from '../../src/mms/harness/acp/permissions'

const request: RequestPermissionRequest = {
  sessionId: 's',
  toolCall: { toolCallId: 'c', title: 'Run npm test' },
  options: [
    { optionId: 'once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    { optionId: 'never', name: 'Always reject', kind: 'reject_always' }
  ]
}

function scope(aborted = false): AcpRequestScope {
  return { threadId: 'thread', cwd: '/w', aborted: () => aborted, throwIfAborted: () => {} }
}

function prompter(answer: string | undefined): PermissionPrompter & { choose: ReturnType<typeof vi.fn> } {
  return { choose: vi.fn(async () => answer) }
}

describe('ACP permission options', () => {
  it('classifies scopes and says that "always" may outlive the session', () => {
    expect(request.options.map(classifyGenericOption)).toEqual([
      { optionId: 'once', kind: 'allow_once', label: 'Allow', scope: 'once' },
      { optionId: 'always', kind: 'allow_always', label: 'Always allow (the agent may remember this beyond this session)', scope: 'persistent' },
      { optionId: 'no', kind: 'reject_once', label: 'Reject', scope: 'once' },
      { optionId: 'never', kind: 'reject_always', label: 'Always reject', scope: 'persistent' }
    ])
    expect(keepOption(request.options[1]!).label).toBe('Always allow')
  })

  it('asks with the shown options and answers with the one picked', async () => {
    const ask = prompter('always')
    expect(await answerPermission(ask, scope(), request, { label: 'Agent', classify: classifyGenericOption })).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } })
    expect(ask.choose).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread', title: 'Run npm test' }))
  })

  it('hides options a preset drops, and an answer outside the shown ones cancels', async () => {
    const onlyOnce = (option: (typeof request.options)[number]) => (option.kind === 'allow_always' ? null : classifyGenericOption(option))
    const ask = prompter('always')
    expect(await answerPermission(ask, scope(), request, { label: 'Agent', classify: onlyOnce })).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(ask.choose.mock.calls[0][0].options.map((option: { optionId: string }) => option.optionId)).toEqual(['once', 'no', 'never'])
  })

  it('answers cancelled for a stopped turn, without asking', async () => {
    const ask = prompter('once')
    expect(await answerPermission(ask, scope(true), request, { label: 'Agent', classify: classifyGenericOption })).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(ask.choose).not.toHaveBeenCalled()
  })

  it('answers cancelled when the turn stops while the user decides', async () => {
    let stopped = false
    const ask: PermissionPrompter = { choose: async () => { stopped = true; return 'once' } }
    const live: AcpRequestScope = { ...scope(), aborted: () => stopped }
    expect(await answerPermission(ask, live, request, { label: 'Agent', classify: classifyGenericOption })).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it.each([['grants', 'once'], ['never', 'no']] as const)('the %s policy answers with a once-only option, never an "always" one', async (approvals, optionId) => {
    const ask = prompter('always')
    expect(await answerPermission(ask, scope(), request, { label: 'Agent', classify: classifyGenericOption, approvals })).toEqual({ outcome: { outcome: 'selected', optionId } })
    expect(ask.choose).not.toHaveBeenCalled()
    const alwaysOnly = { ...request, options: request.options.filter((option) => option.kind.endsWith('always')) }
    expect(await answerPermission(ask, scope(), alwaysOnly, { label: 'Agent', classify: classifyGenericOption, approvals })).toEqual({ outcome: { outcome: 'cancelled' } })
  })
})
