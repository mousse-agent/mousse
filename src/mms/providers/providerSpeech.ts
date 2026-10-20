import type { ProviderSpeechResult } from '../../shared/readAloud'

export interface OpenAiSpeechRequest {
  baseUrl: string
  apiKey: string
  model: string
  voice: string
  text: string
  providerLabel: string
  fetchImpl?: typeof fetch
}

const ERROR_SNIPPET_CHARS = 200

/** Calls an OpenAI-compatible `POST {baseUrl}/audio/speech` and returns the mp3 bytes. */
export async function requestOpenAiSpeech(request: OpenAiSpeechRequest): Promise<ProviderSpeechResult> {
  const fetchImpl = request.fetchImpl ?? fetch
  const response = await fetchImpl(`${request.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.apiKey}`
    },
    body: JSON.stringify({
      model: request.model,
      input: request.text,
      voice: request.voice,
      response_format: 'mp3'
    })
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const snippet = body.replace(/\s+/g, ' ').trim().slice(0, ERROR_SNIPPET_CHARS)
    throw new Error(`${request.providerLabel} text-to-speech failed (HTTP ${response.status})${snippet ? `: ${snippet}` : ''}`)
  }
  const audio = new Uint8Array(await response.arrayBuffer())
  if (audio.byteLength === 0) throw new Error(`${request.providerLabel} returned no audio`)
  return { audio, mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || 'audio/mpeg' }
}
