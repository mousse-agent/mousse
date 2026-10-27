import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runChatgptToken } from '../../src/cli/fastpath/chatgptToken'
import { ChatGptAuth } from '../../src/mms/harness/chatgpt/chatgptAuth'
import { ChatGptTokenBroker } from '../../src/mms/harness/codex/broker'
import type { CodexInstallation } from '../../src/mms/harness/codex/installation'
import { createManagedCodexRuntime, MANAGED_MODEL_PROVIDER } from '../../src/mms/harness/codex/managedRuntime'
import type { DriverContext } from '../../src/mms/harness/driver'
import { decodeCodexConfig } from '../../src/mms/harness/drivers/codex'
import { instanceEnv } from '../../src/mms/harness/env'
import { CHATGPT_USAGE_URL } from '../../src/shared/providerAuth'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import type { CodexLaunch, CodexProcess } from '../../src/mms/providers/codex/CodexAppServerClient'
import type { CodexProviderService } from '../../src/mms/providers/codex/CodexProviderService'
import { FakeIssuer, guardNetwork, plainCodec, tempHomes } from './chatgpt/fakeIssuer'
import { signIn } from './chatgpt/signInFlow'

type Message = { id?: number | string; method?: string; params?: unknown }

/** An app-server stand-in: answers `initialize` and every other request with an empty result. */
function fakeAppServer() {
  const launches: CodexLaunch[] = []
  const messages: Message[] = []
  const exited: boolean[] = []
  /** Processes that ignore signals until `exit(index)` (a stuck Codex). */
  const state = { stubborn: false }
  const exits: Array<() => void> = []
  const launch = (spec: CodexLaunch): CodexProcess => {
    launches.push(spec)
    const index = exited.push(false) - 1
    const stubborn = state.stubborn
    const stdout = new PassThrough()
    const stdin = new PassThrough()
    const exit = (signal: NodeJS.Signals): void => {
      if (exited[index]) return
      exited[index] = true
      process.emit('exit', null, signal)
    }
    const process = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill(signal: NodeJS.Signals = 'SIGTERM') {
        if (stubborn) return true
        if (process.signalCode) return false
        process.signalCode = signal
        setImmediate(() => exit(signal))
        return true
      }
    })
    exits[index] = () => {
      process.signalCode = 'SIGKILL'
      exit('SIGKILL')
    }
    let pending = ''
    stdin.on('data', (chunk: Buffer) => {
      pending += chunk.toString()
      let end: number
      while ((end = pending.indexOf('\n')) !== -1) {
        const message = JSON.parse(pending.slice(0, end)) as Message
        pending = pending.slice(end + 1)
        messages.push(message)
        if (message.id === undefined || !message.method) continue
        const result = message.method === 'initialize' ? { userAgent: 'test', codexHome: '/h', platformFamily: 'unix', platformOs: 'macos' } : { config: {}, layers: [] }
        stdout.write(JSON.stringify({ id: message.id, result }) + '\n')
      }
    })
    return process as unknown as CodexProcess
  }
  return { launch, launches, messages, exited, state, exits, methods: () => messages.map((message) => message.method) }
}

/** The installation's slice the runtime uses, with a lease count. */
function fakeInstallation(path: string) {
  const state = { leases: 0 }
  const installation = {
    installed: () => ({ path, version: '0.162.1' }),
    acquire: () => {
      state.leases += 1
      return () => void (state.leases -= 1)
    },
    unsupportedMessage: () => undefined,
    installing: () => false,
    cancel: () => false
  }
  return { installation: installation as unknown as CodexInstallation, state }
}

/** Runs the token helper in-process, as Codex would through `auth.command`. */
async function helperToken(endpoint: string, leaseId: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const io = {
    stdout: { write: (text: string | Uint8Array, cb?: () => void) => ((stdout += String(text)), cb?.(), true) },
    stderr: { write: (text: string | Uint8Array, cb?: () => void) => ((stderr += String(text)), cb?.(), true) }
  } as unknown as Parameters<typeof runChatgptToken>[1]
  const code = await runChatgptToken(['engine', 'chatgpt-token', endpoint, leaseId], io, { waitMs: 5_000 })
  return { code, stdout, stderr }
}

