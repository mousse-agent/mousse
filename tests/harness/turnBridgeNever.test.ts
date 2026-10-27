/**
 * PR 4 §4: `approvals: 'never'` is enforced. A binding takes its approvals from the caller, and the
 * turn bridge of a `never` binding denies every permission request without asking: ACP answers
 * `reject_once` and refuses file writes and Grok's questions, Claude Code's `canUseTool` denies with
 * the fixed text (and refuses `AskUserQuestion`), Codex declines (the Codex service cases are in
 * `subagentProviderPolicy.test.ts`). A `never` turn without a bridge does not run. `ask` keeps
 * asking the thread's questions.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerPermission, APPROVALS_REFUSED_MESSAGE, classifyGenericOption, QUESTIONS_REFUSED_MESSAGE, questionsPrompter, refusingPrompter, writeWorkspaceFile, type AcpRequestScope, type PermissionPrompter } from '../../src/mms/harness/acp/permissions'
import { answerXaiQuestions } from '../../src/mms/harness/acp/xai'
import type { TurnSpec } from '../../src/mms/harness/gateway'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { ClaudeSubscriptionAdapter, CLAUDE_SUBSCRIPTION_CAPABILITIES, type ClaudeSubscriptionClient } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { CodexAdapter, type CodexClient } from '../../src/mms/run/adapters/codex/CodexAdapter'
import type { AdapterHost, ProviderAdapter, TurnBridge, TurnInput, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { testHarness } from '../../src/mms/run/testkit/harness'
import { methods, PROTOCOL_VERSION, type AgentApp } from '@agentclientprotocol/sdk'
import { AcpSessions, type SavedAcpSession } from '../../src/mms/harness/acp/session'
import { NO_QUIRKS } from '../../src/mms/harness/acp/quirks'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import { QuickActionTools } from '../../src/mms/orchestrator/QuickActionTools'
import { createAppToolRegistry, type AppToolTurn } from '../../src/mms/run/mcp/appTools'
import { appToolRegistry, appTurn, fakeAppToolHost } from '../run/appToolsFixture'
import { delegationFixture, type DelegationFixture } from '../run/delegationFixture'
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
    const turn = async (approvals?: RunPolicy['approvals'], options: { app?: boolean } = {}) => {
      const binding = await harness.bind(harness.resolveStored({ instanceId: 'claude', llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'agent', ...(approvals ? { approvals } : {}) })
      const spec: TurnSpec = {
        binding,
        input: turnInput(),
        sink: sink(),
        control: { drainSteer: () => undefined, heartbeat: noop },
        host: host(),
        ...(options.app === false ? {} : { app: { turnToken: 'tt', modeCeiling: 'default' as const, mcpEligible: false, instructions: () => ({ sessionInstructions: '', turnPreamble: '' }) } })
      }
      await harness.startTurn(spec).result
      return { binding, bridge: hosts.at(-1)!.bridge! }
    }
    return { harness, questions, turn, hosts }
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

  it('a turn without a bridge does not run under `never` (nothing would refuse its prompts), and runs under `ask`', async () => {
    const s = setup()
    await expect(s.turn('never', { app: false })).rejects.toMatchObject({ code: 'policy_unenforceable', details: { reason: expect.stringContaining('no app context') } })
    expect(s.hosts).toHaveLength(0)
    await s.turn('ask', { app: false }).catch(() => {})
    expect(s.hosts).toHaveLength(1)
    expect(s.hosts[0].bridge).toBeUndefined()
    s.harness.stop()
  })
})

describe('ACP file writes and Grok questions under `never`', () => {
  const home = () => tempHome('mousse-never-acp-')

  it('a file write is refused without asking and nothing is written', async () => {
    const cwd = home()
    const questions = new UserQuestionService()
    const asked = vi.spyOn(questions, 'requestAnswers')
    const scope: AcpRequestScope = { threadId: 'thread-1', cwd, approvals: 'never', aborted: () => false, throwIfAborted: noop }
    await expect(writeWorkspaceFile(questions, scope, { sessionId: 's', path: join(cwd, 'a.txt'), content: 'x' }, 'Antigravity')).rejects.toThrow(APPROVALS_REFUSED_MESSAGE)
    expect(asked).not.toHaveBeenCalled()
    expect(existsSync(join(cwd, 'a.txt'))).toBe(false)
  })

  it('a file write still asks under `ask`', async () => {
    const cwd = home()
    const questions = new UserQuestionService()
    const asked = vi.spyOn(questions, 'requestAnswers').mockResolvedValue({ write: 'allow' })
    const scope: AcpRequestScope = { threadId: 'thread-1', cwd, aborted: () => false, throwIfAborted: noop }
    await writeWorkspaceFile(questions, scope, { sessionId: 's', path: join(cwd, 'a.txt'), content: 'x' }, 'Antigravity')
    expect(asked).toHaveBeenCalledOnce()
    expect(existsSync(join(cwd, 'a.txt'))).toBe(true)
  })

  it('Grok ask_user_question is cancelled without asking under `never`, and asked under `ask`', async () => {
    const questions = new UserQuestionService()
    const asked = vi.spyOn(questions, 'requestAnswers').mockResolvedValue({ q0: 'option-0' })
    const params = { questions: [{ question: 'Which file?', options: [{ label: 'a.ts' }] }] }
    const base = { threadId: 'thread-1', cwd: '/work', aborted: () => false, throwIfAborted: noop }
    expect(await answerXaiQuestions(questions, { ...base, approvals: 'never' }, params)).toEqual({ outcome: 'cancelled' })
    expect(asked).not.toHaveBeenCalled()
    expect(await answerXaiQuestions(questions, base, params)).toEqual({ outcome: 'accepted', answers: { 'Which file?': ['a.ts'] } })
    expect(asked).toHaveBeenCalledOnce()
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

  /** A service whose query asks `canUseTool` about `tool` while the turn runs. */
  function claude(tool = 'Bash', args: Record<string, unknown> = { command: 'rm -rf build' }) {
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
          answers.push(await options.canUseTool!(tool, args, { signal: new AbortController().signal } as never))
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

  it('`AskUserQuestion` is denied without asking under `never`, and asked under `ask`', async () => {
    const args = { questions: [{ question: 'Which file?', options: [{ label: 'a.ts' }] }] }
    const refused = claude('AskUserQuestion', args)
    const notAsked = vi.spyOn(refused.questions, 'requestAnswers')
    await refused.service.chat({ threadId: 'thread-1', cwd: refused.home, model: 'sonnet', prompt: 'go', onText: noop, approvals: 'never' })
    expect(refused.answers).toEqual([{ behavior: 'deny', message: QUESTIONS_REFUSED_MESSAGE }])
    expect(notAsked).not.toHaveBeenCalled()
    refused.service.stop()
    const asking = claude('AskUserQuestion', args)
    const asked = vi.spyOn(asking.questions, 'requestAnswers').mockResolvedValue({ 0: 'a.ts' })
    await asking.service.chat({ threadId: 'thread-1', cwd: asking.home, model: 'sonnet', prompt: 'go', onText: noop })
    expect(asking.answers).toEqual([expect.objectContaining({ behavior: 'allow' })])
    expect(asked).toHaveBeenCalledOnce()
    asking.service.stop()
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

describe('Mousse tools that wait for the user', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })
  async function registry() {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-1')
    const fixture = fakeAppToolHost()
    const approve = vi.fn(async () => true)
    const quickActions = new QuickActionTools(approve, () => {})
    const { registry: tools, turns, request } = appToolRegistry(fx.engine, { ...fixture.host, quickActions })
    const call = (name: string, args: Record<string, unknown>, approvals?: 'never') => {
      turns.register(appTurn({ threadId: 'thread-1', runId: run.runId, ...(approvals ? { approvals } : {}) }))
      return tools.call(name, args, request({ threadId: 'thread-1', runId: run.runId }))
    }
    return { askUser: fixture.host.askUser, approve, call }
  }
  const question = { questions: [{ id: 'q1', prompt: 'Which file?', options: [{ id: 'a', label: 'a.ts' }, { id: 'b', label: 'b.ts' }] }] }
  const action = { label: 'Build', kind: 'bash', payload: 'npm run build' }

  it('are refused before they ask under `never`', async () => {
    const r = await registry()
    expect(await r.call('ask_user', question, 'never')).toEqual({ text: QUESTIONS_REFUSED_MESSAGE, isError: true })
    expect(await r.call('create_quick_action', action, 'never')).toEqual({ text: APPROVALS_REFUSED_MESSAGE, isError: true })
    expect(r.askUser).not.toHaveBeenCalled()
    expect(r.approve).not.toHaveBeenCalled()
    // A tool that does not wait for the user still runs.
    expect((await r.call('create_task', { description: 'fine' }, 'never')).isError).toBe(false)
  })

  it('still ask under `ask`', async () => {
    const r = await registry()
    expect(await r.call('ask_user', question)).toMatchObject({ isError: false })
    expect(await r.call('create_quick_action', action)).toMatchObject({ isError: false })
    expect(r.askUser).toHaveBeenCalledOnce()
    expect(r.approve).toHaveBeenCalledOnce()
  })
})

