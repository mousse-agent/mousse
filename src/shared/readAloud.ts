import { localModelBytes, localModelFileUrl, type LocalModelFile, type LocalModelManifest, type LocalModelState, type LocalModelStatus } from './localModels'
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

export type LocalTtsModelFile = LocalModelFile

/** A voice of a local model. `id` is the model's own voice name, e.g. `af_heart`. */
export interface LocalTtsVoice {
  id: string
  label: string
}

export interface LocalTtsModel extends LocalModelManifest {
  id: LocalTtsModelId
  /** transformers.js dtype that selects the ONNX file in `files`. */
  dtype: 'q8'
  defaultVoice: string
  /** Every voice whose file is in `files`. */
  voices: readonly LocalTtsVoice[]
}

/**
 * Kokoro's English voices as listed by kokoro-js, best graded first within each accent. The id
 * prefix gives the accent (`a` American, `b` British) and the voice (`f` female, `m` male).
 */
const KOKORO_VOICES: readonly LocalTtsVoice[] = (
  [
    ['af_heart', 'Heart'], ['af_bella', 'Bella'], ['af_nicole', 'Nicole'], ['af_aoede', 'Aoede'], ['af_kore', 'Kore'],
    ['af_sarah', 'Sarah'], ['af_alloy', 'Alloy'], ['af_nova', 'Nova'], ['af_sky', 'Sky'], ['af_jessica', 'Jessica'],
    ['af_river', 'River'], ['am_fenrir', 'Fenrir'], ['am_michael', 'Michael'], ['am_puck', 'Puck'], ['am_echo', 'Echo'],
    ['am_eric', 'Eric'], ['am_liam', 'Liam'], ['am_onyx', 'Onyx'], ['am_santa', 'Santa'], ['am_adam', 'Adam'],
    ['bf_emma', 'Emma'], ['bf_isabella', 'Isabella'], ['bf_alice', 'Alice'], ['bf_lily', 'Lily'], ['bm_george', 'George'],
    ['bm_fable', 'Fable'], ['bm_lewis', 'Lewis'], ['bm_daniel', 'Daniel']
  ] as const
).map(([id, name]) => ({
  id,
  label: `${name}, ${id[0] === 'a' ? 'American' : 'British'} ${id[1] === 'f' ? 'female' : 'male'}`
}))

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
  voices: KOKORO_VOICES,
  files: [
    { path: 'config.json', size: 44, sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f' },
    { path: 'tokenizer.json', size: 3497, sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34' },
    { path: 'tokenizer_config.json', size: 113, sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20' },
    { path: 'onnx/model_quantized.onnx', size: 92361116, sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478' },
    { path: 'voices/af_heart.bin', size: 522240, sha256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b' },
    { path: 'voices/af_bella.bin', size: 522240, sha256: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b' },
    { path: 'voices/af_nicole.bin', size: 522240, sha256: 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a' },
    { path: 'voices/af_aoede.bin', size: 522240, sha256: '4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361' },
    { path: 'voices/af_kore.bin', size: 522240, sha256: '9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e' },
    { path: 'voices/af_sarah.bin', size: 522240, sha256: '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a' },
    { path: 'voices/af_alloy.bin', size: 522240, sha256: 'c4a6b876047fd7fb472edf4ebd63cfac7c3b958a7cae7c106e8f038ca6308c45' },
    { path: 'voices/af_nova.bin', size: 522240, sha256: '18778272caa0d0eebaea251c35fd635f038434f9eee5e691d02a174bd328414f' },
    { path: 'voices/af_sky.bin', size: 522240, sha256: '4435255c9744f3f31659e0d714ab7689bf65d9e77ec1cce060f083912614f0b9' },
    { path: 'voices/af_jessica.bin', size: 522240, sha256: 'a240a5e3c15b43563d6e923bdca8ef5613a23471d9b77653694012435df23bd8' },
    { path: 'voices/af_river.bin', size: 522240, sha256: '00a2bcf82b1d86e8f19902ede58c65ccf6c0e43b44b7d74fad54e5d8933c9c30' },
    { path: 'voices/am_fenrir.bin', size: 522240, sha256: 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43' },
    { path: 'voices/am_michael.bin', size: 522240, sha256: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1' },
    { path: 'voices/am_puck.bin', size: 522240, sha256: 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0' },
    { path: 'voices/am_echo.bin', size: 522240, sha256: '3968b92c3c4cd1c4416dbded36c13eaa388a90d5788d02a13e4d781f5f8cf3c3' },
    { path: 'voices/am_eric.bin', size: 522240, sha256: 'e8b5be17edd1e3636901ce7598baafe2dc8dd8ff707a0c23bf9e461add7e2832' },
    { path: 'voices/am_liam.bin', size: 522240, sha256: '52403be32fd047c6a44517cb0bcd6b134f2a18baa73e70ef41651e0eab921ade' },
    { path: 'voices/am_onyx.bin', size: 522240, sha256: 'da5d135b424164916d75a68ffb4c2abce3d7d5ccc82dd1ee6cf447ce286145e6' },
    { path: 'voices/am_santa.bin', size: 522240, sha256: '61150cf726ab6c5ed7a99f90a304f91f5a72c00c592e89ec94e5df11c319227a' },
    { path: 'voices/am_adam.bin', size: 522240, sha256: '162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716' },
    { path: 'voices/bf_emma.bin', size: 522240, sha256: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73' },
    { path: 'voices/bf_isabella.bin', size: 522240, sha256: '3754352c4aaa46d17f27654ab7518d65b62ad6163a0f55a5f4330c2da2c4e94f' },
    { path: 'voices/bf_alice.bin', size: 522240, sha256: '08afa6ba24da61ea5e8efa139e5aadc938d83f0a6da5a900adaf763ac1da5573' },
    { path: 'voices/bf_lily.bin', size: 522240, sha256: '5e0ee32ebe64a467124976b14e69590746f1c4ce41a12b587a50c862edfea335' },
    { path: 'voices/bm_george.bin', size: 522240, sha256: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc' },
    { path: 'voices/bm_fable.bin', size: 522240, sha256: 'f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1' },
    { path: 'voices/bm_lewis.bin', size: 522240, sha256: 'b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97' },
    { path: 'voices/bm_daniel.bin', size: 522240, sha256: '6b3194bbceffb746733cbc22c8f593dd44e401a71d53895a2dca891bc595a1e8' }
  ]
}

export const LOCAL_TTS_MODELS: readonly LocalTtsModel[] = [KOKORO_82M]

export function findLocalTtsModel(modelId: string): LocalTtsModel | undefined {
  return LOCAL_TTS_MODELS.find((model) => model.id === modelId)
}

export const localTtsFileUrl: (model: LocalTtsModel, path: string) => string = localModelFileUrl

export const localTtsModelBytes: (model: LocalTtsModel) => number = localModelBytes

export type LocalTtsModelState = LocalModelState

export type LocalTtsModelStatus = LocalModelStatus<LocalTtsModelId>

// ---------------------------------------------------------------------------------------------
// Provider models
// ---------------------------------------------------------------------------------------------

const OPENAI_TTS_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer']
const PLAYAI_VOICES = ['Fritz', 'Arista', 'Atlas', 'Basil', 'Briggs', 'Calum', 'Celeste', 'Cheyenne', 'Chip', 'Cillian', 'Deedee', 'Gail', 'Indigo', 'Mamaw', 'Mason', 'Mikail', 'Mitch', 'Quinn', 'Thunder']

/**
 * Providers whose OpenAI-compatible API serves `POST {baseUrl}/audio/speech`, with the voices of
 * each model id prefix (first match wins). The first voice is the default.
 */
const PROVIDER_TTS_VOICES: Record<string, ReadonlyArray<readonly [prefix: string, voices: readonly string[]]>> = {
  openai: [
    ['gpt-4o-mini-tts', [...OPENAI_TTS_VOICES, 'ballad', 'verse', 'marin', 'cedar']],
    ['', OPENAI_TTS_VOICES]
  ],
  groq: [
    ['playai-tts-arabic', ['Ahmad-PlayAI', 'Amira-PlayAI', 'Khalid-PlayAI', 'Nasser-PlayAI']],
    ['playai-tts', PLAYAI_VOICES.map((name) => `${name}-PlayAI`)],
    ['canopylabs/orpheus-v1-english', ['troy', 'autumn', 'diana', 'hannah', 'austin', 'daniel']],
    ['canopylabs/orpheus', ['troy']]
  ]
}

/** True when a provider catalog id names a text-to-speech model (`tts-1`, `gpt-4o-mini-tts`, ...). */
export function isTtsModelId(modelId: string): boolean {
  return /(^|[/_.-])tts($|[/_.-]|\d)/i.test(modelId) || /(^|\/)orpheus/i.test(modelId)
}

/** The voices Mousse can ask for with this model; empty when the provider model is not supported. */
export function providerTtsVoices(providerId: string, modelId: string): readonly string[] {
  return PROVIDER_TTS_VOICES[providerId]?.find(([prefix]) => modelId.startsWith(prefix))?.[1] ?? []
}

/** The default voice of a provider model, or undefined when the model is not supported. */
export function providerTtsVoice(providerId: string, modelId: string): string | undefined {
  return providerTtsVoices(providerId, modelId)[0]
}

/** `voice` when the model has it, otherwise the model's default voice. */
export function resolveProviderTtsVoice(providerId: string, modelId: string, voice: string | undefined): string | undefined {
  const voices = providerTtsVoices(providerId, modelId)
  return voice && voices.includes(voice) ? voice : voices[0]
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
  /** One of `providerTtsVoices`; the model's default voice when missing or unknown. */
  voice?: string
}

export interface ProviderSpeechResult {
  audio: Uint8Array
  mimeType: string
}
