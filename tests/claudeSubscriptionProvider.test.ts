import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClaudeSubscriptionProviderService,
  claudeSubscriptionEnvironment
} from '../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { LoginSession } from '../src/mms/providers/LoginSession'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function fixture(
  query: (input: { options: Options; prompt: unknown }) => Query,
  authMethod = 'claude.ai'
) {
  const home = mkdtempSync(join(tmpdir(), 'claude-subscription-test-'))
  homes.push(home)
  const binary = join(home, 'claude')
  writeFileSync(binary, 'fixture')
  chmodSync(binary, 0o755)
  const directory = join(home, 'providers', 'claude-subscription')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'settings.json'),
    JSON.stringify({
      signedIn: true,
      binaryPath: binary,
      models: [{ id: 'sonnet', label: 'Sonnet' }]
    })
  )
  const questions = new UserQuestionService()
  const runAuth = vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod }))
  const service = new ClaudeSubscriptionProviderService(home, questions, { query, runAuth })
  return {
    home,
    service,
    questions,
    runAuth,
    settings: () => JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'))
  }
}
function fakeQuery(events: unknown[] = []) {
  const generator = (async function* () {
    for (const event of events) yield event
  })()
  return Object.assign(generator, {
    close: vi.fn(),
    interrupt: vi.fn(async () => {}),
    supportedModels: vi.fn(async () => [
      { value: 'sonnet', displayName: 'Sonnet', description: 'model' }
    ])
  }) as unknown as Query
}
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'hello',
  session_id: 'vendor-session'
}
const chatInput = (cwd: string) => ({
  threadId: 'thread',
  cwd,
  model: 'sonnet',
  prompt: 'hello',
  onText: vi.fn()
})

