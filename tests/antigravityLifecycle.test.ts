import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AntigravityProviderService } from '../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import { antigravityAssistantMessage, antigravityHistory } from '../src/mms/harness/acp/presets/antigravity/history'
import { LoginSession } from '../src/mms/providers/LoginSession'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { resolveBoundServices } from '../src/mms/profiles/admission'
import { decideUsageLimit } from '../src/mms/run/pausePolicy'
import { pausedLine } from '../src/mms/run/pauseText'
import { PROFILES_V1_CAPABILITY } from '../src/shared/profiles/types'
import type { MmsProfileServices } from '../src/mms/MmsProfileServices'
import type { NativeLlmContext } from '../src/shared/types'

const homes: string[] = []
const services: AntigravityProviderService[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** `fail` may return the error a request rejects with; `kind` is the agent that runs once installed. */
function fixture(blockMethod?: string, installed = false, fail?: (method: string) => unknown, kind: 'native' | 'legacy' = 'native', reply?: string) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-acp-lifecycle-'))
  homes.push(home)
  const processes: Array<ReturnType<typeof createProcess>> = []
  // Replace only the external process boundary; exercise the production lifecycle.
  const service = new AntigravityProviderService(home, home, new UserQuestionService(), undefined, {
    connect: () => {
      const active = createProcess()
      processes.push(active)
      return active as never
    }
  })
  services.push(service)
  vi.spyOn(service, 'configured').mockReturnValue(true)
  if (installed) vi.spyOn(service as unknown as { runtime: () => unknown }, 'runtime')
    .mockReturnValue({ kind, binary: join(home, kind === 'native' ? 'agy' : 'agy_acp_server'), source: 'managed' })
  let finishPrompt: (() => void) | undefined
  function createProcess() {
    const abort = new AbortController()
    const active = {
      child: { exitCode: 0, signalCode: null, kill: vi.fn() },
      connection: {
        signal: abort.signal,
        close: vi.fn(() => abort.abort(new Error('ACP closed'))),
        agent: {
          request: vi.fn(async (method: string, params: { prompt?: Array<{ text?: string }> }) => {
            const failure = fail?.(method)
            if (failure) throw failure
            if (method === blockMethod) {
              await new Promise<void>((resolve, reject) => {
                if (method === methods.agent.session.prompt) finishPrompt = resolve
                abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })
              })
            }
            if (method === methods.agent.initialize) return { protocolVersion: PROTOCOL_VERSION }
            if (method === methods.agent.session.new || method === methods.agent.session.resume) return {
              sessionId: `session-${processes.length}`,
              configOptions: [{ id: 'model', type: 'select', options: [{ value: 'account-model', name: 'Account Model' }] }]
            }
            if (method === methods.agent.session.prompt) active.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply ?? params.prompt?.[0]?.text } })
            return { stopReason: 'end_turn' }
          }),
          notify: vi.fn(async () => { finishPrompt?.(); blockMethod = undefined })
        }
      },
      onUpdate: undefined as ((update: unknown) => void) | undefined
    }
    return active
  }
  const input = { threadId: 'thread', cwd: home, model: 'account-model', prompt: 'current request', onText: vi.fn() }
  return { service, input, processes }
}

