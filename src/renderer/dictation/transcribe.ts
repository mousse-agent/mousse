import type { DictationSelection } from '../../shared/dictation'
import { transcribeWithLocalModel } from './localEngine'
import { transcribeWithProvider } from './providerEngine'

/**
 * Turns a recording into text with the model the user picked for dictation. Local models report
 * the text so far through `onPartial` as they go; provider models answer once. Aborting `signal`
 * stops a local transcription between segments; a provider request already sent runs to its end.
 */
export function transcribeRecording(
  recording: Blob,
  selection: DictationSelection,
  onPartial?: (text: string) => void,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  return selection.source === 'local'
    ? transcribeWithLocalModel(selection.modelId, recording, onPartial, signal)
    : transcribeWithProvider(selection.providerId, selection.modelId, recording)
}
