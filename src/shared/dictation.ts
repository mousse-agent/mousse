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

export type LocalSttModelId =
  | 'moonshine-tiny'
  | 'moonshine-base'
  | 'whisper-base'
  | 'parakeet-tdt-110m'
  | 'parakeet-tdt-0.6b-v3'

interface LocalSttModelBase extends LocalModelManifest {
  id: LocalSttModelId
  /** Sample rate of the mono PCM the model expects. */
  sampleRate: number
  /** Longest audio the model transcribes in one pass; longer recordings are split. */
  maxSegmentSeconds: number
}

interface TransformersSttModelBase extends LocalSttModelBase {
  /** transformers.js dtype per ONNX component; selects the files in `files`. */
  dtype: Readonly<Record<string, 'q8'>>
}

/** A Moonshine model run through transformers.js's speech recognition pipeline. */
export interface MoonshineSttModel extends TransformersSttModelBase {
  runtime: 'moonshine'
}

/**
 * A Whisper model run through transformers.js. The pipeline always assumes English for a
 * multilingual model, so `whisperWorker.ts` detects the spoken language itself.
 */
export interface WhisperSttModel extends TransformersSttModelBase {
  runtime: 'whisper'
}

export type TransformersSttModel = MoonshineSttModel | WhisperSttModel

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
  /** Stacked LSTM layers in the prediction network. */
  predictorLayers: number
  /** `<piece> <id>` per line; the last id is the blank token. */
  tokens: string
}

export type LocalSttModel = TransformersSttModel | NemoTransducerSttModel

/**
 * Moonshine Tiny (Useful Sensors) as converted for transformers.js in
 * `onnx-community/moonshine-tiny-ONNX`. English only and the smallest model offered; same files and
 * runtime as Moonshine Base.
 */
export const MOONSHINE_TINY: MoonshineSttModel = {
  id: 'moonshine-tiny',
  label: 'Moonshine Tiny',
  description: 'English, fastest',
  parameters: '27M',
  license: 'MIT',
  homepage: 'https://huggingface.co/moonshine-ai/moonshine-tiny',
  repo: 'onnx-community/moonshine-tiny-ONNX',
  revision: 'a6da1241cd305dcd64eab1edbd615f2bb9aabb95',
  runtime: 'moonshine',
  dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
  sampleRate: 16000,
  maxSegmentSeconds: 30,
  files: [
    { path: 'config.json', size: 921, sha256: '558e1e02069137c796ace1e50c48d8fe451f04a295929138e6bea885517f0edb' },
    { path: 'generation_config.json', size: 147, sha256: 'f9b3f711b57be7def2e50a8942f64f36ee0a55fad5b84ff93a687b6c5bcc1d44' },
    { path: 'preprocessor_config.json', size: 128, sha256: 'fa43a7017ef85cd1d0fba0d9aae77c8adb16990ae6f11115631f41ec5d8aa679' },
    { path: 'tokenizer.json', size: 3761754, sha256: '7b913404bdd039af4756783218af4440bc07fb7d6d8258d677e34f95b3ec416f' },
    { path: 'tokenizer_config.json', size: 135735, sha256: 'edaee394565d428ea98a663ae7209cdcfeefc5585c42d7a570ff7c986df2cd15' },
    { path: 'onnx/encoder_model_quantized.onnx', size: 7937661, sha256: 'c6fc4b7bc5af75c0591fd157a1f3829b533d18e9769a888fd95a62e470dd4f4a' },
    { path: 'onnx/decoder_model_merged_quantized.onnx', size: 20243286, sha256: 'eed87831c3a6103534aae7d47a5d485025c659a1323901513961c39fe8a1a367' }
  ]
}

/**
 * Moonshine Base (Useful Sensors) as converted for transformers.js in
 * `onnx-community/moonshine-base-ONNX`. English only; the q8 encoder and merged decoder run on CPU
 * through WebAssembly.
 */