describe('Claude Subscription native provider', () => {
  it('isolates API, router, token, cloud and nested CLI credentials', () => {
    const env = claudeSubscriptionEnvironment('/profile/claude', {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'secret',
      ANTHROPIC_AUTH_TOKEN: 'secret',
      ANTHROPIC_BASE_URL: 'router',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret',
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_PROFILE: 'other',
      GOOGLE_APPLICATION_CREDENTIALS: 'other',
      CLAUDECODE: '1',
      ELECTRON_RUN_AS_NODE: '1'
    })
    expect(env).toEqual({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/profile/claude' })
  })
  it('exposes a subscription choice separate from Anthropic API keys', () => {
    const { service } = fixture(() => fakeQuery())
    expect(service.loginOption()).toMatchObject({
      id: 'claude-subscription',
      label: 'Claude Subscription',
      authType: 'oauth'
    })
    expect(service.llmProvider()?.models[0].id).toBe('sonnet')
  })
  it('discovers vendor models without sending a prompt or allowing tools', async () => {
    let captured: { options: Options; prompt: unknown } | undefined
    const q = fakeQuery()
    const { service, home } = fixture((input) => {
      captured = input
      return q
    })
    await service.refreshModels(home)
    expect(typeof (captured!.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe(
      'function'
    )
    expect(captured!.options.tools).toEqual([])
    expect(q.supportedModels).toHaveBeenCalledOnce()
    expect(q.close).toHaveBeenCalledOnce()
    expect(service.llmProvider()?.models).toEqual([
      { id: 'sonnet', label: 'Sonnet', efforts: undefined }
    ])
  })
  it('refuses API-key auth without starting a paid turn', async () => {
    const query = vi.fn(() => fakeQuery([result]))
    const { service, home } = fixture(query, 'api_key')
    await expect(service.chat(chatInput(home))).rejects.toThrow(/sign-in expired/)
    expect(query).not.toHaveBeenCalled()
  })
  it('streams text/thinking/tools and only resumes committed matching history', async () => {
    const inputs: Array<{ options: Options; prompt: unknown }> = []
    const events = [
      {
        type: 'stream_event',
        session_id: 'vendor-session',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }
      },
      {
        type: 'stream_event',
        session_id: 'vendor-session',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'thinking' }
        }
      },
      {
        type: 'stream_event',
        session_id: 'vendor-session',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool1', name: 'Read' }
        }
      },
      result
    ]
    const { service, home, settings } = fixture((input) => {
      inputs.push(input)
      return fakeQuery(events)
    })
    const onThinking = vi.fn(),
      onTool = vi.fn()
    expect(await service.chat({ ...chatInput(home), onThinking, onTool })).toBe('hello')
    expect(onThinking).toHaveBeenCalledWith('thinking')
    expect(onTool).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'start', toolName: 'Read' })
    )
    expect(settings().sessions.thread.historyKey).toBeUndefined()
    service.commitConversation('thread', 'canonical history')
    await service.chat({ ...chatInput(home), history: 'canonical history' })
    expect(inputs[1].options.resume).toBe('vendor-session')
    service.commitConversation('thread', 'next history')
    await service.chat({ ...chatInput(home), history: 'edited history' })
    expect(inputs[2].options.resume).toBeUndefined()
    expect(inputs[0].options).toMatchObject({
      permissionMode: 'default',
      settingSources: [],
      extraArgs: { 'strict-mcp-config': null }
    })
    expect(JSON.stringify(settings())).not.toContain('secret')
  })
  it('asks for permission, rejects dismissal and denies writes in plan mode', async () => {
    let decision: unknown
    const { service, home, questions } = fixture((input) => {
      const q = fakeQuery()
      q[Symbol.asyncIterator] = async function* () {
        decision = await input.options.canUseTool!('Bash', { command: 'rm file' }, {
          signal: new AbortController().signal,
          toolUseID: 'tool'
        } as never)
        yield result as never
      }
      return q
    })
    questions.on('pending', ({ requestId }) =>
      questions.submitAnswers(requestId, { permission: 'reject' })
    )
    await service.chat(chatInput(home))
    expect(decision).toMatchObject({ behavior: 'deny' })
    await service.chat({ ...chatInput(home), mode: 'plan' })
    expect(decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('planning only')
    })
  })
  it('bridges Claude AskUserQuestion answers into vendor tool input', async () => {
    let decision: unknown
    const { service, home, questions } = fixture((input) => {
      const q = fakeQuery()
      q[Symbol.asyncIterator] = async function* () {
        decision = await input.options.canUseTool!(
          'AskUserQuestion',
          { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
          { signal: new AbortController().signal } as never
        )
        yield result as never
      }
      return q
    })
    questions.on('pending', ({ requestId }) => questions.submitAnswers(requestId, { '0': 'Yes' }))
    await service.chat(chatInput(home))
    expect(decision).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Continue?': 'Yes' } }
    })
  })
  it('cancels automatic vendor login without saving Claude credentials', async () => {
    const { home, service: initial } = fixture(() => fakeQuery())
    const settingsPath = join(home, 'providers', 'claude-subscription', 'settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    settings.signedIn = false
    writeFileSync(settingsPath, JSON.stringify(settings))
    initial.stop()
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    const startLogin = vi.fn(() => child as never)
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      runAuth: async () => '{}',
      startLogin
    })
    const session = new LoginSession('login')
    session.on('event', (event) => {
      if (event.type === 'select') session.abort.abort()
    })
    expect((await service.login(session, home)).success).toBe(false)
    expect(startLogin).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalled()
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).signedIn).toBe(false)
  })
  it('refuses unsupported image formats explicitly', async () => {
    const query = vi.fn(() => fakeQuery([result]))
    const { service, home } = fixture(query)
    await expect(
      service.chat({
        ...chatInput(home),
        images: [{ name: 'bitmap', mimeType: 'image/bmp', data: 'AA==' }]
      })
    ).rejects.toThrow(/Unsupported Claude image/)
    expect(query).not.toHaveBeenCalled()
  })
  it('prevents concurrent same-thread turns even while authentication is pending', async () => {
    const { home } = fixture(() => fakeQuery())
    let finish!: (value: string) => void
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      query: () => fakeQuery([result]),
      runAuth: () =>
        new Promise((resolve) => {
          finish = resolve
        })
    })
    const first = service.chat(chatInput(home))
    await expect(service.chat(chatInput(home))).rejects.toThrow(/already running/)
    finish(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    await first
  })
  it('does not persist successful-looking sessions after stop', async () => {
    const { service, home, settings } = fixture(() => {
      const q = fakeQuery()
      q[Symbol.asyncIterator] = async function* () {
        service.stop()
        yield result as never
      }
      return q
    })
    await expect(service.chat(chatInput(home))).rejects.toThrow()
    expect(settings().sessions).toBeUndefined()
  })
  it('cancels a pending permission question on turn abort', async () => {
    const controller = new AbortController()
    let decision: unknown
    const { service, home, questions } = fixture((input) => {
      const q = fakeQuery()
      q[Symbol.asyncIterator] = async function* () {
        decision = await input.options.canUseTool!('Bash', { command: 'touch file' }, {
          signal: controller.signal
        } as never)
        yield result as never
      }
      return q
    })
    questions.on('pending', () => controller.abort())
    await expect(service.chat({ ...chatInput(home), signal: controller.signal })).rejects.toThrow()
    expect(decision).toMatchObject({ behavior: 'deny' })
    expect(questions.listAllPending()).toEqual([])
  })

  it('fences a late authentication response after stop', async () => {
    const { home, settings } = fixture(() => fakeQuery())
    let finish!: (value: string) => void
    const query = vi.fn(() => fakeQuery([result]))
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      query,
      runAuth: () =>
        new Promise((resolve) => {
          finish = resolve
        })
    })
    const turn = service.chat(chatInput(home))
    service.stop()
    finish(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    await expect(turn).rejects.toThrow()
    expect(query).not.toHaveBeenCalled()
    expect(settings().sessions).toBeUndefined()
  })
  it('disconnects and dismisses pending permissions during logout', async () => {
    const { service, home, questions, settings } = fixture((input) => {
      const q = fakeQuery()
      q[Symbol.asyncIterator] = async function* () {
        await input.options.canUseTool!('Bash', { command: 'touch file' }, {
          signal: new AbortController().signal
        } as never)
        yield result as never
      }
      return q
    })
    let loggedOut!: Promise<void>
    questions.on('pending', () => {
      loggedOut = service.logout()
    })
    await expect(service.chat(chatInput(home))).rejects.toThrow()
    await loggedOut
    expect(questions.listAllPending()).toEqual([])
    expect(settings()).toMatchObject({ signedIn: false, sessions: {} })
  })
  it('interrupts and resumes steering exactly once without replaying the original request', async () => {
    const captured: Array<{ options: Options; prompt: unknown }> = []
    const queries: Query[] = []
    const { service, home } = fixture((input) => {
      captured.push({ options: { ...input.options }, prompt: input.prompt })
      const q = fakeQuery([result])
      if (!queries.length) {
        q[Symbol.asyncIterator] = async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'vendor-session' } as never
          await new Promise((resolve) => setTimeout(resolve, 120))
          yield result as never
        }
      }
      queries.push(q)
      return q
    })
    const onSteer = vi.fn()
    const drainSteer = vi.fn().mockReturnValueOnce('new guidance').mockReturnValue(undefined)
    expect(await service.chat({ ...chatInput(home), drainSteer, onSteer })).toBe('hello\n\nhello')
    expect(onSteer).toHaveBeenCalledExactlyOnceWith('new guidance')
    expect(queries[0].interrupt).toHaveBeenCalledOnce()
    expect(captured[1].options.resume).toBe('vendor-session')
    const messages = []
    for await (const message of captured[1].prompt as AsyncIterable<{
      message: { content: string }
    }>)
      messages.push(message)
    expect(messages[0].message.content).toBe('new guidance')
  })
  it('keeps nested agent text and thinking out of the main reply', async () => {
    const { service, home } = fixture(() => fakeQuery([
      { type: 'stream_event', parent_tool_use_id: 'nested', session_id: 'vendor-session', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'nested secret answer' } } },
      { type: 'stream_event', parent_tool_use_id: 'nested', session_id: 'vendor-session', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'nested thinking' } } },
      result
    ]))
    const onThinking = vi.fn()
    expect(await service.chat({ ...chatInput(home), onThinking })).toBe('hello')
    expect(onThinking).not.toHaveBeenCalled()
  })

})

