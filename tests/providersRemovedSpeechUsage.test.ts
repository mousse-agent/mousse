/**
 * PR 5a-1: pi-ai keys are shared by the profiles, so speech and usage go through one per-profile
 * `providerAccess`. A provider removed from a profile is refused there before any request with the
 * shared key; another profile that still has it keeps using it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { createProviderAccess, type ProviderAccess } from '../src/mms/providers/providerAccess'
import { ProviderInstanceService } from '../src/mms/providers/ProviderInstanceService'

const REMOVED_TEXT = 'OpenAI was removed from this profile. Add it again in Settings → Providers.'

let dir: string
let auth: ProviderAuthService
const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown) => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }))

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mousse-removed-speech-'))
  // Every request a shared call would make lands here: nothing reaches a provider.
  vi.stubGlobal('fetch', fetchSpy)
  auth = new ProviderAuthService(join(dir, 'auth.json'))
  await auth.setApiKey('openai', 'fixture-openai-key')
  await auth.setApiKey('opencode-go', 'fixture-go-key')
  fetchSpy.mockClear()
})

afterEach(() => {
  auth.stop()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** A profile's access over the shared credentials, with `removed` tombstoned in its instance map. */
function profileAccess(removed: string[]): { access: ProviderAccess; instances: ProviderInstanceService } {
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: {}, seedVersion: 1, removed }), write: () => {} }, providerAuth: auth })
  return { access: createProviderAccess(auth, instances), instances }
}

const audio = { providerId: 'openai', modelId: 'whisper-1', audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/webm' }

describe('speech and usage on a provider removed from the profile', () => {
  it('refuses speech, transcription and usage text with the removed text, with no request and no shared call', async () => {
    const shared = {
      speech: vi.spyOn(auth, 'synthesizeSpeech'),
      transcription: vi.spyOn(auth, 'transcribeAudio'),
      usage: vi.spyOn(auth, 'getSubscriptionUsage')
    }
    const { access } = profileAccess(['pi:openai', 'pi:opencode-go'])
    await expect(access.synthesizeSpeech({ providerId: 'openai', modelId: 'gpt-4o-mini-tts', text: 'Hi' })).rejects.toMatchObject({ code: 'provider_removed', message: REMOVED_TEXT })
    await expect(access.transcribeAudio(audio)).rejects.toMatchObject({ code: 'provider_removed', message: REMOVED_TEXT })
    await expect(access.subscriptionUsage('opencode-go')).rejects.toMatchObject({ code: 'provider_removed', message: 'OpenCode Go was removed from this profile. Add it again in Settings → Providers.' })
    expect(shared.speech).not.toHaveBeenCalled()
    expect(shared.transcription).not.toHaveBeenCalled()
    expect(shared.usage).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('leaves removed providers out of the usage list without reading their usage', async () => {
    const { access } = profileAccess(['pi:openai', 'pi:opencode-go'])
    const usage = await access.usage()
    expect(usage.providers.map((provider) => provider.id)).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('another profile without the tombstone still uses the shared key', async () => {
    const { access } = profileAccess([])
    const speech = await access.synthesizeSpeech({ providerId: 'openai', modelId: 'gpt-4o-mini-tts', text: 'Hi' })
    expect(speech.audio.byteLength).toBe(3)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const usage = await access.usage()
    expect(usage.providers.map((provider) => provider.id).sort()).toEqual(['openai', 'opencode-go'])
    // OpenCode Go's usage reader asked its endpoint (here the recorder).
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1)
  })

  it('the protocol methods go through the profile access: a stored speech choice naming a removed provider fails with the same text', async () => {
    const { access } = profileAccess(['pi:openai'])
    const context = {
      mms: {
        providerAccess: access,
        providerAuth: auth,
        claudeSubscription: { status: async () => undefined, configured: () => false },
        worktrees: { getRepoRoot: () => dir }
      },
      globalSequence: () => 0
    } as unknown as HandlerContext
    const speech = vi.spyOn(auth, 'synthesizeSpeech')
    await expect(dispatchMethod(context, 'providers.synthesizeSpeech', { providerId: 'openai', modelId: 'gpt-4o-mini-tts', text: 'Hi' })).rejects.toMatchObject({ message: REMOVED_TEXT })
    await expect(dispatchMethod(context, 'providers.transcribeAudio', { providerId: 'openai', modelId: 'whisper-1', mimeType: 'audio/webm', audioBase64: Buffer.from([1, 2, 3]).toString('base64') })).rejects.toMatchObject({ message: REMOVED_TEXT })
    await expect(dispatchMethod(context, 'providers.getSubscriptionUsage', { providerId: 'openai' })).rejects.toMatchObject({ message: REMOVED_TEXT })
    const usage = await dispatchMethod(context, 'providers.getUsage', {}) as { providers: Array<{ id: string }> }
    expect(usage.providers.map((provider) => provider.id)).toEqual(['opencode-go'])
    expect(speech).not.toHaveBeenCalled()
    expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes('openai'))).toBe(true)
  })
})
