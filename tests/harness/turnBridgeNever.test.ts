/**
 * PR 4 §4: `approvals: 'never'` is enforced. A binding takes its approvals from the caller, and the
 * turn bridge of a `never` binding denies every permission request without asking: ACP answers
 * `reject_once`, Claude Code's `canUseTool` denies with the fixed text, Codex declines (the Codex
 * service case is in `subagentProviderPolicy.test.ts`). `ask` keeps asking the thread's questions.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerPermission, APPROVALS_REFUSED_MESSAGE, classifyGenericOption, questionsPrompter, refusingPrompter, type AcpRequestScope, type PermissionPrompter } from '../../src/mms/harness/acp/permissions'
import type { TurnSpec } from '../../src/mms/harness/gateway'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { ClaudeSubscriptionAdapter, CLAUDE_SUBSCRIPTION_CAPABILITIES, type ClaudeSubscriptionClient } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { CodexAdapter, type CodexClient } from '../../src/mms/run/adapters/codex/CodexAdapter'
import type { AdapterHost, ProviderAdapter, TurnBridge, TurnInput, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { testHarness } from '../../src/mms/run/testkit/harness'
import type { RunPolicy } from '../../src/shared/harness/types'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
const tempHome = (prefix: string) => {
  const home = mkdtempSync(join(tmpdir(), prefix))
  homes.push(home)
  return home
}

const noop = () => {}
const sink = (): TurnSink => ({ text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop, usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop })
const turnInput = (patch: Partial<TurnInput> = {}): TurnInput => ({
  runId: 'run-1', attemptId: 'a', threadId: 'thread-1', cwd: '/work', instanceId: 'claude', model: 'm', llmProvider: 'claude', modelPinned: true, mode: 'agent', prompt: 'hi', messages: [], signal: new AbortController().signal, ...patch
})
const bridge = (permission: PermissionPrompter): TurnBridge => ({ mcp: null, turnToken: 't', sessionInstructions: '', turnPreamble: '', userMcp: 'native', permission })
const host = (permission?: PermissionPrompter): AdapterHost => ({
  tools: {},
  ...(permission ? { bridge: bridge(permission) } : {}),
  context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' }
})

describe('the gateway mints the bridge from the binding\'s approvals', () => {
  function setup() {
    const home = tempHome('mousse-never-')
    const hosts: AdapterHost[] = []
    const adapter: ProviderAdapter = {
      driver: 'claude',
      capabilities: CLAUDE_SUBSCRIPTION_CAPABILITIES,
      configured: () => true,
      startTurn: async (input, _sink, _ctl, adapterHost) => {
        hosts.push(adapterHost)
        return { text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef: { provider: 'p' } }
      },
      interrupt: async () => 'not_active'
    }
    let stored: unknown
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored }), write: (next) => { stored = next.instances } } })
    const questions = new UserQuestionService()
    const harness = testHarness({ adapters: [adapter], instances, profileHome: home, questions })
    const turn = async (approvals?: RunPolicy['approvals']) => {
      const binding = await harness.bind(harness.resolveStored({ instanceId: 'claude', llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'agent', ...(approvals ? { approvals } : {}) })
      const spec: TurnSpec = {
        binding,
        input: turnInput(),
        sink: sink(),
        control: { drainSteer: () => undefined, heartbeat: noop },
        host: host(),
        app: { turnToken: 'tt', modeCeiling: 'default', mcpEligible: false, instructions: () => ({ sessionInstructions: '', turnPreamble: '' }) }
      }
      await harness.startTurn(spec).result
      return { binding, bridge: hosts.at(-1)!.bridge! }
    }
    return { harness, questions, turn }
  }

  it('records the caller\'s approvals on the binding, `ask` by default', async () => {
    const s = setup()
    expect((await s.turn()).binding.policy.approvals).toBe('ask')
    expect((await s.turn('never')).binding.policy.approvals).toBe('never')
    s.harness.stop()
  })

  it('`never` denies without asking; `ask` asks the thread', async () => {
    const s = setup()
    const asked = vi.spyOn(s.questions, 'requestAnswers').mockResolvedValue({ permission: 'yes' })
    const refused = (await s.turn('never')).bridge.permission!
    expect(refused.approvals).toBe('never')
    expect(await refused.choose({ threadId: 'thread-1', title: 'Run rm?', options: [] })).toBeUndefined()
    expect(asked).not.toHaveBeenCalled()
    const asking = (await s.turn('ask')).bridge.permission!
    expect(asking.approvals).toBeUndefined()
    expect(await asking.choose({ threadId: 'thread-1', title: 'Run rm?', options: [] })).toBe('yes')
    expect(asked).toHaveBeenCalledOnce()
    s.harness.stop()
  })
})

describe('ACP request_permission', () => {
  const scope: AcpRequestScope = { threadId: 'thread-1', cwd: '/work', aborted: () => false, throwIfAborted: noop }
  const request = {
    sessionId: 's',
    toolCall: { toolCallId: 'c', title: 'Run rm -rf build' },
    options: [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always', kind: 'allow_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' }
    ]
  } as RequestPermissionRequest

  it('answers `reject_once` under `never` without asking', async () => {
    const questions = new UserQuestionService()
    const asked = vi.spyOn(questions, 'requestAnswers')
    const answer = await answerPermission(refusingPrompter(), scope, request, { label: 'Agent', classify: classifyGenericOption })
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
    expect(asked).not.toHaveBeenCalled()
  })

  it('asks under `ask`, as before', async () => {
    const questions = new UserQuestionService()
    const asked = vi.spyOn(questions, 'requestAnswers').mockResolvedValue({ permission: 'yes' })
    const answer = await answerPermission(questionsPrompter(questions), scope, request, { label: 'Agent', classify: classifyGenericOption })
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } })
    expect(asked).toHaveBeenCalledOnce()
  })
})

describe('Claude Code', () => {
  it('the adapter passes `never` from the bridge, and nothing under `ask`', async () => {
    const inputs: Array<{ approvals?: string }> = []
    const client = {
      chat: vi.fn(async (chat) => {
        inputs.push(chat)
        return 'done'
      }),
      commitConversation: vi.fn(),
      standaloneWorkspace: vi.fn(() => '/standalone'),
      configured: () => true
    } satisfies ClaudeSubscriptionClient
    const adapter = new ClaudeSubscriptionAdapter(() => client)
    const control = { drainSteer: () => undefined, heartbeat: noop }
    await adapter.startTurn(turnInput(), sink(), control, host(refusingPrompter()))
    await adapter.startTurn(turnInput(), sink(), control, host(questionsPrompter(new UserQuestionService())))
    expect(inputs.map((chat) => chat.approvals)).toEqual(['never', undefined])
  })

  /** A service whose query asks `canUseTool` about `Bash` while the turn runs. */
  function claude() {
    const home = tempHome('mousse-never-claude-')
    const binary = join(home, 'claude')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    const directory = join(home, 'providers', 'claude-subscription')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const answers: unknown[] = []
    const questions = new UserQuestionService()
    const service = new ClaudeSubscriptionProviderService(home, questions, {
      query: ({ options }: { options: Options }) => {
        const generator = (async function* () {
          answers.push(await options.canUseTool!('Bash', { command: 'rm -rf build' }, { signal: new AbortController().signal } as never))
          yield { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'vendor-session' }
        })()
        return Object.assign(generator, { close: vi.fn(), interrupt: vi.fn(async () => {}) }) as unknown as Query
      },
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    return { home, service, questions, answers }
  }

  it('`canUseTool` denies with the fixed text under `never` and never asks', async () => {
    const c = claude()
    const asked = vi.spyOn(c.questions, 'requestAnswers')
    await c.service.chat({ threadId: 'thread-1', cwd: c.home, model: 'sonnet', prompt: 'go', onText: noop, approvals: 'never' })
    expect(c.answers).toEqual([{ behavior: 'deny', message: APPROVALS_REFUSED_MESSAGE }])
    expect(APPROVALS_REFUSED_MESSAGE).toBe('Tools that need approval are refused here.')
    expect(asked).not.toHaveBeenCalled()
    c.service.stop()
  })

  it('`canUseTool` asks the user under `ask`, as before', async () => {
    const c = claude()
    const asked = vi.spyOn(c.questions, 'requestAnswers').mockResolvedValue({ permission: 'allow' })
    await c.service.chat({ threadId: 'thread-1', cwd: c.home, model: 'sonnet', prompt: 'go', onText: noop })
    expect(c.answers).toEqual([expect.objectContaining({ behavior: 'allow' })])
    expect(asked).toHaveBeenCalledOnce()
    c.service.stop()
  })
})

describe('Codex', () => {
  it('the adapter passes `never` from the bridge, and nothing under `ask`', async () => {
    const inputs: Array<{ approvals?: string }> = []
    const client = {
      chat: vi.fn(async (chat: { approvals?: string }) => {
        inputs.push(chat)
        return 'done'
      }),
      commitConversation: vi.fn(),
      standaloneWorkspace: vi.fn(() => '/standalone'),
      configured: () => true,
      interrupt: vi.fn(),
      steer: vi.fn(),
      userSetup: vi.fn()
    } as unknown as CodexClient
    const adapter = new CodexAdapter(() => client)
    const control = { drainSteer: () => undefined, heartbeat: noop }
    const codexInput = turnInput({ instanceId: 'codex', llmProvider: 'codex', model: 'gpt-x' })
    await adapter.startTurn(codexInput, sink(), control, host(refusingPrompter()))
    await adapter.startTurn(codexInput, sink(), control, host(questionsPrompter(new UserQuestionService())))
    expect(inputs.map((chat) => chat.approvals)).toEqual(['never', undefined])
  })
})
