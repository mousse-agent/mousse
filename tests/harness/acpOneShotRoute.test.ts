/**
 * Generic ACP agents name threads on `acpOneShot` (docs/plans/one-shots-every-provider.md, slice 1): an agent known
 * only by its command is listed for thread titles as best-effort, and a title runs it once in a place of its own, on
 * the sealed launch, through the real gateway, driver, runner and places. The agent is a scripted process
 * (`fakeAcpOneShotAgent.mjs`, hand-authored: it proves Mousse's side only).
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { acpDriver } from '../../src/mms/harness/drivers/acp'
import type { Harness } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { classifyOneShotFailure, ONE_SHOT_INSTRUCTION, oneShotWasSent } from '../../src/mms/harness/oneShot/runner'
import { extractLimitFromError } from '../../src/mms/models/usageLimits'
import { dispatchMethod, type HandlerContext } from '../../src/mms/protocol/handlers'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { testHarness } from '../../src/mms/run/testkit/harness'
import { getDefaultSettings, type MousseSettings, type TitleOptions } from '../../src/shared/settings'
import type { Thread } from '../../src/shared/types'

const AGENT = join(dirname(fileURLToPath(import.meta.url)), 'fakeAcpOneShotAgent.mjs')
const SECRET = 'MOUSSE_ONE_SHOT_TEST_SECRET'

const homes: string[] = []
const harnesses: Harness[] = []
beforeAll(() => { process.env[SECRET] = 'leaked-from-mousse' })
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const home of homes.splice(0)) {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* a program copy still closing: the temporary folder is left */ }
  }
})

type Mode = 'answer' | 'tool' | 'write' | 'grandchild' | 'permission' | 'auth'
interface Logged { event: string; [key: string]: unknown }

/** A profile with one generic ACP entry per agent given, each known only by its command, all checked once. */
async function profile(agents: Array<{ name: string; mode?: Mode; answer?: string; program?: string }>) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-acp-one-shot-'))
  homes.push(home)
  const harness = testHarness({ drivers: [acpDriver()], instances: new ProviderInstanceService(), profileHome: home })
  harnesses.push(harness)
  const logs: Record<string, string> = {}
  const ids: Record<string, string> = {}
  for (const agent of agents) {
    logs[agent.name] = join(home, `${agent.name}.log`)
    const added = await harness.instances.add({
      driver: 'acp',
      config: {
        displayName: agent.name,
        binaryPath: agent.program ?? process.execPath,
        args: [AGENT],
        env: { FAKE_ACP_MODE: agent.mode ?? 'answer', FAKE_ACP_ANSWER: agent.answer ?? `${agent.name} title`, FAKE_ACP_LOG: logs[agent.name]! }
      }
    })
    ids[agent.name] = (added as { instanceId: string }).instanceId
  }
  const read = (name: string): Logged[] => existsSync(logs[name]!) ? readFileSync(logs[name]!, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Logged) : []
  const placesLeft = () => ['one-shot', 'one-shot-ledger'].flatMap((dir) => existsSync(join(home, dir)) ? readdirSync(join(home, dir)) : [])
  // Settings → Agents → Thread titles, as the app reads it (`settings.titleOptions`).
  const titleOptions = async (title: MousseSettings['title'] = getDefaultSettings().title) => ((await dispatchMethod({
    mms: { harness, settings: { get: () => ({ ...getDefaultSettings(), title }) } },
    globalSequence: () => 0
  } as unknown as HandlerContext, 'settings.titleOptions', {})) as { titleOptions: TitleOptions }).titleOptions
  return { home, harness, ids, read, placesLeft, titleOptions }
}

/** The orchestrator's naming on the real gateway: a thread store, the settings, and the title queue. */
function namer(harness: Harness, title: MousseSettings['title']) {
  let thread: Thread = { id: 't1', name: 'New Chat', createdAt: '', updatedAt: '' }
  const settings = { ...getDefaultSettings(), title } as MousseSettings
  const orch = Object.assign(Object.create(OrchestratorService.prototype), {
    threadStore: {
      getThread: (id: string) => (id === thread.id ? { ...thread } : null),
      updateThreadMeta: (_id: string, partial: Partial<Thread>) => { thread = { ...thread, ...partial }; return { ...thread } }
    },
    settingsStore: { get: () => settings },
    harness,
    titleWork: new Map<string, Promise<void>>(),
    threadScope: () => undefined,
    getMessages: () => []
  }) as { nameThreadOnFirstSend(threadId: string, content: string, images: number): void; titleWork: Map<string, Promise<void>> }
  return {
    name: async (content: string) => {
      orch.nameThreadOnFirstSend('t1', content, 0)
      while (orch.titleWork.size) await Promise.all([...orch.titleWork.values()])
      return thread
    }
  }
}