it.each(['low', 'medium', 'high', 'xhigh', 'max'])('passes %s effort separately from the Claude model alias', async (effort) => {
  const captured: Options[] = []
  const { service, home } = fixture(({ options }) => { captured.push(options); return fakeQuery([result]) })
  await service.chat({ ...chatInput(home), model: `opus:${effort}` })
  expect(captured[0]).toMatchObject({ model: 'opus', effort })
})

it('keeps standalone workspaces profile-owned even for non-path thread IDs', () => {
  const { service, home } = fixture(() => fakeQuery())
  const path = service.standaloneWorkspace('../../outside')
  expect(path).toMatch(new RegExp('/workspaces/[a-f0-9]{64}$'))
  expect(path.startsWith(home)).toBe(true)
  expect(service.standaloneWorkspace('../../outside')).toBe(path)
})

const measuredResult = (input = 10, output = 5, cost = 0.1, uuid = 'usage-result') => ({
  ...result,
  uuid,
  total_cost_usd: cost,
  usage: {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 1
  },
  modelUsage: {
    'claude-sonnet-4-6': {
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 1,
      costUSD: cost,
      contextWindow: 200000
    }
  }
})

it('reports measured usage once, persists baselines and subtracts them after daemon restart', async () => {
  const { service, home, settings, runAuth } = fixture(() => fakeQuery([measuredResult()]))
  const first = vi.fn()
  await service.chat({ ...chatInput(home), onMetrics: first })
  service.commitConversation('thread', 'canonical')
  expect(first).toHaveBeenCalledOnce()
  expect(first.mock.calls[0][0].usage).toMatchObject({ input: 10, output: 5, cost: { total: 0.1 } })
  expect(settings().sessions.thread.usageBaseline.sessionId).toBe('vendor-session')
  const restarted = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
    runAuth,
    query: () => fakeQuery([measuredResult(14, 7, 0.15, 'next-result')])
  })
  const second = vi.fn()
  await restarted.chat({ ...chatInput(home), history: 'canonical', onMetrics: second })
  expect(second).toHaveBeenCalledOnce()
  expect(second.mock.calls[0][0].usage).toMatchObject({
    input: 4,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { total: expect.closeTo(0.05) }
  })
})

