/**
 * Several Antigravity entries on one computer: each entry added after the first is another Google account, named
 * "<Label> 2", "<Label> 3", ..., with its sign-in, settings and sessions in a home of its own. Signing one in, out or
 * removing it never touches another entry's home or the first entry's (this computer's `agy` sign-in).
 *
 * The agent is a hand-authored ACP fake per home, so this proves Mousse's side only. What the real `agy` does with
 * `AGY_CLI_FORCE_FILE_TOKEN_STORAGE` (the sign-in stays in the home) is checked by `tests/live/antigravityAgy.test.ts`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AntigravityProviderService, SHARED_SIGN_IN_MESSAGE, type AntigravityEntry } from '../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import { antigravityDriver } from '../src/mms/harness/drivers/antigravity'
import type { HarnessGatewayEvent } from '../src/mms/harness/gateway'
import { instanceStateDir } from '../src/mms/harness/instances'
import { ProviderInstanceService } from '../src/mms/harness/instanceMap'
import { adapterDriver, testHarness } from '../src/mms/run/testkit/harness'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { LoginSession } from '../src/mms/providers/LoginSession'
import { PiStubAdapter } from './support/piStub'

const homes: string[] = []
const services: AntigravityProviderService[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
const newHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'mousse-agy-entries-'))
  homes.push(home)
  return home
}

/** One agent's Google sign-in, as the fake keeps it; `shared` answers signed in without any sign-in (a keyring). */
interface Agent { signedIn: boolean; requests: string[] }

/** The ACP process boundary: a fake `agy acp` whose sign-in is `agent`'s. */
function connectTo(agent: Agent) {
  return () => {
    const abort = new AbortController()
    return {
      child: { exitCode: 0, signalCode: null, kill: vi.fn() },
      connection: {
        signal: abort.signal,
        close: vi.fn(() => abort.abort(new Error('ACP closed'))),
        agent: {
          request: vi.fn(async (method: string) => {
            agent.requests.push(method)
            if (method === methods.agent.initialize) return { protocolVersion: PROTOCOL_VERSION }
            if (method === methods.agent.authenticate) { agent.signedIn = true; return {} }
            if (method === methods.agent.logout) { agent.signedIn = false; return {} }
            if (method === methods.agent.session.new) {
              if (!agent.signedIn) throw RequestError.authRequired()
              return { sessionId: 'agent-session', configOptions: [{ id: 'model', type: 'select', currentValue: 'm', options: [{ value: 'm', name: 'Model' }] }] }
            }
            return {}
          }),
          notify: vi.fn(async () => undefined)
        }
      }
    } as never
  }
}

/** A file standing in for `agy`: the services find it as the user's own. */
function fakeAgy(home: string): string {
  const agy = join(home, 'bin', 'agy.exe')
  mkdirSync(join(home, 'bin'), { recursive: true })
  writeFileSync(agy, 'agy')
  return agy
}

function entryService(home: string, entry: AntigravityEntry | undefined, agent: Agent): AntigravityProviderService {
  const service = new AntigravityProviderService(home, home, new UserQuestionService(), undefined, {
    ...(entry ? { entry } : {}),
    connect: connectTo(agent),
    findUserAgy: () => fakeAgy(home)
  })
  services.push(service)
  return service
}

