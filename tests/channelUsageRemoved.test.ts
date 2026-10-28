/**
 * PR 5a-1: channel `/usage` reads usage through the profile's `providerAccess`, like the protocol
 * methods: on a provider removed from the profile it says so and makes no request with the key
 * another profile saved. `ChannelService` has no unguarded fallback.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchSlashCommand, type SlashContext } from '../src/mms/channels/slash/handlers'
import { parseSlashCommand } from '../src/mms/channels/slash/parse'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { createProviderAccess } from '../src/mms/providers/providerAccess'
import { ProviderInstanceService } from '../src/mms/harness/instanceMap'

let dir: string
let auth: ProviderAuthService
const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown) => new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } }))

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mousse-channel-usage-'))
  vi.stubGlobal('fetch', fetchSpy)
  auth = new ProviderAuthService(join(dir, 'auth.json'))
  // The shared key, saved again by another profile after this one removed the provider.
  await auth.setApiKey('opencode-go', 'fixture-go-key')
  fetchSpy.mockClear()
})

afterEach(() => {
  auth.stop()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** `/usage` in a channel session whose model is on OpenCode Go, in a profile with `removed` tombstoned. */
async function usageReply(removed: string[]): Promise<string | undefined> {
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: {}, seedVersion: 1, removed }), write: () => {} }, providerAuth: auth })
  const access = createProviderAccess(auth, instances)
  const parsed = parseSlashCommand('/usage')!
  const session = { sessionKey: 's', platform: 'telegram', chatId: 'c', modelOverride: { instanceId: 'pi:opencode-go', llmProvider: 'opencode-go', model: 'fixture-model' } }
  const ctx = {
    message: { platform: 'telegram', chatId: 'c', text: '/usage' },
    session,
    args: parsed.args,
    parsed,
    sessionManager: { getSession: () => session },
    settings: { get: () => ({ provider: { llmProvider: 'opencode-go', model: 'fixture-model' } }) },
    listModels: () => [],
    // What `ChannelService` passes the router (`MmsProfileServices`: `providerAccess.subscriptionUsage`).
    getSubscriptionUsage: (providerId: string) => access.subscriptionUsage(providerId),
    bumpGeneration: () => 1,
    getGeneration: () => 1
  } as unknown as SlashContext
  return (await dispatchSlashCommand(ctx)).reply
}

describe('channel /usage', () => {
  it('on a provider removed from the profile replies with the removed text and makes no request', async () => {
    const shared = vi.spyOn(auth, 'getSubscriptionUsage')
    expect(await usageReply(['pi:opencode-go'])).toBe('OpenCode Go was removed from this profile. Add it again in Settings → Providers.')
    expect(shared).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the same session in a profile that has the provider gets its usage', async () => {
    const reply = await usageReply([])
    expect(reply).toContain('OpenCode Go')
    expect(reply).not.toContain('was removed')
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('ChannelService reads usage only through the profile it is given', () => {
    const source = readFileSync(join(__dirname, '../src/mms/channels/ChannelService.ts'), 'utf8')
    expect(source).not.toMatch(/providerAuth\.getSubscriptionUsage/)
    expect(source).toMatch(/getSubscriptionUsage: options\.getSubscriptionUsage/)
  })
})
