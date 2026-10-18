import { createErrorProvider, knownAppError } from '../../shared/errors'
const voiceErrors = createErrorProvider({
  voice_permission_denied: { category: 'denied', retryable: false, message: 'Microphone access was denied. Allow microphone access in system or browser settings, then retry.' },
  voice_device_missing: { category: 'unavailable', retryable: false, message: 'No microphone was found. Connect a microphone, then retry.' },
  voice_capture_failed: { category: 'unavailable', retryable: false, message: 'Microphone recording failed. Check that your microphone is available, then retry.' },
  voice_unsupported: { category: 'unsupported', retryable: false, message: 'Microphone recording is unavailable in this environment.' }
})
export function normalizeVoiceError(error: unknown) {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined
  if (name === 'NotAllowedError' || name === 'SecurityError') return voiceErrors.create('voice_permission_denied', error)
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return voiceErrors.create('voice_device_missing', error)
  if (name === 'NotSupportedError') return voiceErrors.create('voice_unsupported', error)
  return voiceErrors.create('voice_capture_failed', error)
}

/** Electron prefixes errors thrown in the main process with the channel name. */
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/

/** A recording that could not be turned into text: names the cause so the user knows what to change. */
export function normalizeTranscriptionError(error: unknown) {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const cause = raw.replace(IPC_ERROR_PREFIX, '').trim()
  return knownAppError(
    { code: 'voice_transcription_failed', message: cause ? `Dictation failed: ${cause}` : 'Dictation failed. Check the dictation model under Settings, Models, then try again.' },
    { category: 'unavailable', retryable: true }
  )
}
