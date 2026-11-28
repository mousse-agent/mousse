import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { codexModelRouteView, decodeCodexConfig } from '../../src/mms/harness/drivers/codex'
import type { DriverContext } from '../../src/mms/harness/driver'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { CUSTOM_MODEL_PROVIDER, readCodexConfig, routeLayerProblem, routeOffer, routeTable } from '../../src/mms/harness/vendors/codex/providerRoute'
import { dispatchMethod } from '../../src/mms/protocol/handlers'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import type { ProviderAdapter } from '../../src/mms/harness/adapter'
import { classifyRoutedMethod } from '../../src/shared/bridge/routed'
import type { CodexModelRoute } from '../../src/shared/harness/modelRoute'
import { PiStubAdapter } from '../support/piStub'

/**
 * A Codex entry on the model provider its own config.toml selects (docs/plans/codex-own-provider.md):
 * what Mousse offers from the file, when an agreed route can run, which config layers refuse a
 * thread, and the gateway and RPC that record the agreement. The wire test
 * (`codexRouteWire.test.ts`) runs the real binary.
 */

const KEY = 'sk-route-secret-value-9z8y'
const BASE = 'https://llm.example.com/v1'
const dirs: string[] = []
const home = (config?: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-route-'))
  dirs.push(dir)
  if (config !== undefined) writeFileSync(join(dir, 'config.toml'), config)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const table = (fields: string) => `model_provider = "mine"\n[model_providers.mine]\nname = "Mine"\n${fields}\n`
const GOOD = table(`base_url = "${BASE}"\nwire_api = "responses"\nexperimental_bearer_token = "${KEY}"`)

describe('what config.toml offers', () => {
  it.each([
    ['no file', undefined, { kind: 'none' }],
    ['no model_provider', '[model_providers.mine]\nbase_url = "https://x"', { kind: 'none' }],
    ["OpenAI's own provider", 'model_provider = "openai"', { kind: 'none' }],
    ['a selected provider with no table', 'model_provider = "mine"', { kind: 'problem', message: expect.stringContaining('no [model_providers.mine] table') }],
    ['a table with no base_url', table(`experimental_bearer_token = "${KEY}"`), { kind: 'problem', message: expect.stringContaining('has no base_url') }],
    ['a base_url that is not http', table(`base_url = "file:///etc"\nexperimental_bearer_token = "${KEY}"`), { kind: 'problem', message: expect.stringContaining("isn't an http or https address") }],
    ['the chat wire API', table(`base_url = "${BASE}"\nwire_api = "chat"\nexperimental_bearer_token = "${KEY}"`), { kind: 'problem', message: expect.stringContaining('"chat"') }],
    ['a key from the environment', table(`base_url = "${BASE}"\nenv_key = "MY_KEY"`), { kind: 'problem', message: expect.stringContaining('env_key') }],
    ['headers Mousse would drop', table(`base_url = "${BASE}"\nexperimental_bearer_token = "${KEY}"\nhttp_headers = { a = "b" }`), { kind: 'problem', message: expect.stringContaining('http_headers') }],
    ['no key', table(`base_url = "${BASE}"`), { kind: 'problem', message: expect.stringContaining('no experimental_bearer_token') }],
    ['retry tuning only', table(`base_url = "${BASE}"\nexperimental_bearer_token = "${KEY}"\nrequest_max_retries = 2`), { kind: 'offer', table: 'mine', name: 'Mine', baseUrl: BASE, host: 'llm.example.com', keyMasked: '•••• 9z8y' }],
    ['a provider with its key', GOOD, { kind: 'offer', table: 'mine', name: 'Mine', baseUrl: BASE, host: 'llm.example.com', keyMasked: '•••• 9z8y' }]
  ])('%s', (_name, config, expected) => {
    const offer = routeOffer(readCodexConfig(home(config)))
    expect(offer).toEqual(expected)
    expect(JSON.stringify(offer)).not.toContain(KEY)
  })

  it("names only the line of a file that isn't TOML, never its text", () => {
    const reading = readCodexConfig(home(`model_provider = "mine"\nexperimental_bearer_token = "${KEY}" oops\n`))
    expect(reading).toEqual({ kind: 'unreadable', message: "Codex's config.toml isn't valid TOML (line 2)." })
  })
})

describe('whether an agreed route runs', () => {
  const route: CodexModelRoute = { kind: 'custom', table: 'mine', baseUrl: BASE }
  it.each([
    ['the file as agreed', GOOD, true],
    ['the file gone', undefined, "Codex's config.toml is gone."],
    ['the table gone', 'model_provider = "mine"', 'The provider mine is gone from config.toml.'],
    ['another base URL', GOOD.replace(BASE, 'https://other.example.com/v1'), 'The base URL in config.toml changed. Agree to it again in Settings → Providers.'],
    ['the key gone', table(`base_url = "${BASE}"`), 'The API key is gone from config.toml.'],
    // A route keeps running when the file selects another provider again: the person's agreement decides.
    ['another provider selected', GOOD.replace('model_provider = "mine"', 'model_provider = "openai"'), true]
  ])('%s', (_name, config, expected) => {
    const result = routeTable(route, readCodexConfig(home(config)))
    if (expected === true) expect(result).toMatchObject({ ok: true, table: { key: KEY, host: 'llm.example.com' } })
    else expect(result).toEqual({ ok: false, message: expected })
  })
})

describe('the config layers a thread starts with', () => {
  const layer = (type: string, config: Record<string, unknown>, disabledReason: string | null = null) => ({ name: { type }, disabledReason, config })
  it.each([
    ["Mousse's own -c table", [layer('sessionFlags', { model_provider: CUSTOM_MODEL_PROVIDER, model_providers: { [CUSTOM_MODEL_PROVIDER]: {} } })], undefined],
    ["the user's own provider", [layer('user', { model_provider: 'mine', model_providers: { mine: {} } })], undefined],
    ["the user's file adds to Mousse's table", [layer('user', { model_providers: { [CUSTOM_MODEL_PROVIDER]: { http_headers: { a: 'b' } } } })], expect.stringContaining(`defines the provider ${CUSTOM_MODEL_PROVIDER}`)],
    ['a project adds to it', [layer('project', { model_providers: { [CUSTOM_MODEL_PROVIDER]: {} } })], expect.stringContaining("This project's .codex/config.toml defines")],
    ['a project selects a provider', [layer('project', { model_provider: 'openai' })], expect.stringContaining('chooses a model provider')],
    ['an untrusted project (disabled)', [layer('project', { model_provider: 'openai' }, 'untrusted')], undefined],
    ['no layers read', null, expect.stringContaining("couldn't read Codex's config layers")]
  ])('%s', (_name, layers, expected) => {
    expect(routeLayerProblem(layers)).toEqual(expected)
  })
})

describe('the view the provider editor reads', () => {
  it('offers the selected provider while on ChatGPT, and offers a changed one while on the route', () => {
    const dir = home(GOOD)
    expect(codexModelRouteView(undefined, dir)).toEqual({ kind: 'chatgpt', offer: { table: 'mine', name: 'Mine', baseUrl: BASE, host: 'llm.example.com', keyMasked: '•••• 9z8y' } })
    const route: CodexModelRoute = { kind: 'custom', table: 'mine', baseUrl: BASE }
    expect(codexModelRouteView(route, dir)).toEqual({ kind: 'custom', table: 'mine', name: 'Mine', host: 'llm.example.com', keyMasked: '•••• 9z8y' })
    writeFileSync(join(dir, 'config.toml'), GOOD.replace(BASE, 'https://other.example.com/v1'))
    const changed = codexModelRouteView(route, dir)
    expect(changed).toMatchObject({ kind: 'custom', problem: expect.stringContaining('base URL in config.toml changed'), offer: { baseUrl: 'https://other.example.com/v1' } })
    expect(JSON.stringify(changed)).not.toContain(KEY)
  })

  it("keeps a stored route on an entry on the user's Codex, never on a managed one", () => {
    const stored = { modelRoute: { kind: 'custom', table: 'mine', baseUrl: BASE } }
    expect(decodeCodexConfig(stored, 'codex').modelRoute).toEqual(stored.modelRoute)
    expect(decodeCodexConfig({ ...stored, setup: 'managed' }, 'codex:managed').modelRoute).toBeUndefined()
    expect(decodeCodexConfig({ modelRoute: { kind: 'custom', table: 'mine' } }, 'codex').modelRoute).toBeUndefined()
  })
})

describe('the gateway', () => {
  const codexStub = (): ProviderAdapter => ({
    driver: 'codex',
    capabilities: new PiStubAdapter().capabilities,
    configured: () => true,
    startTurn: async () => { throw new Error('unused') },
    interrupt: async () => 'not_active'
  })

  function harness(dir: string, stored: Record<string, unknown> = {}) {
    let value: unknown = { codex: { driver: 'codex', enabled: true, config: stored } }
    const instances = new ProviderInstanceService({
      store: { read: () => ({ instances: value }), write: (next) => { value = next.instances } },
      providerAuth: { credentials: { listProviderIds: () => [] } }
    })
    const changed = vi.fn(async () => {})
    const base = adapterDriver(codexStub())
    const driver = {
      ...base,
      decodeConfig: decodeCodexConfig,
      create: (context: DriverContext) => ({ ...base.create(context), modelRoute: () => codexModelRouteView(context.config.modelRoute, dir), modelRouteChanged: changed })
    }
    const gateway = testHarness({ drivers: [adapterDriver(new PiStubAdapter()), driver], instances })
    onTestFinished(() => gateway.stop())
    return { gateway, changed, stored: () => (instances.list().codex?.config ?? {}) as Record<string, unknown> }
  }

  it('records the agreement only for what the file offers now, and ends the old route', async () => {
    const dir = home(GOOD)
    const { gateway, changed, stored } = harness(dir)
    expect(gateway.instances.modelRoute('codex')).toMatchObject({ kind: 'chatgpt', offer: { table: 'mine' } })
    // A base URL other than the one shown is never agreed to.
    await expect(gateway.instances.setModelRoute({ instanceId: 'codex', route: { table: 'mine', baseUrl: 'https://other.example.com/v1' } })).rejects.toThrow("config.toml changed since it was shown")
    expect(stored().modelRoute).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()

    const view = await gateway.instances.setModelRoute({ instanceId: 'codex', route: { table: 'mine', baseUrl: BASE } })
    expect(view).toMatchObject({ kind: 'custom', host: 'llm.example.com', keyMasked: '•••• 9z8y' })
    expect(stored().modelRoute).toEqual({ kind: 'custom', table: 'mine', baseUrl: BASE })
    expect(changed).toHaveBeenCalledTimes(1)
    // The key stays in config.toml: nothing Mousse stores holds it.
    expect(JSON.stringify(stored())).not.toContain(KEY)
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toBe(GOOD)

    expect(await gateway.instances.setModelRoute({ instanceId: 'codex', route: null })).toMatchObject({ kind: 'chatgpt' })
    expect(stored().modelRoute).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('refuses a managed entry', async () => {
    const { gateway, changed } = harness(home(GOOD), { setup: 'managed' })
    await expect(gateway.instances.setModelRoute({ instanceId: 'codex', route: { table: 'mine', baseUrl: BASE } })).rejects.toThrow('runs on its ChatGPT plan')
    expect(changed).not.toHaveBeenCalled()
  })
})

describe('the model-route methods', () => {
  const services = () => {
    const modelRoute = vi.fn(() => ({ kind: 'chatgpt' as const }))
    const setModelRoute = vi.fn(async () => ({ kind: 'chatgpt' as const }))
    return { mms: { harness: { instances: { modelRoute, setModelRoute } } }, modelRoute, setModelRoute }
  }
  const call = (mms: unknown, method: string, params: unknown, clientType = 'gui') =>
    dispatchMethod({ mms: mms as never, globalSequence: () => 0, connection: { clientType } as never }, method, params)

  it('answer a window on this computer and pass only the table and base URL on', async () => {
    const { mms, setModelRoute } = services()
    expect(await call(mms, 'providers.instances.modelRoute', { instanceId: 'codex' })).toEqual({ route: { kind: 'chatgpt' } })
    await call(mms, 'providers.instances.setModelRoute', { instanceId: 'codex', route: { table: 'mine', baseUrl: BASE, key: 'ignored' } })
    expect(setModelRoute).toHaveBeenLastCalledWith({ instanceId: 'codex', route: { table: 'mine', baseUrl: BASE } })
    await call(mms, 'providers.instances.setModelRoute', { instanceId: 'codex', route: null })
    expect(setModelRoute).toHaveBeenLastCalledWith({ instanceId: 'codex', route: null })
    await expect(call(mms, 'providers.instances.setModelRoute', { instanceId: 'codex', route: 'mine' })).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('are never routed to another computer, and refuse one', async () => {
    for (const method of ['providers.instances.modelRoute', 'providers.instances.setModelRoute'])
      expect(classifyRoutedMethod(method)?.kind).toBe('local')
    const { mms, modelRoute, setModelRoute } = services()
    await expect(call(mms, 'providers.instances.modelRoute', { instanceId: 'codex' }, 'bridge')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(call(mms, 'providers.instances.setModelRoute', { instanceId: 'codex', route: null }, 'bridge')).rejects.toMatchObject({ code: 'forbidden' })
    expect(modelRoute).not.toHaveBeenCalled()
    expect(setModelRoute).not.toHaveBeenCalled()
  })
})
