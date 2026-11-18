import { OldMetaReader } from './oldMetaReader'
import { SECRET_SERVICES } from '../../src/shared/secretServices'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSecretBinding } from '../../src/mms/secrets/secretBinding'
import { SecretVault } from '../../src/mms/secrets/SecretVault'
import { SecretRequests, secretOutcomeText } from '../../src/mms/secrets/SecretRequests'
import { createProfileSecretAdapter } from '../../src/mms/profiles/secrets'
import { createSecretToolHost } from '../../src/mms/secrets/secretToolHost'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {...actual, readFileSync: vi.fn(actual.readFileSync)}
})

const homes: string[] = []
afterEach(() => homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })))
const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), 'bound-secret-')); homes.push(home)
  const vault = new SecretVault({ profileRoot: home, threadAlive: () => true })
  return { home, vault, requests: new SecretRequests(vault) }
}
const VALUE = 'private-test-value-0123456789'
it.each(['openai', 'anthropic', 'github', 'stripe', 'notion', 'huggingface'])('resolves %s to a fixed service binding', service => {
  const binding = resolveSecretBinding({ service })
  expect(binding.origin).toMatch(/^https:\/\//)
  expect(binding.paths?.length).toBeGreaterThan(0)
  expect(binding.format).toContain('{}')
  if (service === 'notion') expect(binding.headers?.['Notion-Version']).toBeTruthy()
})
it.each(['http://api.example.com', 'https://api.example.com/path', 'https://u@api.example.com', 'https://api.example.com?x', 'https://api.example.com#x', 'https://127.0.0.1', 'https://10.0.0.1', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://2130706433'])('refuses invalid origin %s', origin => {
  expect(() => resolveSecretBinding({ origin })).toThrow()
})
it('accepts a public custom origin, and refuses ambiguous or unknown services', () => {
  expect(resolveSecretBinding({ origin: 'https://api.example.com:8443' })).toMatchObject({ origin: 'https://api.example.com:8443', header: 'Authorization', format: 'Bearer {}' })
  expect(() => resolveSecretBinding({ service: 'missing' })).toThrow()
  expect(() => resolveSecretBinding({ service: 'openai', origin: 'https://other.com' })).toThrow()
})
it('keeps the binding across restart, masks the value, and never gives a readable copy or command/settings access', async () => {
  const { home, vault, requests } = fixture()
  const binding = resolveSecretBinding({ service: 'openai' })
  const asked = requests.request('bot', { label: 'OpenAI key', reason: 'Read models', name: 'OPENAI_API_KEY', binding })
  const [card] = requests.list('bot')
  expect(card.binding).toEqual({ service: 'OpenAI', host: 'api.openai.com', readOnly: true })
  requests.answer('bot', card.requestId, VALUE, 'saved')
  const result = await asked
  expect(secretOutcomeText(result).text).toContain('secret_fetch')
  expect(secretOutcomeText(result).text).not.toContain('secret_run')
  vault.allowCopies('bot', true)
  expect(vault.fileFor('OPENAI_API_KEY', 'bot')).toBeUndefined()
  expect(existsSync(join(home, 'secrets/threads/bot/OPENAI_API_KEY'))).toBe(false)
  expect(new OldMetaReader({profileRoot: home, threadAlive: () => true}).readMeta().OPENAI_API_KEY).toMatchObject({ keep: 'saved', threads: ['bot'] })
  const restarted = new SecretVault({ profileRoot: home, threadAlive: () => true })
  expect(restarted.bindingFor('OPENAI_API_KEY')).toEqual(binding)
  expect(restarted.list()[0].binding).toEqual(card.binding)
  expect(restarted.maskerFor('bot')!(VALUE)).not.toContain(VALUE)
  expect(restarted.maskerForStore()!(VALUE)).not.toContain(VALUE)
  expect(JSON.stringify([card, result, restarted.list(), readFileSync(join(home, 'secrets/meta.json'), 'utf8')])).not.toContain(VALUE)
  const host = createSecretToolHost({ vault: restarted, requests, scratchRoot: home })
  await expect(host.run({ threadId: 'bot', cwd: home, command: 'echo should-not-run', secrets: [{ name: 'OPENAI_API_KEY' }], timeoutMs: 1000, signal: new AbortController().signal })).rejects.toThrow('OPENAI_API_KEY is bound to OpenAI; use secret_fetch.')
  const adapter = createProfileSecretAdapter({ profileRoot: home, inheritProcessEnv: true, environment: { OPENAI_API_KEY: 'ambient-fallback' } })
  expect(() => adapter.resolveEnv('${secret:OPENAI_API_KEY}')).toThrow(/bound to OpenAI/)
  // Old-format records still work: absence of binding is unrestricted.
  restarted.store('UNBOUND', VALUE, { threadId: 'bot', keep: 'saved' })
  expect(adapter.resolveEnv('${secret:UNBOUND}')).toBe(VALUE)
  expect(restarted.bindingFor('UNBOUND')).toBeUndefined()
  requests.dispose()
})
it('offers and reuses saved secrets only for matching origin, header, format, paths and fixed headers', async () => {
  const { vault, requests } = fixture()
  const binding = resolveSecretBinding({ service: 'notion' })
  vault.store('KEY', VALUE, { threadId: 'first', keep: 'saved', binding })
  const bindings = [undefined, { ...binding, serviceId: undefined, origin: 'https://other.com' }, { ...binding, serviceId: undefined, header: 'Other' }, { ...binding, serviceId: undefined, format: '{}' }, { ...binding, serviceId: undefined, paths: ['/other'] }, { ...binding, serviceId: undefined, headers: {} }, binding]
  for (const wanted of bindings) {
    const asked = requests.request('second', { name: 'KEY', label: 'Key', reason: 'Read', binding: wanted })
    const [card] = requests.list('second')
    expect(card.savedExists).toBe(wanted === binding)
    if (wanted === binding) { requests.useSaved('second', card.requestId); expect((await asked).kind).toBe('saved_reused') }
    else { expect(() => requests.useSaved('second', card.requestId)).toThrow(/No saved secret/); requests.decline('second', card.requestId); await asked }
  }
  requests.dispose()
})

it('accepts bindings through the bot tool only, while threads keep their original schema and input', async () => {
  const { secretTools } = await import('../../src/mms/run/mcp/appTools/secrets')
  const { home, vault, requests } = fixture()
  const host = createSecretToolHost({ vault, requests, scratchRoot: home })
  const [request] = secretTools({ secrets: () => host } as never)
  expect(request.botInputSchema?.properties).toHaveProperty('for')
  expect(request.inputSchema.properties).not.toHaveProperty('for')
  const context = (bot: boolean) => ({ turn: { threadId: 'bot', ...(bot ? { bot: {} } : {}) }, transport: 'mcp', caller: { threadId: 'bot' }, signal: new AbortController().signal } as never)
  for (const target of [{ service: 'openai' }, { origin: 'https://api.example.com' }]) {
    const result = request.handler({ label: 'Key', reason: 'Read', for: target }, context(true))
    const [card] = requests.list('bot')
    expect(card.binding?.host).toBe('service' in target ? 'api.openai.com' : 'api.example.com')
    requests.answer('bot', card.requestId, VALUE, 'saved')
    expect(JSON.stringify(await result)).not.toContain(VALUE)
  }
  expect((await request.handler({ label: 'Key', reason: 'Read', for: { origin: 'http://host' } }, context(true))).isError).toBe(true)
  expect((await request.handler({ label: 'Key', reason: 'Read', for: { service: 'openai' } }, context(false))).isError).toBe(true)
  requests.dispose()
})

it('never advertises local secret cards as remote methods', async () => {
  const { METHOD_ACCESS } = await import('../../src/shared/net/accessClasses')
  const { ROUTED_METHODS } = await import('../../src/shared/bridge/routed')
  const { SECRET_METHODS } = await import('../../src/shared/secretRequests')
  for (const method of SECRET_METHODS) {
    expect(METHOD_ACCESS[method]).toBeUndefined()
    expect(METHOD_ACCESS[`routed.${method}`]).toBeUndefined()
    expect(ROUTED_METHODS[method]).toBeUndefined()
  }
})
it('returns the binding refusal through the tool before starting a command', async () => {
  const { secretTools } = await import('../../src/mms/run/mcp/appTools/secrets')
  const { home, vault, requests } = fixture()
  vault.store('KEY', VALUE, { keep: 'saved', threadId: 'bot', binding: resolveSecretBinding({service:'github'}) })
  const [,run] = secretTools({ secrets: () => createSecretToolHost({vault, requests, scratchRoot:home}) } as never)
  const output = await run.handler({command:'echo forbidden',secrets:[{name:'KEY'}]}, {turn:{threadId:'bot',projectPath:home},transport:'mcp',caller:{threadId:'bot'},signal:new AbortController().signal} as never)
  expect(output).toEqual({text:'KEY is bound to GitHub; use secret_fetch.',isError:true})
  requests.dispose()
})

// Old writers, restarts, missing/corrupt authority, stale copies, deletion and unbound controls.
it.each(['store', 'grant', 'markUsed', 'delete', 'sweep'] as const)('keeps bindings after the v0.1.3 %s writer rewrites metadata', async operation => {
  const {home, vault, requests} = fixture()
  const binding = resolveSecretBinding({service: 'github'})
  vault.store('BOUND', VALUE, {threadId: 'bot', keep: 'saved', binding})
  let oldNow = Date.now()
  const old = new OldMetaReader({profileRoot: home, threadAlive: () => false, now: () => oldNow})
  old.store('OTHER', 'other-value', {threadId: 'old', keep: 'thread'})
  if (operation === 'store') old.store('NEW', 'new-value', {threadId: 'old', keep: 'saved'})
  if (operation === 'grant') old.grant('BOUND', 'old')
  if (operation === 'markUsed') old.markUsed('BOUND')
  if (operation === 'delete') old.delete('OTHER')
  if (operation === 'sweep') {
    old.store('EXPIRED', 'expiring-value', {threadId: 'old', keep: 'day'})
    oldNow += 24 * 60 * 60 * 1000 + 1
    expect(old.sweep()).toContain('EXPIRED')
  }
  expect(JSON.parse(readFileSync(join(home, 'secrets/meta.json'), 'utf8')).BOUND).not.toHaveProperty('binding')
  const restarted = new SecretVault({profileRoot: home, threadAlive: () => true})
  expect(restarted.bindingFor('BOUND')).toEqual(binding)
  restarted.allowCopies('bot', true)
  expect(restarted.fileFor('BOUND', 'bot')).toBeUndefined()
  expect(existsSync(join(home, 'secrets/threads/bot/BOUND'))).toBe(false)
  const adapter = createProfileSecretAdapter({profileRoot: home, inheritProcessEnv: false})
  expect(() => adapter.resolveEnv('${secret:BOUND}')).toThrow(/bound/)
  const host = createSecretToolHost({vault: restarted, requests, scratchRoot: home})
  await expect(host.run({threadId: 'bot', cwd: home, command: 'echo forbidden', secrets: [{name: 'BOUND'}], timeoutMs: 1000, signal: new AbortController().signal})).rejects.toThrow(/bound/)
  expect(restarted.maskerFor('bot')!(VALUE)).not.toContain(VALUE)
  requests.dispose()
})
it.each(['missing', 'invalid JSON', 'invalid entry'] as const)('fails closed with %s bindings without breaking an unbound key', state => {
  const {home, vault, requests} = fixture()
  vault.store('BOUND', VALUE, {threadId: 'bot', keep: 'saved', binding: resolveSecretBinding({service: 'github'})})
  vault.store('PLAIN', 'plain-value', {threadId: 'bot', keep: 'saved'})
  const path = join(home, 'secrets/bindings.json')
  if (state === 'missing') rmSync(path, {force: true})
  else writeFileSync(path, state === 'invalid JSON' ? '{' : '{"BOUND":{"origin":5}}')
  const copy = join(home, 'secrets/threads/bot/BOUND')
  mkdirSync(join(home, 'secrets/threads/bot'), {recursive: true}); writeFileSync(copy, VALUE)
  const restarted = new SecretVault({profileRoot: home, threadAlive: () => true})
  // Exercise fileFor itself before syncFiles can remove the stale copy.
  expect(restarted.fileFor('BOUND', 'bot')).toBeUndefined()
  expect(() => restarted.list()).not.toThrow()
  const adapter = createProfileSecretAdapter({profileRoot: home, inheritProcessEnv: false})
  expect(() => adapter.resolveEnv('${secret:BOUND}')).toThrow(/bound/)
  expect(adapter.resolveEnv('${secret:PLAIN}')).toBe('plain-value')
  writeFileSync(join(home, 'secrets/meta.json'), '{')
  expect(adapter.resolveEnv('${secret:PLAIN}')).toBe('plain-value')
  requests.dispose()
})
it('removes a binding on delete and leaves bound keys out of automation pickers', () => {
  const {home, vault, requests} = fixture()
  vault.store('BOUND', VALUE, {threadId: 'bot', keep: 'saved', binding: resolveSecretBinding({service: 'github'})})
  vault.store('PLAIN', VALUE, {threadId: 'bot', keep: 'saved'})
  expect(vault.savedKeyNames()).toEqual(['PLAIN'])
  vault.delete('BOUND')
  expect(vault.bindingFor('BOUND')).toBeUndefined()
  expect(JSON.parse(readFileSync(join(home, 'secrets/bindings.json'), 'utf8'))).not.toHaveProperty('BOUND')
  vault.store('BOUND', VALUE, {threadId: 'bot', keep: 'saved'})
  expect(createProfileSecretAdapter({profileRoot: home, inheritProcessEnv: false}).resolveEnv('${secret:BOUND}')).toBe(VALUE)
  requests.dispose()
})
it.each(['https://API.github.com:443.', 'https://API.GITHUB.COM.', 'https://api.github.com:443', 'https://API.OPENAI.COM.:443/'])('uses the known service limits for normalised origin %s', origin => {
  const expected = resolveSecretBinding({service: origin.toLowerCase().includes('github') ? 'github' : 'openai'})
  expect(resolveSecretBinding({origin})).toEqual(expected)
})
it.each(['https://localhost', 'https://localhost.', 'https://printer', 'https://api.local', 'https://api.internal', 'https://api.localhost', 'https://api.example.com:0'])('refuses local custom origin %s', origin => {
  expect(() => resolveSecretBinding({origin})).toThrow()
})

it('stores known service ids and uses the current service table for saved reuse', () => {
  const {home, vault, requests} = fixture()
  const original = structuredClone(SECRET_SERVICES.notion)
  try {
    vault.store('KEY', VALUE, {threadId: 'bot', keep: 'saved', binding: resolveSecretBinding({service: 'notion'})})
    expect(JSON.parse(readFileSync(join(home, 'secrets/bindings.json'), 'utf8')).KEY).toEqual({service: 'notion'})
    SECRET_SERVICES.notion.headers = {'Notion-Version': 'future-fixture-version'}
    const binding = resolveSecretBinding({service: 'notion'})
    expect(vault.bindingFor('KEY')?.headers).toEqual(binding.headers)
    expect(vault.isSaved('KEY', binding)).toBe(true)
  } finally { SECRET_SERVICES.notion = original; requests.dispose() }
})
it('caches binding file reads across references while observing atomic replacements', () => {
  const {home, vault, requests} = fixture()
  vault.store('KEY', VALUE, {threadId: 'bot', keep: 'saved', binding: resolveSecretBinding({service: 'github'})})
  const adapter = createProfileSecretAdapter({profileRoot: home, inheritProcessEnv: false})
  const spy = vi.mocked(readFileSync).mockClear()
  try {
    for (let n = 0; n < 4; n++) expect(() => adapter.resolveEnv('${secret:KEY}')).toThrow(/GitHub/)
    expect(spy.mock.calls.filter(([path]) => String(path).endsWith('/bindings.json'))).toHaveLength(1)
    const path = join(home, 'secrets/bindings.json')
    const replacement = path + '.new'
    writeFileSync(replacement, '{"KEY":{"service":"openai"}}'); renameSync(replacement, path)
    expect(() => adapter.resolveEnv('${secret:KEY}')).toThrow(/OpenAI/)
    expect(spy.mock.calls.filter(([path]) => String(path).endsWith('/bindings.json'))).toHaveLength(2)
  } finally { spy.mockClear(); requests.dispose() }
})