describe('an ACP session carries the turn prompter\'s approvals to client file writes', () => {
  async function writeThroughSession(prompter: PermissionPrompter) {
    const cwd = tempHome('mousse-never-acp-session-')
    const questions = new UserQuestionService()
    const asked = vi.spyOn(questions, 'requestAnswers').mockResolvedValue({ write: 'allow' })
    const agent = inProcessAgent((app: AgentApp) => {
      app
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'native-1' }))
        .onRequest(methods.agent.session.prompt, async (c) => {
          await c.client.request(methods.client.fs.writeTextFile, { sessionId: 'native-1', path: join(cwd, 'new.txt'), content: 'x' }).catch(() => undefined)
          return { stopReason: 'end_turn' as const }
        })
    })
    const saved = new Map<string, SavedAcpSession>()
    const sessions = new AcpSessions({
      label: 'Agent',
      defaultInstanceId: 'acp:fake',
      questions,
      connect: agent.connect,
      quirks: { ...NO_QUIRKS, clientFs: true },
      store: { saved: (id) => saved.get(id), setSaved: (id, value) => (value ? saved.set(id, value) : saved.delete(id)), models: () => [], setModels: noop },
      launchGeneration: () => 0,
      signInGeneration: () => 0,
      markSignedOut: noop,
      signInRequiredMessage: 'Sign in first'
    })
    try {
      await sessions.chat({ threadId: 'thread-1', cwd, model: 'default', prompt: 'write', onText: noop, prompter })
    } finally {
      sessions.stop()
    }
    return { asked, written: existsSync(join(cwd, 'new.txt')) }
  }

  it('refuses without asking under `never`', async () => {
    const { asked, written } = await writeThroughSession(refusingPrompter())
    expect(asked).not.toHaveBeenCalled()
    expect(written).toBe(false)
  })

  it('asks under `ask`', async () => {
    const { asked, written } = await writeThroughSession(questionsPrompter(new UserQuestionService()))
    expect(asked).toHaveBeenCalledOnce()
    expect(written).toBe(true)
  })
})

describe('Mousse tools that wait for the user are not offered under `never`', () => {
  it('the registry offers them only when the run may ask', () => {
    const fixture = fakeAppToolHost()
    const quickActions = new QuickActionTools(async () => true, () => {})
    const { registry: tools } = createAppToolRegistry({ host: { ...fixture.host, quickActions } })
    const offered = (approvals?: 'never') => tools.offeredFor({ ...appTurn({ threadId: 'thread-1', runId: 'run-1', ...(approvals ? { approvals } : {}) }), turnToken: '' } as AppToolTurn).map((tool) => tool.name)
    expect(offered()).toEqual(expect.arrayContaining(['ask_user', 'create_quick_action']))
    expect(offered('never')).not.toContain('ask_user')
    expect(offered('never')).not.toContain('create_quick_action')
    expect(offered('never')).toContain('create_task')
  })
})