guardNetwork()
const homes = tempHomes()
let issuer: FakeIssuer
let broker: ChatGptTokenBroker
const cleanup: Array<() => void> = []
beforeEach(async () => {
  issuer = await new FakeIssuer().start()
  broker = new ChatGptTokenBroker()
})
afterEach(async () => {
  for (const step of cleanup.splice(0)) step()
  await broker.close()
  await issuer.stop()
})

function setup(shared?: { profileHome: string; installationHome: string }, serviceDeps: Record<string, unknown> = {}) {
  const { profileHome, installationHome } = shared ?? homes()
  const instanceId = 'codex:managed'
  const stateDir = join(profileHome, 'harness', 'codex-managed')
  const privateHome = join(stateDir, 'home')
  const env = instanceEnv({
    instanceId,
    driver: 'codex',
    configRevision: 0,
    home: privateHome,
    searchPath: [],
    base: { PATH: '/bin', OPENAI_API_KEY: 'sk-parent', CODEX_API_KEY: 'parent-key' }
  })
  const questions = new UserQuestionService()
  const context: DriverContext = {
    instanceId,
    builtIn: false,
    config: { home: 'private', setup: 'managed' },
    env,
    profileHome,
    installationHome,
    stateDir,
    questions,
    findBinary: () => undefined,
    changed: () => {}
  }
  const server = fakeAppServer()
  // The runtime starts only an executable that exists; the fake app-server stands in for it.
  mkdirSync(installationHome, { recursive: true })
  const binary = join(installationHome, process.platform === 'win32' ? 'codex.exe' : 'codex')
  writeFileSync(binary, ['#!/bin/sh', 'exit 0', ''].join('\n'))
  chmodSync(binary, 0o755)
  const { installation, state } = fakeInstallation(binary)
  const helpers: Array<{ endpoint: string; leaseId: string }> = []
  let auth!: ChatGptAuth
  const runtime = createManagedCodexRuntime(context, {
    installation,
    broker,
    auth: (options) => (auth = new ChatGptAuth({ ...options, endpoints: issuer.endpoints, codec: plainCodec })),
    service: { launch: server.launch, ...serviceDeps },
    helper: (endpoint, leaseId) => {
      helpers.push({ endpoint, leaseId })
      return { command: '/opt/mousse-cli', args: ['--cli', 'engine', 'chatgpt-token', endpoint, leaseId], env: { MOUSSE_CLI: '1' } }
    }
  })
  cleanup.push(() => {
    runtime.stop()
    questions.shutdown()
  })
  const service = (runtime.adapter as unknown as { service: () => CodexProviderService }).service()
  /** Starts the app-server, as a turn's preflight does. */
  const launch = () => service.userSetup(null)
  return { runtime, auth, server, state, helpers, privateHome, launch, service, homes: { profileHome, installationHome } }
}

const alice = { subject: 'alice', email: 'a@example.com' }