describe('Antigravity turn lifecycle', () => {
  it.each([methods.agent.initialize, methods.agent.session.new, methods.agent.session.setConfigOption])('stops during %s before dispatching a prompt', async (method) => {
    const { service, input, processes } = fixture(method)
    const abort = new AbortController()
    const pending = service.chat({ ...input, signal: abort.signal })
    const failed = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(processes[0]?.connection.agent.request).toHaveBeenCalledWith(method, expect.anything()))
    abort.abort()
    await failed
    expect(processes[0].connection.agent.request.mock.calls.some(([name]) => name === methods.agent.session.prompt)).toBe(false)
  })

  it('reuses only committed matching history and rebuilds after undo or provider switch', async () => {
    const { service, input, processes } = fixture()
    await service.chat({ ...input, history: 'previous provider history' })
    expect(processes[0].connection.agent.request.mock.calls.find(([name]) => name === methods.agent.session.prompt)?.[1].prompt?.[0].text).toContain('previous provider history')
    service.commitConversation(input.threadId, 'completed history')
    await service.chat({ ...input, history: 'completed history' })
    expect(processes).toHaveLength(1)
    service.commitConversation(input.threadId, 'longer completed history')
    await service.chat({ ...input, history: 'restored branch history' })
    expect(processes).toHaveLength(2)
    expect(processes[0].connection.close).toHaveBeenCalled()
    expect(processes[1].connection.agent.request.mock.calls.find(([name]) => name === methods.agent.session.prompt)?.[1].prompt?.[0].text).toContain('restored branch history')
  })

  it('replaces an idle agent process after the launch settings change, resuming its session', async () => {
    const { service, input, processes } = fixture()
    await service.chat({ ...input, history: '' })
    service.commitConversation(input.threadId, 'committed')
    // The gateway saved new launch settings to the instance config and tells the service.
    service.launchChanged()
    expect(processes[0].connection.close).toHaveBeenCalled()
    await service.chat({ ...input, history: 'committed' })
    expect(processes).toHaveLength(2)
    expect(processes[1].connection.agent.request).toHaveBeenCalledWith(methods.agent.session.resume, expect.objectContaining({ sessionId: 'session-1' }))
  })

  it('cancels an active ACP prompt and delivers accepted steer within the same turn', async () => {
    const { service, input, processes } = fixture(methods.agent.session.prompt)
    let steer: string | undefined
    const onSteer = vi.fn()
    const pending = service.chat({ ...input, drainSteer: () => { const value = steer; steer = undefined; return value }, onSteer })
    await vi.waitFor(() => expect(processes[0]?.connection.agent.request.mock.calls.some(([name]) => name === methods.agent.session.prompt)).toBe(true))
    steer = 'Focus on the bug'
    await pending
    expect(onSteer).toHaveBeenCalledExactlyOnceWith('Focus on the bug')
    expect(processes[0].connection.agent.notify).toHaveBeenCalledWith(methods.agent.session.cancel, expect.anything())
    const prompts = processes[0].connection.agent.request.mock.calls.filter(([name]) => name === methods.agent.session.prompt)
    expect(prompts).toHaveLength(2)
    expect(prompts[1][1].prompt).toEqual([{ type: 'text', text: 'Focus on the bug' }])
  })

  it.each(['stop', 'logout'] as const)('releases profile-owned login work on %s while Google sign-in is pending', async (operation) => {
    const { service, input, processes } = fixture(methods.agent.authenticate, true, undefined, 'legacy')
    const session = new LoginSession('setup')
    const pending = service.login(session, input.cwd)
    await vi.waitFor(() => expect(processes[0]?.connection.agent.request).toHaveBeenCalledWith(methods.agent.authenticate, expect.anything()))
    await service[operation]()
    expect(await pending).toEqual({ success: false, sessionId: 'setup', error: 'Login cancelled' })
    expect(session.abort.signal.aborted).toBe(true)
  })

  it('goes straight to Google sign-in on the 1.1.1 server once installed, without asking how to set up', async () => {
    const { service, input, processes } = fixture(undefined, true, undefined, 'legacy')
    const session = new LoginSession('setup')
    const events: unknown[] = []
    session.on('event', (event) => events.push(event))
    expect(await service.login(session, input.cwd)).toEqual({ success: true, sessionId: 'setup' })
    expect(processes[0].connection.agent.request.mock.calls.map(([method]) => method)).toEqual([methods.agent.initialize, methods.agent.authenticate, methods.agent.session.new])
    expect(processes[0].connection.agent.request).toHaveBeenCalledWith(methods.agent.authenticate, { methodId: 'oauth-personal' })
    // A process that started before this sign-in can no longer sign the profile out.
    expect((service as unknown as { signInGeneration: number }).signInGeneration).toBe(1)
    // Only that it is starting: no setup choice or path prompt, and with no Google link printed, no paste field.
    expect((events as Array<{ type: string }>).map((event) => event.type)).toEqual(['progress'])
  })

  it('signs in on agy without a Google flow when the agy on this computer is already signed in', async () => {
    const { service, input, processes } = fixture(undefined, true)
    const session = new LoginSession('setup')
    const events: Array<{ type: string; message?: string }> = []
    session.on('event', (event) => events.push(event))
    expect(await service.login(session, input.cwd)).toEqual({ success: true, sessionId: 'setup' })
    expect(processes[0].connection.agent.request.mock.calls.map(([method]) => method)).toEqual([methods.agent.initialize, methods.agent.session.new])
    expect(events.map((event) => event.message)).toEqual(['Starting Antigravity…'])
    expect(service.signedIn()).toBe(true)
  })

  it('runs Google sign-in on agy when it asks for one', async () => {
    let asked = false
    const { service, input, processes } = fixture(undefined, true, (method) => {
      if (method !== methods.agent.session.new || asked) return undefined
      asked = true
      return RequestError.authRequired()
    })
    const session = new LoginSession('setup')
    const events: Array<{ type: string; message?: string }> = []
    session.on('event', (event) => events.push(event))
    expect(await service.login(session, input.cwd)).toEqual({ success: true, sessionId: 'setup' })
    expect(processes[0].connection.agent.request.mock.calls.map(([method]) => method))
      .toEqual([methods.agent.initialize, methods.agent.session.new, methods.agent.authenticate, methods.agent.session.new])
    expect(events.map((event) => event.message)).toEqual(['Starting Antigravity…', 'Starting Google sign-in…'])
  })

  it('does not start Google sign-in on agy for an error that is not a sign-in request', async () => {
    const { service, input, processes } = fixture(undefined, true, (method) => method === methods.agent.session.new && new RequestError(-32603, 'network down'))
    const session = new LoginSession('setup')
    expect(await service.login(session, input.cwd)).toMatchObject({ success: false, error: 'network down' })
    expect(processes[0].connection.agent.request.mock.calls.map(([method]) => method)).not.toContain(methods.agent.authenticate)
  })

  it('fails sign-in fast, without a prompt or an agent, when Antigravity is not installed', async () => {
    const { service, input, processes } = fixture()
    const session = new LoginSession('setup')
    const events: unknown[] = []
    session.on('event', (event) => events.push(event))
    expect(await service.login(session, input.cwd)).toEqual({ success: false, sessionId: 'setup', error: 'Install Antigravity first, then sign in' })
    expect(events).toEqual([])
    expect(processes).toHaveLength(0)
  })
})

