import { createErrorProvider } from '../../shared/errors'
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
