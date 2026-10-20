import type { ProviderTranscriptionResult } from '../../shared/dictation'

export interface OpenAiTranscriptionRequest {
  baseUrl: string
  apiKey: string
  model: string
  audio: Uint8Array
  /** Recorded container type, e.g. `audio/webm;codecs=opus`. */
  mimeType: string
  providerLabel: string
  fetchImpl?: typeof fetch
}

const ERROR_SNIPPET_CHARS = 200

const EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav'
}

/** The upload needs a filename whose extension matches the container, since providers sniff it. */
export function transcriptionFilename(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return `recording.${EXTENSIONS[base] ?? 'webm'}`
}

/** Calls an OpenAI-compatible `POST {baseUrl}/audio/transcriptions` and returns the transcript. */
export async function requestOpenAiTranscription(request: OpenAiTranscriptionRequest): Promise<ProviderTranscriptionResult> {
  const fetchImpl = request.fetchImpl ?? fetch
  const form = new FormData()
  form.append('model', request.model)
  form.append('response_format', 'json')
  form.append('file', new Blob([request.audio as BlobPart], { type: request.mimeType }), transcriptionFilename(request.mimeType))
  // No Content-Type header: fetch adds the multipart boundary itself.
  const response = await fetchImpl(`${request.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${request.apiKey}` },
    body: form
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const snippet = body.replace(/\s+/g, ' ').trim().slice(0, ERROR_SNIPPET_CHARS)
    throw new Error(`${request.providerLabel} transcription failed (HTTP ${response.status})${snippet ? `: ${snippet}` : ''}`)
  }
  const payload = (await response.json().catch(() => undefined)) as { text?: unknown } | undefined
  if (typeof payload?.text !== 'string') throw new Error(`${request.providerLabel} returned no transcript`)
  return { text: payload.text.trim() }
}
