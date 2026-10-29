import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSubscriptionProviderService, claudeModelOptions } from '../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { ProfileDatabase } from '../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../src/mms/run/EffectOutbox'
import { RunEngine } from '../src/mms/run/RunEngine'
import { RunStore } from '../src/mms/run/RunStore'
import { readUsageLimit } from '../src/mms/orchestrator/providerErrors'

const homes: string[] = []
beforeEach(() => {
  // The user's own Claude settings (which may forbid bypassing permissions) must not reach a test.
  const claudeHome = mkdtempSync(join(tmpdir(), 'claude-config-test-'))
  homes.push(claudeHome)
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome)
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function fixture(
  query: (input: { options: Options; prompt: unknown }) => Query,
  loggedIn = true,
  usageLimitHoldMs?: number
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
  let launch: { binaryPath?: string; args?: string[]; env?: Record<string, string> } = { binaryPath: binary }
  const service = new ClaudeSubscriptionProviderService(home, questions, { query, runAuth, live: false, usageLimitHoldMs, launchConfig: () => launch })
  return {
    home,
    service,
    questions,
    runAuth,
    setLaunch: (next: { args?: string[]; env?: Record<string, string> }) => { launch = { binaryPath: binary, ...next } },
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
const chatInput = (cwd: string, permissionMode: 'ask' | 'accept_edits' | 'auto' | 'full' = 'full') => ({
  threadId: 'thread',
  cwd,
  model: 'sonnet',
  prompt: 'hello',
  permissionMode,
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
  it('records the call and the result of a Mousse subagent tool, and nothing of other tools', async () => {
    const start = (id: string, name: string) => ({ type: 'stream_event', session_id: 'vendor-session', event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name } } })
    const events = [
      start('sub1', 'mcp__mousse__delegate_task'),
      start('sub2', 'mcp__mousse__delegate_task'),
      start('read1', 'Read'),
      {
        type: 'assistant',
        session_id: 'vendor-session',
        message: {
          content: [
            { type: 'tool_use', id: 'sub1', name: 'mcp__mousse__delegate_task', input: { title: 'API reviewer', prompt: 'SECRET PROMPT TEXT', workspace: 'shared' } },
            { type: 'tool_use', id: 'sub2', name: 'mcp__mousse__delegate_task', input: { title: 'Docs', prompt: 'x', workspace: 'shared' } },
            { type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: 'a.ts' } }
          ]
        }
      },
      {
        type: 'user',
        session_id: 'vendor-session',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'sub2', content: [{ type: 'text', text: JSON.stringify({ delegationId: 'd2', childThreadId: 't2', childRunId: 'r2', title: 'Docs', note: 'Started. LONG NOTE' }) }] },
            { type: 'tool_result', tool_use_id: 'sub1', content: JSON.stringify({ started: false, code: 'title_taken', message: 'You already have a subagent titled "API reviewer".', existing: [{ childThreadId: 'x' }] }) },
            { type: 'tool_result', tool_use_id: 'read1', content: 'file contents' }
          ]
        }
      },
      result
    ]
    const { service, home } = fixture(() => fakeQuery(events))
    const onTool = vi.fn()
    await service.chat({ ...chatInput(home), onTool })
    const complete = (callId: string) => onTool.mock.calls.map(([event]) => event).find((event) => event.phase === 'complete' && event.callId === callId)
    // Every subagent row is marked as recorded from the first start, and repeats its start once the arguments are known.
    const starts = (callId: string) => onTool.mock.calls.map(([event]) => event).filter((event) => event.phase === 'start' && event.callId === callId)
    expect(starts('sub1').map((event) => event.record?.input)).toEqual([{ recordVersion: 1 }, { recordVersion: 1, title: 'API reviewer' }])
    expect(starts('sub2').map((event) => event.record?.input)).toEqual([{ recordVersion: 1 }, { recordVersion: 1, title: 'Docs' }])
    // Another tool repeats its start with the typed fields its arguments carry.
    expect(starts('read1')).toEqual([
      { phase: 'start', callId: 'read1', title: 'Read', toolName: 'Read' },
      { phase: 'start', callId: 'read1', title: 'Read', toolName: 'Read', activity: { kind: 'generic', input: { file_path: 'a.ts' } } }
    ])
    // A Mousse subagent tool keeps its bounded record only: nothing typed is derived from its arguments.
    for (const callId of ['sub1', 'sub2']) {
      const events = onTool.mock.calls.map(([event]) => event).filter((event) => event.callId === callId)
      expect(events.some((event) => event.activity)).toBe(false)
    }
    expect(complete('sub2').record).toEqual({
      input: { recordVersion: 1, title: 'Docs' },
      response: JSON.stringify({ delegationId: 'd2', childThreadId: 't2', title: 'Docs' }),
      failed: false
    })
    const refused = complete('sub1').record
    expect(refused.input).toEqual({ recordVersion: 1, title: 'API reviewer' })
    expect(JSON.parse(refused.response)).toEqual({ started: false, code: 'title_taken', message: 'You already have a subagent titled "API reviewer".' })
    expect(JSON.stringify(onTool.mock.calls)).not.toContain('SECRET PROMPT TEXT')
    expect(complete('read1')).toEqual({ phase: 'complete', callId: 'read1', title: 'Read', toolName: 'Read', activity: { kind: 'generic' } })
  })

  it('streams text/thinking/tools and only resumes committed matching history', async () => {
    const inputs: Array<{ options: Options; prompt: unknown }> = []
    const events = [
      {
        type: 'stream_event',
        session_id: 'vendor-session',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }
      },
      // A thinking block whose text is omitted streams an empty delta first: no thought to show.
      {
        type: 'stream_event',
        session_id: 'vendor-session',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: '' }
        }
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
    expect(onThinking.mock.calls).toEqual([['thinking']])
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
    // A headless Claude Code streams thinking text only when the session asks for a display.
    for (const input of inputs) {
      expect(input.options).not.toHaveProperty('settingSources')
      expect(input.options.extraArgs).toEqual({ 'thinking-display': 'summarized' })
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
      launchConfig: () => ({ binaryPath: join(home, 'claude') }),
      live: false,
      query: (input) => { inputs.push(input); return fakeQuery([result]) },
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    await reloaded.chat({ ...chatInput(home), history: 'history' })
    expect(inputs[2].options.resume).toBe('old-session')

    // A session from an older separate (profile-private) sign-in is never resumed.
    legacy({ sessionId: 'isolated-session', cwd: home, model: 'sonnet', historyKey: key, instanceId: 'claude' }, { loginPolicy: 'isolated' })
    const switched = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      launchConfig: () => ({ binaryPath: join(home, 'claude') }),
      live: false,
      query: (input) => { inputs.push(input); return fakeQuery([result]) },
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    await switched.chat({ ...chatInput(home), instanceId: 'claude', history: 'history' })
    expect(inputs[3].options.resume).toBeUndefined()
  })
  describe('a stopped turn keeps its native session (issue #142)', () => {
    /** Turn 1 completes; turn 2 is stopped after `yielded` messages; the result is what turn 3 resumes. */
    const stoppedThenContinued = async (yielded: number) => {
      const inputs: Array<{ options: Options; prompt: unknown }> = []
      const stop = new AbortController()
      const { service, home } = fixture((input) => {
        inputs.push(input)
        if (inputs.length !== 2) return fakeQuery([result])
        const events = (async function* () {
          if (yielded > 0) yield { type: 'stream_event', session_id: 'vendor-session', parent_tool_use_id: null, event: { type: 'message_start' } }
          stop.abort()
          yield { type: 'stream_event', session_id: 'vendor-session', parent_tool_use_id: null, event: { type: 'message_stop' } }
        })()
        return Object.assign(events, { close: vi.fn(), interrupt: vi.fn(async () => {}) }) as unknown as Query
      })
      await service.chat({ ...chatInput(home), history: '' })
      service.commitConversation('thread', 'H1')
      await expect(service.chat({ ...chatInput(home), history: 'H1', signal: stop.signal })).rejects.toThrow()
      // The adapter fingerprints the history as the stopped turn left it: H1 and the stopped request.
      service.commitInterrupted('thread', 'H1 + stopped request')
      await service.chat({ ...chatInput(home), history: 'H1 + stopped request' })
      return inputs
    }

    it('resumes the same session on the next turn', async () => {
      const inputs = await stoppedThenContinued(1)
      expect(inputs[1].options.resume).toBe('vendor-session')
      expect(inputs[2].options.resume).toBe('vendor-session')
    })

    it('starts fresh when the stop came before the SDK had a session', async () => {
      const inputs = await stoppedThenContinued(0)
      expect(inputs[2].options.resume).toBeUndefined()
    })

    it('does not resume when the history changed since the stop', async () => {
      const inputs: Array<{ options: Options; prompt: unknown }> = []
      const stop = new AbortController()
      const { service, home } = fixture((input) => {
        inputs.push(input)
        if (inputs.length !== 1) return fakeQuery([result])
        const events = (async function* () {
          yield { type: 'stream_event', session_id: 'vendor-session', parent_tool_use_id: null, event: { type: 'message_start' } }
          stop.abort()
          yield { type: 'stream_event', session_id: 'vendor-session', parent_tool_use_id: null, event: { type: 'message_stop' } }
        })()
        return Object.assign(events, { close: vi.fn(), interrupt: vi.fn(async () => {}) }) as unknown as Query
      })
      await expect(service.chat({ ...chatInput(home), signal: stop.signal })).rejects.toThrow()
      service.commitInterrupted('thread', 'what the stopped turn left')
      await service.chat({ ...chatInput(home), history: 'something else' })
      expect(inputs[1].options.resume).toBeUndefined()
    })
  })
  it("keeps the user's --append-system-prompt launch args by moving their text after Mousse's guidance", async () => {
    const inputs: Array<{ options: Options; prompt: unknown }> = []
    const { service, home, setLaunch } = fixture((input) => {
      inputs.push(input)
      return fakeQuery([result])
    })
    writeFileSync(join(home, 'extra.md'), 'FROM FILE\n')
    setLaunch({ args: ['--append-system-prompt', 'INLINE', '--append-system-prompt-file', 'extra.md', '--verbose'] })
    await service.chat({ ...chatInput(home), systemPromptAppend: 'GUIDE' })
    expect(inputs[0].options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'GUIDE\n\nFROM FILE\n\nINLINE' })
    // The SDK's append text replaces the CLI's, so the flags are not passed again.
    expect(inputs[0].options.extraArgs).toEqual({ 'thinking-display': 'summarized', verbose: null })
    await service.chat({ ...chatInput(home), threadId: 'plain' })
    expect(inputs[1].options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'FROM FILE\n\nINLINE' })

    // Values Claude Code would reject fail the turn with a clear message instead of disappearing.
    setLaunch({ args: ['--append-system-prompt-file', 'missing.md'] })
    await expect(service.chat({ ...chatInput(home), threadId: 'missing' })).rejects.toThrow(/could not read the --append-system-prompt-file/)
    setLaunch({ args: ['--append-system-prompt'] })
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
      questions.submitAnswers(requestId, { permission: 'reject' }, { kind: 'user' })
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
      questions.submitAnswers(requestId, { permission: 'reject' }, { kind: 'user' })
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
  describe('permission modes', () => {
    /** Runs one turn in `mode`, probing `tools` through the hook and `canUseTool`; every prompt is rejected. */
    async function probe(mode: 'ask' | 'accept_edits' | 'auto' | 'full', tools: string[], cwd?: string) {
      const hooks: Record<string, string> = {}
      const decisions: Record<string, string> = {}
      const options: Options[] = []
      const { service, home, questions } = fixture((input) => {
        options.push(input.options)
        const q = fakeQuery()
        q[Symbol.asyncIterator] = async function* () {
          for (const tool of tools) {
            const output = await input.options.hooks!.PreToolUse![0].hooks[0](
              { hook_event_name: 'PreToolUse', tool_use_id: tool, tool_name: tool, tool_input: { command: 'ls' } } as never, tool, { signal: new AbortController().signal }
            ) as { hookSpecificOutput?: { permissionDecision?: string } }
            hooks[tool] = output.hookSpecificOutput?.permissionDecision ?? 'none'
            decisions[tool] = (await input.options.canUseTool!(tool, { command: 'ls' }, { signal: new AbortController().signal } as never)).behavior
          }
          yield result as never
        }
        return q
      })
      const prompts: Array<{ prompt: string; threadId: string }> = []
      questions.on('pending', ({ requestId, threadId, questions: asked }) => {
        prompts.push({ prompt: asked[0].prompt, threadId })
        questions.submitAnswers(requestId, { permission: 'reject' }, { kind: 'user' })
      })
      if (cwd) mkdirSync(join(home, cwd), { recursive: true })
      await service.chat(chatInput(cwd ? join(home, cwd) : home, mode))
      return { hooks, decisions, options: options[0], prompts, home }
    }

    it('maps the thread mode to Claude Code\'s own mode', async () => {
      expect((await probe('ask', [])).options).toMatchObject({ permissionMode: 'default' })
      expect((await probe('accept_edits', [])).options).toMatchObject({ permissionMode: 'acceptEdits' })
      expect((await probe('full', [])).options).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })
      // Under Ask and Auto-accept edits a one-shot query never asks for the bypass flag.
      expect((await probe('ask', [])).options).not.toHaveProperty('allowDangerouslySkipPermissions')
      expect((await probe('accept_edits', [])).options).not.toHaveProperty('allowDangerouslySkipPermissions')
    })

    it('makes the hook ask for Bash and PowerShell under Ask and Auto-accept edits, and for edits only under Ask', async () => {
      const commands = ['Bash', 'PowerShell']
      const edits = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
      const others = ['Read', 'WebFetch', 'mcp__srv__tool']
      const ask = (await probe('ask', [...commands, ...edits, ...others])).hooks
      for (const tool of [...commands, ...edits]) expect(ask[tool], tool).toBe('ask')
      for (const tool of others) expect(ask[tool], tool).toBe('none')
      const accept = (await probe('accept_edits', [...commands, ...edits, ...others])).hooks
      for (const tool of commands) expect(accept[tool], tool).toBe('ask')
      for (const tool of [...edits, ...others]) expect(accept[tool], tool).toBe('none')
      const full = (await probe('full', [...commands, ...edits])).hooks
      for (const tool of [...commands, ...edits]) expect(full[tool], tool).toBe('none')
    })

    it('runs Auto in Claude Code\'s auto mode: edits go ahead, its classifier decides commands, and what it cannot decide asks the user', async () => {
      const commands = ['Bash', 'PowerShell']
      const edits = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
      const auto = await probe('auto', [...commands, ...edits, 'Read'])
      expect(auto.options).toMatchObject({ permissionMode: 'auto' })
      // A one-shot query in Auto never asks for the bypass flag.
      expect(auto.options).not.toHaveProperty('allowDangerouslySkipPermissions')
      // Mousse's hook leaves commands to the classifier instead of asking first, as it does under Auto-accept edits.
      for (const tool of [...commands, ...edits, 'Read']) expect(auto.hooks[tool], tool).toBe('none')
      // A command the classifier sends on to canUseTool is the user's to answer.
      expect(auto.decisions).toMatchObject({ Bash: 'deny', PowerShell: 'deny', Read: 'allow' })
      expect(auto.prompts.map((entry) => entry.prompt.split('\n')[0])).toContain('Allow Claude Code to run a command (Bash)?')
    })

    it('runs Auto as Auto-accept edits when Claude Code settings turn auto mode off', async () => {
      const home = mkdtempSync(join(tmpdir(), 'claude-auto-off-'))
      homes.push(home)
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ disableAutoMode: 'disable' }))
      const seen: Options[] = []
      const { service } = fixture((input) => { seen.push(input.options); return fakeQuery([result]) })
      await service.chat(chatInput(home, 'auto'))
      expect(seen[0]).toMatchObject({ permissionMode: 'acceptEdits' })
      expect(service.permissionLimits(home)).toEqual({ unavailable: { auto: 'Claude Code settings turn auto mode off' } })
    })

    it('lets read-only built-ins through without asking, and names the action class when it asks', async () => {
      const { decisions, prompts } = await probe('ask', ['Read', 'Glob', 'Bash', 'Edit', 'WebSearch', 'mcp__srv__tool'])
      expect(decisions).toMatchObject({ Read: 'allow', Glob: 'allow', WebSearch: 'allow', Bash: 'deny', Edit: 'deny', mcp__srv__tool: 'deny' })
      expect(prompts.map((entry) => entry.prompt.split('\n')[0])).toEqual([
        'Allow Claude Code to run a command (Bash)?',
        'Allow Claude Code to edit files (Edit)?',
        'Allow Claude Code to use mcp__srv__tool?'
      ])
    })

    it('says a call that still reaches the prompt under Full access is Claude Code\'s own safety check', async () => {
      const { prompts } = await probe('full', ['Bash'])
      expect(prompts[0].prompt).toMatch(/^Claude Code asks even in Full access: its own safety check\./)
    })

    describe('"Always for this thread"', () => {
      /** Binds the question service to a Run Engine that runs the test's thread (`thread`) as a profile does. */
      async function bind(questions: UserQuestionService, initialMode: 'ask' | 'accept_edits' | 'full', initialApprovals: 'ask' | 'grants') {
        /** What the run's binding says; a test changes it between turns, as a mode change does. */
        const state = { permissionMode: initialMode, approvals: initialApprovals }
        const profileHome = mkdtempSync(join(tmpdir(), 'claude-approvals-'))
        homes.push(profileHome)
        const db = new ProfileDatabase({ profileHome })
        const store = new RunStore(db)
        const engine = new RunEngine({ store, pid: 1, outbox: new EffectOutbox(store) })
        engine.reconcileOnBoot()
        questions.setApprovalStore({
          store: engine.approvals,
          context: (threadId) => {
            const run = engine.getActiveRun(threadId)
            return run ? { runId: run.runId, instanceId: 'claude-subscription', provider: 'claude', origin: 'interactive', ...state, startedByPerson: true } : null
          },
          effectDelivery: () => false,
          continuationDue: () => undefined
        })
        const sent = await engine.dispatch({ kind: 'send', threadId: 'thread', clientRequestId: 'claude-run', source: 'gui' })
        if (sent.status !== 'accepted') throw new Error('send rejected')
        engine.markStarting(sent.runId)
        engine.markRunning(sent.runId)
        return { engine, state, close: () => db.close() }
      }

      it('is offered on a Bash prompt, answers the same command again, and still asks for another command or another shell', async () => {
        const decisions: Array<[string, string]> = []
        const { service, home, questions } = fixture((input) => {
          const q = fakeQuery()
          q[Symbol.asyncIterator] = async function* () {
            const ask = async (tool: string, command: string) => {
              decisions.push([`${tool}: ${command}`, (await input.options.canUseTool!(tool, { command }, { signal: new AbortController().signal } as never)).behavior])
            }
            await ask('Bash', 'npm test')
            await ask('Bash', 'npm test')
            await ask('Bash', 'npm test --watch')
            await ask('PowerShell', 'npm test')
            yield result as never
          }
          return q
        })
        const { engine, close } = await bind(questions, 'accept_edits', 'ask')
        try {
          const prompts: Array<{ prompt: string; options: string[] }> = []
          questions.on('pending', ({ requestId, questions: asked }) => {
            prompts.push({ prompt: asked[0].prompt, options: asked[0].options.map((option) => option.id) })
            const always = asked[0].prompt.includes('(Bash)') && asked[0].prompt.endsWith('{"command":"npm test"}')
            questions.submitAnswers(requestId, { permission: always ? 'allow_always' : 'reject' }, { kind: 'user' })
          })
          await service.chat(chatInput(home, 'accept_edits'))
          expect(decisions).toEqual([
            ['Bash: npm test', 'allow'],
            ['Bash: npm test', 'allow'],
            ['Bash: npm test --watch', 'deny'],
            ['PowerShell: npm test', 'deny']
          ])
          // The repeat was answered by the rule: three prompts for four calls, each offering "always".
          expect(prompts).toHaveLength(3)
          expect(prompts.every((entry) => entry.options.join() === 'allow,allow_always,reject')).toBe(true)
          expect(engine.approvals.listRules('thread')).toEqual([expect.objectContaining({ permissionKey: 'claude:command', grantedUnder: 'accept_edits' })])
        } finally {
          close()
        }
      })

      it('offers no "always", in any mode, on an ask Claude Code says must not be remembered, and a rule never answers it', async () => {
        const decisions: string[] = []
        const flags: Array<Record<string, unknown>> = [
          {}, { suppressAlwaysAllowRule: true }, { blockedPath: '/etc/passwd' }, { decisionReason: 'Path is outside the allowed folders' },
          { matchedAskRule: { source: 'userSettings', toolName: 'Bash' } }, {}
        ]
        const { service, home, questions } = fixture((input) => {
          const q = fakeQuery()
          q[Symbol.asyncIterator] = async function* () {
            for (const extra of flags)
              decisions.push((await input.options.canUseTool!('Bash', { command: 'npm test' }, { signal: new AbortController().signal, ...extra } as never)).behavior)
            yield result as never
          }
          return q
        })
        const { engine, close } = await bind(questions, 'accept_edits', 'ask')
        try {
          const prompts: Array<{ options: string[]; reason?: string }> = []
          let first = true
          questions.on('pending', ({ requestId, questions: asked, approval }) => {
            prompts.push({ options: asked[0].options.map((option) => option.id), ...(approval?.reason ? { reason: approval.reason } : {}) })
            // "Always" to the first, plain request only.
            questions.submitAnswers(requestId, { permission: first ? 'allow_always' : 'reject' }, { kind: 'user' })
            first = false
          })
          await service.chat(chatInput(home, 'accept_edits'))
          // Plain, four flagged (asked, no "always"), plain again (answered by the rule).
          expect(decisions).toEqual(['allow', 'deny', 'deny', 'deny', 'deny', 'allow'])
          expect(prompts.map((entry) => entry.options.join())).toEqual(['allow,allow_always,reject', 'allow,reject', 'allow,reject', 'allow,reject', 'allow,reject'])
          expect(prompts[3]!.reason).toContain('Path is outside the allowed folders')
          expect(engine.approvals.listRules('thread')).toHaveLength(1)
        } finally {
          close()
        }
      })

      it('offers no "always" on Claude Code\'s own safety prompt under Full access, and a rule made under Ask does not answer it', async () => {
        const decisions: string[] = []
        const { service, home, questions } = fixture((input) => {
          const q = fakeQuery()
          q[Symbol.asyncIterator] = async function* () {
            decisions.push((await input.options.canUseTool!('Bash', { command: 'npm test' }, { signal: new AbortController().signal } as never)).behavior)
            yield result as never
          }
          return q
        })
        const { engine, state, close } = await bind(questions, 'ask', 'ask')
        try {
          const prompts: Array<{ prompt: string; options: string[] }> = []
          questions.on('pending', ({ requestId, questions: asked }) => {
            prompts.push({ prompt: asked[0].prompt, options: asked[0].options.map((option) => option.id) })
            questions.submitAnswers(requestId, { permission: asked[0].options.some((option) => option.id === 'allow_always') ? 'allow_always' : 'reject' }, { kind: 'user' })
          })
          // Under Ask the user says "always" to this command...
          await service.chat(chatInput(home, 'ask'))
          expect(decisions).toEqual(['allow'])
          expect(engine.approvals.listRules('thread')).toHaveLength(1)
          // ...and later the thread runs under Full access, where only Claude Code's own check can still ask.
          state.permissionMode = 'full'
          state.approvals = 'grants'
          await service.chat(chatInput(home, 'full'))
          expect(decisions).toEqual(['allow', 'deny'])
          expect(prompts).toHaveLength(2)
          expect(prompts[1]!.prompt).toMatch(/^Claude Code asks even in Full access: its own safety check\./)
          expect(prompts[1]!.options).toEqual(['allow', 'reject'])
        } finally {
          close()
        }
      })
    })

    it('runs Full access as Auto-accept edits when the project\'s Claude Code settings forbid bypassing permissions', async () => {
      const home = mkdtempSync(join(tmpdir(), 'claude-bypass-'))
      homes.push(home)
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } }))
      const seen: Options[] = []
      const { service } = fixture((input) => { seen.push(input.options); return fakeQuery([result]) })
      await service.chat(chatInput(home, 'full'))
      expect(seen[0]).toMatchObject({ permissionMode: 'acceptEdits' })
      expect(seen[0]).not.toHaveProperty('allowDangerouslySkipPermissions')
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
      launchConfig: () => ({ binaryPath: join(home, 'claude') }),
      live: false,
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
      launchConfig: () => ({ binaryPath: join(home, 'claude') }),
      live: false,
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
    // The service drops its sessions; the signed-out flag is the gateway's (and its mirror's), never written here.
    expect(settings()).toMatchObject({ sessions: {} })
    expect(settings().cliDisconnected).toBeUndefined()
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
      launchConfig: () => ({ binaryPath: join(home, 'claude') }),
    live: false,
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