export const MOONSHINE_BASE: MoonshineSttModel = {
  id: 'moonshine-base',
  label: 'Moonshine Base',
  description: 'English',
  parameters: '61M',
  license: 'MIT',
  homepage: 'https://huggingface.co/UsefulSensors/moonshine-base',
  repo: 'onnx-community/moonshine-base-ONNX',
  revision: 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad',
  runtime: 'moonshine',
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
  description: 'English with punctuation',
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
  predictorLayers: 1,
  tokens: 'tokens.txt',
  files: [
    { path: 'tokens.txt', size: 9953, sha256: '450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10' },
    { path: 'decoder.int8.onnx', size: 3955863, sha256: 'f7c331c5504c2e593c76ed22b728e3f554af6c4a383dde862e719ced08b1da19' },
    { path: 'joiner.int8.onnx', size: 1411403, sha256: 'bf7dff69e9f2cdbe9943d70da358f38b361c115ba0105bae7e908e0d6ec782f6' },
    { path: 'encoder.int8.onnx', size: 131113202, sha256: '0f35509ddeb9b39002fb077d979a9fe74f06eb0bc4dd5c34f512f82e5111d657' }
  ]
}
/**
 * OpenAI Whisper Base as converted for transformers.js in `onnx-community/whisper-base`.
 * Multilingual: the spoken language is detected for each recording. The q8 encoder and merged
 * decoder run on CPU through WebAssembly.
 */
export const WHISPER_BASE: WhisperSttModel = {
  id: 'whisper-base',
  label: 'Whisper Base',
  description: '99 languages',
  parameters: '74M',
  license: 'Apache-2.0',
  homepage: 'https://huggingface.co/openai/whisper-base',
  repo: 'onnx-community/whisper-base',
  revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
  runtime: 'whisper',
  dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
  sampleRate: 16000,
  maxSegmentSeconds: 30,
  files: [
    { path: 'config.json', size: 2243, sha256: 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b' },
    { path: 'generation_config.json', size: 3832, sha256: '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0' },
    { path: 'preprocessor_config.json', size: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
    { path: 'tokenizer.json', size: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
    { path: 'tokenizer_config.json', size: 282682, sha256: '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573' },
    { path: 'onnx/encoder_model_quantized.onnx', size: 23201314, sha256: '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46' },
    { path: 'onnx/decoder_model_merged_quantized.onnx', size: 53693315, sha256: 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b' }
  ]
}

/**
 * NVIDIA Parakeet TDT 0.6B v3 in sherpa-onnx's int8 export, published by the sherpa-onnx
 * maintainer as `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`. Transcribes 25 European
 * languages with punctuation and capitals. Unlike the 110M model it takes 128 mel bins, its
 * prediction network has two LSTM layers, and its vocabulary has 8192 pieces. The 650 MB encoder
 * runs on CPU through WebAssembly.
 */
export const PARAKEET_TDT_06B_V3: NemoTransducerSttModel = {
  id: 'parakeet-tdt-0.6b-v3',
  label: 'Parakeet TDT 0.6B v3',
  description: '25 European languages',
  parameters: '600M',
  license: 'CC-BY-4.0',
  homepage: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3',
  repo: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
  revision: '2bda32ec70b097a55adaa07d9a7173915b43cc78',
  runtime: 'nemo-transducer',
  sampleRate: 16000,
  maxSegmentSeconds: 30,
  featureSize: 128,
  encoder: 'encoder.int8.onnx',
  decoder: 'decoder.int8.onnx',
  joiner: 'joiner.int8.onnx',
  predictorSize: 640,
  predictorLayers: 2,
  tokens: 'tokens.txt',
  files: [
    { path: 'tokens.txt', size: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
    { path: 'decoder.int8.onnx', size: 11845275, sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e' },
    { path: 'joiner.int8.onnx', size: 6355277, sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3' },
    { path: 'encoder.int8.onnx', size: 652184281, sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247' }
  ]
}

/** Listed in this order in the model picker. */
export const LOCAL_STT_MODELS: readonly LocalSttModel[] = [
  MOONSHINE_TINY,
  MOONSHINE_BASE,
  WHISPER_BASE,
  PARAKEET_TDT_110M,
  PARAKEET_TDT_06B_V3
]

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
