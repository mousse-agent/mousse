import type { DictationSelection } from '../../shared/dictation'
import { transcribeWithLocalModel } from './localEngine'
import { transcribeWithProvider } from './providerEngine'

/** Turns a recording into text with the model the user picked for dictation. */
export function transcribeRecording(recording: Blob, selection: DictationSelection): Promise<string> {
  return selection.source === 'local'
    ? transcribeWithLocalModel(selection.modelId, recording)
    : transcribeWithProvider(selection.providerId, selection.modelId, recording)
}