describe('Antigravity after a turn that did not finish', () => {
  const promptsOf = (process: { connection: { agent: { request: { mock: { calls: unknown[][] } } } } }) => process.connection.agent.request.mock.calls
    .filter(([name]) => name === methods.agent.session.prompt)
    .map(([, params]) => (params as { prompt: Array<{ text?: string }> }).prompt.map((block) => block.text).join('\n'))
  const quota = () => new RequestError(-32603, 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4h29m13s.')

  it('resumes the session after a failed prompt, sending only the new message', async () => {
    let failing = false
    const { service, input, processes } = fixture(undefined, false, (method) => failing && method === methods.agent.session.prompt && quota())
    await service.chat({ ...input, prompt: 'first', history: 'old history' })
    service.commitConversation(input.threadId, 'after first')
    failing = true
    await expect(service.chat({ ...input, prompt: 'second', history: 'after first' })).rejects.toThrow()
    // The adapter reports the history the failed turn left: its request, no reply.
    service.commitInterrupted(input.threadId, 'after first + second')
    failing = false
    await service.chat({ ...input, prompt: 'third', history: 'after first + second' })
    expect(processes).toHaveLength(2)
    expect(processes[1].connection.agent.request).toHaveBeenCalledWith(methods.agent.session.resume, expect.objectContaining({ sessionId: 'session-1' }))
    expect(processes[1].connection.agent.request).not.toHaveBeenCalledWith(methods.agent.session.new, expect.anything())
    expect(promptsOf(processes[1])).toEqual(['third'])
  })

  it('resumes the session after a stopped prompt', async () => {
    const { service, input, processes } = fixture()
    await service.chat({ ...input, prompt: 'first' })
    service.commitConversation(input.threadId, 'after first')
    const stop = new AbortController()
    const first = processes[0]
    const answer = first.connection.agent.request.getMockImplementation()!
    first.connection.agent.request.mockImplementation(async (method: string, params: { prompt?: Array<{ text?: string }> }) => {
      if (method !== methods.agent.session.prompt) return answer(method, params)
      // The prompt is running when Stop closes the agent's process.
      return new Promise<never>((_, reject) => {
        first.connection.signal.addEventListener('abort', () => reject(first.connection.signal.reason), { once: true })
        stop.abort()
      })
    })
    await expect(service.chat({ ...input, prompt: 'second', history: 'after first', signal: stop.signal })).rejects.toThrow()
    service.commitInterrupted(input.threadId, 'after first + second')
    await service.chat({ ...input, prompt: 'third', history: 'after first + second' })
    expect(processes[1].connection.agent.request).toHaveBeenCalledWith(methods.agent.session.resume, expect.objectContaining({ sessionId: 'session-1' }))
    expect(promptsOf(processes[1])).toEqual(['third'])
  })

  it('hands the history over again when a new session failed its first prompt before the agent worked on it', async () => {
    // That prompt carried the handed-over history; the agent may never have kept it.
    let failing = true
    const { service, input, processes } = fixture(undefined, false, (method) => failing && method === methods.agent.session.prompt && quota())
    await expect(service.chat({ ...input, prompt: 'first', history: 'old history' })).rejects.toThrow()
    service.commitInterrupted(input.threadId, 'old history + first')
    failing = false
    await service.chat({ ...input, prompt: 'second', history: 'old history + first' })
    expect(processes[1].connection.agent.request).not.toHaveBeenCalledWith(methods.agent.session.resume, expect.anything())
    expect(promptsOf(processes[1])[0]).toContain('old history + first')
  })

  it('hands the history over again when the failed prompt carried a steer the agent never showed it read', async () => {
    // The steer goes back and runs again: the agent may hold it while Mousse's history does not.
    let failing = false
    const { service, input, processes } = fixture(undefined, false, (method) => failing && method === methods.agent.session.prompt && quota())
    await service.chat({ ...input, prompt: 'first' })
    service.commitConversation(input.threadId, 'after first')
    failing = true
    let steer: { text: string; token: string } | undefined = { text: 'also check the tests', token: 'steer-1' }
    const returnSteer = vi.fn()
    await expect(service.chat({ ...input, prompt: 'second', history: 'after first', drainSteerEntry: () => { const entry = steer; steer = undefined; return entry }, returnSteer })).rejects.toThrow()
    expect(returnSteer).toHaveBeenCalledWith('also check the tests', 'steer-1')
    service.commitInterrupted(input.threadId, 'after first + second')
    failing = false
    await service.chat({ ...input, prompt: 'third', history: 'after first + second' })
    expect(processes[1].connection.agent.request).not.toHaveBeenCalledWith(methods.agent.session.resume, expect.anything())
    expect(promptsOf(processes[1])[0]).toContain('after first + second')
  })
})

describe('Antigravity quota answers', () => {
  // agy 1.5's own words when the account's quota is spent (its session/prompt error).
  const QUOTA = 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h29m13s.'
  const pauseFor = async (error: unknown) => {
    const { service, input } = fixture(undefined, false, (name) => name === methods.agent.session.prompt && error)
    const failure = await service.chat(input).then(() => undefined, (caught: unknown) => caught)
    return decideUsageLimit({ error: failure, run: {}, lookup: () => null, cap: 3, autoResume: true, nowMs: Date.now() })
  }

  it.each([
    ['as its message', new RequestError(-32603, QUOTA)],
    ['as the data under the SDK label', new RequestError(-32603, 'Internal error', QUOTA)]
  ])('pauses the run until the reset agy names (%s)', async (_, error) => {
    const before = Date.now()
    const decision = await pauseFor(error)
    expect(decision?.action).toBe('pause')
    const pause = decision?.action === 'pause' ? decision.pause : undefined
    const resetMs = ((4 * 60 + 29) * 60 + 13) * 1000
    expect(Date.parse(pause!.until) - before).toBeGreaterThanOrEqual(resetMs - 1000)
    expect(Date.parse(pause!.until) - Date.now()).toBeLessThanOrEqual(resetMs + 1000)
    expect(pause).toMatchObject({ estimated: false, provider: 'antigravity' })
    expect(pausedLine(pause!)).toContain("Antigravity's usage limit was reached (time reported by Antigravity)")
  })

  it('pauses on an estimate when agy names no reset time', async () => {
    const decision = await pauseFor(new RequestError(-32603, 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits.'))
    expect(decision?.action === 'pause' && decision.pause).toMatchObject({ estimated: true, provider: 'antigravity' })
  })

  it.each([
    'RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).',
    'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 5s.'
  ])('leaves a rate limit that clears in seconds as an ordinary failure: %s', async (text) => {
    expect(await pauseFor(new RequestError(-32603, text))).toBeUndefined()
  })

  // agy 1.5.13 also answers a spent quota as its reply, with a normal end.
  const NOTICE = '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h45m30s.'
  const replyOutcome = async (reply: string) => {
    const { service, input } = fixture(undefined, false, undefined, 'native', reply)
    return service.chat(input).then((text) => ({ text }), (error: unknown) => ({ error }))
  }

  it.each([
    ['as the whole reply', `\n${NOTICE}\n`],
    ['after what agy wrote first', `Checking the build.\n\n${NOTICE}`]
  ])('fails the turn and pauses the run when agy answers with its quota notice (%s)', async (_, reply) => {
    const before = Date.now()
    const outcome = await replyOutcome(reply)
    expect(outcome).toHaveProperty('error')
    const decision = decideUsageLimit({ error: (outcome as { error: unknown }).error, run: {}, lookup: () => null, cap: 3, autoResume: true, nowMs: Date.now() })
    const pause = decision?.action === 'pause' ? decision.pause : undefined
    expect(pause).toMatchObject({ estimated: false, provider: 'antigravity' })
    expect(Date.parse(pause!.until) - before).toBeGreaterThanOrEqual(((3 * 60 + 45) * 60 + 30) * 1000 - 1000)
  })

  it('keeps a reply that only mentions the notice before going on', async () => {
    const reply = `The log said "Individual quota reached." earlier.\n\nThe build passes now.`
    expect(await replyOutcome(reply)).toEqual({ text: reply })
  })
})

describe('Antigravity auth-required answers', () => {
  const authRequired = () => RequestError.authRequired()
  const signedInSettings = { nativeSignedIn: true, models: [{ id: 'account-model', label: 'Account Model' }] }
  const arm = (service: AntigravityProviderService) => {
    ;(service as unknown as { settings: unknown }).settings = { ...signedInSettings }
    const changed = vi.fn()
    service.hooks.changed = changed
    const saved = () => JSON.parse(readFileSync(join((service as unknown as { profileDir: string }).profileDir, 'settings.json'), 'utf8'))
    return { changed, saved }
  }

  it.each([methods.agent.session.new, methods.agent.session.setConfigOption, methods.agent.session.prompt])('marks the provider signed out when %s answers authentication required, keeping the chat error', async (method) => {
    const { service, input } = fixture(undefined, false, (name) => name === method && authRequired())
    const { changed, saved } = arm(service)
    await expect(service.chat(input)).rejects.toThrow('Sign in to Antigravity in Settings before chatting')
    expect(saved()).toMatchObject({ nativeSignedIn: false, models: [] })
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['Not logged in', undefined],
    ['Please sign in', undefined],
    ['Request failed', { type: 'auth_required' }]
  ])('also recognizes Google wording: %s', async (message, data) => {
    const { service, input } = fixture(undefined, false, (name) => name === methods.agent.session.new && new RequestError(-32000, message, data))
    const { changed, saved } = arm(service)
    await expect(service.chat(input)).rejects.toThrow('Sign in to Antigravity in Settings before chatting')
    expect(saved()).toMatchObject({ nativeSignedIn: false, models: [] })
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('needs the -32000 code: the same words under another code are an ordinary failure', async () => {
    const { service, input } = fixture(undefined, false, (name) => name === methods.agent.session.new && new RequestError(-32603, 'Not logged in'))
    const { changed } = arm(service)
    await expect(service.chat(input)).rejects.toThrow('Not logged in')
    expect(changed).not.toHaveBeenCalled()
  })

  it('marks the provider signed out when a model refresh is asked to authenticate', async () => {
    const { service, input } = fixture(undefined, false, (name) => name === methods.agent.session.new && authRequired())
    const { changed, saved } = arm(service)
    await expect(service.refreshModels(input.cwd)).rejects.toThrow('Sign in to Antigravity in Settings before chatting')
    expect(saved()).toMatchObject({ nativeSignedIn: false, models: [] })
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('does not sign out for other agent errors', async () => {
    const { service, input } = fixture(undefined, false, (name) => name === methods.agent.session.prompt && new RequestError(-32000, 'turn failed'))
    const { changed } = arm(service)
    await expect(service.chat(input)).rejects.toThrow('turn failed')
    expect(changed).not.toHaveBeenCalled()
    expect(service.llmProvider()).toBeDefined()
  })

  it('does not sign out for a request from before the latest sign-in', async () => {
    let holder: AntigravityProviderService | undefined
    const { service, input } = fixture(undefined, false, (name) => {
      if (name !== methods.agent.session.new) return undefined
      ;(holder as unknown as { signInGeneration: number }).signInGeneration += 1 // a login finishes during the request
      return authRequired()
    })
    holder = service
    const { changed } = arm(service)
    await expect(service.chat(input)).rejects.toThrow('Sign in to Antigravity in Settings before chatting')
    expect(changed).not.toHaveBeenCalled()
    expect(service.llmProvider()).toBeDefined()
  })
})

describe('Antigravity canonical history', () => {
  it('keeps selected text lineage while excluding retired history, images and reasoning', () => {
    const context: NativeLlmContext = {
      version: 2, fidelity: 'native', activeStartIndex: 1,
      messages: [
        { role: 'user', content: 'compacted text', timestamp: 1 },
        { role: 'user', content: [{ type: 'text', text: 'selected question' }, { type: 'image', data: 'private-binary', mimeType: 'image/png' }], timestamp: 2 },
        { ...antigravityAssistantMessage('selected answer', 'account-model'), content: [{ type: 'thinking', thinking: 'private-reasoning' }, { type: 'text', text: 'selected answer' }] },
        { role: 'user', content: 'current request', timestamp: 3 }
      ]
    }
    const history = antigravityHistory(context, 3)
    expect(history).toContain('selected question')
    expect(history).toContain('selected answer')
    for (const excluded of ['compacted text', 'private-binary', 'private-reasoning', 'current request']) expect(history).not.toContain(excluded)
  })
})

describe('Antigravity profile admission', () => {
  it('routes personal ACP operations to the bound profile and needs a binding for them', async () => {
    const personal = {} as MmsProfileServices
    const host = { activeProfileCount: () => 2, manager: { get: () => ({ id: 'personal', status: 'active' }) }, getProfileServices: vi.fn(async () => personal) }
    const installation = { getInstallationHost: () => host } as unknown as MmsProfileServices
    const args = { installation, binding: { profileId: 'personal', epoch: 1 }, capabilities: new Set([PROFILES_V1_CAPABILITY]) }
    for (const method of ['providers.catalog.addOptions', 'providers.instances.add', 'providers.instances.setSecret', 'providers.instances.signIn', 'providers.instances.remove']) {
      expect((await resolveBoundServices({ ...args, method })).services, method).toBe(personal)
    }
    await expect(resolveBoundServices({ ...args, binding: undefined, method: 'providers.instances.signIn' })).rejects.toMatchObject({ code: 'profile_binding_required' })
  })
})

describe('Antigravity reasoning level discovery and cache refresh', () => {
  it('treats pre-fix native model lists without efforts as stale once, then refreshes and notifies on change', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-agy-efforts-'))
    homes.push(home)
    const requests: Array<[string, Record<string, unknown>]> = []
    const service = new AntigravityProviderService(home, home, new UserQuestionService(), undefined, {
      connect: () => {
        const abort = new AbortController()
        return {
          child: { exitCode: 0, signalCode: null, kill: vi.fn() },
          connection: {
            signal: abort.signal,
            close: vi.fn(() => abort.abort(new Error('ACP closed'))),
            agent: {
              request: vi.fn(async (method: string, params: Record<string, unknown>) => {
                requests.push([method, params])
                if (method === methods.agent.initialize) return { protocolVersion: PROTOCOL_VERSION }
                if (method === methods.agent.session.new) return {
                  sessionId: 'ses-1',
                  configOptions: [
                    {
                      id: 'model',
                      category: 'model',
                      type: 'select',
                      currentValue: 'gemini-4-neon',
                      options: [
                        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
                        { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
                        { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }
                      ]
                    },
                    {
                      id: 'thought_level',
                      category: 'thought_level',
                      type: 'select',
                      currentValue: 'high',
                      options: [
                        { value: 'low', name: 'Low' },
                        { value: 'medium', name: 'Medium' },
                        { value: 'high', name: 'High' },
                        { value: 'xhigh', name: 'Extra' }
                      ]
                    }
                  ],
                  models: {
                    currentModelId: 'gemini-4-neon-high',
                    availableModels: [
                      { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
                      { modelId: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
                      { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
                      { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
                      { modelId: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
                      { modelId: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' },
                      { modelId: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
                      { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }
                    ]
                  }
                }
                return {}
              }),
              notify: vi.fn(async () => undefined)
            }
          }
        } as never
      }
    })
    services.push(service)
    vi.spyOn(service, 'configured').mockReturnValue(true)
    vi.spyOn(service as unknown as { runtime: () => unknown }, 'runtime')
      .mockReturnValue({ kind: 'native', binary: join(home, 'agy'), source: 'user' })
    // Simulate a pre-fix settings.json cached from native agy without efforts.
    ;(service as unknown as { settings: unknown }).settings = {
      nativeSignedIn: true,
      models: [{ id: 'gemini-4-neon', label: 'Gemini 4 Neon' }],
      modelsRefreshedAt: '2026-11-25T04:00:00.000Z'
    }
    expect(service.modelsRefreshedAt()).toBeUndefined()

    const refreshed = await service.refreshModels(home)
    expect(refreshed).toEqual([
      { id: 'gemini-4-neon', label: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', thinkingOff: false },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', thinkingOff: false },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
    ])
    // Zero extra setConfigOption calls needed when models.availableModels is present.
    expect(requests.map(([method]) => method)).toEqual([methods.agent.initialize, methods.agent.session.new])
    expect(service.modelsRefreshedAt()).toBeDefined()
  })

  it('probes per-model thought_level options when an agent omits models.availableModels', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-agy-probe-'))
    homes.push(home)
    const modelSelect = (currentValue: string) => ({
      id: 'model',
      category: 'model',
      type: 'select',
      currentValue,
      options: [
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
        { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }
      ]
    })
    const service = new AntigravityProviderService(home, home, new UserQuestionService(), undefined, {
      connect: () => {
        const abort = new AbortController()
        return {
          child: { exitCode: 0, signalCode: null, kill: vi.fn() },
          connection: {
            signal: abort.signal,
            close: vi.fn(() => abort.abort(new Error('ACP closed'))),
            agent: {
              request: vi.fn(async (method: string, params: Record<string, unknown>) => {
                if (method === methods.agent.initialize) return { protocolVersion: PROTOCOL_VERSION }
                if (method === methods.agent.session.new) return {
                  sessionId: 'ses-probe',
                  configOptions: [
                    modelSelect('gemini-4-neon'),
                    { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'xhigh', name: 'Extra' }] }
                  ]
                }
                if (method === methods.agent.session.setConfigOption && params.configId === 'model') {
                  const id = String(params.value)
                  if (id === 'claude-opus-5-5') {
                    return {
                      configOptions: [
                        modelSelect(id),
                        { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }
                      ]
                    }
                  }
                  return { configOptions: [modelSelect(id)] }
                }
                return {}
              }),
              notify: vi.fn(async () => undefined)
            }
          }
        } as never
      }
    })
    services.push(service)
    vi.spyOn(service, 'configured').mockReturnValue(true)
    const refreshed = await service.refreshModels(home)
    expect(refreshed).toEqual([
      { id: 'gemini-4-neon', label: 'Gemini 4 Neon', efforts: ['low', 'high', 'xhigh'], defaultEffort: 'high', thinkingOff: false },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', thinkingOff: false },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
    ])
  })
})
