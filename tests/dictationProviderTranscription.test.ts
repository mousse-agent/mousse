import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { requestOpenAiTranscription, transcriptionFilename } from '../src/mms/providers/providerTranscription'

const AUDIO = new Uint8Array([1, 2, 3, 4, 5])

function recordingFetch(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return response()
  }) as typeof fetch
  return { calls, fetchImpl }
}

const jsonResponse = (text: string) => new Response(JSON.stringify({ text }), { headers: { 'content-type': 'application/json' } })

describe('requestOpenAiTranscription', () => {
  it('posts multipart form data to /audio/transcriptions and returns trimmed text', async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse('  hello world \n'))
    const result = await requestOpenAiTranscription({
      baseUrl: 'https://api.example.test/v1/',
      apiKey: 'sk-test',
      model: 'whisper-1',
      audio: AUDIO,
      mimeType: 'audio/webm;codecs=opus',
      providerLabel: 'Example',
      fetchImpl
    })
    expect(result).toEqual({ text: 'hello world' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.example.test/v1/audio/transcriptions')
    expect(calls[0]!.init.method).toBe('POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('content-type')
    const form = calls[0]!.init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('whisper-1')
    expect(form.get('response_format')).toBe('json')
    const file = form.get('file') as File
    expect(file.name).toBe('recording.webm')
    expect(file.type).toBe('audio/webm;codecs=opus')
    expect(file.size).toBe(AUDIO.byteLength)
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(Array.from(AUDIO))
  })

  it('names the file after the container', () => {
    expect(transcriptionFilename('audio/webm')).toBe('recording.webm')
    expect(transcriptionFilename('audio/ogg;codecs=opus')).toBe('recording.ogg')
    expect(transcriptionFilename('audio/mp4')).toBe('recording.m4a')
    expect(transcriptionFilename('audio/mpeg')).toBe('recording.mp3')
    expect(transcriptionFilename('audio/wav')).toBe('recording.wav')
    expect(transcriptionFilename('audio/x-unknown')).toBe('recording.webm')
  })

  it('accepts an empty transcript', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse('  '))
    const result = await requestOpenAiTranscription({ baseUrl: 'https://a.test', apiKey: 'k', model: 'm', audio: AUDIO, mimeType: 'audio/webm', providerLabel: 'X', fetchImpl })
    expect(result.text).toBe('')
  })

  it('rejects a response without text', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('{}'))
    await expect(
      requestOpenAiTranscription({ baseUrl: 'https://a.test', apiKey: 'k', model: 'm', audio: AUDIO, mimeType: 'audio/webm', providerLabel: 'X', fetchImpl })
    ).rejects.toThrow(/no transcript/)
  })

  it('throws with the status and a short body snippet, never the key', async () => {
    const { fetchImpl } = recordingFetch(() => new Response(`{"error":{"message":"${'bad '.repeat(200)}"}}`, { status: 401 }))
    const error = await requestOpenAiTranscription({
      baseUrl: 'https://a.test',
      apiKey: 'sk-secret-key',
      model: 'm',
      audio: AUDIO,
      mimeType: 'audio/webm',
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

describe('ProviderAuthService.transcribeAudio', () => {
  async function withService(run: (service: ProviderAuthService) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-dictation-provider-'))
    const service = new ProviderAuthService(join(dir, 'auth.json'))
    try {
      await run(service)
    } finally {
      service.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const request = (providerId: string, modelId: string) => ({ providerId, modelId, audio: AUDIO, mimeType: 'audio/webm' })

  it('uses the provider base URL and API key', async () => {
    await withService(async (service) => {
      const baseUrl = service.models.getModels('openai')[0]!.baseUrl
      await service.setApiKey('openai', 'sk-openai-test')
      const { calls, fetchImpl } = recordingFetch(() => jsonResponse('Hi there'))
      const result = await service.transcribeAudio(request('openai', 'gpt-4o-transcribe'), fetchImpl)
      expect(result.text).toBe('Hi there')
      expect(calls[0]!.url).toBe(`${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`)
      expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-openai-test')
      expect((calls[0]!.init.body as FormData).get('model')).toBe('gpt-4o-transcribe')
    })
  })

  it('rejects non-STT models and unsupported providers', async () => {
    await withService(async (service) => {
      await service.setApiKey('openai', 'sk-openai-test')
      const { calls, fetchImpl } = recordingFetch(() => jsonResponse('x'))
      await expect(service.transcribeAudio(request('openai', 'gpt-4o'), fetchImpl)).rejects.toThrow(/no supported speech-to-text model/)
      await expect(service.transcribeAudio(request('anthropic', 'whisper-1'), fetchImpl)).rejects.toThrow(/no supported speech-to-text model/)
      expect(calls).toHaveLength(0)
    })
  })

  it('requires a stored credential', async () => {
    await withService(async (service) => {
      const saved = process.env.OPENAI_API_KEY
      delete process.env.OPENAI_API_KEY
      try {
        const { calls, fetchImpl } = recordingFetch(() => jsonResponse('x'))
        await expect(service.transcribeAudio(request('openai', 'whisper-1'), fetchImpl)).rejects.toThrow(/not signed in/)
        expect(calls).toHaveLength(0)
      } finally {
        if (saved !== undefined) process.env.OPENAI_API_KEY = saved
      }
    })
  })
})
