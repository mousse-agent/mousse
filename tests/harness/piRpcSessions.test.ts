import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { instanceEnv } from '../../src/mms/harness/env'
import { PI_RPC_CAPS } from '../../src/mms/harness/drivers/pi'
import { PiRpcEngine, type PiRpcEngineOptions } from '../../src/mms/harness/pi/engine'
import type { AdapterHost, TurnControl, TurnInput, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import type { ProviderRef } from '../../src/mms/run/types'
import type { Message } from '../../src/shared/transcript'
import { cleanBase, piPackage, scratchDir, startRecorder, testExtension, type RecordedRequest, type Recorder } from './piRpcFixture'

// Pi sessions across threads with the real pinned Pi child and an OpenAI-compatible mock on
// 127.0.0.1: native forks, and history handed to a new session (seeded, or as a preamble). Fake key
// only; nothing leaves the machine.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Answers each request with the next reply as an OpenAI chat-completions stream. */
function replies(texts: string[]) {
  let index = 0
  return (_request: RecordedRequest, res: ServerResponse) => {
    const text = texts[Math.min(index, texts.length - 1)]
    index += 1
    const chunks = [
      { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text } }] },
      { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`)
  }
}

async function setup(options: Pick<PiRpcEngineOptions, 'onSeed'> = {}) {
  const scratch = scratchDir('mousse-pi-sessions-')
  cleanups.push(() => scratch.cleanup())
  const recorder: Recorder = await startRecorder()
  cleanups.push(() => recorder.close())
  const extension = await testExtension(scratch.dir)
  const stateDir = join(scratch.dir, 'state')
  const userHome = join(scratch.dir, 'user')
  mkdirSync(userHome, { recursive: true })
  const env = instanceEnv({ instanceId: 'pi:mock', driver: 'pi', configRevision: 0, home: join(stateDir, 'home'), searchPath: [], base: cleanBase(userHome) })
  const notices: Array<{ threadId: string; code: string; message: string }> = []
  const engine = new PiRpcEngine({
    instanceId: 'pi:mock',
    provider: 'mock',
    label: 'Mock',
    capabilities: PI_RPC_CAPS,
    env: () => env,
    stateDir,
    runtime: () => ({ root: piPackage, entry: join(piPackage, 'dist/bundle/rpc-entry.js'), extension }),
    catalog: () => ({
      revision: 1,
      provider: {
        id: 'mock', builtin: false, name: 'Mock',
        models: [{ id: 'mock-model', name: 'Mock model', api: 'openai-completions', provider: 'mock', baseUrl: `${recorder.url}/v1`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096, compat: { supportsStore: false, supportsDeveloperRole: false } }] as never
      }
    }),
    apiKey: () => 'fake-mock-key',
    readyDeadlineMs: 15_000,
    settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 10, provider: { maxRetries: 0 } } },
    notice: (threadId, notice) => void notices.push({ threadId, ...notice }),
    ...options
  })
  cleanups.push(() => engine.stop())
  const project = join(scratch.dir, 'project')
  mkdirSync(project)
  return { engine, recorder, project, stateDir, notices, scratch: scratch.dir }
}

function harness(project: string, overrides: Partial<TurnInput> = {}) {
  const controller = new AbortController()
  const prompt = overrides.prompt ?? 'Say hello'
  const input: TurnInput = {
    runId: 'r1', attemptId: 'a1', threadId: 't1', cwd: project, instanceId: 'pi:mock', model: 'mock-model', llmProvider: 'mock',
    modelPinned: true, mode: 'agent' as TurnInput['mode'], prompt, messages: [{ role: 'user', content: prompt, timestamp: 1 }], signal: controller.signal, ...overrides
  }
  const sink: TurnSink = {
    text: () => {}, thinking: () => {}, tool: () => {}, nativeMessages: () => {}, compaction: () => {}, retry: () => {}, progress: () => {},
    usage: () => {}, providerRef: () => {}, steerAccepted: () => {}, providerMetrics: () => {}, lineEdits: () => {}
  }
  const ctl: TurnControl = { drainSteer: () => undefined, heartbeat: () => {} }
  const host: AdapterHost = {
    tools: {},
    context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: (text) => `${input.nativeHistory ?? ''}\nuser: ${prompt}\nassistant: ${text}` }
  }
  return { input, sink, ctl, host }
}

async function run(engine: PiRpcEngine, turn: ReturnType<typeof harness>) {
  return engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
}

/** The chat messages of a recorded request, as `role: text`. */
function sent(request: RecordedRequest | undefined): string[] {
  const body = JSON.parse(request?.body ?? '{}') as { messages?: Array<{ role: string; content: unknown }> }
  return (body.messages ?? []).filter((message) => message.role !== 'system' && message.role !== 'developer').map((message) => {
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content) ? message.content.map((part: { text?: string }) => part.text ?? '').join('') : ''
    return `${message.role}: ${content}`
  })
}

/** The messages of a session file, as Pi stored them. */
function sessionMessages(stateDir: string, sessionId: string): unknown[] {
  const name = readdirSync(join(stateDir, 'sessions')).find((entry) => entry.endsWith(`_${sessionId}.jsonl`))
  if (!name) throw new Error(`no session file for ${sessionId}`)
  return readFileSync(join(stateDir, 'sessions', name), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string; message?: unknown })
    .filter((entry) => entry.type === 'message').map((entry) => entry.message)
}

function savedThreads(stateDir: string): Record<string, { sessionId: string }> {
  return JSON.parse(readFileSync(join(stateDir, 'threads.json'), 'utf8')) as Record<string, { sessionId: string }>
}

describe('Pi RPC sessions with the real Pi child', () => {
  it('forks natively: the latest turn is cloned, an earlier one branched, and each fork’s first turn resumes its branch in its own workspace', async () => {
    const { engine, recorder, project, stateDir, notices, scratch } = await setup()
    recorder.respond(replies(['First answer', 'Second answer', 'Fork of latest', 'Fork of first']))
    const first = await run(engine, harness(project))
    const second = await run(engine, harness(project, { runId: 'r2', prompt: 'Second question', nativeHistory: `\nuser: Say hello\nassistant: First answer` }))
    const source = second.providerRef as ProviderRef
    expect(source.sessionId).toBe(first.providerRef.sessionId)

    // Without a thread to bind the branch to, there is no native fork.
    expect(await engine.forkSession(source, 2)).toBeNull()

    const latest = await engine.forkSession(source, 2, { threadId: 'fork-latest' })
    expect(latest?.sessionId).toBeTruthy()
    expect(latest?.sessionId).not.toBe(source.sessionId)
    // The clone holds the source session's messages exactly.
    expect(sessionMessages(stateDir, latest!.sessionId!)).toEqual(sessionMessages(stateDir, source.sessionId!))

    const earlier = await engine.forkSession(first.providerRef, 1, { threadId: 'fork-first' })
    expect(earlier?.sessionId).toBeTruthy()
    expect(sessionMessages(stateDir, earlier!.sessionId!)).toEqual(sessionMessages(stateDir, source.sessionId!).slice(0, 2))

    // Each fork runs in its own worktree; its first turn resumes the branch, nothing is handed over.
    const forkProject = join(scratch, 'fork-worktree')
    mkdirSync(forkProject)
    const onLatest = await run(engine, harness(forkProject, { threadId: 'fork-latest', runId: 'f1', prompt: 'Go on' }))
    expect(onLatest).toMatchObject({ text: 'Fork of latest', providerRef: { sessionId: latest!.sessionId } })
    expect(sent(recorder.requests.at(-1))).toEqual(['user: Say hello', 'assistant: First answer', 'user: Second question', 'assistant: Second answer', 'user: Go on'])
    const onFirst = await run(engine, harness(forkProject, { threadId: 'fork-first', runId: 'f2', prompt: 'Go on' }))
    expect(onFirst.text).toBe('Fork of first')
    expect(sent(recorder.requests.at(-1))).toEqual(['user: Say hello', 'assistant: First answer', 'user: Go on'])
    expect(notices).toEqual([])
  }, 120_000)

  it('hands a pi-loop thread’s history to a seeded session: Pi sends the prior messages as messages, and the thread is told', async () => {
    const { engine, recorder, project, stateDir, notices } = await setup()
    recorder.respond(replies(['Seeded reply', 'Resumed reply']))
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    const legacy: Message[] = [
      { role: 'user', content: 'Earlier question', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call_legacy', name: 'read', arguments: { path: 'notes.txt' } }], api: 'openai-completions', provider: 'mock', model: 'mock-model', usage, stopReason: 'toolUse', timestamp: 2 },
      { role: 'toolResult', toolCallId: 'call_legacy', toolName: 'read', content: [{ type: 'text', text: 'notes body' }], isError: false, timestamp: 3 },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }], api: 'openai-completions', provider: 'mock', model: 'mock-model', usage, stopReason: 'stop', timestamp: 4 },
      { role: 'user', content: 'Say hello', timestamp: 5 }
    ]
    const turn = harness(project, { threadId: 'legacy', messages: legacy, nativeHistory: 'pi-loop history' })
    const result = await run(engine, turn)
    expect(result.text).toBe('Seeded reply')
    const messages = sent(recorder.requests.at(-1))
    expect(messages).toEqual(['user: Earlier question', 'assistant: ', 'tool: notes body', 'assistant: Earlier answer', 'user: Say hello'])
    expect(messages.join('\n')).not.toContain('Previous conversation')
    expect(notices).toEqual([{ threadId: 'legacy', code: 'history_injected', message: expect.stringContaining('history handed over') }])
    // The seeded session is the thread's from now on: the next turn resumes it with no notice.
    expect(savedThreads(stateDir).legacy.sessionId).toBe(result.providerRef.sessionId)
    await run(engine, harness(project, { threadId: 'legacy', runId: 'r2', prompt: 'And then?', nativeHistory: `pi-loop history\nuser: Say hello\nassistant: Seeded reply` }))
    expect(sent(recorder.requests.at(-1)).slice(-3)).toEqual(['user: Say hello', 'assistant: Seeded reply', 'user: And then?'])
    expect(notices).toHaveLength(1)
    // Forking the seeded session at another thinking level leaves the source file as it was.
    const sourceFile = join(stateDir, 'sessions', readdirSync(join(stateDir, 'sessions')).find((entry) => entry.endsWith(`_${result.providerRef.sessionId}.jsonl`))!)
    const before = readFileSync(sourceFile, 'utf8')
    const fork = await engine.forkSession({ ...(result.providerRef as ProviderRef), model: `${(result.providerRef as ProviderRef).model}:high` }, 1, { threadId: 'seed-fork' })
    expect(fork?.sessionId).toBeTruthy()
    expect(readFileSync(sourceFile, 'utf8')).toBe(before)
  }, 120_000)

  it('a seed Pi does not load as written falls back to the preamble', async () => {
    const corrupted: string[] = []
    const { engine, recorder, project, stateDir, notices } = await setup({
      // Only the header, the model and thinking entries and the first message survive: Pi loads it,
      // `get_messages` disagrees.
      onSeed: (file) => {
        corrupted.push(file)
        writeFileSync(file, `${readFileSync(file, 'utf8').split('\n').slice(0, 4).join('\n')}\n`)
      }
    })
    recorder.respond(replies(['Preamble reply']))
    const legacy: Message[] = [
      { role: 'user', content: 'Earlier question', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }], api: 'openai-completions', provider: 'mock', model: 'mock-model', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 2 },
      { role: 'user', content: 'Say hello', timestamp: 3 }
    ]
    const result = await run(engine, harness(project, { threadId: 'legacy', messages: legacy, nativeHistory: 'user: Earlier question\nassistant: Earlier answer' }))
    expect(result.text).toBe('Preamble reply')
    expect(corrupted).toHaveLength(1)
    expect(existsSync(corrupted[0])).toBe(false)
    const messages = sent(recorder.requests.at(-1))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('Previous conversation (context only; do not repeat earlier actions):\nuser: Earlier question\nassistant: Earlier answer')
    expect(messages[0]).toContain('Say hello')
    expect(notices).toEqual([{ threadId: 'legacy', code: 'history_injected', message: expect.any(String) }])
    expect(corrupted[0]).not.toContain(savedThreads(stateDir).legacy.sessionId)
  }, 120_000)
})
