/**
 * Antigravity runs Mousse's one-shot requests (chat titles, drafts): a fresh agent process and session of its own in a
 * new empty folder, no MCP server, the system text and prompt as one prompt, every tool refused, one attempt, and the
 * process ended afterwards. The agent is a hand-authored ACP stand-in at the connection boundary (`connect`); it
 * proves Mousse's side only.
 *
 * Inputs the agent may send during the prompt: text (answer), too much text, a `tool_call` update before any text,
 * a permission request, a client file read, a terminal request, an unknown extension request, a question, a file
 * left in its folder, an empty folder left there, a cancelled stop reason, nothing until Stop, nothing until the
 * deadline. Inputs of the home: hooks or MCP servers set, a blank or empty config, a malformed config. Session
 * files: this request's, another session's, this session's naming another folder.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AntigravityProviderService } from '../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import { ONE_SHOT_DEADLINE_MS, ONE_SHOT_INSTRUCTION, ONE_SHOT_OUTPUT_CAP } from '../src/mms/harness/acp/session'
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

type Agent = { handlers: AcpClientHandlers; update(update: unknown): void; aborted: AbortSignal; cwd: string; sessionId: string }
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
      // Closing ends the process, which then reports its exit (`AcpLaunchRequest.onExit`).
      const close = vi.fn(() => {
        if (abort.signal.aborted) return
        abort.abort(new Error('ACP closed'))
        launched.onExit?.()
      })
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
                const agent: Agent = { handlers: launched.handlers, update: (update) => active.onUpdate?.(update), aborted: abort.signal, cwd: launched.cwd!, sessionId: String(params.sessionId) }
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
  const geminiHome = join(home, 'providers', 'antigravity', 'gemini-home')
  /** The service runs `agy` (its session files are then removed afterwards). */
  const onAgy = () => vi.spyOn(service as unknown as { runtime(): unknown }, 'runtime').mockReturnValue({ kind: 'native', binary: join(home, 'agy.exe'), source: 'manual' })
  return { service, processes, spec, questions, oneShotDir, geminiHome, onAgy }
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
    // The process starts in the same folder.
    expect(process.launched.cwd).toBe(opened.cwd)
    // The folder is gone afterwards.
    expect(readdirSync(s.oneShotDir)).toEqual([])
    expect(process.requests).toContainEqual([methods.agent.session.setConfigOption, expect.objectContaining({ configId: 'model', value: 'account-model' })])
    const sent = process.requests.find(([method]) => method === methods.agent.session.prompt)![1].prompt as Array<{ type: string; text: string }>
    expect(sent).toEqual([{ type: 'text', text: `${ONE_SHOT_INSTRUCTION}\n\nYou name chats.\n\nUser request: fix the login bug` }])
    expect(spec.onActivity).toHaveBeenCalled()
    expect(process.close).toHaveBeenCalled()
  })

  it.each([
    ['a tool call update before any text', async (agent: Agent) => {
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
    }],
    ['a terminal request', async (agent: Agent) => {
      answers.push(await agent.handlers.refuseRequest!(methods.client.terminal.create).catch((error: Error) => `refused: ${error.message}`))
      return await new Promise(() => {})
    }],
    ['an unknown extension request', async (agent: Agent) => {
      answers.push(await agent.handlers.refuseRequest!('_google/run_workflow').catch((error: Error) => `refused: ${error.message}`))
      return await new Promise(() => {})
    }],
    ['a question', async (agent: Agent) => {
      answers.push(await agent.handlers.createElicitation!({ sessionId: 's', mode: 'form', message: 'Which file?', requestedSchema: { type: 'object', properties: {} } } as never))
      return await new Promise(() => {})
    }]
  ])('ends the request as refused on %s, asks nobody, and ends the process', async (_name, script) => {
    const s = fixture(script)
    const asked = vi.spyOn(s.questions, 'requestAnswers')
    await expect(s.service.oneShot(s.spec(), new AbortController().signal)).rejects.toMatchObject({ code: 'one_shot_tool_refused' })
    expect(asked).not.toHaveBeenCalled()
    // A permission is answered cancelled, a question declined, every other request fails: nothing is allowed.
    for (const answer of answers) expect(answer).toSatisfy((value) => typeof value === 'string' ? value.startsWith('refused:')
      : 'action' in (value as object) ? (value as { action: string }).action === 'decline'
        : (value as { outcome: { outcome: string } }).outcome.outcome === 'cancelled')
    expect(s.processes[0].close).toHaveBeenCalled()
    expect(readdirSync(s.oneShotDir)).toEqual([])
  })

  it('a file the agent leaves in its folder fails the request once the process has ended; empty folders do not', async () => {
    const wrote = fixture(async (agent) => {
      writeFileSync(join(agent.cwd, 'notes.md'), 'hello')
      agent.update(text('Login bug'))
      return { stopReason: 'end_turn' }
    })
    await expect(wrote.service.oneShot(wrote.spec(), new AbortController().signal)).rejects.toMatchObject({ code: 'one_shot_tool_refused', message: expect.stringContaining('notes.md') })
    expect(readdirSync(wrote.oneShotDir)).toEqual([])
    const folders = fixture(async (agent) => {
      mkdirSync(join(agent.cwd, '.agents', 'workflows'), { recursive: true })
      agent.update(text('Login bug'))
      return { stopReason: 'end_turn' }
    })
    await expect(folders.service.oneShot(folders.spec(), new AbortController().signal)).resolves.toEqual({ text: 'Login bug' })
  })

  it.each([
    ['hooks.json', '{"hooks":{"PreToolUse":[{"command":"curl example.com"}]}}', 'wont_run'],
    ['mcp_config.json', '{"mcpServers":{"files":{"command":"npx"}}}', 'wont_run'],
    ['mcp_config.json', '{"mcpServers":', 'wont_run'],
    ['hooks.json', '[]', 'wont_run'],
    ['mcp_config.json', '', undefined],
    ['mcp_config.json', '{"mcpServers":{}}', undefined],
    ['hooks.json', ' \n', undefined]
  ])("the home's config/%s holding %j is refused before anything starts (%s), or runs", async (file, content, refused) => {
    const s = fixture(async (agent) => {
      agent.update(text('Login bug'))
      return { stopReason: 'end_turn' }
    })
    mkdirSync(join(s.geminiHome, 'config'), { recursive: true })
    writeFileSync(join(s.geminiHome, 'config', file), content)
    const run = s.service.oneShot(s.spec(), new AbortController().signal)
    if (!refused) {
      await expect(run).resolves.toEqual({ text: 'Login bug' })
      return
    }
    await expect(run).rejects.toMatchObject({ code: refused, message: expect.stringContaining(file) })
    expect(s.processes).toHaveLength(0)
  })

  it('an answer longer than the cap ends the request and the process', async () => {
    const s = fixture(async (agent) => {
      agent.update(text('x'.repeat(ONE_SHOT_OUTPUT_CAP)))
      agent.update(text('y'))
      return await new Promise(() => {})
    })
    await expect(s.service.oneShot(s.spec(), new AbortController().signal)).rejects.toMatchObject({ code: 'protocol' })
    expect(s.processes[0].close).toHaveBeenCalled()
  })

  it('an agent that keeps the request open past the deadline is stopped, even while it still sends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const s = fixture(async (agent) => {
        agent.update(text('still thinking'))
        return await new Promise(() => {})
      })
      const run = s.service.oneShot(s.spec(), new AbortController().signal)
      const settled = expect(run).rejects.toMatchObject({ code: 'timeout' })
      await vi.waitFor(() => expect(s.processes[0]?.requests.some(([method]) => method === methods.agent.session.prompt)).toBe(true))
      await vi.advanceTimersByTimeAsync(ONE_SHOT_DEADLINE_MS)
      await settled
      expect(s.processes[0].close).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("removes the files of the session it opened, and only those, once they name this request's folder", async () => {
    const appData = join('antigravity-acp')
    const s = fixture(async (agent) => {
      const base = join(s.geminiHome, appData)
      for (const dir of ['conversations', join('brain', agent.sessionId), join('brain', 'other-session'), 'annotations']) mkdirSync(join(base, dir), { recursive: true })
      // agy's saved conversation names its workspace.
      writeFileSync(join(base, 'conversations', `${agent.sessionId}.db`), `workspace file:///${agent.cwd.replaceAll('\\', '/')}`)
      writeFileSync(join(base, 'annotations', `${agent.sessionId}.pbtxt`), '')
      writeFileSync(join(base, 'conversations', 'other-session.db'), `workspace file:///${agent.cwd.replaceAll('\\', '/')}`)
      agent.update(text('Login bug'))
      return { stopReason: 'end_turn' }
    })
    s.onAgy()
    await expect(s.service.oneShot(s.spec(), new AbortController().signal)).resolves.toEqual({ text: 'Login bug' })
    const base = join(s.geminiHome, appData)
    expect(readdirSync(join(base, 'conversations'))).toEqual(['other-session.db'])
    expect(readdirSync(join(base, 'brain'))).toEqual(['other-session'])
    expect(readdirSync(join(base, 'annotations'))).toEqual([])
  })

  it('keeps the files of its session when its saved conversation names another folder', async () => {
    const s = fixture(async (agent) => {
      const conversations = join(s.geminiHome, 'antigravity-acp', 'conversations')
      mkdirSync(conversations, { recursive: true })
      writeFileSync(join(conversations, `${agent.sessionId}.db`), 'workspace file:///somewhere/else')
      agent.update(text('Login bug'))
      return { stopReason: 'end_turn' }
    })
    s.onAgy()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(s.service.oneShot(s.spec(), new AbortController().signal)).resolves.toEqual({ text: 'Login bug' })
    expect(readdirSync(join(s.geminiHome, 'antigravity-acp', 'conversations'))).toEqual(['session-1.db'])
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
