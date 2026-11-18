import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { SecretVault } from '../../src/mms/secrets/SecretVault'
import { fetchWithSecret } from '../../src/mms/secrets/secretFetch'
import { resolveSecretBinding } from '../../src/mms/secrets/secretBinding'
import { publicFetch } from '../../src/mms/net-public/publicFetch'

vi.mock('../../src/mms/net-public/publicFetch', () => ({ publicFetch: vi.fn() }))
vi.mock('node:crypto', async importOriginal => {
  const original = await importOriginal<typeof import('node:crypto')>()
  return { ...original, randomUUID: vi.fn(original.randomUUID) }
})
const homes: string[] = []
afterEach(() => {
  homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true }))
  vi.restoreAllMocks()
  vi.mocked(randomUUID).mockRestore()
})
const VALUE = 'private-test-value-0123456789'
function fixture(threadId = 'home', value = VALUE) {
  const home = mkdtempSync(join(tmpdir(), 'fetch-guards-'))
  homes.push(home)
  const vault = new SecretVault({ profileRoot: home, threadAlive: () => true })
  vault.store('KEY', value, { threadId, keep: 'saved', binding: resolveSecretBinding({ service: 'openai' }) })
  vi.mocked(publicFetch).mockClear().mockResolvedValue({ status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('ok') })
  const run = (args: Record<string, unknown> = {}) => fetchWithSecret(vault, { threadId: 'home', folder: home, args: { secret: 'KEY', path: '/v1/models', ...args }, signal: new AbortController().signal })
  return { home, vault, run }
}

it('refuses a bound secret belonging to another home before revealing its service', async () => {
  const { run, vault } = fixture('another-home')
  const used = vi.spyOn(vault, 'markUsed')
  const result = await run()
  expect(result.isError).toBe(true)
  expect(result.text).toContain('cannot use')
  expect(result.text).not.toContain('OpenAI')
  expect(publicFetch).not.toHaveBeenCalled()
  expect(used).not.toHaveBeenCalled()
})
it.each(['/v1/models/a%2fb', `/v1/models/${VALUE}`, '/v1/models/ghp_abcdefghijklmnopqrstuvwxyz'])('refuses a URL unsafe only because of %s', async path => {
  const { run } = fixture()
  expect((await run({ path })).isError).toBe(true)
  expect(publicFetch).not.toHaveBeenCalled()
})
it('fails closed when the binding record cannot be read', async () => {
  const { home, run } = fixture()
  writeFileSync(join(home, 'secrets', 'bindings.json'), 'broken JSON')
  const result = await run()
  expect(result.isError).toBe(true)
  expect(result.text).toContain('binding is unavailable')
  expect(publicFetch).not.toHaveBeenCalled()
})
it.each(['line\rbreak-private-value', 'line\nbreak-private-value'])('refuses a key containing a line break before using it', async value => {
  const { run, vault } = fixture('home', value)
  const used = vi.spyOn(vault, 'markUsed')
  expect((await run()).isError).toBe(true)
  expect(used).not.toHaveBeenCalled()
  expect(publicFetch).not.toHaveBeenCalled()
})
it('records last use for an admitted service request', async () => {
  const { run, vault } = fixture()
  const used = vi.spyOn(vault, 'markUsed')
  expect((await run()).isError).not.toBe(true)
  expect(used).toHaveBeenCalledOnce()
  expect(used).toHaveBeenCalledWith('KEY')
})
it('creates private response files exclusively and preserves an existing file on collision', async () => {
  const { run } = fixture()
  vi.mocked(publicFetch).mockResolvedValue({ status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.alloc(70000, 'a') })
  const first = await run()
  const file = first.text.split('File: ')[1]!
  expect(statSync(file).mode & 0o777).toBe(0o600)
  vi.mocked(randomUUID).mockReturnValue(basename(file) as ReturnType<typeof randomUUID>)
  vi.mocked(publicFetch).mockResolvedValue({ status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.alloc(70000, 'b') })
  expect((await run()).isError).toBe(true)
  expect(readFileSync(file)).toEqual(Buffer.alloc(70000, 'a'))
})
