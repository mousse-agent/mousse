import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import { registerSecretMethods } from '../../src/mms/secrets/registerMethods'
import { SecretVault } from '../../src/mms/secrets/SecretVault'
import { createSecretToolHost } from '../../src/mms/secrets/secretToolHost'
import { SecretRequests } from '../../src/mms/secrets/SecretRequests'

const value = 'sk-E5SyntheticKeyForTestsOnly123456AAAAAAAAAAAAAAAA'
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
it.each([{ value: 'ordinary prose' }, { value: `Use ${value} please` }, { value: 'sk-E5SyntheticKeyForTestsOnly123456AAAAAAAAAAAAAAAA\u0000' }, { keep: 'forever' }])('refuses invalid input without echoing it: %j', async params => {
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

it('resolves the real bot home and observes its current secret grant and switch', async () => {
  const { botFixture, createBot, start, finish } = await import('../bots/botFixture')
  const f = botFixture()
  try {
    await f.bots.reconcileOnStartup()
    const { botId } = await createBot(f, { name: 'Pip', description: 'Help me', reply: 'Hello.' })
    expect(f.bots.service.secretHome(botId)).toMatchObject({ allowed: false })
    const activation = await f.bots.activate({ botId, input: 'Use a key', clientRequestId: 'secret-grant' })
    const turn = await start(f, activation.id)
    turn.prepared.authority.escalate!({ permission: { tool: 'secrets' }, reason: 'Use a key.' })
    await finish(f, turn.payload, 'completed', { text: 'Asked.' })
    for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'allow')
    const resolved = f.bots.service.secretHome(botId)
    expect(resolved).toEqual({ threadId: f.bots.service.get(botId).summary.homeThreadId, allowed: true })
    const permission = f.bots.service.get(botId).permissions.find(item => item.title === 'use secrets you give it')!
    f.bots.service.setPermission(botId, permission.id, false)
    expect(f.bots.service.secretHome(botId).allowed).toBe(false)
  } finally { f.close() }
})

it('never puts a storage error containing the value in a reply or a log', async () => {
  const { vault, call } = setup()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(vault, 'store').mockImplementation(() => { throw new Error(value) })
  try {
    const error = await call().catch(error => error)
    expect(error.message).toContain('could not be saved')
    expect(error.message).not.toContain(value)
    expect(JSON.stringify(log.mock.calls)).not.toContain(value)
    expect(vault.list()).toEqual([])
  } finally { vi.restoreAllMocks() }
})

it('keeps only the secret half of an AWS pair', async () => {
  const { call, vault } = setup()
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  expect(await call({ value: 'AKIAIOSFODNN7EXAMPLE '+secret })).toEqual({ name: 'AWS_SECRET_ACCESS_KEY' })
  expect(vault.value('AWS_SECRET_ACCESS_KEY')).toBe(secret)
})

it('keeps an Authorization bearer value by itself, without its header',async()=>{
  const {call,vault}=setup()
  const token='eyJabc.def.ghi'
  expect(await call({value:'Authorization: Bearer '+token})).toEqual({name:'API_KEY'})
  expect(vault.value('API_KEY')).toBe(token)
})

it('keeps the secret half when it precedes the AWS ID',async()=>{
  const {call,vault}=setup()
  const secret='wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  expect(await call({value:secret+' AKIAIOSFODNN7EXAMPLE'})).toEqual({name:'AWS_SECRET_ACCESS_KEY'})
  expect(vault.value('AWS_SECRET_ACCESS_KEY')).toBe(secret)
})

it.each([
 'Access key ID,Secret access key\nAKIAIOSFODNN7EXAMPLE,wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
 '{"AccessKeyId":"AKIAIOSFODNN7EXAMPLE","SecretAccessKey":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}',
 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\nAKIAIOSFODNN7EXAMPLE'
])('normalizes AWS paste for the vault: %s',async value=>{
 const {vault,call}=setup();await call({value});expect(vault.value('AWS_SECRET_ACCESS_KEY')).toBe('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
})
it('refuses keeping an AWS ID alone',async()=>{const {call}=setup();await expect(call({value:'AKIAIOSFODNN7EXAMPLE'})).rejects.toMatchObject({code:'invalid_params'})})
