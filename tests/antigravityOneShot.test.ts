/**
 * Antigravity runs Mousse's one-shot requests (chat titles, drafts): a fresh agent process and session of its own in a
 * new empty folder, no MCP server, the system text and prompt as one prompt, every tool refused, one attempt, and the
 * process ended afterwards. The agent is a hand-authored ACP stand-in at the connection boundary (`connect`); it
 * proves Mousse's side only.
 *
 * Inputs the agent may send during the prompt: text (answer), a `tool_call` update, a permission request, a client
 * file read, a cancelled stop reason, nothing until Stop.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AntigravityProviderService } from '../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import type { AcpClientHandlers, AcpLaunchRequest } from '../src/mms/harness/acp/connection'
import { antigravityDriver } from '../src/mms/harness/drivers/antigravity'
import { ProviderInstanceService } from '../src/mms/harness/instanceMap'
import type { Harness } from '../src/mms/harness/gateway'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { testHarness } from '../src/mms/run/testkit/harness'

const homes: string[] = []
const services: AntigravityProviderService[] = []
const harnesses: Harness[] = []
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const service of services.splice(0)) service.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

type Agent = { handlers: AcpClientHandlers; update(update: unknown): void; aborted: AbortSignal }
/** What the agent's own requests were answered, in order. */
const answers: unknown[] = []
afterEach(() => { answers.length = 0 })
type Script = (agent: Agent) => Promise<unknown>

/** An Antigravity service whose agent processes are scripted: `prompt` answers each `session/prompt`. */
function fixture(prompt: Script) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-agy-one-shot-'))
  homes.push(home)
  const processes: Array<{ requests: Array<[string, Record<string, unknown>]>; close: ReturnType<typeof vi.fn>; launched: AcpLaunchRequest }> = []
  const questions = new UserQuestionService()
  const service = new AntigravityProviderService(home, home, questions, undefined, {
    connect: (launched) => {
      const abort = new AbortController()
      const requests: Array<[string, Record<string, unknown>]> = []
      const close = vi.fn(() => abort.abort(new Error('ACP closed')))
      const active = {
        child: { exitCode: null, signalCode: null, kill: vi.fn() },
        connection: {
          signal: abort.signal,
          close,
          agent: {
            request: vi.fn(async (method: string, params: Record<string, unknown>) => {
              requests.push([method, params])
              abort.signal.throwIfAborted()
              if (method === methods.agent.initialize) return { protocolVersion: PROTOCOL_VERSION }
              if (method === methods.agent.session.new) return {
                sessionId: `session-${processes.length}`,
                configOptions: [{ id: 'model', type: 'select', options: [{ value: 'account-model', name: 'Account Model' }] }]
              }
              if (method === methods.agent.session.prompt) {
                const agent: Agent = { handlers: launched.handlers, update: (update) => active.onUpdate?.(update), aborted: abort.signal }
                // The connection closing rejects the request, as the SDK does.
                const closed = new Promise((_resolve, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true }))
                return await Promise.race([closed, prompt(agent)])
              }
              return {}
            }),
            notify: vi.fn(async () => undefined)
          }
        },
        onUpdate: undefined as ((update: unknown) => void) | undefined
      }
      processes.push({ requests, close, launched })
      return active as never
    }
  })
  services.push(service)
  vi.spyOn(service, 'configured').mockReturnValue(true)
  vi.spyOn(service, 'models').mockReturnValue([{ id: 'account-model', label: 'Account Model' }])
  // The store the model check reads (`AcpSessions.selectModel`).
  ;(service as unknown as { settings: { models: unknown[] } }).settings.models = [{ id: 'account-model', label: 'Account Model' }]
  const spec = (patch: Partial<Parameters<AntigravityProviderService['oneShot']>[0]> = {}) => ({
    model: 'account-model', system: 'You name chats.', prompt: 'User request: fix the login bug', onActivity: vi.fn(), ...patch
  })
  const oneShotDir = join(home, 'providers', 'antigravity', 'one-shot')
  return { service, processes, spec, questions, oneShotDir }
}

const text = (value: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })

