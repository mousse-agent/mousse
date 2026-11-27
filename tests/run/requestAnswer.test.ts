/**
 * `request_answer` (docs/plans/tool-api.md §1.5 "request"): the request's id decides its kind, each kind keeps its old
 * tool's authority (`REQUEST_ANSWER_KINDS`), and a grant or a call under an old name holds its own kind only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { definitionToolGranted, recordAuthorizedCall, withoutTransportFields, type DefinitionAuthority } from '../../src/mms/agentDefinitions/definitionGate'
import { ClaudeLockedGate } from '../../src/mms/harness/claude/locked'
import { CLAUDE_MOUSSE_TOOL_PREFIX } from '../../src/mms/run/mcp/attachment'
import { BOT_RELAY_OWNER_ONLY_TEXT } from '../../src/mms/bots/activation/turnKinds'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import type { BotToolHost } from '../../src/mms/bots/seams'
import { RunCounters } from '../../src/mms/harness/budget'
import type { ApprovalRequestInfo } from '../../src/mms/run/mcp/appTools'
import { refused } from '../../src/mms/run/mcp/appTools/refusal'
import { noSuchRequest } from '../../src/mms/run/mcp/appTools/requestAnswer'
import type { AgentRuntimePolicy } from '../../src/shared/agents/execution'
import type { Thread } from '../../src/shared/types'
import { appToolRegistry, appTurn, fakeAppToolHost, refusalOf } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const NOW = '2026-11-27T00:00:00.000Z'
const thread = (id: string): Thread => ({ id, name: `Thread ${id}`, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1', ...(id === 'private' ? { localOnly: true } : {}) }) as Thread
const request = (requestId: string, threadId: string, approval = true): ApprovalRequestInfo => ({
  requestId, threadId, status: 'pending', approval,
  questions: [{ id: 'permission', prompt: 'Allow it?', options: [{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }] }]
})
const ALLOW = { permission: 'allow' }

/** `caller` is the parent of `child`, which is the parent of `grandchild`; `other` is no relation. */
const PARENTS: Record<string, string> = { child: 'caller', grandchild: 'child' }
const REQUESTS = new Map([
  ['req-child', request('req-child', 'child', false)],
  ['req-grandchild', request('req-grandchild', 'grandchild', false)],
  ['req-other', request('req-other', 'other')],
  ['req-private', request('req-private', 'private')]
])
const POLICY: AgentRuntimePolicy = {
  profileId: 'default', threadId: 'caller', runId: 'r', definitionId: 'def-1', definitionRevision: 'rev-1', source: 'editor',
  workspace: { mode: 'thread_worktree', canonicalRoots: [process.cwd()] },
  script: { enabled: false, allowFilesystem: false, allowNetwork: false, executionMode: 'workspace', interpreters: [] },
  approval: { askUser: true, policy: 'inherit', unattendedBehavior: 'pause' },
  memoryScope: 'off', includeCurrentThread: false, includeProjectInstructions: false, attachmentPolicy: 'none',
  fallbacks: { enabled: false, retryOn: [], allowHigherCost: false, retryCount: 0, backoffMs: 0 }, fallbackModels: []
}
const granted = (id: string) => ({ skills: [], mcpTools: [], builtinTools: [{ id, source: 'definition' as never }], denied: [] })
const botAuthority = (appTools: string[]) => createBotAuthority({
  activationId: 'act-1', role: 'activation', permissions: { tools: [], appTools, mcp: [], skills: [], workspace: null },
  waiting: () => false, counters: new RunCounters(), time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal }, spend: null
})