it('reports available SDK usage on failure and caller abort without committing history', async () => {
  const failed = fixture(() =>
    fakeQuery([
      { ...measuredResult(), subtype: 'error_during_execution', is_error: true, errors: ['failed'] }
    ])
  )
  const onFailure = vi.fn()
  await expect(
    failed.service.chat({ ...chatInput(failed.home), onMetrics: onFailure })
  ).rejects.toThrow('failed')
  expect(onFailure).toHaveBeenCalledOnce()
  expect(onFailure.mock.calls[0][0].usage.input).toBe(10)
  expect(failed.settings().sessions.thread.historyKey).toBeUndefined()
  const controller = new AbortController()
  const aborted = fixture(() => {
    const q = fakeQuery()
    q[Symbol.asyncIterator] = async function* () {
      controller.abort()
      yield measuredResult() as never
    }
    return q
  })
  const onAbort = vi.fn()
  await expect(
    aborted.service.chat({
      ...chatInput(aborted.home),
      signal: controller.signal,
      onMetrics: onAbort
    })
  ).rejects.toThrow()
  expect(onAbort).toHaveBeenCalledOnce()
  expect(onAbort.mock.calls[0][0].usage.input).toBe(10)
  expect(aborted.settings().sessions.thread.historyKey).toBeUndefined()
})

it('keeps ask permissions while recording successful official file edits only once', async () => {
  const { service, home } = fixture(({ options }) => {
    const q = fakeQuery()
    q[Symbol.asyncIterator] = async function* () {
      const pre = options.hooks!.PreToolUse![0].hooks[0]
      const post = options.hooks!.PostToolUse![0].hooks[0]
      const event = {
        hook_event_name: 'PreToolUse',
        tool_use_id: 'native-write',
        tool_name: 'Write',
        tool_input: { file_path: 'written' }
      }
      expect(
        await pre(event as never, 'native-write', { signal: new AbortController().signal })
      ).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } })
      writeFileSync(join(home, 'written'), 'one\ntwo')
      await post({ ...event, hook_event_name: 'PostToolUse' } as never, 'native-write', {
        signal: new AbortController().signal
      })
      await post({ ...event, hook_event_name: 'PostToolUse' } as never, 'native-write', {
        signal: new AbortController().signal
      })
      yield result as never
    }
    return q
  })
  const onLineEdits = vi.fn()
  await service.chat({ ...chatInput(home), onLineEdits })
  expect(onLineEdits).toHaveBeenCalledExactlyOnceWith(2)
})


it('starts a fresh Claude session with canonical history when the model changes', async () => {
  const inputs: Array<{ options: Options; prompt: unknown }> = []
  const { service, home } = fixture((input) => { inputs.push(input); return fakeQuery([result]) })
  await service.chat(chatInput(home))
  service.commitConversation('thread', 'full canonical history')
  await service.chat({ ...chatInput(home), model: 'opus:medium', history: 'full canonical history' })
  expect(inputs[1].options.resume).toBeUndefined()
  const prompt: unknown[] = []
  for await (const message of inputs[1].prompt as AsyncIterable<unknown>) prompt.push(message)
  expect(JSON.stringify(prompt)).toContain('full canonical history')
  expect(inputs[1].options.model).toBe('opus')
  service.commitConversation('thread', 'next history')
  await service.chat({ ...chatInput(home), model: 'opus:high', history: 'next history' })
  expect(inputs[2].options.resume).toBe('vendor-session')
})

it('reports the vendor OAuth refresh lock as recoverable without committing a session', async () => {
  const { service, home, settings } = fixture(() => fakeQuery([{
    ...result, subtype: 'error_during_execution', is_error: true,
    errors: ['Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh.']
  }]))
  await expect(service.chat(chatInput(home))).rejects.toMatchObject({
    code: 'claude_subscription_auth_refresh_busy', errorInfo: { category: 'unavailable', retryable: true }
  })
  expect(settings().sessions?.thread).toBeUndefined()
})