describe('Antigravity one-shot', () => {
  it('answers with the agent text from a session of its own in an empty folder, with no MCP server, and ends the process', async () => {
    const s = fixture(async (agent) => {
      agent.update(text('Fix the '))
      agent.update(text('login bug'))
      return { stopReason: 'end_turn' }
    })
    const spec = s.spec()
    const result = await s.service.oneShot(spec, new AbortController().signal)
    expect(result).toEqual({ text: 'Fix the login bug' })
    expect(s.processes).toHaveLength(1)
    const [process] = s.processes
    expect(process.launched.purpose).toBe('one_shot')
    const opened = process.requests.find(([method]) => method === methods.agent.session.new)![1]
    expect(opened.mcpServers).toEqual([])
    expect(String(opened.cwd).startsWith(s.oneShotDir)).toBe(true)
    // The folder is gone afterwards.
    expect(readdirSync(s.oneShotDir)).toEqual([])
    expect(process.requests).toContainEqual([methods.agent.session.setConfigOption, expect.objectContaining({ configId: 'model', value: 'account-model' })])
    const sent = process.requests.find(([method]) => method === methods.agent.session.prompt)![1].prompt as Array<{ type: string; text: string }>
    expect(sent).toEqual([{ type: 'text', text: 'You name chats.\n\nUser request: fix the login bug' }])
    expect(spec.onActivity).toHaveBeenCalled()
    expect(process.close).toHaveBeenCalled()
  })

  it.each([
    ['a tool call update', async (agent: Agent) => {
      agent.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', name: 'view_file' })
      agent.update(text('after the tool'))
      return await new Promise(() => {})
    }],
    ['a permission request', async (agent: Agent) => {
      answers.push(await agent.handlers.requestPermission({ sessionId: 's', toolCall: { toolCallId: 't1', title: 'Run command' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } as never))
      return await new Promise(() => {})
    }],
    ['a client file read', async (agent: Agent) => {
      answers.push(await agent.handlers.readTextFile!({ sessionId: 's', path: '/etc/hosts' } as never).catch((error: Error) => `refused: ${error.message}`))
      return await new Promise(() => {})
    }]
  ])('ends the request as refused on %s, asks nobody, and ends the process', async (_name, script) => {
    const s = fixture(script)
    const asked = vi.spyOn(s.questions, 'requestAnswers')
    await expect(s.service.oneShot(s.spec(), new AbortController().signal)).rejects.toMatchObject({ code: 'policy_unenforceable' })
    expect(asked).not.toHaveBeenCalled()
    // A permission is answered cancelled, a file read fails: nothing is allowed.
    for (const answer of answers) expect(answer).toSatisfy((value) => typeof value === 'string' ? value.startsWith('refused:') : (value as { outcome: { outcome: string } }).outcome.outcome === 'cancelled')
    expect(s.processes[0].close).toHaveBeenCalled()
    expect(readdirSync(s.oneShotDir)).toEqual([])
  })

  it('Stop aborts a prompt the agent never answers, and ends the process', async () => {
    const s = fixture(async () => await new Promise(() => {}))
    const stop = new AbortController()
    const pending = s.service.oneShot(s.spec(), stop.signal)
    await vi.waitFor(() => expect(s.processes[0]?.requests.some(([method]) => method === methods.agent.session.prompt)).toBe(true))
    stop.abort()
    await expect(pending).rejects.toBeDefined()
    expect(s.processes[0].close).toHaveBeenCalled()
    expect(s.processes).toHaveLength(1)
  })

  it('a prompt the agent ends cancelled is a failure, not an empty title, and is not tried again', async () => {
    const s = fixture(async (agent) => {
      agent.update(text('partial'))
      return { stopReason: 'cancelled' }
    })
    await expect(s.service.oneShot(s.spec(), new AbortController().signal)).rejects.toBeDefined()
    expect(s.processes).toHaveLength(1)
  })

  it("agy's quota notice sent as the reply is a rate limit, not a title", async () => {
    // The reply agy 1.5.13 sent for a model whose quota was used up (seen live, November 2026).
    const s = fixture(async (agent) => {
      agent.update(text('\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h28m19s.\n'))
      return { stopReason: 'end_turn' }
    })
    await expect(s.service.oneShot(s.spec(), new AbortController().signal)).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('a stop before it starts launches nothing', async () => {
    const s = fixture(async () => ({ stopReason: 'end_turn' }))
    const stop = new AbortController()
    stop.abort()
    await expect(s.service.oneShot(s.spec(), stop.signal)).rejects.toBeDefined()
    expect(s.processes).toHaveLength(0)
    expect(existsSync(s.oneShotDir)).toBe(false)
  })
})

describe('gateway one-shot on Antigravity', () => {
  it('lists Antigravity for chat titles and runs a title request through its driver', async () => {
    const s = fixture(async (agent) => {
      agent.update(text('Login bug'))
      return { stopReason: 'end_turn' }
    })
    vi.spyOn(s.service, 'signedIn').mockReturnValue(true)
    let stored: unknown = { antigravity: { driver: 'antigravity', enabled: true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = testHarness({ drivers: [antigravityDriver({ builtIn: () => s.service })], instances, profileHome: homes[0] })
    harnesses.push(harness)
    const listed = (await harness.llmProviders({ kind: 'device' })).find((provider) => provider.instanceId === 'antigravity')
    expect(listed?.oneShot).toBe(true)
    const answer = await harness.oneShot({
      selection: { instanceId: 'antigravity', llmProvider: 'antigravity', model: 'account-model' },
      purpose: 'title',
      system: 'You name chats.',
      prompt: 'User request: fix the login bug',
      maxChars: 80
    })
    expect(answer).toEqual({ text: 'Login bug' })
    expect(s.processes).toHaveLength(1)
  })
})
