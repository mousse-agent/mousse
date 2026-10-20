import type { LocalModelManifest, LocalModelStatus } from './localModels'
import type { LlmProviderOption } from './settings'

/**
 * Dictation: the composer's microphone button records speech and types the transcript into the
 * message box. The speech-to-text model is either one from a configured provider (transcribed by
 * the daemon with that provider's credential) or a local model downloaded from Hugging Face and
 * run in the renderer.
 */

/** The model the user picked for dictation. Stored per profile in the renderer. */
export type DictationSelection =
  | { source: 'provider'; providerId: string; modelId: string; label: string }
  | { source: 'local'; modelId: LocalSttModelId; label: string }

// ---------------------------------------------------------------------------------------------
// Local models
// ---------------------------------------------------------------------------------------------

export type LocalSttModelId = 'moonshine-base' | 'parakeet-tdt-110m'

interface LocalSttModelBase extends LocalModelManifest {
  id: LocalSttModelId
  /** Sample rate of the mono PCM the model expects. */
  sampleRate: number
  /** Longest audio the model transcribes in one pass; longer recordings are split. */
  maxSegmentSeconds: number
}

/** A model run through transformers.js's speech recognition pipeline. */
export interface TransformersSttModel extends LocalSttModelBase {
  runtime: 'transformers'
  /** transformers.js dtype per ONNX component; selects the files in `files`. */
  dtype: Readonly<Record<string, 'q8'>>
}

/** A NeMo transducer exported by sherpa-onnx, decoded with TDT greedy search. */
export interface NemoTransducerSttModel extends LocalSttModelBase {
  runtime: 'nemo-transducer'
  /** Mel bins the encoder takes. */
  featureSize: number
  encoder: string
  decoder: string
  joiner: string
  /** Width of the prediction network's LSTM state. */
  predictorSize: number
  /** `<piece> <id>` per line; the last id is the blank token. */
  tokens: string
}

export type LocalSttModel = TransformersSttModel | NemoTransducerSttModel

/**
 * Moonshine Base (Useful Sensors) as converted for transformers.js in
 * `onnx-community/moonshine-base-ONNX`. English only; the q8 encoder and merged decoder run on CPU
 * through WebAssembly.
 */
export const MOONSHINE_BASE: TransformersSttModel = {
  id: 'moonshine-base',
  label: 'Moonshine Base',
  description: 'English, runs on this computer',
  parameters: '61M',
  license: 'MIT',
  homepage: 'https://huggingface.co/UsefulSensors/moonshine-base',
  repo: 'onnx-community/moonshine-base-ONNX',
  revision: 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad',
  runtime: 'transformers',
  dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
  sampleRate: 16000,
  maxSegmentSeconds: 30,
  files: [
    { path: 'config.json', size: 922, sha256: 'fab7241d1e9fc6c2370c4c6dfb5da79bb54d67ed9ab6b507ac51d29d2abe01d1' },
    { path: 'generation_config.json', size: 147, sha256: 'f9b3f711b57be7def2e50a8942f64f36ee0a55fad5b84ff93a687b6c5bcc1d44' },
    { path: 'preprocessor_config.json', size: 128, sha256: 'fa43a7017ef85cd1d0fba0d9aae77c8adb16990ae6f11115631f41ec5d8aa679' },
    { path: 'tokenizer.json', size: 3761754, sha256: '7b913404bdd039af4756783218af4440bc07fb7d6d8258d677e34f95b3ec416f' },
    { path: 'tokenizer_config.json', size: 135735, sha256: 'edaee394565d428ea98a663ae7209cdcfeefc5585c42d7a570ff7c986df2cd15' },
    { path: 'onnx/encoder_model_quantized.onnx', size: 20513063, sha256: '1dd9ab0a7f987113d30affcba5a068d11c8f90fa0223caa3e491ade431ad9751' },
    { path: 'onnx/decoder_model_merged_quantized.onnx', size: 42498870, sha256: 'cc9f3cd6698a369c6008b41aa60aa3fb3322e7f03c9bdf19d8e6b7200afca4f3' }
  ]
}

