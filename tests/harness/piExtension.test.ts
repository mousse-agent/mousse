import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { Provider } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'vitest'
import { PiBridge, type PiBridgeHandlers } from '../../src/mms/harness/pi/bridge'
import { isGuarded } from '../../src/mms/harness/pi/extension/guard'
import mousseExtension from '../../src/mms/harness/pi/extension/index'
import { GATE_REFUSALS } from '../../src/mms/harness/pi/extension/messages'
import { PI_BRIDGE_ENV, type PiGateRequest, type PiReadyRequest, type PiTurnResponse } from '../../src/mms/harness/pi/extension/protocol'

// Mousse's extension against a fake ExtensionAPI and the engine's real bridge, in process.

type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown

function fakePi() {
  const providers: Provider[] = []
  const tools: Array<Record<string, unknown>> = []
  const handlers = new Map<string, Handler>()
  const active: string[][] = []
  const pi = {
    registerCommand: () => {},
    registerProvider: (provider: Provider) => void providers.push(provider),
    registerTool: (tool: Record<string, unknown>) => void tools.push(tool),
    setActiveTools: (names: string[]) => void active.push(names),
    on: (event: string, handler: Handler) => void handlers.set(event, handler)
  }
  return { pi, providers, tools, handlers, active }
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  delete process.env[PI_BRIDGE_ENV]
})

const TURN: PiTurnResponse = {
  attemptToken: 'attempt-1',
  sessionInstructions: 'Use Mousse tools.',
  tools: [
    { name: 'delegate_task', description: 'd', parameters: { type: 'object', properties: {} }, class: 'delegation' },
    { name: 'ask_user', description: 'a', parameters: { type: 'object', properties: {} }, class: 'read' }
  ],
  activeBuiltins: ['read', 'grep'],
  mcp: { url: 'http://127.0.0.1:1/mcp', token: 'bearer' },
  catalogRevision: 1
}

async function loaded(gate: (request: PiGateRequest) => ReturnType<PiBridgeHandlers['gate']>) {
  const bridge = new PiBridge()
  await bridge.start()
  cleanups.push(() => bridge.stop())
  const ready: PiReadyRequest[] = []
  const firsts: boolean[] = []
  const registration = bridge.register({
    catalog: async (first) => {
      firsts.push(first)
      return { provider: { id: 'openrouter', builtin: true, models: [] }, catalogRevision: 1, ...(first ? { apiKey: 'stored-key' } : {}) }
    },
    ready: (request) => void ready.push(request),
    turn: async () => TURN,
    gate,
    quiesce: async () => ({ ok: true }),
    fatal: () => {}
  })
  process.env[PI_BRIDGE_ENV] = JSON.stringify(registration.address)
  const fake = fakePi()
  await mousseExtension(fake.pi as never)
  return { ...fake, ready, firsts, registration }
}

describe('Mousse’s Pi extension', () => {
  it('scrubs its bridge variable and registers every built-in provider guarded, the instance one with the stored key', async () => {
    const { providers, firsts } = await loaded(async () => ({ allow: true }))
    expect(process.env[PI_BRIDGE_ENV]).toBeUndefined()
    expect(firsts).toEqual([true])
    expect(new Set(providers.map((provider) => provider.id))).toEqual(new Set(builtinProviders().map((provider) => provider.id)))
    for (const provider of providers) expect(isGuarded(provider), provider.id).toBe(true)
    const openrouter = providers.find((provider) => provider.id === 'openrouter')!
    const resolved = await openrouter.auth.apiKey!.resolve({ ctx: { env: async () => undefined, fileExists: async () => false }, signal: new AbortController().signal })
    expect(resolved?.auth.apiKey).toBe('stored-key')
  })

  it('guards what another extension registered at session start, then reports the guarded set', async () => {
    const { handlers, ready, providers, pi } = await loaded(async () => ({ allow: true }))
    const registered = new Map(providers.map((provider) => [provider.id, provider]))
    const llama = { ...builtinProviders()[0], id: 'llama.cpp' } as Provider
    registered.set('llama.cpp', llama)
    const later: Provider[] = []
    const registry = {
      getRegisteredProviderIds: () => [...registered.keys()],
      getAll: () => [{ provider: 'llama.cpp' }],
      getRegisteredNativeProvider: (id: string) => registered.get(id),
      getProvider: (id: string) => registered.get(id)
    }
    // After bind, the extension's registrations apply at once.
    const fake = handlers.get('session_start')!
    pi.registerProvider = (provider: Provider) => {
      later.push(provider)
      registered.set(provider.id, provider)
    }
    await fake({ reason: 'startup' }, { modelRegistry: registry })
    expect(later.map((provider) => provider.id)).toEqual(['llama.cpp'])
    expect(isGuarded(later[0])).toBe(true)
    expect(ready).toHaveLength(1)
    expect(ready[0].guarded).toContain('llama.cpp')
    expect(ready[0].aws).toEqual({ maxAttempts: process.env.AWS_MAX_ATTEMPTS ?? null, retryMode: process.env.AWS_RETRY_MODE ?? null })
  })

  it('registers the turn’s tools (delegation sequential) and activates exactly the turn’s set', async () => {
    const { handlers, tools, active } = await loaded(async () => ({ allow: true }))
    const result = await handlers.get('before_agent_start')!({ systemPrompt: 'base' }) as { systemPrompt: string }
    expect(result.systemPrompt).toBe('base\n\nUse Mousse tools.')
    expect(tools.map((tool) => [tool.name, tool.executionMode])).toEqual([['delegate_task', 'sequential'], ['ask_user', undefined]])
    expect(active.at(-1)).toEqual(['read', 'grep', 'delegate_task', 'ask_user'])
  })

  it('asks the gate for every call with the attempt token, blocks a denial, and blocks when the gate is down', async () => {
    const seen: PiGateRequest[] = []
    const { handlers, registration } = await loaded(async (request) => {
      seen.push(request)
      return request.toolName === 'read' ? { allow: true } : { allow: false, reason: GATE_REFUSALS.denied }
    })
    const gate = handlers.get('tool_call')!
    // Before any turn: default deny without asking.
    expect(await gate({ toolCallId: 'c0', toolName: 'read', input: {} })).toEqual({ block: true, reason: GATE_REFUSALS.denied })
    await handlers.get('before_agent_start')!({ systemPrompt: '' })
    expect(await gate({ toolCallId: 'c1', toolName: 'read', input: { path: 'a' } })).toBeUndefined()
    expect(await gate({ toolCallId: 'c2', toolName: 'bash', input: { command: 'ls' } })).toEqual({ block: true, reason: GATE_REFUSALS.denied })
    expect(seen.map((request) => [request.attemptToken, request.toolName])).toEqual([['attempt-1', 'read'], ['attempt-1', 'bash']])
    registration.close()
    expect(await gate({ toolCallId: 'c3', toolName: 'read', input: {} })).toEqual({ block: true, reason: GATE_REFUSALS.unreachable })
  })

  it('drops subscription headers before a request (a second layer behind the wrapper)', async () => {
    const { handlers } = await loaded(async () => ({ allow: true }))
    const headers: Record<string, string | null> = { authorization: 'Bearer sk-ant-oat01-x', 'anthropic-beta': 'oauth-2025-04-20', 'x-ok': 'fine' }
    handlers.get('before_provider_headers')!({ headers })
    expect(headers).toEqual({ authorization: null, 'anthropic-beta': null, 'x-ok': 'fine' })
  })
})
