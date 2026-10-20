import { PROVIDER_STT_MAX_BYTES } from '../../shared/dictation'

/** Transcribes a recording with a provider's speech-to-text model (the daemon makes the request). */
export async function transcribeWithProvider(providerId: string, modelId: string, recording: Blob): Promise<string> {
  if (recording.size > PROVIDER_STT_MAX_BYTES) {
    const limit = (PROVIDER_STT_MAX_BYTES / 1_000_000).toFixed(1)
    throw new Error(`This recording is too long for a provider model (limit about ${limit} MB). Record a shorter clip or use a local model.`)
  }
  const audio = new Uint8Array(await recording.arrayBuffer())
  const { text } = await window.mousse.dictation.transcribeWithProvider({ providerId, modelId, audio, mimeType: recording.type })
  return text
}