/**
 * NVIDIA Parakeet TDT-CTC 110M (transducer branch) in sherpa-onnx's int8 export,
 * `sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8` from the k2-fsa/sherpa-onnx
 * releases. Hugging Face has no official copy of the int8 files, so they come from a mirror whose
 * bytes match that release exactly (the hashes below are the release's). English with punctuation
 * and capitals; runs on CPU through WebAssembly.
 */
export const PARAKEET_TDT_110M: NemoTransducerSttModel = {
  id: 'parakeet-tdt-110m',
  label: 'Parakeet TDT 110M',
  description: 'English with punctuation, runs on this computer',
  parameters: '110M',
  license: 'CC-BY-4.0',
  homepage: 'https://huggingface.co/nvidia/parakeet-tdt_ctc-110m',
  repo: 'punitd/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8',
  revision: '66a4fa70643dc7ce25c9b38b2f87e1b35ddad33d',
  runtime: 'nemo-transducer',
  sampleRate: 16000,
  maxSegmentSeconds: 30,
  featureSize: 80,
  encoder: 'encoder.int8.onnx',
  decoder: 'decoder.int8.onnx',
  joiner: 'joiner.int8.onnx',
  predictorSize: 640,
  tokens: 'tokens.txt',
  files: [
    { path: 'tokens.txt', size: 9953, sha256: '450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10' },
    { path: 'decoder.int8.onnx', size: 3955863, sha256: 'f7c331c5504c2e593c76ed22b728e3f554af6c4a383dde862e719ced08b1da19' },
    { path: 'joiner.int8.onnx', size: 1411403, sha256: 'bf7dff69e9f2cdbe9943d70da358f38b361c115ba0105bae7e908e0d6ec782f6' },
    { path: 'encoder.int8.onnx', size: 131113202, sha256: '0f35509ddeb9b39002fb077d979a9fe74f06eb0bc4dd5c34f512f82e5111d657' }
  ]
}

export const LOCAL_STT_MODELS: readonly LocalSttModel[] = [MOONSHINE_BASE, PARAKEET_TDT_110M]

export function findLocalSttModel(modelId: string): LocalSttModel | undefined {
  return LOCAL_STT_MODELS.find((model) => model.id === modelId)
}

export type LocalSttModelStatus = LocalModelStatus<LocalSttModelId>

// ---------------------------------------------------------------------------------------------
// Provider models
// ---------------------------------------------------------------------------------------------

/** Providers whose OpenAI-compatible API serves `POST {baseUrl}/audio/transcriptions`. */
const PROVIDER_STT_PROVIDERS = new Set(['openai', 'groq'])

/**
 * True when a provider catalog id names a speech-to-text model (`whisper-1`, `gpt-4o-transcribe`,
 * `whisper-large-v3-turbo`, ...). Diarizing models need extra request fields and are left out.
 */
export function isSttModelId(modelId: string): boolean {
  if (/diariz/i.test(modelId)) return false
  return /(^|[/_.-])whisper/i.test(modelId) || /(^|[/_.-])transcribe($|[/_.-])/i.test(modelId)
}

export function providerSupportsStt(providerId: string): boolean {
  return PROVIDER_STT_PROVIDERS.has(providerId)
}

export interface ProviderSttModel {
  providerId: string
  providerLabel: string
  modelId: string
  label: string
}

/** Speech-to-text models found in the configured providers' model lists that Mousse can use. */
export function sttModelsFromProviders(providers: readonly LlmProviderOption[]): ProviderSttModel[] {
  const out: ProviderSttModel[] = []
  for (const provider of providers) {
    if (!providerSupportsStt(provider.id)) continue
    for (const model of provider.models) {
      if (!isSttModelId(model.id)) continue
      out.push({ providerId: provider.id, providerLabel: provider.label, modelId: model.id, label: model.label })
    }
  }
  return out
}

/**
 * Largest recording sent to a provider. The audio travels to the daemon base64-encoded in one
 * protocol frame (4 MiB), which leaves room for about 2.2 MB of compressed audio.
 */
export const PROVIDER_STT_MAX_BYTES = 2_200_000

export interface ProviderTranscriptionRequest {
  providerId: string
  modelId: string
  audio: Uint8Array
  /** Recorded container type, e.g. `audio/webm;codecs=opus`. */
  mimeType: string
}

export interface ProviderTranscriptionResult {
  text: string
}