describe('request_answer', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  const world = async (turn: Partial<Parameters<typeof appTurn>[0]> = {}, bots?: () => { host: BotToolHost }, answered: Record<string, 'subagent' | 'approval'> = {}) => {
    fx = delegationFixture()
    const run = await fx.runningRun('caller')
    const fake = fakeAppToolHost({
      threadMeta: (id) => thread(id),
      parentThread: (id) => PARENTS[id],
      approvalRequest: (id) => REQUESTS.get(id),
      answeredRequest: (_caller, keys) => keys.map((key) => answered[key]).find(Boolean),
      answerApproval: vi.fn(() => ({ ok: true as const, decision: 'allow' as const, replayed: false }))
    })
    const { registry, turns, request: as } = appToolRegistry(fx.engine, fake.host, bots ? { bots } : {})
    turns.register(appTurn({ threadId: 'caller', runId: run.runId, turnToken: 'tt', ...turn }))
    const call = (name: string, args: Record<string, unknown>, extra: Partial<ReturnType<typeof as>> = {}) => registry.call(name, args, { ...as({ threadId: 'caller', runId: run.runId }), ...extra })
    const resolve = (name: string, args: Record<string, unknown>) => registry.resolveCall(name, args, { threadId: 'caller', runId: run.runId })
    return { call, resolve, host: fake.host, delegation: fake.host.delegation(), perCall: () => as({ threadId: 'caller', runId: run.runId, binding: 'per_call' }) }
  }

  it('answers its own subagent\'s question as answer_subagent did, and another thread\'s approval as approval_respond did', async () => {
    const { call, host, delegation } = await world()
    await call('request_answer', { requestId: 'req-child', answers: ALLOW })
    expect(delegation.answerSubagent).toHaveBeenCalledWith(expect.objectContaining({ subagent: 'child', requestId: 'req-child' }), expect.anything())
    expect((await call('request_answer', { requestId: 'req-other', answers: ALLOW })).isError).toBeFalsy()
    expect(host.answerApproval).toHaveBeenCalledWith('other', 'req-other', ALLOW, expect.anything())
  })

  it('a grandchild\'s question is not its grandparent\'s: refused as another thread\'s question for the user', async () => {
    const { call, host, delegation } = await world()
    const refusal = refusalOf(await call('request_answer', { requestId: 'req-grandchild', answers: ALLOW }))
    expect(refusal).toMatchObject({ code: 'mousse_scope_denied' })
    expect(refusal!.message).toMatch(/only the user answers it/)
    expect(delegation.answerSubagent).not.toHaveBeenCalled()
    expect(host.answerApproval).not.toHaveBeenCalled()
  })

  it('a call under answer_subagent answers no other thread\'s approval', async () => {
    const { call, host } = await world()
    expect(await call('answer_subagent', { subagent: 'other', requestId: 'req-other', answers: ALLOW })).toEqual(refused('not_granted',
      "That request is another thread's approval; answer_subagent answers only a question or approval of the caller's own subagent.", { variant: 'approval' }))
    expect(host.answerApproval).not.toHaveBeenCalled()
  })

  it('a definition granted answer_subagent answers its subagents and no other thread\'s approval', async () => {
    const definition = {
      policy: POLICY,
      grants: { skills: [], mcpTools: [], builtinTools: [{ id: 'answer_subagent', source: 'definition' }], denied: [] },
      mcpTools: [],
      approve: async () => ({ status: 'denied', reason: 'asked' })
    } as unknown as DefinitionAuthority
    const { call, host } = await world({ definition })
    expect(refusalOf(await call('request_answer', { requestId: 'req-other', answers: ALLOW }))?.message).toBe('Tool "request_answer" is not granted to this agent definition.')
    expect(host.answerApproval).not.toHaveBeenCalled()
    expect(refusalOf(await call('request_answer', { requestId: 'req-child', answers: ALLOW }))?.message ?? '').not.toMatch(/not granted/)
  })

  it('a bot passes on its owner\'s answer only from a turn its owner\'s own message started', async () => {
    const relay = vi.fn(() => ({ ok: true as const, title: 'Flats' }))
    const host = { activationOf: () => ({ botId: 'b1', activationId: 'act-1', lane: 'chat' as const }), questions: { relay, asked: (_bot: string, id: string) => id === 'q-1' } } as unknown as BotToolHost
    const bot = botAuthority(['question_answer'])
    const { call } = await world({ bot: { ...bot, turnRefusals: new Map([['question_answer', BOT_RELAY_OWNER_ONLY_TEXT]]) } }, () => ({ host }))
    expect(refusalOf(await call('request_answer', { requestId: 'q-1', answer: 'The second flat' }))?.message).toBe(BOT_RELAY_OWNER_ONLY_TEXT)
    expect(relay).not.toHaveBeenCalled()
  })

  it('a relay answers only the question its id names: one no work of the bot asked is no such request, kind or not', async () => {
    const relay = vi.fn(() => ({ ok: true as const, title: 'Flats' }))
    const host = { activationOf: () => ({ botId: 'b1', activationId: 'act-1', lane: 'chat' as const }), questions: { relay, asked: (_bot: string, id: string) => id === 'q-1' } } as unknown as BotToolHost
    const { call } = await world({ bot: botAuthority(['question_answer']) }, () => ({ host }))
    // A conflicting old questionId never redirects the answer to another question.
    expect(refusalOf(await call('request_answer', { requestId: 'q-1', questionId: 'q-2', answer: 'Flat B' }))).toMatchObject({ code: 'invalid_arguments' })
    // An id no work of this bot asked: the caller's `kind` (or the old name that adds it) picks no branch.
    expect(await call('request_answer', { requestId: 'q-2', answer: 'Flat B' })).toEqual(noSuchRequest('q-2'))
    expect(await call('question_answer', { questionId: 'q-2', answer: 'Flat B' })).toEqual(noSuchRequest('q-2'))
    expect(relay).not.toHaveBeenCalled()
    expect(JSON.parse((await call('request_answer', { requestId: 'q-1', answer: 'Flat B' })).text)).toMatchObject({ ok: true })
    expect(relay).toHaveBeenCalledWith('b1', 'act-1', 'q-1', 'Flat B', expect.any(String))
  })

  it('an approval found by id alone never names a thread the caller may not reach', async () => {
    const { call, host } = await world()
    expect(await call('request_answer', { requestId: 'req-private', answers: ALLOW })).toEqual(noSuchRequest('req-private'))
    expect(await call('request_answer', { requestId: 'req-nowhere', answers: ALLOW })).toEqual(noSuchRequest('req-nowhere'))
    expect(host.answerApproval).not.toHaveBeenCalled()
  })

  it('a retry of an answered call replays as the kind its receipt says, after the request is gone', async () => {
    const { call, delegation } = await world({}, undefined, { 'mcp:answer-1': 'subagent' })
    // The subagent's question settled and left the lookup; the retry still reaches answer_subagent, which replays it.
    await call('request_answer', { requestId: 'req-settled', thread: 'child', answers: ALLOW }, { toolCallId: 'mcp:answer-1' })
    expect(delegation.answerSubagent).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-settled' }), { toolCallId: 'mcp:answer-1' })
  })

  it('a Claude bot holding approval_respond calls request_answer for an approval, and a relay grant answers none', async () => {
    const { resolve } = await world()
    const gate = (appTools: string[], resolveAppCall?: typeof resolve) =>
      new ClaudeLockedGate({ authority: botAuthority(appTools), ...(resolveAppCall ? { resolveAppCall } : {}), cwd: process.cwd(), shellContained: false, temps: [], systemPrompt: '' }, true)
    const answer = { requestId: 'req-other', answers: ALLOW }
    expect(gate(['approval_respond'], resolve).preToolUse(`${CLAUDE_MOUSSE_TOOL_PREFIX}request_answer`, answer)).toEqual({ ok: true })
    expect(gate(['question_answer'], resolve).preToolUse(`${CLAUDE_MOUSSE_TOOL_PREFIX}request_answer`, answer)).toMatchObject({ ok: false })
    // Judged by its literal name, the call was refused before the registry could resolve it.
    expect(gate(['approval_respond']).preToolUse(`${CLAUDE_MOUSSE_TOOL_PREFIX}request_answer`, answer)).toMatchObject({ ok: false })
  })

  it('a runtime gate and the registry judge one call: a variant grant holds it, and an approval is not asked twice', async () => {
    const approve = vi.fn(async () => ({ status: 'denied' as const, reason: 'asked again' }))
    const definition = { policy: { ...POLICY, approval: { ...POLICY.approval, policy: 'always' } }, grants: granted('approval_respond'), approve } as unknown as DefinitionAuthority
    const { call, resolve, perCall } = await world({ definition })
    const calls: Array<[string, Record<string, unknown>]> = [['pi-1', { requestId: 'req-other', answers: ALLOW }], ['pi-2', { kind: 'approval', requestId: 'req-other', answers: ALLOW }]]
    for (const [callId, args] of calls) {
      // What Pi's gate authorizes: the call as the registry will run it (Pi's extension sends its call id as clientRequestId).
      const gated = resolve('request_answer', { ...args, clientRequestId: callId })
      if ('refused' in gated) throw new Error(gated.refused.text)
      expect(definitionToolGranted('request_answer', definition.grants, [], args)).toBe('kind' in args)
      expect(definitionToolGranted('request_answer', definition.grants, [], gated.args)).toBe(true)
      recordAuthorizedCall(definition, { turnToken: 'tt', toolName: 'request_answer', callId, args: withoutTransportFields(gated.args) })
      expect((await call('request_answer', { ...args, _mousse_turn: 'tt' }, { ...perCall(), toolCallId: `mcp:${callId}` })).isError).toBeFalsy()
    }
    expect(approve).not.toHaveBeenCalled()
  })
})