describe('managed Codex: launch', () => {
  it('starts the pinned provider with the token helper, a private home and no inherited keys', async () => {
    const { auth, server, helpers, privateHome, launch, state } = setup()
    await signIn(issuer, auth, alice)
    await launch()
    expect(server.launches).toHaveLength(1)
    const spec = server.launches[0]!
    const args = spec.args.join(' ')
    expect(spec.args).toContain(`model_provider="${MANAGED_MODEL_PROVIDER}"`)
    expect(spec.args).toContain('features.multi_agent=false')
    const table = spec.args.find((arg) => arg.startsWith(`model_providers.${MANAGED_MODEL_PROVIDER}=`))!
    expect(table).toContain('wire_api="responses"')
    expect(table).toContain('timeout_ms=80000')
    expect(table).toContain('refresh_interval_ms=0')
    expect(table).toContain(`command="/opt/mousse-cli"`)
    expect(table).toContain(`args=["--cli","engine","chatgpt-token",${JSON.stringify(helpers[0]!.endpoint)},"${helpers[0]!.leaseId}"]`)
    expect(args).not.toContain('requires_openai_auth')
    expect(args).not.toContain('env_key')
    expect(spec.env.CODEX_HOME).toBe(privateHome)
    expect(existsSync(privateHome)).toBe(true)
    expect(spec.env.OPENAI_API_KEY).toBeUndefined()
    expect(spec.env.CODEX_API_KEY).toBeUndefined()
    expect(spec.env.MOUSSE_CLI).toBe('1')
    const init = server.messages.find((message) => message.method === 'initialize')!
    expect((init.params as { clientInfo: { name: string; title: string } }).clientInfo).toMatchObject({ name: 'Mousse', title: 'Mousse' })
    expect(state.leases).toBe(1)

    // Codex's token command gets the current access token, and nothing else.
    const token = await helperToken(helpers[0]!.endpoint, helpers[0]!.leaseId)
    expect(token).toMatchObject({ code: 0, stdout: (await auth.access()).accessToken })
    expect(token.stdout).toMatch(/^at-\d+$/)
    expect(server.methods()).not.toContain('account/read')
  })

  it('has no usage meter: it points to ChatGPT, and starts nothing and contacts nothing to say so', async () => {
    const { runtime, auth, server } = setup()
    await signIn(issuer, auth, alice)
    const requests = issuer.modelRequests.length
    expect(await runtime.usage!(new AbortController().signal)).toEqual({
      status: 'unavailable',
      windows: [],
      message: "ChatGPT shows this plan's usage on its own page.",
      manageUrl: CHATGPT_USAGE_URL
    })
    expect(server.launches).toHaveLength(0)
    expect(issuer.modelRequests).toHaveLength(requests)
  })

  it('refuses to launch while signed out', async () => {
    const { server, launch } = setup()
    await launch().catch(() => undefined)
    expect(server.launches).toHaveLength(0)
  })
})

describe('managed Codex: credential changes', () => {
  it('sign-out saves, revokes the leases, stops the process, then revokes at OpenAI', async () => {
    const { runtime, auth, server, helpers, launch, state } = setup()
    await signIn(issuer, auth, alice)
    await launch()
    const { endpoint, leaseId } = helpers[0]!
    const seen: Array<{ signedOut: boolean; exited: boolean; lease: number }> = []
    issuer.onRevoke = async () => {
      seen.push({ signedOut: auth.status().state === 'signed_out', exited: server.exited[0]!, lease: (await helperToken(endpoint, leaseId)).code })
      return { status: 200 }
    }
    await runtime.signOut!()
    expect(seen).toEqual([{ signedOut: true, exited: true, lease: 1 }])
    expect(issuer.revokeRequests).toHaveLength(1)
    expect(state.leases).toBe(0)
    const refused = await helperToken(endpoint, leaseId)
    expect(refused.code).toBe(1)
    expect(refused.stderr.trim().split('\n')).toHaveLength(1)
  })

  it('activating another saved connection stops the process before the old one is touched', async () => {
    const { auth, server, helpers, launch } = setup()
    await signIn(issuer, auth, alice)
    await signIn(issuer, auth, { subject: 'bob' }, { method: 'chatgpt-new-account', clientId: 'oaiapp_two' })
    await launch()
    const { endpoint, leaseId } = helpers[0]!
    expect((await helperToken(endpoint, leaseId)).code).toBe(0)
    await auth.activate('oaiapp_one')
    expect(server.exited[0]).toBe(true)
    expect((await helperToken(endpoint, leaseId)).code).toBe(1)
    // The next launch runs on the newly active connection, with a new lease.
    await launch()
    expect(server.launches).toHaveLength(2)
    expect(helpers[1]!.leaseId).not.toBe(leaseId)
    expect((await helperToken(helpers[1]!.endpoint, helpers[1]!.leaseId)).code).toBe(0)
  })

  it('a sign-out whose stop fails rejects and leaves the revocation pending', async () => {
    const { runtime, auth, service } = setup()
    await signIn(issuer, auth, alice)
    vi.spyOn(service, 'stopAll').mockRejectedValueOnce(new Error('the process would not stop'))
    await expect(runtime.signOut!()).rejects.toThrow()
    expect(issuer.revokeRequests).toHaveLength(0)
    expect(auth.status()).toMatchObject({ state: 'signed_out', revocationPending: true })
    // Signing out again retries the stop and the revocation.
    await runtime.signOut!()
    expect(issuer.revokeRequests).toHaveLength(1)
    expect(auth.status().revocationPending).toBeUndefined()
  })

  it('deleteCredentials empties the store, stops the process and revokes; a failed stop rejects', async () => {
    const { runtime, auth, server, launch, service } = setup()
    await signIn(issuer, auth, alice)
    await launch()
    vi.spyOn(service, 'stopAll').mockRejectedValueOnce(new Error('the process would not stop'))
    await expect(runtime.deleteCredentials!()).rejects.toThrow()
    expect(issuer.revokeRequests).toHaveLength(0)
    await runtime.deleteCredentials!()
    expect(auth.status().state).toBe('signed_out')
    expect(server.exited[0]).toBe(true)
    expect(issuer.revokeRequests).toHaveLength(1)
  })

  it('a sign-in whose stop fails is saved and succeeds with a warning', async () => {
    const { auth, service } = setup()
    await signIn(issuer, auth, alice)
    vi.spyOn(service, 'stopAll').mockRejectedValueOnce(new Error('the process would not stop'))
    const { result } = await signIn(issuer, auth, alice)
    expect(result).toMatchObject({ success: true, warning: expect.any(String) })
    expect(auth.status().state).toBe('signed_in')
  })
})

