/**
 * `request_answer` (docs/plans/tool-api.md §1.5 "request"): the request's id decides its kind, each kind keeps its old
 * tool's authority (`REQUEST_ANSWER_KINDS`), and a grant or a call under an old name holds its own kind only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DefinitionAuthority } from '../../src/mms/agentDefinitions/definitionGate'
import { BOT_RELAY_OWNER_ONLY_TEXT } from '../../src/mms/bots/activation/turnKinds'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import type { BotToolHost } from '../../src/mms/bots/seams'
import { RunCounters } from '../../src/mms/harness/budget'
import type { ApprovalRequestInfo } from '../../src/mms/run/mcp/appTools'
import { refused } from '../../src/mms/run/mcp/appTools/refusal'
import type { AgentRuntimePolicy } from '../../src/shared/agents/execution'
import type { Thread } from '../../src/shared/types'
import { appToolRegistry, appTurn, fakeAppToolHost, refusalOf } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const NOW = '2026-11-27T00:00:00.000Z'
const thread = (id: string): Thread => ({ id, name: `Thread ${id}`, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1' }) as Thread
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
  ['req-other', request('req-other', 'other')]
])

describe('request_answer', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  const world = async (turn: Partial<Parameters<typeof appTurn>[0]> = {}, bots?: () => { host: BotToolHost }) => {
    fx = delegationFixture()
    const run = await fx.runningRun('caller')
    const fake = fakeAppToolHost({
      threadMeta: (id) => thread(id),
      parentThread: (id) => PARENTS[id],
      approvalRequest: (id) => REQUESTS.get(id),
      answerApproval: vi.fn(() => ({ ok: true as const, decision: 'allow' as const, replayed: false }))
    })
    const { registry, turns, request: as } = appToolRegistry(fx.engine, fake.host, bots ? { bots } : {})
    turns.register(appTurn({ threadId: 'caller', runId: run.runId, ...turn }))
    const call = (name: string, args: Record<string, unknown>) => registry.call(name, args, as({ threadId: 'caller', runId: run.runId }))
    return { call, host: fake.host, delegation: fake.host.delegation() }
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
      policy: {
        profileId: 'default', threadId: 'caller', runId: 'r', definitionId: 'def-1', definitionRevision: 'rev-1', source: 'editor',
        workspace: { mode: 'thread_worktree', canonicalRoots: [process.cwd()] },
        script: { enabled: false, allowFilesystem: false, allowNetwork: false, executionMode: 'workspace', interpreters: [] },
        approval: { askUser: true, policy: 'inherit', unattendedBehavior: 'pause' },
        memoryScope: 'off', includeCurrentThread: false, includeProjectInstructions: false, attachmentPolicy: 'none',
        fallbacks: { enabled: false, retryOn: [], allowHigherCost: false, retryCount: 0, backoffMs: 0 }, fallbackModels: []
      } satisfies AgentRuntimePolicy,
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
    const host = { activationOf: () => ({ botId: 'b1', activationId: 'act-1', lane: 'chat' as const }), questions: { relay } } as unknown as BotToolHost
    const bot = createBotAuthority({
      activationId: 'act-1', role: 'activation', permissions: { tools: [], appTools: ['question_answer'], mcp: [], skills: [], workspace: null },
      waiting: () => false, counters: new RunCounters(), time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal }, spend: null
    })
    const { call } = await world({ bot: { ...bot, turnRefusals: new Map([['question_answer', BOT_RELAY_OWNER_ONLY_TEXT]]) } }, () => ({ host }))
    expect(refusalOf(await call('request_answer', { requestId: 'q-1', answer: 'The second flat' }))?.message).toBe(BOT_RELAY_OWNER_ONLY_TEXT)
    expect(relay).not.toHaveBeenCalled()
  })
})
