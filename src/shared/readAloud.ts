import type { LlmProviderOption } from './settings'

/**
 * Read aloud: speaks a chat message with a text-to-speech model. The model is either a TTS model
 * from a configured provider (synthesized by the daemon with that provider's credential) or a local
 * model downloaded from Hugging Face and run in the renderer.
 */

/** The model the user picked for read aloud. Stored per profile in the renderer. */
export type ReadAloudSelection =
  | { source: 'provider'; providerId: string; modelId: string; label: string }
  | { source: 'local'; modelId: LocalTtsModelId; label: string }

// ---------------------------------------------------------------------------------------------
// Local models
// ---------------------------------------------------------------------------------------------

export type LocalTtsModelId = 'kokoro-82m'

export interface LocalTtsModelFile {
  /** Path inside the Hugging Face repository, e.g. `onnx/model_quantized.onnx`. */
  path: string
  size: number
  sha256: string
}

export interface LocalTtsModel {
  id: LocalTtsModelId
  label: string
  description: string
  parameters: string
  license: string
  /** Model card shown to the user. */
  homepage: string
  /** Hugging Face repository the files are downloaded from. */
  repo: string
  /** Pinned commit of `repo`, so every download gets the same verified bytes. */
  revision: string
  /** transformers.js dtype that selects the ONNX file in `files`. */
  dtype: 'q8'
  defaultVoice: string
  files: readonly LocalTtsModelFile[]
}

/**
 * Kokoro v1.0 ONNX weights from `onnx-community/Kokoro-82M-v1.0-ONNX`, the repository loaded by
 * the official `kokoro-js` package (hexgrad/kokoro). The q8 model runs on CPU through WebAssembly.
 */
export const KOKORO_82M: LocalTtsModel = {
  id: 'kokoro-82m',
  label: 'Kokoro 82M',
  description: 'English voices, runs on this computer',
  parameters: '82M',
  license: 'Apache-2.0',
  homepage: 'https://huggingface.co/hexgrad/Kokoro-82M',
  repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
  dtype: 'q8',
  defaultVoice: 'af_heart',
  files: [
    { path: 'config.json', size: 44, sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f' },
    { path: 'tokenizer.json', size: 3497, sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34' },
    { path: 'tokenizer_config.json', size: 113, sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20' },
    { path: 'onnx/model_quantized.onnx', size: 92361116, sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478' },
    { path: 'voices/af_heart.bin', size: 522240, sha256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b' }
  ]
}

export const LOCAL_TTS_MODELS: readonly LocalTtsModel[] = [KOKORO_82M]

export function findLocalTtsModel(modelId: string): LocalTtsModel | undefined {
  return LOCAL_TTS_MODELS.find((model) => model.id === modelId)
}

export function localTtsFileUrl(model: LocalTtsModel, path: string): string {
  return `https://huggingface.co/${model.repo}/resolve/${model.revision}/${path}`
}

export function localTtsModelBytes(model: LocalTtsModel): number {
  return model.files.reduce((total, file) => total + file.size, 0)
}

export type LocalTtsModelState =
  | { status: 'not-downloaded' }
  | { status: 'downloading'; receivedBytes: number; totalBytes: number }
  | { status: 'downloaded' }
  | { status: 'error'; message: string }

export interface LocalTtsModelStatus {
  modelId: LocalTtsModelId
  state: LocalTtsModelState
}

// ---------------------------------------------------------------------------------------------
// Provider models
// ---------------------------------------------------------------------------------------------

/**
 * Providers whose OpenAI-compatible API serves `POST {baseUrl}/audio/speech`. The value is the
 * voice used for each model id prefix (first match wins).
 */
const PROVIDER_TTS_VOICES: Record<string, ReadonlyArray<readonly [prefix: string, voice: string]>> = {
  openai: [['', 'alloy']],
  groq: [['playai-tts-arabic', 'Ahmad-PlayAI'], ['playai-tts', 'Fritz-PlayAI'], ['canopylabs/orpheus', 'troy']]
}

/** True when a provider catalog id names a text-to-speech model (`tts-1`, `gpt-4o-mini-tts`, ...). */
export function isTtsModelId(modelId: string): boolean {
  return /(^|[/_.-])tts($|[/_.-]|\d)/i.test(modelId) || /(^|\/)orpheus/i.test(modelId)
}

export function providerTtsVoice(providerId: string, modelId: string): string | undefined {
  const voices = PROVIDER_TTS_VOICES[providerId]
  return voices?.find(([prefix]) => modelId.startsWith(prefix))?.[1]
}

export interface ProviderTtsModel {
  providerId: string
  providerLabel: string
  modelId: string
  label: string
}

/** TTS models found in the configured providers' model lists that Mousse can synthesize with. */
export function ttsModelsFromProviders(providers: readonly LlmProviderOption[]): ProviderTtsModel[] {
  const out: ProviderTtsModel[] = []
  for (const provider of providers) {
    for (const model of provider.models) {
      if (!isTtsModelId(model.id) || !providerTtsVoice(provider.id, model.id)) continue
      out.push({ providerId: provider.id, providerLabel: provider.label, modelId: model.id, label: model.label })
    }
  }
  return out
}

/** OpenAI's `/audio/speech` input limit; longer text is sent in several requests. */
export const PROVIDER_TTS_MAX_CHARS = 4096

export interface ProviderSpeechRequest {
  providerId: string
  modelId: string
  text: string
}

export interface ProviderSpeechResult {
  audio: Uint8Array
  mimeType: string
}