describe('a generic ACP agent names threads on acpOneShot', () => {
  it('is listed best-effort once checked, and the choice made from the listing names the thread once, in a sealed place removed afterwards', async () => {
    const p = await profile([{ name: 'Scripted agent', answer: 'OAuth callback loop' }])
    const id = p.ids['Scripted agent']!
    // Settings reads the cached listing while the entry's first check is pending: it answers at once, starts no agent,
    // and the model is unavailable until the check has read it.
    const pending = await p.titleOptions()
    expect(pending.llmProviders.find((provider) => provider.instanceId === id)?.models.find((model) => model.id === 'default')?.title)
      .toMatchObject({ state: 'unavailable', reason: expect.stringContaining('not been checked') })
    expect(p.read('Scripted agent')).toEqual([])
    // The entry's check runs (the providers page, or Automatic's first checks).
    await p.harness.llmProviders({ kind: 'device' })
    const listed = (await p.titleOptions()).llmProviders.find((provider) => provider.instanceId === id)!
    expect(listed.oneShot).toBe(true)
    const model = listed.models.find((each) => each.id === 'default')!
    expect(model.title).toMatchObject({ state: 'best_effort', route: 'acp:generic', facts: expect.arrayContaining([expect.stringContaining('tools of its own')]) })
    // The person picks it: the choice is what the picker writes from that listing.
    const choice = { instanceId: listed.instanceId!, llmProvider: listed.id, model: model.id, mode: 'auto' as const, prompt: '' }
    expect((await p.titleOptions(choice)).titleListing?.saved).toMatchObject({ instanceId: id, state: 'best_effort' })

    const thread = await namer(p.harness, choice).name('Please fix the OAuth loop')
    expect(thread).toMatchObject({ name: 'OAuth callback loop', titleSource: 'auto' })

    const prompts = p.read('Scripted agent').filter((event) => event.event === 'prompt')
    expect(prompts).toHaveLength(1)
    expect(String(prompts[0]!.text).startsWith(ONE_SHOT_INSTRUCTION)).toBe(true)
    const started = p.read('Scripted agent').filter((event) => event.event === 'start').at(-1)!
    const session = p.read('Scripted agent').filter((event) => event.event === 'session').at(-1)!
    // Its process and its session ran in the place's work folder, with no MCP server.
    const place = relative(join(p.home, 'one-shot'), String(started.cwd))
    expect(place.startsWith('..')).toBe(false)
    expect(place.split(/[\\/]/)[1]).toBe('work')
    expect(resolve(String(session.cwd))).toBe(resolve(String(started.cwd)))
    expect(session.mcpServers).toEqual([])
    // Every config and temporary root points into the place; Mousse's own variables do not reach it.
    const env = started.env as Record<string, string | null>
    for (const name of ['HOME', 'USERPROFILE', 'TMP', 'APPDATA', 'XDG_CONFIG_HOME'])
      expect(relative(join(p.home, 'one-shot', place.split(/[\\/]/)[0]!), String(env[name])).startsWith('..'), name).toBe(false)
    expect(env.secret).toBeNull()
    // The place and its record are gone.
    expect(p.placesLeft()).toEqual([])
  }, 90_000)

  it("an agent whose answer is agy's quota notice fails as that model's usage limit, not a title: Automatic moves on", async () => {
    const notice = '\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h28m19s.\n'
    const p = await profile([{ name: 'A quota agent', answer: notice }, { name: 'B quiet agent', answer: 'OAuth redirect state' }])
    await p.harness.llmProviders({ kind: 'device' })
    const failed = await p.harness.oneShot({ selection: { instanceId: p.ids['A quota agent']!, llmProvider: '', model: 'default' }, purpose: 'title', system: 'You name chats.', prompt: 'fix the login bug', maxChars: 80 })
      .catch((error: unknown) => error)
    expect(classifyOneShotFailure(failed)).toBe('rate_limited')
    const limit = extractLimitFromError(failed)!
    expect(limit.scope).toBe('model')
    expect(Date.parse(limit.until) - Date.now()).toBeGreaterThan(2 * 60 * 60_000)
    const thread = await namer(p.harness, { ...getDefaultSettings().title }).name('Please fix the OAuth loop')
    expect(thread).toMatchObject({ name: 'OAuth redirect state', titleSource: 'auto' })
    expect(p.placesLeft()).toEqual([])
  }, 90_000)

  it('a tool the agent reports ends its request, and Automatic moves on to the next candidate', async () => {
    const p = await profile([{ name: 'A tool agent', mode: 'tool' }, { name: 'B quiet agent', answer: 'OAuth redirect state' }])
    await p.harness.llmProviders({ kind: 'device' })
    const thread = await namer(p.harness, { ...getDefaultSettings().title }).name('Please fix the OAuth loop')
    expect(thread).toMatchObject({ name: 'OAuth redirect state', titleSource: 'auto' })
    expect(p.read('A tool agent').filter((event) => event.event === 'prompt')).toHaveLength(1)
    expect(p.read('B quiet agent').filter((event) => event.event === 'prompt')).toHaveLength(1)
    expect(p.placesLeft()).toEqual([])
  }, 90_000)

  it('an explicit choice that fails does not fall back: the thread keeps its first line and no other agent is asked', async () => {
    const p = await profile([{ name: 'A tool agent', mode: 'tool' }, { name: 'B quiet agent' }])
    const listed = (await p.harness.llmProviders({ kind: 'device' })).find((provider) => provider.instanceId === p.ids['A tool agent'])!
    const thread = await namer(p.harness, { instanceId: listed.instanceId!, llmProvider: listed.id, model: 'default', mode: 'auto', prompt: '' }).name('Please fix the OAuth loop')
    expect(thread.name).toBe('Fix the OAuth loop')
    expect(p.read('B quiet agent').filter((event) => event.event === 'prompt')).toHaveLength(0)
  }, 90_000)

  it.each<[Mode, string]>([
    ['auth', 'signed_out'],
    ['tool', 'one_shot_tool_refused'],
    ['permission', 'one_shot_tool_refused'],
    ['write', 'one_shot_tool_refused']
  ])('%s: the request fails as refused and its place is removed', async (mode, code) => {
    const p = await profile([{ name: 'Agent', mode }])
    await p.harness.llmProviders({ kind: 'device' })
    await expect(p.harness.oneShot({ selection: { instanceId: p.ids.Agent!, llmProvider: '', model: 'default' }, purpose: 'title', system: 'You name chats.', prompt: 'fix the login bug', maxChars: 80 }))
      .rejects.toMatchObject({ code })
    expect(p.placesLeft()).toEqual([])
  }, 90_000)

  it('a process the agent left running is ended with the request, before its place is removed', async () => {
    const p = await profile([{ name: 'Agent', mode: 'grandchild' }])
    await p.harness.llmProviders({ kind: 'device' })
    await expect(p.harness.oneShot({ selection: { instanceId: p.ids.Agent!, llmProvider: '', model: 'default' }, purpose: 'title', system: 'You name chats.', prompt: 'fix the login bug', maxChars: 80 }))
      .resolves.toEqual({ text: 'Agent title' })
    const grandchild = Number(p.read('Agent').find((event) => event.event === 'grandchild')!.pid)
    expect(() => process.kill(grandchild, 0)).toThrow()
    expect(p.placesLeft()).toEqual([])
  }, 90_000)
})