describe('managed Codex: models and readings', () => {
  it('fixes default to the first listed model; explicit ids stay', async () => {
    const { runtime, auth } = setup()
    expect(runtime.concreteModel!('default')).toBeUndefined()
    await signIn(issuer, auth, alice)
    issuer.onModels = () => ({ status: 200, body: { models: [{ slug: 'gpt-b', display_name: 'B', visibility: 'list' }, { slug: 'gpt-a', display_name: 'A', visibility: 'list' }] } })
    await runtime.refreshModels!('/')
    expect(runtime.models().map((model) => model.id)).toEqual(['gpt-b', 'gpt-a'])
    expect(runtime.concreteModel!('default')).toBe('gpt-b')
    expect(runtime.concreteModel!('gpt-a')).toBe('gpt-a')
  })

  it('reads the sign-in from the store, never through account/read', async () => {
    const { runtime, auth, server, launch } = setup()
    const out = await runtime.auth({ force: true })
    expect(out).toMatchObject({ state: 'signed_out', canSignIn: true, ownedByMousse: true })
    await signIn(issuer, auth, alice)
    const reading = await runtime.auth({ force: true })
    expect(reading).toMatchObject({ state: 'signed_in', ownedByMousse: true })
    expect(reading.subject).toMatch(/^chatgpt:.+:alice$/)
    expect(await runtime.identity!(new AbortController().signal)).toBe(reading.subject)
    await launch()
    expect(runtime.configured()).toBeTypeOf('boolean')
    expect(server.methods()).not.toContain('account/read')
  })
})


describe('codex driver config', () => {
  it('a managed entry always has a private home; the own setup never keeps one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(decodeCodexConfig({ setup: 'managed', home: 'default' })).toMatchObject({ setup: 'managed', home: 'private' })
      expect(decodeCodexConfig({ home: 'private' })).toMatchObject({ home: 'default' })
      expect(decodeCodexConfig({ setup: 'existing', home: 'private' })).toMatchObject({ setup: 'existing', home: 'default' })
      expect(warn).toHaveBeenCalledTimes(2)
      expect(decodeCodexConfig(undefined)).toEqual({ home: 'default' })
    } finally {
      warn.mockRestore()
    }
  })
})

