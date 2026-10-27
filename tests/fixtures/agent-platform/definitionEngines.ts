import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AssistantMessage, Context, Message, Model } from '@earendil-works/pi-ai'
import { streamSimple as openAiCompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { piDriver } from '../../../src/mms/harness/drivers/pi'
import type { Harness } from '../../../src/mms/harness/gateway'
import type { OrchestratorService } from '../../../src/mms/orchestrator/OrchestratorService'
import { ProviderInstanceService } from '../../../src/mms/providers/ProviderInstanceService'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import type { AdapterHost, ProviderAdapter, TurnInput } from '../../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../../src/mms/run/testkit/harness'
import { APPROVAL_ONLY_INSTANCE, installExactDefinitionRuntime } from './exactDefinitionRuntime'

/**
 * The runtimes definition tests run on (PR 4 §6):
 * - `legacy`: the real legacy Pi engine (the `pi` driver's loop adapter and Mousse's in-process
 *   loop), its pi-ai `openai-completions` transport pointed at a local HTTP recorder with a fake key.
 *   This is where definitions run today.
 * - `exact`: a stand-in for a runtime that earned `toolControl: 'exact'` with its own loop (Pi RPC,
 *   once it does): every tool call passes the definition's authority first, as Pi's gate does.
 * Both sit beside a Claude Code-like instance (`claude`) that only asks for approval.
 */
export type DefinitionEngineKind = 'legacy' | 'exact'
export const DEFINITION_ENGINES: DefinitionEngineKind[] = ['legacy', 'exact']

export const ENGINE_MODEL = 'recorder-model'
export const FAKE_KEY = 'fake-recorder-key'

export interface DefinitionEngine {
  kind: DefinitionEngineKind
  /** For the orchestrator's constructor: the profile's provider credentials (fake). */
  providerAuth: never
  /** Every turn the engine's runtime was given, with its host. */
  turns: Array<{ input: TurnInput; host: AdapterHost }>
  /** The model's replies, in order (or `setNext`). */
  outputs: AssistantMessage[]
  /** What each model request carried: its system prompt, messages and tools. */
  captured: Context[]
  /** Raw requests the recorder received (legacy only). */
  requests: Array<{ authorization: string | undefined; body: Record<string, unknown> }>
  setNext(next: ((context: Context, signal: AbortSignal) => Promise<AssistantMessage>) | undefined): void
  /** `engine: 'rpc'`: the Pi connections are set to the new engine (legacy only; Pi itself never starts). */
  install(orchestrator: OrchestratorService, profileHome: string, options?: { engine?: 'rpc' }): Harness
  close(): Promise<void>
}

function modelFor(provider: string, baseUrl: string): Model<'openai-completions'> {
  return {
    id: ENGINE_MODEL, name: 'Recorder model', api: 'openai-completions', provider, baseUrl, reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4_000
  } as Model<'openai-completions'>
}

function text(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('')
  return ''
}

/** A recorded OpenAI chat-completions request, as the pi-ai context that produced it. */
function contextOf(body: Record<string, unknown>): Context {
  const messages: Message[] = []
  let systemPrompt = ''
  for (const raw of (body.messages as Array<Record<string, unknown>>) ?? []) {
    const role = raw.role
    if (role === 'system' || role === 'developer') systemPrompt = text(raw.content)
    else if (role === 'user') messages.push({ role: 'user', content: text(raw.content), timestamp: 0 })
    else if (role === 'assistant') messages.push({ role: 'assistant', content: [{ type: 'text', text: text(raw.content) }] } as never)
    else if (role === 'tool') messages.push({ role: 'toolResult', toolCallId: String(raw.tool_call_id), toolName: '', content: [{ type: 'text', text: text(raw.content) }], isError: false, timestamp: 0 } as never)
  }
  const tools = ((body.tools as Array<{ function?: { name?: string } }>) ?? []).map((tool) => ({ name: tool.function?.name ?? '', description: '', parameters: {} as never }))
  return { systemPrompt, messages, tools }
}

/** One assistant reply as an OpenAI chat-completions SSE stream. */
function sse(reply: AssistantMessage): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>) =>
    `data: ${JSON.stringify({ id: 'rec', object: 'chat.completion.chunk', created: 0, model: ENGINE_MODEL, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
  let out = chunk({ role: 'assistant', content: '' }, null)
  let toolIndex = 0
  for (const block of reply.content) {
    if (block.type === 'text') out += chunk({ content: block.text }, null)
    else if (block.type === 'toolCall')
      out += chunk({ tool_calls: [{ index: toolIndex++, id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.arguments) } }] }, null)
  }
  out += chunk({}, toolIndex ? 'tool_calls' : 'stop', { prompt_tokens: reply.usage?.input ?? 3, completion_tokens: reply.usage?.output ?? 1, total_tokens: (reply.usage?.input ?? 3) + (reply.usage?.output ?? 1) })
  return `${out}data: [DONE]\n\n`
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

export async function createDefinitionEngine(kind: DefinitionEngineKind, providers: string[]): Promise<DefinitionEngine> {
  const turns: DefinitionEngine['turns'] = []
  const outputs: AssistantMessage[] = []
  const captured: Context[] = []
  const requests: DefinitionEngine['requests'] = []
  let custom: ((context: Context, signal: AbortSignal) => Promise<AssistantMessage>) | undefined
  const next = async (context: Context, signal: AbortSignal): Promise<AssistantMessage> => {
    if (custom) return custom(context, signal)
    const reply = outputs.shift()
    if (!reply) throw new Error('fixture provider exhausted')
    return reply
  }
  const approvalOnly: ProviderAdapter = {
    driver: 'claude',
    capabilities: CLAUDE_SUBSCRIPTION_CAPABILITIES,
    configured: () => true,
    startTurn: async () => { throw new Error('An approval-only runtime must never be given a definition turn.') },
    interrupt: async () => 'not_active'
  }
  if (kind === 'exact') {
    return {
      kind, providerAuth: {} as never, turns, outputs, captured, requests,
      setNext: (value) => { custom = value },
      install: (orchestrator, profileHome) => {
        return installExactDefinitionRuntime({ orchestrator, providerId: providers[0]!, alsoProviders: providers.slice(1), profileHome, captured, next, turns }).harness
      },
      close: async () => {}
    }
  }
  // The legacy engine: a local recorder speaking OpenAI chat completions.
  const server: Server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request)
      requests.push({ authorization: request.headers.authorization, body })
      const context = contextOf(body)
      captured.push(structuredClone(context))
      const closed = new AbortController()
      response.on('close', () => closed.abort())
      let reply: AssistantMessage
      try {
        reply = await next(context, closed.signal)
      } catch (error) {
        if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
        return
      }
      if (closed.signal.aborted) return
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(sse(reply))
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  const models = {
    getModel: (provider: string, id: string) => (providers.includes(provider) && id === ENGINE_MODEL ? modelFor(provider, baseUrl) : undefined),
    getModels: (provider: string) => (providers.includes(provider) ? [modelFor(provider, baseUrl)] : []),
    getProviders: () => providers.map((id) => ({ id })),
    getAuth: async () => ({ apiKey: FAKE_KEY }),
    stream: () => { throw new Error('unused') },
    // The real pinned transport; only the key is the fixture's, as the profile's auth would add it.
    streamSimple: (model: Model<'openai-completions'>, context: Context, options: Record<string, unknown>) => openAiCompletions(model, context, { ...options, apiKey: FAKE_KEY } as never)
  }
  const providerAuth = {
    has: (provider: string) => providers.includes(provider),
    credentials: { listProviderIds: () => providers },
    getConfiguredProviders: () => providers.map((id) => ({ id, label: id, authType: 'api_key' as const })),
    getConfiguredLlmProviders: () => providers.map((id) => ({ id, label: id, models: [{ id: ENGINE_MODEL, label: 'Recorder model' }] })),
    models
  }
  return {
    kind, providerAuth: providerAuth as never, turns, outputs, captured, requests,
    setNext: (value) => { custom = value },
    install: (orchestrator, profileHome, options = {}) => {
      const never = (): never => { throw new Error('Pi RPC must not start for a definition turn') }
      const pi = piDriver({ credentials: () => providerAuth as never, ...(options.engine === 'rpc' ? { rpc: { runtime: never, catalog: never } } : {}) })
      // The real loop adapter, with every turn it is given recorded.
      const recorded = {
        ...pi,
        create: (context: Parameters<typeof pi.create>[0]) => {
          const runtime = pi.create(context)
          const adapter = runtime.adapter
          const wrapped = Object.create(adapter) as ProviderAdapter
          wrapped.startTurn = (input, sink, ctl, host) => {
            turns.push({ input, host })
            return adapter.startTurn(input, sink, ctl, host)
          }
          return { ...runtime, adapter: wrapped }
        }
      }
      let stored: unknown = {
        ...Object.fromEntries(providers.map((provider) => [`pi:${provider}`, { driver: 'pi', enabled: true, ...(options.engine === 'rpc' ? { config: { engine: 'rpc' } } : {}) }])),
        [APPROVAL_ONLY_INSTANCE]: { driver: 'claude', enabled: true }
      }
      const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (state) => { stored = state.instances } } })
      const harness = testHarness({
        drivers: [recorded, adapterDriver(approvalOnly, { budgets: 'hard', runtime: { configured: () => true } })],
        instances,
        profileHome
      })
      orchestrator.setHarness(harness)
      return harness
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
