import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { requestOpenAiSpeech } from '../src/mms/providers/providerSpeech'

const AUDIO = new Uint8Array([1, 2, 3, 4])

function recordingFetch(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return response()
  }) as typeof fetch
  return { calls, fetchImpl }
}

describe('requestOpenAiSpeech', () => {
  it('posts to /audio/speech and returns the audio bytes', async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response(AUDIO, { headers: { 'content-type': 'audio/mpeg; charset=x' } }))
    const result = await requestOpenAiSpeech({
      baseUrl: 'https://api.example.test/v1/',
      apiKey: 'sk-test',
      model: 'tts-1',
      voice: 'alloy',
      text: 'Hello there',
      providerLabel: 'Example',
      fetchImpl
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.example.test/v1/audio/speech')
    expect(calls[0]!.init.method).toBe('POST')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: 'tts-1',
      input: 'Hello there',
      voice: 'alloy',
      response_format: 'mp3'
    })
    expect(Array.from(result.audio)).toEqual(Array.from(AUDIO))
    expect(result.mimeType).toBe('audio/mpeg')
  })

  it('defaults the mime type', async () => {
    const { fetchImpl } = recordingFetch(() => new Response(AUDIO))
    const result = await requestOpenAiSpeech({ baseUrl: 'https://a.test', apiKey: 'k', model: 'm', voice: 'v', text: 't', providerLabel: 'X', fetchImpl })
    expect(result.mimeType).toBe('audio/mpeg')
  })

  it('throws with the status and a short body snippet, never the key', async () => {
    const { fetchImpl } = recordingFetch(() => new Response(`{"error":{"message":"${'bad '.repeat(200)}"}}`, { status: 401 }))
    const error = await requestOpenAiSpeech({
      baseUrl: 'https://a.test',
      apiKey: 'sk-secret-key',
      model: 'm',
      voice: 'v',
      text: 't',
      providerLabel: 'Example',
      fetchImpl
    }).catch((cause: Error) => cause)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('HTTP 401')
    expect(message).toContain('Example')
    expect(message).not.toContain('sk-secret-key')
    expect(message.length).toBeLessThan(320)
  })
})

describe('ProviderAuthService.synthesizeSpeech', () => {
  async function withService(run: (service: ProviderAuthService) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-read-aloud-provider-'))
    const service = new ProviderAuthService(join(dir, 'auth.json'))
    try {
      await run(service)
    } finally {
      service.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('uses the provider base URL, API key, and voice', async () => {
    await withService(async (service) => {
      const baseUrl = service.models.getModels('openai')[0]!.baseUrl
      await service.setApiKey('openai', 'sk-openai-test')
      const { calls, fetchImpl } = recordingFetch(() => new Response(AUDIO, { headers: { 'content-type': 'audio/mpeg' } }))
      const result = await service.synthesizeSpeech({ providerId: 'openai', modelId: 'gpt-4o-mini-tts', text: 'Hi' }, fetchImpl)
      expect(calls[0]!.url).toBe(`${baseUrl.replace(/\/+$/, '')}/audio/speech`)
      expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-openai-test')
      expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: 'Hi' })
      expect(result.audio.byteLength).toBe(AUDIO.byteLength)
    })
  })

  it('uses the chosen voice when the model has it, and the default otherwise', async () => {
    await withService(async (service) => {
      await service.setApiKey('openai', 'sk-openai-test')
      const { calls, fetchImpl } = recordingFetch(() => new Response(AUDIO))
      await service.synthesizeSpeech({ providerId: 'openai', modelId: 'gpt-4o-mini-tts', text: 'Hi', voice: 'marin' }, fetchImpl)
      await service.synthesizeSpeech({ providerId: 'openai', modelId: 'tts-1', text: 'Hi', voice: 'marin' }, fetchImpl)
      expect(calls.map((call) => JSON.parse(String(call.init.body)).voice)).toEqual(['marin', 'alloy'])
    })
  })

  it('picks the Groq voice by model prefix', async () => {
    await withService(async (service) => {
      await service.setApiKey('groq', 'gsk-test')
      const { calls, fetchImpl } = recordingFetch(() => new Response(AUDIO))
      await service.synthesizeSpeech({ providerId: 'groq', modelId: 'playai-tts', text: 'Hi' }, fetchImpl)
      expect(JSON.parse(String(calls[0]!.init.body)).voice).toBe('Fritz-PlayAI')
    })
  })

  it('rejects non-TTS models and providers without a voice', async () => {
    await withService(async (service) => {
      await service.setApiKey('openai', 'sk-openai-test')
      const { calls, fetchImpl } = recordingFetch(() => new Response(AUDIO))
      await expect(service.synthesizeSpeech({ providerId: 'openai', modelId: 'gpt-4o', text: 'Hi' }, fetchImpl)).rejects.toThrow(/no supported text-to-speech voice/)
      await expect(service.synthesizeSpeech({ providerId: 'anthropic', modelId: 'tts-1', text: 'Hi' }, fetchImpl)).rejects.toThrow(/no supported text-to-speech voice/)
      expect(calls).toHaveLength(0)
    })
  })

  it('requires a stored credential', async () => {
    await withService(async (service) => {
      const saved = process.env.OPENAI_API_KEY
      delete process.env.OPENAI_API_KEY
      try {
        const { fetchImpl } = recordingFetch(() => new Response(AUDIO))
        await expect(service.synthesizeSpeech({ providerId: 'openai', modelId: 'tts-1', text: 'Hi' }, fetchImpl)).rejects.toThrow(/not signed in/)
      } finally {
        if (saved !== undefined) process.env.OPENAI_API_KEY = saved
      }
    })
  })

  it('surfaces HTTP failures', async () => {
    await withService(async (service) => {
      await service.setApiKey('openai', 'sk-openai-test')
      const { fetchImpl } = recordingFetch(() => new Response('rate limited', { status: 429 }))
      await expect(service.synthesizeSpeech({ providerId: 'openai', modelId: 'tts-1', text: 'Hi' }, fetchImpl)).rejects.toThrow(/HTTP 429\): rate limited/)
    })
  })
})
