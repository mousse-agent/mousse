import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSubscriptionProviderService, claudeModelOptions } from '../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function fixture(
  query: (input: { options: Options; prompt: unknown }) => Query,
  loggedIn = true
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
      loginPolicy: 'cli',
      binaryPath: binary,
      models: [{ id: 'sonnet', label: 'Sonnet' }]
    })
  )
  const questions = new UserQuestionService()
  const runAuth = vi.fn(async () => JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none' }))
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
  it('exposes a subscription choice separate from Anthropic API keys', async () => {
    const { service } = fixture(() => fakeQuery())
    expect(service.loginOption()).toMatchObject({
      id: 'claude-subscription',
      label: 'Claude Subscription',
      authType: 'oauth'
    })
    await service.status()
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
  it('names Claude models with their version and drops a duplicate default', () => {
    const models = [
      { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
      { value: 'custom', displayName: 'Custom', description: 'model' }
    ]
    expect(claudeModelOptions(models).map((model) => [model.id, model.label])).toEqual([
      ['opus', 'Opus 5.5'],
      ['haiku', 'Haiku 4.5'],
      ['custom', 'Custom']
    ])
    expect(claudeModelOptions([{ ...models[0], resolvedModel: 'claude-sonnet-5-5' }])[0].label).toBe('Opus 5.5')
  })
  it('refuses a signed-out terminal without starting a turn', async () => {
    const query = vi.fn(() => fakeQuery([result]))
    const { service, home } = fixture(query, false)
    await expect(service.chat(chatInput(home))).rejects.toThrow(/claude auth login/)
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
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // Claude Code's own system prompt, as in a terminal.
      systemPrompt: { type: 'preset', preset: 'claude_code' }
    })
    // No settingSources: the SDK then loads the user, project and local settings like the CLI.
    // No strict-mcp-config: the user's own MCP servers load too.
    for (const input of inputs) {
      expect(input.options).not.toHaveProperty('settingSources')
      expect(input.options).not.toHaveProperty('extraArgs')
    }
    expect(JSON.stringify(settings())).not.toContain('secret')
  })
  it('resumes a saved session only on the instance that created it', async () => {
    const inputs: Array<{ options: Options; prompt: unknown }> = []
    const { service, home, settings } = fixture((input) => {
      inputs.push(input)
      return fakeQuery([result])
    })
    await service.chat({ ...chatInput(home), instanceId: 'claude' })
    expect(settings().sessions.thread).toMatchObject({ sessionId: 'vendor-session', instanceId: 'claude' })
    service.commitConversation('thread', 'history')
    // Another instance never resumes this instance's session.
    await service.chat({ ...chatInput(home), instanceId: 'claude-work', history: 'history' })
    expect(inputs[1].options.resume).toBeUndefined()
    expect(settings().sessions.thread.instanceId).toBe('claude-work')

    // A session saved before instances existed belongs to the default instance.
    const directory = join(home, 'providers', 'claude-subscription')
    const legacy = (session: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      writeFileSync(join(directory, 'settings.json'), JSON.stringify({ ...settings(), ...extra, sessions: { thread: session } }))
    const key = createHash('sha256').update('history').digest('hex')
    legacy({ sessionId: 'old-session', cwd: home, model: 'sonnet', historyKey: key })
    const reloaded = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      query: (input) => { inputs.push(input); return fakeQuery([result]) },
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    await reloaded.chat({ ...chatInput(home), history: 'history' })
    expect(inputs[2].options.resume).toBe('old-session')

    // A session from an older separate (profile-private) sign-in is never resumed.
    legacy({ sessionId: 'isolated-session', cwd: home, model: 'sonnet', historyKey: key, instanceId: 'claude' }, { loginPolicy: 'isolated' })
    const switched = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      query: (input) => { inputs.push(input); return fakeQuery([result]) },
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    await switched.chat({ ...chatInput(home), instanceId: 'claude', history: 'history' })
    expect(inputs[3].options.resume).toBeUndefined()
  })
  it("keeps the user's --append-system-prompt launch args by moving their text after Mousse's guidance", async () => {
    const inputs: Array<{ options: Options; prompt: unknown }> = []
    const { service, home } = fixture((input) => {
      inputs.push(input)
      return fakeQuery([result])
    })
    writeFileSync(join(home, 'extra.md'), 'FROM FILE\n')
    await service.setCliConfig({ args: ['--append-system-prompt', 'INLINE', '--append-system-prompt-file', 'extra.md', '--verbose'] })
    await service.chat({ ...chatInput(home), systemPromptAppend: 'GUIDE' })
    expect(inputs[0].options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'GUIDE\n\nFROM FILE\n\nINLINE' })
    // The SDK's append text replaces the CLI's, so the flags are not passed again.
    expect(inputs[0].options.extraArgs).toEqual({ verbose: null })
    await service.chat({ ...chatInput(home), threadId: 'plain' })
    expect(inputs[1].options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'FROM FILE\n\nINLINE' })

    // Values Claude Code would reject fail the turn with a clear message instead of disappearing.
    await service.setCliConfig({ args: ['--append-system-prompt-file', 'missing.md'] })
    await expect(service.chat({ ...chatInput(home), threadId: 'missing' })).rejects.toThrow(/could not read the --append-system-prompt-file/)
    await service.setCliConfig({ args: ['--append-system-prompt'] })
    await expect(service.chat({ ...chatInput(home), threadId: 'empty' })).rejects.toThrow(/--append-system-prompt launch argument has no text/)
    expect(inputs).toHaveLength(2)
  })
  it('lets ToolSearch load the Mousse tools without a prompt only when the Mousse server is attached', async () => {
    const decisions: unknown[] = []
    const { service, home, questions } = fixture((input) => {
      const q = fakeQuery()
      q[Symbol.asyncIterator] = async function* () {
        decisions.push(await input.options.canUseTool!('ToolSearch', { query: 'select:mcp__mousse__delegate_task' }, { signal: new AbortController().signal, toolUseID: 'tool' } as never))
        yield result as never
      }
      return q
    })
    const asked = vi.fn()
    questions.on('pending', ({ requestId }) => {
      asked()
      questions.submitAnswers(requestId, { permission: 'reject' })
    })
    await service.chat({ ...chatInput(home), mcp: { url: 'http://127.0.0.1:1/mcp', token: 't' } })
    expect(decisions[0]).toMatchObject({ behavior: 'allow' })
    expect(asked).not.toHaveBeenCalled()
    await service.chat(chatInput(home))
    expect(decisions[1]).toMatchObject({ behavior: 'deny' })
    expect(asked).toHaveBeenCalledOnce()
  })
  it('asks only for calls bypass mode escalates and keeps plan mode read-only without prompts', async () => {
    let decision: unknown
    let tool = 'Bash'
    const inputs: Options[] = []
    const { service, home, questions } = fixture((input) => {
      inputs.push(input.options)
      const q = fakeQuery()
      q[Symbol.asyncIterator] = async function* () {
        decision = await input.options.canUseTool!(tool, { command: 'rm file' }, {
          signal: new AbortController().signal,
          toolUseID: 'tool'
        } as never)
        yield result as never
      }
      return q
    })
    const asked = vi.fn()
    questions.on('pending', ({ requestId }) => {
      asked()
      questions.submitAnswers(requestId, { permission: 'reject' })
    })
    await service.chat(chatInput(home))
    expect(decision).toMatchObject({ behavior: 'deny' })
    expect(asked).toHaveBeenCalledOnce()
    await service.chat({ ...chatInput(home), mode: 'plan' })
    expect(decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('planning only')
    })
    tool = 'Read'
    await service.chat({ ...chatInput(home), mode: 'plan' })
    expect(decision).toMatchObject({ behavior: 'allow' })
    expect(asked).toHaveBeenCalledOnce()
    expect(inputs[2].permissionMode).toBe('plan')
    expect(inputs[2].allowDangerouslySkipPermissions).toBeUndefined()
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
    // Every sign-in check of the turn waits on the same pending answer.
    const pending = new Promise<string>((resolve) => {
      finish = resolve
    })
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      query: () => fakeQuery([result]),
      runAuth: () => pending
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
    expect(settings()).toMatchObject({ cliDisconnected: true, sessions: {} })
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
  it('resumes a steer when the SDK throws after the interrupted error result', async () => {
    const queries: Query[] = []
    const { service, home } = fixture(() => {
      const q = fakeQuery([result])
      if (!queries.length) {
        q[Symbol.asyncIterator] = async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'vendor-session' } as never
          await new Promise((resolve) => setTimeout(resolve, 120))
          yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['interrupted'], session_id: 'vendor-session' } as never
          throw new Error('Claude Code returned an error result: interrupted')
        }
      }
      queries.push(q)
      return q
    })
    const drainSteer = vi.fn().mockReturnValueOnce('new guidance').mockReturnValue(undefined)
    expect(await service.chat({ ...chatInput(home), drainSteer })).toBe('hello')
    expect(queries).toHaveLength(2)
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

it('forces host review of every call only in plan mode', async () => {
  const decisions: unknown[] = []
  const { service, home } = fixture(({ options }) => {
    const q = fakeQuery()
    q[Symbol.asyncIterator] = async function* () {
      decisions.push(
        await options.hooks!.PreToolUse![0].hooks[0](
          {
            hook_event_name: 'PreToolUse',
            tool_use_id: 'native-read',
            tool_name: 'Read',
            tool_input: { file_path: 'package.json' }
          } as never,
          'native-read',
          { signal: new AbortController().signal }
        )
      )
      yield result as never
    }
    return q
  })
  await service.chat(chatInput(home))
  await service.chat({ ...chatInput(home), mode: 'plan' })
  expect(decisions[0]).toEqual({})
  expect(decisions[1]).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } })
})

it('records successful official file edits only once without asking', async () => {
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
      ).toEqual({})
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