describe('managed Codex: readiness, models and revisions', () => {
  const models = () => ({ status: 200, body: { models: [{ slug: 'gpt-a', display_name: 'GPT A', visibility: 'list' }, { slug: 'gpt-b', display_name: 'GPT B', visibility: 'list' }] } })

  it('a signed-in entry reaches the picker with its listed models, and again after a restart', async () => {
    issuer.onModels = models
    const first = setup()
    expect(first.runtime.configured()).toBe(false)
    expect(first.runtime.llmProvider!()).toBeUndefined()
    await signIn(issuer, first.auth, alice)
    // The sign-in check lists the plan's models on its own.
    expect((await first.runtime.auth({ force: true })).state).toBe('signed_in')
    await vi.waitFor(() => expect(first.runtime.models().map((model) => model.id)).toEqual(['gpt-a', 'gpt-b']))
    expect(first.runtime.configured()).toBe(true)
    expect(first.runtime.llmProvider!()).toMatchObject({ models: [{ id: 'gpt-a' }, { id: 'gpt-b' }] })
    // A new process over the same folders: ready from the store, with the saved listing.
    const restarted = setup(first.homes)
    expect(restarted.runtime.configured()).toBe(true)
    expect(restarted.runtime.llmProvider!()?.models.map((model) => model.id)).toEqual(['gpt-a', 'gpt-b'])
  })

  it('a failed first listing is tried again later; an account change clears the listing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      let fail = true
      issuer.onModels = () => (fail ? { status: 500, body: {} } : models())
      const { runtime, auth } = setup()
      await signIn(issuer, auth, alice)
      await runtime.auth({ force: true })
      await vi.waitFor(() => expect(issuer.modelRequests.length).toBeGreaterThan(0))
      const tried = issuer.modelRequests.length
      fail = false
      await runtime.auth({ force: true })
      // Within the retry wait nothing is asked again.
      expect(issuer.modelRequests.length).toBe(tried)
      vi.setSystemTime(Date.now() + 61_000)
      await runtime.auth({ force: true })
      await vi.waitFor(() => expect(runtime.models().map((model) => model.id)).toEqual(['gpt-a', 'gpt-b']))
      // Another account may list other models: the old listing goes with the change.
      await auth.signOut()
      expect(runtime.models()).toEqual([])
      expect(runtime.concreteModel!('default')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('an account change stops the processes of a revision a reconfiguration replaced, before any revocation', async () => {
    const old = setup()
    await signIn(issuer, old.auth, alice)
    await old.launch()
    // A reconfiguration builds a new runtime while the old one still finishes its turn.
    const current = setup(old.homes)
    const seen: boolean[] = []
    issuer.onRevoke = async () => {
      seen.push(old.server.exited[0]!)
      return { status: 200 }
    }
    await current.runtime.signOut!()
    expect(seen).toEqual([true])
    expect(old.state.leases).toBe(0)
  })
})

describe('managed Codex: a stopped revision until its process exits', () => {
  it('a sign-out through the replacement waits for a stopped old revision whose process ignores signals', async () => {
    let old!: ReturnType<typeof setup>
    const killTree = vi.fn(() => setTimeout(() => old.server.exits[0]!(), 30))
    old = setup(undefined, { killTree, stopTiming: { killAfterMs: 20, exitDeadlineMs: 2_000 } })
    old.server.state.stubborn = true
    await signIn(issuer, old.auth, alice)
    await old.launch()
    // The reconfiguration's replacement exists; the gateway then stops the old runtime once its turns end.
    const current = setup(old.homes)
    old.runtime.stop()
    expect(old.server.exited[0]).toBe(false)
    const seen: Array<{ exited: boolean; leases: number }> = []
    issuer.onRevoke = async () => {
      seen.push({ exited: old.server.exited[0]!, leases: old.state.leases })
      return { status: 200 }
    }
    await current.runtime.signOut!()
    expect(killTree).toHaveBeenCalled()
    expect(seen).toEqual([{ exited: true, leases: 0 }])
  })
})

describe('managed Codex: a listing for the previous account', () => {
  it('a listing that ends after an account change neither blocks nor overwrites the new account\'s listing', async () => {
    const listed = { status: 200, body: { models: [{ slug: 'gpt-a', display_name: 'GPT A', visibility: 'list' }] } }
    let release!: () => void
    const held = new Promise<typeof listed>((resolve) => (release = () => resolve(listed)))
    issuer.onModels = (() => held) as unknown as typeof issuer.onModels
    const { runtime, auth } = setup()
    await signIn(issuer, auth, alice)
    await runtime.auth({ force: true })
    await vi.waitFor(() => expect(issuer.modelRequests).toHaveLength(1))
    // Another account signs in while the first listing is still out.
    await signIn(issuer, auth, { subject: 'bob' }, { method: 'chatgpt-new-account', clientId: 'oaiapp_two' })
    issuer.onModels = () => listed
    release()
    // The old listing is refused (it was for the previous account) once it ends.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(runtime.models()).toEqual([])
    // The new account's check lists its models at once, without waiting out a retry delay.
    await runtime.auth({ force: true })
    await vi.waitFor(() => expect(runtime.models().map((model) => model.id)).toEqual(['gpt-a']))
  })
})
