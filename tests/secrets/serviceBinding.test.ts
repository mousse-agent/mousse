import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSecretBinding } from '../../src/mms/secrets/secretBinding'
import { SecretVault } from '../../src/mms/secrets/SecretVault'
import { SecretRequests, secretOutcomeText } from '../../src/mms/secrets/SecretRequests'
import { createProfileSecretAdapter } from '../../src/mms/profiles/secrets'
import { createSecretToolHost } from '../../src/mms/secrets/secretToolHost'

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
  const bindings = [undefined, { ...binding, origin: 'https://other.com' }, { ...binding, header: 'Other' }, { ...binding, format: '{}' }, { ...binding, paths: ['/other'] }, { ...binding, headers: {} }, binding]
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