describe('a plan usage limit (one-shot query)', () => {
  const rejected = (extra: Record<string, unknown> = {}) => ({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600, ...extra },
    uuid: 'event',
    session_id: 'vendor-session'
  })
  const init = { type: 'system', subtype: 'init', session_id: 'vendor-session' }
  const failure = (extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['limit'], session_id: 'vendor-session', ...extra })

  it('a rejected window followed by an error result fails with the typed limit and its reset', async () => {
    const { service, home } = fixture(() => fakeQuery([init, rejected(), failure()]))
    const error = await service.chat(chatInput(home)).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'provider_usage_limit', details: { provider: 'claude', limitKind: 'five_hour', estimated: false }, errorInfo: { retryable: false } })
    expect(readUsageLimit(error)?.resetsAt).toBeDefined()
  })

  it('a rejected window followed by a success is no error', async () => {
    const { service, home } = fixture(() => fakeQuery([init, rejected(), result]))
    expect(await service.chat(chatInput(home))).toBe('hello')
  })

  it('an unrelated api failure after a rejected window stays a plain failure', async () => {
    const { service, home } = fixture(() => fakeQuery([init, rejected(), failure({ api_error_status: 503, errors: ['overloaded'] })]))
    const error = await service.chat(chatInput(home)).catch((caught: unknown) => caught)
    expect(error).not.toMatchObject({ code: 'provider_usage_limit' })
    expect((error as Error).message).toBe('overloaded')
  })

  /** A query that shows a rejected window and then says nothing until it is interrupted or closed. */
  function heldQuery() {
    const q = fakeQuery()
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    q[Symbol.asyncIterator] = async function* () {
      yield init as never
      yield rejected() as never
      await released
      yield failure({ errors: ['interrupted'], terminal_reason: 'aborted_streaming' }) as never
    }
    vi.mocked(q.interrupt).mockImplementation(async () => release())
    vi.mocked(q.close).mockImplementation(() => release())
    return q
  }

  it('a turn Claude Code holds after a rejected window is interrupted and fails with the limit', async () => {
    const q = heldQuery()
    const { service, home } = fixture(() => q, true, 150)
    const error = await service.chat(chatInput(home)).catch((caught: unknown) => caught)
    expect(q.interrupt).toHaveBeenCalledOnce()
    expect(error).toMatchObject({ code: 'provider_usage_limit', details: { limitKind: 'five_hour', estimated: false } })
  })

  it('a turn that goes on after a rejected window is not interrupted by the hold timer', async () => {
    const q = fakeQuery()
    q[Symbol.asyncIterator] = async function* () {
      yield init as never
      yield rejected({ rateLimitType: 'seven_day_opus' }) as never
      yield { type: 'assistant', session_id: 'vendor-session', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }] } } as never
      // A long tool: far longer than the hold, with no frame.
      await new Promise((resolve) => setTimeout(resolve, 500))
      yield result as never
    }
    const { service, home } = fixture(() => q, true, 150)
    expect(await service.chat(chatInput(home))).toBe('hello')
    expect(q.interrupt).not.toHaveBeenCalled()
  })

  it('a later failure that is not a limit stays a plain failure after the turn went on', async () => {
    const assistantText = { type: 'assistant', session_id: 'vendor-session', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } }
    const { service, home } = fixture(() => fakeQuery([init, rejected(), assistantText, failure({ api_error_status: null, errors: ['connection dropped'] })]))
    const error = await service.chat(chatInput(home)).catch((caught: unknown) => caught)
    expect(error).not.toMatchObject({ code: 'provider_usage_limit' })
    expect((error as Error).message).toBe('connection dropped')
  })

  it('a held turn whose stream ends without a result after the interrupt still fails with the limit', async () => {
    for (const how of ['ends', 'throws'] as const) {
      const q = fakeQuery()
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      q[Symbol.asyncIterator] = async function* () {
        yield init as never
        yield rejected() as never
        await released
        if (how === 'throws') throw new Error('Claude Code process exited')
      }
      vi.mocked(q.interrupt).mockImplementation(async () => release())
      const { service, home } = fixture(() => q, true, 150)
      const error = await service.chat(chatInput(home)).catch((caught: unknown) => caught)
      expect(q.interrupt).toHaveBeenCalledOnce()
      expect(error, how).toMatchObject({ code: 'provider_usage_limit', details: { limitKind: 'five_hour', estimated: false } })
    }
  })

  it('a user Stop during the hold cancels the turn and Mousse never interrupts it', async () => {
    const q = heldQuery()
    const { service, home } = fixture(() => q, true, 600)
    const stop = new AbortController()
    const turn = service.chat({ ...chatInput(home), signal: stop.signal })
    await vi.waitFor(() => expect(vi.mocked(q.close)).not.toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 150))
    stop.abort()
    const error = await turn.catch((caught: unknown) => caught)
    expect(error).not.toMatchObject({ code: 'provider_usage_limit' })
    expect(q.interrupt).not.toHaveBeenCalled()
  })

  it('the next turn resumes the session the limit ended', async () => {
    const inputs: Array<{ options: Options; prompt: unknown }> = []
    const { service, home } = fixture((input) => {
      inputs.push(input)
      return inputs.length === 1 ? fakeQuery([init, rejected(), failure()]) : fakeQuery([result])
    })
    await expect(service.chat({ ...chatInput(home), history: 'H1' })).rejects.toMatchObject({ code: 'provider_usage_limit' })
    // The adapter reports the history the failed turn left: H1 and its request.
    service.commitFailed('thread', 'H1 + request')
    await service.chat({ ...chatInput(home), history: 'H1 + request' })
    expect(inputs[1].options.resume).toBe('vendor-session')
  })

  it('a limit read only from the result text also keeps the session for the next turn', async () => {
    const inputs: Array<{ options: Options; prompt: unknown }> = []
    const body = failure({ errors: ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Usage limit reached (reset after 1h)"}}'] })
    const { service, home } = fixture((input) => {
      inputs.push(input)
      return inputs.length === 1 ? fakeQuery([init, body]) : fakeQuery([result])
    })
    const error = await service.chat({ ...chatInput(home), history: 'H1' }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'provider_usage_limit', details: { estimated: false } })
    service.commitFailed('thread', 'H1 + request')
    await service.chat({ ...chatInput(home), history: 'H1 + request' })
    expect(inputs[1].options.resume).toBe('vendor-session')
  })

  it('a failure that is not a limit saves no session, even when a rejected window was seen earlier', async () => {
    const inputs: Array<{ options: Options; prompt: unknown }> = []
    const assistantText = { type: 'assistant', session_id: 'vendor-session', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } }
    const { service, home } = fixture((input) => {
      inputs.push(input)
      return inputs.length === 1 ? fakeQuery([init, rejected(), assistantText, failure({ api_error_status: 503, errors: ['overloaded'] })]) : fakeQuery([result])
    })
    await expect(service.chat({ ...chatInput(home), history: 'H1' })).rejects.toThrow('overloaded')
    service.commitFailed('thread', 'H1 + request')
    await service.chat({ ...chatInput(home), history: 'H1 + request' })
    expect(inputs[1].options.resume).toBeUndefined()
  })
})
