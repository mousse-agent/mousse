import type { ServerResponse } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { instanceEnv } from '../../src/mms/harness/env'
import { PI_RPC_CAPS } from '../../src/mms/harness/drivers/pi'
import { PiRpcEngine, type PiRpcEngineOptions } from '../../src/mms/harness/pi/engine'
import type { AdapterHost, TurnControl, TurnInput, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { cleanBase, piPackage, scratchDir, startRecorder, testExtension, type RecordedRequest, type Recorder } from './piRpcFixture'

// The Pi RPC engine with the real pinned Pi child, Mousse's extension built from source and an
// OpenAI-compatible mock on 127.0.0.1. Fake key only; nothing leaves the machine.

export type Step = { text?: string; tool?: { name: string; args: Record<string, unknown> }; tools?: Array<{ name: string; args: Record<string, unknown> }>; status?: number }

/** Answers each request with the next step as an OpenAI chat-completions stream. */
export function script(steps: Step[]) {
  let index = 0
  return (_request: RecordedRequest, res: ServerResponse) => {
    const step = steps[Math.min(index, steps.length - 1)]
    index += 1
    if (step.status) {
      const body = JSON.stringify({ error: { message: 'Service unavailable', type: 'server_error' } })
      res.writeHead(step.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      return res.end(body)
    }
    const chunks: unknown[] = []
    if (step.text) chunks.push({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: step.text } }] })
    const tools = step.tools ?? (step.tool ? [step.tool] : [])
    for (const [position, tool] of tools.entries())
      chunks.push({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: position, id: `call_${index}_${position}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } }] })
    chunks.push({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: tools.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`)
  }
}

export interface SetupOptions {
  retry?: { enabled: boolean; maxRetries: number; baseDelayMs: number; provider: { maxRetries: number } }
  testEnv?: Record<`MOUSSE_PI_TEST_${string}`, string>
  adjustLaunch?: PiRpcEngineOptions['adjustLaunch']
  holdTurn?: PiRpcEngineOptions['holdTurn']
  mousseTools?: PiRpcEngineOptions['mousseTools']
  /** The mock provider's models instead of the one OpenAI-compatible model (`url`: the recorder's). */
  models?: (url: string) => unknown[]
  extraEnv?: Record<string, string>
  /** Pi's threshold compaction, read when a process starts (default on). */
  compaction?: () => boolean
}

/** An engine on a fresh scratch dir with a recorder; `cleanups` gets what to undo, in order. */
export async function setup(cleanups: Array<() => unknown>, options: SetupOptions = {}) {
  const scratch = scratchDir()
  cleanups.push(() => scratch.cleanup())
  const recorder: Recorder = await startRecorder()
  cleanups.push(() => recorder.close())
  const extension = await testExtension(scratch.dir)
  const stateDir = join(scratch.dir, 'state')
  const home = join(stateDir, 'home')
  const userHome = join(scratch.dir, 'user')
  mkdirSync(userHome, { recursive: true })
  const env = instanceEnv({ instanceId: 'pi:mock', driver: 'pi', configRevision: 0, home, searchPath: [], base: cleanBase(userHome) })
  const commands: string[] = []
  const catalogRevision = { value: 1 }
  const spawned: number[] = []
  const engine = new PiRpcEngine({
    instanceId: 'pi:mock',
    provider: 'mock',
    label: 'Mock',
    capabilities: PI_RPC_CAPS,
    env: () => env,
    stateDir,
    runtime: () => ({ root: piPackage, entry: join(piPackage, 'dist/bundle/rpc-entry.js'), extension }),
    catalog: () => ({
      revision: catalogRevision.value,
      provider: {
        id: 'mock', builtin: false, name: 'Mock',
        models: (options.models?.(recorder.url) ?? [{ id: 'mock-model', name: 'Mock model', api: 'openai-completions', provider: 'mock', baseUrl: `${recorder.url}/v1`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096, compat: { supportsStore: false, supportsDeveloperRole: false } }]) as never
      }
    }),
    apiKey: () => 'fake-mock-key',
    onCommand: (type) => commands.push(type),
    onSpawn: (pid) => void spawned.push(pid),
    readyDeadlineMs: 15_000,
    ...(options.testEnv ? { testEnv: options.testEnv } : {}),
    ...(options.extraEnv ? { extraEnv: () => options.extraEnv } : {}),
    ...(options.compaction ? { compaction: options.compaction } : {}),
    ...(options.adjustLaunch ? { adjustLaunch: options.adjustLaunch } : {}),
    ...(options.holdTurn ? { holdTurn: options.holdTurn } : {}),
    ...(options.mousseTools ? { mousseTools: options.mousseTools } : {}),
    ...(options.retry ? { settings: { retry: options.retry } } : { settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 10, provider: { maxRetries: 0 } } } })
  })
  cleanups.push(() => engine.stop())
  const project = join(scratch.dir, 'project')
  mkdirSync(project)
  return { engine, recorder, commands, project, home, stateDir, catalogRevision, userHome, spawned, scratch: scratch.dir }
}

/** One turn's input, sink, control and host, recording what the sink sees. */
export function harness(project: string, overrides: Partial<TurnInput> = {}, hostOverrides: Partial<AdapterHost> = {}) {
  const events: Array<{ kind: string; [key: string]: unknown }> = []
  const controller = new AbortController()
  const input: TurnInput = {
    runId: 'r1', attemptId: 'a1', threadId: 't1', cwd: project, instanceId: 'pi:mock', model: 'mock-model', llmProvider: 'mock',
    modelPinned: true, mode: 'agent' as TurnInput['mode'], prompt: 'Say hello', messages: [], signal: controller.signal, ...overrides
  }
  const sink: TurnSink = {
    text: (event) => events.push({ ...event, kind: 'text' }),
    thinking: () => {},
    tool: (event) => events.push({ ...event, toolKind: event.kind, kind: 'tool' }),
    nativeMessages: () => {},
    compaction: () => {},
    retry: (attempt) => events.push({ kind: 'retry', attempt }),
    progress: () => {},
    usage: (usage) => events.push({ kind: 'usage', ...usage }),
    providerRef: () => {},
    steerAccepted: (text) => events.push({ kind: 'steer', text }),
    providerMetrics: () => {},
    lineEdits: () => {}
  }
  const ctl: TurnControl = { drainSteer: () => undefined, heartbeat: () => {} }
  const committed: string[] = []
  const host: AdapterHost = {
    tools: {},
    context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: (text) => (committed.push(text), `user: Say hello\nassistant: ${text}`) },
    ...hostOverrides
  }
  return { input, sink, ctl, host, events, controller, committed }
}
