import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import { registerSecretMethods } from '../../src/mms/secrets/registerMethods'
import { SecretVault } from '../../src/mms/secrets/SecretVault'
import { createSecretToolHost } from '../../src/mms/secrets/secretToolHost'
import { SecretRequests } from '../../src/mms/secrets/SecretRequests'

const value = 'sk-e5SyntheticKeyForTestsOnly123456'
const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
function setup(allowed = true) {
  const home = mkdtempSync(join(tmpdir(), 'pasted-secret-')); homes.push(home)
  const vault = new SecretVault({ profileRoot: home, threadAlive: () => true })
  const domains = new DomainHandlerRegistry()
  registerSecretMethods(domains, async () => ({ requests: new SecretRequests(vault), list: () => vault.list(), delete: name => vault.delete(name), pasted: { vault, homeFor: () => ({ threadId: 'home', allowed }) } }))
  const call = (params = {}, clientType = 'gui') => domains.dispatch({ connection: { clientType, binding: { profileId: 'p', epoch: 1 }, capabilities: new Set() } } as unknown as HandlerContext, 'secrets.keepPasted', { botId: 'bot', value, keep: 'day', ...params })
  return { home, vault, call }
}
it('keeps a pasted key for the bot home, uses a free name, and makes it usable by secret_run', async () => {
  const { vault, call, home } = setup()
  expect(await call()).toEqual({ name: 'OPENAI_API_KEY' })
  expect(await call()).toEqual({ name: 'OPENAI_API_KEY_2' })
  expect(vault.value('OPENAI_API_KEY')).toBe(value)
  expect(vault.usableIn('OPENAI_API_KEY', 'home')).toBe(true)
  expect(vault.usableIn('OPENAI_API_KEY', 'other')).toBe(false)
  const host = createSecretToolHost({ vault, requests: new SecretRequests(vault), scratchRoot: join(home, 'run') })
  const result = await host.run({ threadId: 'home', command: 'printf "%s" "$OPENAI_API_KEY"', secrets: [{ name: 'OPENAI_API_KEY', as: 'env' }], cwd: home, signal: new AbortController().signal })
  expect(result.output).toContain('[secret OPENAI_API_KEY hidden]')
  expect(JSON.stringify(result)).not.toContain(value)
})
// Actors and invalid inputs: no refusal may store or repeat the supplied text.
it.each(['cli', 'bridge', 'agent'])('refuses %s without storing or echoing', async client => {
  const { vault, call } = setup()
  await expect(call({}, client)).rejects.toThrow(/window/)
  expect(vault.list()).toEqual([])
})
it.each([{ value: 'ordinary prose' }, { value: 'sk-e5SyntheticKeyForTestsOnly123456\u0000' }, { keep: 'forever' }])('refuses invalid input without echoing it: %j', async params => {
  const { vault, call } = setup()
  const error = await call(params).catch(error => error)
  expect(error).toBeInstanceOf(Error)
  expect(error.message).not.toContain(params.value ?? value)
  expect(vault.list()).toEqual([])
})
it('refuses a bot without Use secrets', async () => {
  const { vault, call } = setup(false)
  await expect(call()).rejects.toThrow(/Use secrets/)
  expect(vault.list()).toEqual([])
})