describe('Antigravity entries in the gateway', () => {
  function profile() {
    const home = newHome()
    let stored: unknown
    let seedVersion: number | undefined
    const source = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion }), write: (next) => { stored = next.instances; seedVersion = next.seedVersion } } })
    const first: Agent = { signedIn: false, requests: [] }
    const agents = new Map<string, Agent>()
    const builtIn = entryService(home, undefined, first)
    const driver = antigravityDriver({
      builtIn: () => builtIn,
      entry: (_context, entry) => {
        const agent: Agent = { signedIn: false, requests: [] }
        agents.set(entry.instanceId, agent)
        return entryService(home, entry, agent)
      }
    })
    const harness = testHarness({ drivers: [adapterDriver(new PiStubAdapter()), driver], instances: source, profileHome: home })
    const events: HarnessGatewayEvent[] = []
    harness.instances.subscribe((event) => events.push(event))
    const signIn = async (instanceId: string) => {
      const started = await harness.instances.signIn(instanceId)
      await vi.waitFor(() => expect(events.some((event) => event.type === 'operation' && event.data.operationId === started.operationId && event.data.phase === 'completed')).toBe(true))
    }
    return { home, harness, builtIn, first, agents, signIn, stored: () => stored as Record<string, { config?: Record<string, unknown> }> }
  }

  it('names each further entry "<Label> N" with the first free number, in a home of its own', async () => {
    const { harness, stored } = profile()
    const second = await harness.instances.add({ driver: 'antigravity' })
    const third = await harness.instances.add({ driver: 'antigravity' })
    expect([second.displayName, third.displayName]).toEqual(['Google Antigravity 2', 'Google Antigravity 3'])
    expect(second).toMatchObject({ builtIn: false, config: { home: 'private' } })
    // A name given on Add is kept; renaming stays possible.
    expect((await harness.instances.add({ driver: 'antigravity', config: { displayName: 'Work' } })).displayName).toBe('Work')
    expect((await harness.instances.configure(third.instanceId, { displayName: 'Personal' })).displayName).toBe('Personal')
    // The freed number is the next one used.
    await harness.instances.remove(second.instanceId)
    expect((await harness.instances.add({ driver: 'antigravity' })).displayName).toBe('Google Antigravity 2')
    expect(stored()[third.instanceId]?.config).toMatchObject({ home: 'private', displayName: 'Personal' })
  })

  it('signs each entry in to its own account, kept in its own folders; the first entry and the others stay as they were', async () => {
    const { home, harness, builtIn, first, agents, signIn } = profile()
    const second = await harness.instances.add({ driver: 'antigravity' })
    const third = await harness.instances.add({ driver: 'antigravity' })
    await signIn(second.instanceId)
    expect(agents.get(second.instanceId)?.requests).toContain(methods.agent.authenticate)
    const secondSettings = JSON.parse(readFileSync(join(instanceStateDir(home, second.instanceId), 'settings.json'), 'utf8'))
    expect(secondSettings).toMatchObject({ nativeSignedIn: true, homeSignIn: true, models: [expect.objectContaining({ id: 'm' })] })
    // Nothing reached the first entry (this computer's agy sign-in) or the third one.
    expect(builtIn.signedIn()).toBe(false)
    expect(first.requests).not.toContain(methods.agent.authenticate)
    expect(agents.get(third.instanceId)?.signedIn).toBe(false)
    expect(existsSync(join(home, 'providers', 'antigravity', 'settings.json'))).toBe(false)
    const snapshots = await harness.instances.snapshots({ kind: 'device' })
    const auth = (id: string) => snapshots.find((snapshot) => snapshot.instanceId === id)?.auth.state
    expect([auth(second.instanceId), auth(third.instanceId)]).toEqual(['signed_in', 'signed_out'])
  })

  it('removing an entry deletes its own home only, never another entry\'s, the first entry\'s or the user\'s skills', async () => {
    const { home, harness } = profile()
    const second = await harness.instances.add({ driver: 'antigravity' })
    const third = await harness.instances.add({ driver: 'antigravity' })
    const homeOf = (id: string) => join(instanceStateDir(home, id), 'home')
    const skills = join(home, 'user-skills')
    mkdirSync(skills, { recursive: true })
    writeFileSync(join(skills, 'SKILL.md'), 'mine')
    for (const dir of [join(homeOf(second.instanceId), 'gemini-home', 'antigravity-acp'), join(homeOf(third.instanceId), 'gemini-home', 'antigravity-acp'), join(home, 'providers', 'antigravity', 'gemini-home', 'antigravity-acp')]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'token'), 'sign-in')
    }
    // The agent links the user's own skills into its home; the delete must not follow the link.
    mkdirSync(join(homeOf(second.instanceId), 'gemini-home', 'config'), { recursive: true })
    symlinkSync(skills, join(homeOf(second.instanceId), 'gemini-home', 'config', 'skills'), process.platform === 'win32' ? 'junction' : 'dir')

    await harness.instances.remove(second.instanceId)
    expect(existsSync(homeOf(second.instanceId))).toBe(false)
    expect(readFileSync(join(skills, 'SKILL.md'), 'utf8')).toBe('mine')
    expect(existsSync(join(homeOf(third.instanceId), 'gemini-home', 'antigravity-acp', 'token'))).toBe(true)
    expect(existsSync(join(home, 'providers', 'antigravity', 'gemini-home', 'antigravity-acp', 'token'))).toBe(true)
  })

  it('removing the first entry deletes nothing of agy\'s', async () => {
    const { home, harness } = profile()
    const dir = join(home, 'providers', 'antigravity', 'gemini-home', 'antigravity-acp')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'token'), 'sign-in')
    await harness.instances.remove('antigravity')
    expect(existsSync(join(dir, 'token'))).toBe(true)
  })
})

