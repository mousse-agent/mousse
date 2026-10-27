import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AntigravityProviderService } from '../src/mms/providers/antigravity/AntigravityProviderService'
import { antigravityAssistantMessage, antigravityHistory } from '../src/mms/providers/antigravity/history'
import { LoginSession } from '../src/mms/providers/LoginSession'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { resolveBoundServices } from '../src/mms/profiles/admission'
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

/** `fail` may return the error a request rejects with. */
function fixture(blockMethod?: string, installed = false, fail?: (method: string) => unknown) {
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
  if (installed) vi.spyOn(service as unknown as { binary: () => string }, 'binary').mockReturnValue(join(home, 'agy_acp_server'))
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
            if (method === methods.agent.session.prompt) active.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: params.prompt?.[0]?.text } })
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
    const { service, input, processes } = fixture(methods.agent.authenticate, true)
    const session = new LoginSession('setup')
    const pending = service.login(session, input.cwd)
    await vi.waitFor(() => expect(processes[0]?.connection.agent.request).toHaveBeenCalledWith(methods.agent.authenticate, expect.anything()))
    await service[operation]()
    expect(await pending).toEqual({ success: false, sessionId: 'setup', error: 'Login cancelled' })
    expect(session.abort.signal.aborted).toBe(true)
  })

  it('goes straight to Google sign-in once installed, without asking how to set up', async () => {
    const { service, input, processes } = fixture(undefined, true)
    const session = new LoginSession('setup')
    const events: unknown[] = []
    session.on('event', (event) => events.push(event))
    expect(await service.login(session, input.cwd)).toEqual({ success: true, sessionId: 'setup' })
    expect(processes[0].connection.agent.request.mock.calls.map(([method]) => method)).toEqual([methods.agent.initialize, methods.agent.authenticate, methods.agent.session.new])
    expect(processes[0].connection.agent.request).toHaveBeenCalledWith(methods.agent.authenticate, { methodId: 'oauth-personal' })
    // A process that started before this sign-in can no longer sign the profile out.
    expect((service as unknown as { signInGeneration: number }).signInGeneration).toBe(1)
    // Only the Google redirect-URL fallback may be offered; never a setup choice or a path prompt.
    expect((events as Array<{ type: string }>).map((event) => event.type).filter((type) => type !== 'manual_code')).toEqual([])
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

describe('Antigravity auth-required answers', () => {
  const authRequired = () => RequestError.authRequired()
  const signedInSettings = { signedIn: true, models: [{ id: 'account-model', label: 'Account Model' }] }
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
    expect(saved()).toMatchObject({ signedIn: false, models: [] })
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
    expect(saved()).toMatchObject({ signedIn: false, models: [] })
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
    expect(saved()).toMatchObject({ signedIn: false, models: [] })
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
  it('routes personal ACP operations to the bound profile and keeps shared API credentials on the installation', async () => {
    const personal = {} as MmsProfileServices
    const host = { activeProfileCount: () => 2, manager: { get: () => ({ id: 'personal', status: 'active' }) }, getProfileServices: vi.fn(async () => personal) }
    const installation = { getInstallationHost: () => host } as unknown as MmsProfileServices
    const args = { installation, binding: { profileId: 'personal', epoch: 1 }, capabilities: new Set([PROFILES_V1_CAPABILITY]) }
    for (const method of ['providers.listConfigured', 'providers.getLoginOptions', 'providers.refreshModels', 'providers.loginOAuth', 'providers.logout']) {
      expect((await resolveBoundServices({ ...args, method })).services, method).toBe(personal)
    }
    expect((await resolveBoundServices({ ...args, method: 'providers.setApiKey' })).services).toBe(installation)
    await expect(resolveBoundServices({ ...args, binding: undefined, method: 'providers.loginOAuth' })).rejects.toMatchObject({ code: 'profile_binding_required' })
  })
})
