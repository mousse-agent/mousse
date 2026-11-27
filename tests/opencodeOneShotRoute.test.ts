/**
 * OpenCode names threads on `opencode:sealed` (docs/plans/one-shots-every-provider.md, slice 3), through the real
 * gateway, driver, runner and places, on the real OpenCode (`realOpencode.ts`: a throwaway home given to the entry as its
 * own variables, a loopback stub model, dummy keys, no sign-in). A model on a provider with a key is listed held; one of
 * OpenCode's own free models is listed best-effort; a provider signed in with an account is not offered. A title chosen
 * from the listing runs once on a sealed server of its own, in a place removed afterwards.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { opencodeDriver } from '../src/mms/harness/drivers/opencode'
import type { Harness } from '../src/mms/harness/gateway'
import { ProviderInstanceService } from '../src/mms/harness/instanceMap'
import { ONE_SHOT_INSTRUCTION } from '../src/mms/harness/oneShot/runner'
import { OPENCODE_CONSOLE_FACTS, OPENCODE_FREE_FACTS, OPENCODE_SEALED_FACTS } from '../src/mms/harness/oneShot/routes'
import { opencodeOneShotRoute, opencodeSignIns } from '../src/mms/harness/opencode/oneShot'
import { OrchestratorService } from '../src/mms/orchestrator/OrchestratorService'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'
import { testHarness } from '../src/mms/run/testkit/harness'
import { getDefaultSettings, type MousseSettings, type TitleOptions } from '../src/shared/settings'
import type { Thread } from '../src/shared/types'
import { modelStub, opencodeBinary, placesLeft, stubProviderConfig, throwawayUser } from './harness/realOpencode'

const binary = opencodeBinary()
const ID = 'opencode:opencode'
const cleanups: Array<() => void | Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

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

describe.skipIf(!binary)('OpenCode names threads on opencode:sealed (real OpenCode, through the gateway)', () => {
  it('lists a keyed model held, and the choice made from the listing names the thread once, in a sealed place removed afterwards', async () => {
    const user = throwawayUser()
    cleanups.push(user.remove)
    const stub = await modelStub('OAuth callback loop')
    cleanups.push(() => stub.close())
    // The person's OpenCode lists the stub provider from its own config; the sealed server never reads that config, so
    // it is given the same provider through the test seam.
    const global = join(user.env.XDG_CONFIG_HOME!, 'opencode')
    mkdirSync(global, { recursive: true })
    writeFileSync(join(global, 'opencode.json'), stubProviderConfig(stub, 'dummy-key'))
    const project = join(user.root, 'project')
    mkdirSync(project)

    let stored: unknown = { [ID]: { driver: 'opencode', enabled: true, config: { binaryPath: binary, env: { ...user.env, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1' } } } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = testHarness({ drivers: [opencodeDriver({ oneShotConfigContent: stubProviderConfig(stub, 'dummy-key') })], instances, profileHome: user.profile, cwd: () => project })
    cleanups.push(() => harness.stop())
    const titleOptions = async (title: MousseSettings['title'] = getDefaultSettings().title) => ((await dispatchMethod({
      mms: { harness, settings: { get: () => ({ ...getDefaultSettings(), title }) } },
      globalSequence: () => 0
    } as unknown as HandlerContext, 'settings.titleOptions', {})) as { titleOptions: TitleOptions }).titleOptions

    // The entry's check: its server lists the models (OpenCode adds config providers a moment after its own).
    await harness.instances.recheck(ID)
    const deadline = Date.now() + 30_000
    while (!(await harness.instances.refreshModels(ID).then(() => harness.llmProviders({ kind: 'device' })))
      .find((provider) => provider.instanceId === ID)?.models.some((model) => model.id === 'stub/stub-model') && Date.now() < deadline);

    const listed = (await titleOptions()).llmProviders.find((provider) => provider.instanceId === ID)!
    expect(listed.oneShot).toBe(true)
    const keyed = listed.models.find((model) => model.id === 'stub/stub-model')!
    expect(keyed.title).toMatchObject({ state: 'held', route: 'opencode:sealed' })
    // OpenCode's own free models are offered `read`: best-effort, and the listing says why.
    const free = listed.models.find((model) => model.id === 'opencode/big-pickle')!
    expect(free.title).toMatchObject({ state: 'best_effort', route: 'opencode:sealed', facts: [expect.stringMatching(/Tools are offered/)] })

    // The person picks the keyed model: the choice is what the picker writes from that listing.
    const choice = { instanceId: ID, llmProvider: listed.id, model: keyed.id, mode: 'auto' as const, prompt: '' }
    expect((await titleOptions(choice)).titleListing?.saved).toMatchObject({ instanceId: ID, state: 'held' })
    const before = stub.requests.length
    const thread = await namer(harness, choice).name('Please fix the OAuth loop')
    expect(thread).toMatchObject({ name: 'OAuth callback loop', titleSource: 'auto' })
    const asked = stub.requests.slice(before)
    expect(asked).toHaveLength(1)
    expect(asked[0]!.tools).toEqual([])
    // Offered no tool, it gets no no-tools line either.
    expect(asked[0]!.text).not.toContain(ONE_SHOT_INSTRUCTION.slice(0, 40))
    expect(asked[0]!.text).toContain('Please fix the OAuth loop')
    // The place and its record are gone.
    expect(placesLeft(user.profile)).toEqual([])
  }, 120_000)
})

describe('the route of each OpenCode model, from what the entry’s last check read', () => {
  // `GET /api/integration` as OpenCode 2.0.20 answers it: a key and an account sign-in stored through its API, and a
  // provider connected through its variable.
  const integrations = [
    { id: 'anthropic', name: 'Anthropic', methods: [], connections: [{ type: 'credential', id: 'cred_1', label: 'default', method: 'key' }] },
    { id: 'groq', name: 'Groq', methods: [], connections: [{ type: 'env', name: 'GROQ_API_KEY' }] },
    { id: 'openai', name: 'OpenAI', methods: [], connections: [{ type: 'credential', id: 'cred_2', label: 'default', method: 'oauth' }] },
    { id: 'mistral', name: 'Mistral', methods: [], connections: [] }
  ]

  it('a keyed or variable-connected provider is held, an account sign-in is not offered with its reason, OpenCode’s own models are best-effort', () => {
    const signIns = opencodeSignIns(integrations)
    expect(signIns).toEqual({ anthropic: { kind: 'key' }, groq: { kind: 'env', names: ['GROQ_API_KEY'] }, openai: { kind: 'oauth' } })
    const cache = { signIns, free: ['opencode/big-pickle'] }
    expect(opencodeOneShotRoute('anthropic/claude-haiku-5-5', cache)).toMatchObject({ route: { id: 'opencode:sealed', facts: OPENCODE_SEALED_FACTS } })
    expect(opencodeOneShotRoute('groq/llama-4', cache)).toMatchObject({ route: { facts: OPENCODE_SEALED_FACTS } })
    expect(opencodeOneShotRoute('openai/gpt-6:high', cache)).toEqual({ refused: expect.stringMatching(/signs in to openai with an account.*API key/) })
    // OpenCode's own: free by the last listing's price or by name, else its paid Console models.
    expect(opencodeOneShotRoute('opencode/big-pickle', cache)).toMatchObject({ route: { facts: OPENCODE_FREE_FACTS } })
    expect(opencodeOneShotRoute('opencode/nemotron-3-ultra-free', undefined)).toMatchObject({ route: { facts: OPENCODE_FREE_FACTS } })
    expect(opencodeOneShotRoute('opencode/claude-opus-5-5', cache)).toMatchObject({ route: { facts: OPENCODE_CONSOLE_FACTS } })
    expect(opencodeOneShotRoute('default', cache)).toEqual({ refused: expect.any(String) })
  })
})