describe('the sign-in of an entry with a home of its own', () => {
  const entryIn = (home: string): AntigravityEntry => {
    const stateDir = join(home, 'harness', 'antigravity_antigravity-2')
    return { instanceId: 'antigravity:antigravity-2', stateDir, home: join(stateDir, 'home') }
  }

  it('refuses an agy that opens a session in a home never signed in: that sign-in is another entry\'s', async () => {
    const home = newHome()
    // A keyring sign-in: every home opens a session without signing in.
    const keyring: Agent = { signedIn: true, requests: [] }
    const service = entryService(home, entryIn(home), keyring)
    expect(await service.checkSignedIn(home)).toBe(false)
    expect(service.isolationProblem()).toBe(SHARED_SIGN_IN_MESSAGE)
    expect(await service.login(new LoginSession('one'), home)).toMatchObject({ success: false, error: SHARED_SIGN_IN_MESSAGE })
    expect(service.signedIn()).toBe(false)
    expect(keyring.requests).not.toContain(methods.agent.authenticate)
    // The first entry, on this computer's sign-in, takes it as before.
    const first = entryService(newHome(), undefined, keyring)
    expect(await first.checkSignedIn()).toBe(true)
  })

  it('reads its own sign-in again once it signed in there', async () => {
    const home = newHome()
    const agent: Agent = { signedIn: false, requests: [] }
    const entry = entryIn(home)
    expect(await entryService(home, entry, agent).login(new LoginSession('one'), home)).toMatchObject({ success: true })
    // After a restart, an explicit check finds the sign-in in the home.
    rmSync(join(entry.stateDir, 'settings.json'))
    writeFileSync(join(entry.stateDir, 'settings.json'), JSON.stringify({ homeSignIn: true }))
    const again = entryService(home, entry, agent)
    expect(await again.checkSignedIn(home)).toBe(true)
    expect(again.isolationProblem()).toBeUndefined()
  })

  it('signs out by deleting its own agent folders, never through agy\'s sign-out, which may clear the computer\'s keyring', async () => {
    const home = newHome()
    const agent: Agent = { signedIn: false, requests: [] }
    const entry = entryIn(home)
    const service = entryService(home, entry, agent)
    await service.login(new LoginSession('one'), home)
    const skills = join(home, 'user-skills')
    mkdirSync(skills, { recursive: true })
    writeFileSync(join(skills, 'SKILL.md'), 'mine')
    mkdirSync(join(entry.home, 'gemini-home', 'antigravity-cli'), { recursive: true })
    writeFileSync(join(entry.home, 'gemini-home', 'token'), 'sign-in')
    symlinkSync(skills, join(entry.home, 'gemini-home', 'antigravity-cli', 'skills'), process.platform === 'win32' ? 'junction' : 'dir')
    await service.logout()
    expect(agent.requests).not.toContain(methods.agent.logout)
    expect(existsSync(join(entry.home, 'gemini-home'))).toBe(false)
    expect(readFileSync(join(skills, 'SKILL.md'), 'utf8')).toBe('mine')
    expect(service.signedIn()).toBe(false)
    expect(JSON.parse(readFileSync(join(entry.stateDir, 'settings.json'), 'utf8')).homeSignIn).toBeUndefined()
    // The first entry still signs agy out on this computer.
    const firstAgent: Agent = { signedIn: true, requests: [] }
    await entryService(newHome(), undefined, firstAgent).logout()
    expect(firstAgent.requests).toContain(methods.agent.logout)
  })
})