describe('admission of the ACP route', () => {
  it('an entry whose check could not start its program is not admitted', async () => {
    const p = await profile([{ name: 'Agent', program: join(tmpdir(), 'mousse-no-such-agent', 'agent.exe') }])
    await p.harness.llmProviders({ kind: 'device' })
    expect(p.harness.admitOneShot('thread_title', { kind: 'model', instanceId: p.ids.Agent!, model: 'default' })).toMatchObject({ notAdmitted: 'unchecked' })
  }, 90_000)

  it('a program replaced after its check is not started: the request is refused unsent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-acp-program-'))
    homes.push(dir)
    const program = join(dir, process.platform === 'win32' ? 'agent-node.exe' : 'agent-node')
    copyFileSync(process.execPath, program)
    const p = await profile([{ name: 'Agent', program }])
    await p.harness.llmProviders({ kind: 'device' })
    const started = p.read('Agent').filter((event) => event.event === 'start').length
    // Updated in place after the check read it.
    const later = new Date(Date.now() + 60_000)
    utimesSync(program, later, later)
    const error = await p.harness.oneShot({ selection: { instanceId: p.ids.Agent!, llmProvider: '', model: 'default' }, purpose: 'title', system: 'You name chats.', prompt: 'fix the login bug', maxChars: 80 }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'binding_stale' })
    expect(oneShotWasSent(error)).toBe(false)
    expect(p.read('Agent').filter((event) => event.event === 'start')).toHaveLength(started)
  }, 90_000)


  it('a local-thread binding on an entry that is not a local server is refused before anything is sent', async () => {
    const p = await profile([{ name: 'Agent' }])
    await p.harness.llmProviders({ kind: 'device' })
    await expect(p.harness.oneShot({ selection: { instanceId: p.ids.Agent!, llmProvider: '', model: 'default' }, localThread: { resident: true }, purpose: 'title', system: 'You name chats.', prompt: 'fix the login bug', maxChars: 80 }))
      .rejects.toMatchObject({ code: 'unsupported' })
    expect(p.read('Agent').filter((event) => event.event === 'prompt')).toHaveLength(0)
  }, 90_000)
})
