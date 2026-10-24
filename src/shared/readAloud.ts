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

export type PocketTtsLanguage = 'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'nl'

export type PocketTtsModelId = `pocket-tts-${PocketTtsLanguage}`

export type LocalTtsModelId = 'kokoro-82m' | 'kitten-tts-mini' | 'kitten-tts-micro' | 'kitten-tts-nano' | 'supertonic-3' | PocketTtsModelId
  | PocketTtsModelId

export type LocalTtsModelFile = LocalModelFile

/** A voice of a local model. `id` is the model's own voice name, e.g. `af_heart`. */
export interface LocalTtsVoice {
  id: string
  label: string
}

interface LocalTtsModelBase extends LocalModelManifest {
  id: LocalTtsModelId
  defaultVoice: string
  /** Every voice whose data is in `files`. Voices stored as separate files other than the default are optional files. */
  voices: readonly LocalTtsVoice[]
}

/** Kokoro through kokoro-js (transformers.js). */
export interface KokoroTtsModel extends LocalTtsModelBase {
  runtime: 'kokoro'
  /** transformers.js dtype that selects the ONNX file in `files`. */
  dtype: 'q8'
}

/** KittenTTS: one ONNX graph, espeak phonemes, and all voices in one `.npz` file. */
export interface KittenTtsModel extends LocalTtsModelBase {
  runtime: 'kitten'
  /** `config.json` with the voice aliases and per-voice speed priors. */
  config: string
  /** The ONNX graph. */
  model: string
  /** `.npz` archive holding one style matrix per voice. */
  voicesFile: string
}

/** Supertonic: four ONNX graphs (duration, text encoder, flow-matching vector estimator, vocoder) and one style file per voice. */
export interface SupertonicTtsModel extends LocalTtsModelBase {
  runtime: 'supertonic'
  durationPredictor: string
  textEncoder: string
  vectorEstimator: string
  vocoder: string
  /** `tts.json` with the audio and latent sizes. */
  config: string
  /** `unicode_indexer.json`, the character to id table. */
  indexer: string
  /** Folder of `<voice id>.json` style files. */
  voiceStyles: string
}

/** Pocket TTS: four ONNX graphs, a unigram tokenizer, and the voices as precomputed model states in one file. */
export interface PocketTtsModel extends LocalTtsModelBase {
  runtime: 'pocket'
  id: PocketTtsModelId
  /** The language the weights were trained for; numbers are spelled out in English words only for `en`. */
  language: PocketTtsLanguage
  /** `bundle.json`: sampling settings, text rules and the state layout of the graphs. */
  bundle: string
  tokenizer: string
  /** `voices.bin` with every voice. */
  voicesFile: string
  textConditioner: string
  flowLmMain: string
  flowLmFlow: string
  mimiDecoder: string
}

/** The model families Mousse can run; each runtime has its own worker. */
export type LocalTtsModel = KokoroTtsModel | KittenTtsModel | SupertonicTtsModel | PocketTtsModel

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
export const KOKORO_82M: KokoroTtsModel = {
  id: 'kokoro-82m',
  label: 'Kokoro 82M',
  description: 'English voices',
  parameters: '82M',
  license: 'Apache-2.0',
  homepage: 'https://huggingface.co/hexgrad/Kokoro-82M',
  repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
  runtime: 'kokoro',
  dtype: 'q8',
  defaultVoice: 'af_heart',
  voices: KOKORO_VOICES,
  files: [
    { path: 'config.json', size: 44, sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f' },
    { path: 'tokenizer.json', size: 3497, sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34' },
    { path: 'tokenizer_config.json', size: 113, sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20' },
    { path: 'onnx/model_quantized.onnx', size: 92361116, sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478' },
    { path: 'voices/af_heart.bin', size: 522240, sha256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b' },
    { path: 'voices/af_bella.bin', size: 522240, sha256: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b', optional: true },
    { path: 'voices/af_nicole.bin', size: 522240, sha256: 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a', optional: true },
    { path: 'voices/af_aoede.bin', size: 522240, sha256: '4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361', optional: true },
    { path: 'voices/af_kore.bin', size: 522240, sha256: '9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e', optional: true },
    { path: 'voices/af_sarah.bin', size: 522240, sha256: '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a', optional: true },
    { path: 'voices/af_alloy.bin', size: 522240, sha256: 'c4a6b876047fd7fb472edf4ebd63cfac7c3b958a7cae7c106e8f038ca6308c45', optional: true },
    { path: 'voices/af_nova.bin', size: 522240, sha256: '18778272caa0d0eebaea251c35fd635f038434f9eee5e691d02a174bd328414f', optional: true },
    { path: 'voices/af_sky.bin', size: 522240, sha256: '4435255c9744f3f31659e0d714ab7689bf65d9e77ec1cce060f083912614f0b9', optional: true },
    { path: 'voices/af_jessica.bin', size: 522240, sha256: 'a240a5e3c15b43563d6e923bdca8ef5613a23471d9b77653694012435df23bd8', optional: true },
    { path: 'voices/af_river.bin', size: 522240, sha256: '00a2bcf82b1d86e8f19902ede58c65ccf6c0e43b44b7d74fad54e5d8933c9c30', optional: true },
    { path: 'voices/am_fenrir.bin', size: 522240, sha256: 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43', optional: true },
    { path: 'voices/am_michael.bin', size: 522240, sha256: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1', optional: true },
    { path: 'voices/am_puck.bin', size: 522240, sha256: 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0', optional: true },
    { path: 'voices/am_echo.bin', size: 522240, sha256: '3968b92c3c4cd1c4416dbded36c13eaa388a90d5788d02a13e4d781f5f8cf3c3', optional: true },
    { path: 'voices/am_eric.bin', size: 522240, sha256: 'e8b5be17edd1e3636901ce7598baafe2dc8dd8ff707a0c23bf9e461add7e2832', optional: true },
    { path: 'voices/am_liam.bin', size: 522240, sha256: '52403be32fd047c6a44517cb0bcd6b134f2a18baa73e70ef41651e0eab921ade', optional: true },
    { path: 'voices/am_onyx.bin', size: 522240, sha256: 'da5d135b424164916d75a68ffb4c2abce3d7d5ccc82dd1ee6cf447ce286145e6', optional: true },
    { path: 'voices/am_santa.bin', size: 522240, sha256: '61150cf726ab6c5ed7a99f90a304f91f5a72c00c592e89ec94e5df11c319227a', optional: true },
    { path: 'voices/am_adam.bin', size: 522240, sha256: '162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716', optional: true },
    { path: 'voices/bf_emma.bin', size: 522240, sha256: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73', optional: true },
    { path: 'voices/bf_isabella.bin', size: 522240, sha256: '3754352c4aaa46d17f27654ab7518d65b62ad6163a0f55a5f4330c2da2c4e94f', optional: true },
    { path: 'voices/bf_alice.bin', size: 522240, sha256: '08afa6ba24da61ea5e8efa139e5aadc938d83f0a6da5a900adaf763ac1da5573', optional: true },
    { path: 'voices/bf_lily.bin', size: 522240, sha256: '5e0ee32ebe64a467124976b14e69590746f1c4ce41a12b587a50c862edfea335', optional: true },
    { path: 'voices/bm_george.bin', size: 522240, sha256: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc', optional: true },
    { path: 'voices/bm_fable.bin', size: 522240, sha256: 'f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1', optional: true },
    { path: 'voices/bm_lewis.bin', size: 522240, sha256: 'b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97', optional: true },
    { path: 'voices/bm_daniel.bin', size: 522240, sha256: '6b3194bbceffb746733cbc22c8f593dd44e401a71d53895a2dca891bc595a1e8', optional: true }
  ]
}

/**
 * KittenTTS 0.8 voices, by the names the model's `config.json` gives them. The name maps to the
 * voice's matrix in `voices.npz` (Bella is `expr-voice-2-f`, and so on).
 */
const KITTEN_VOICES: readonly LocalTtsVoice[] = [
  ['Bella', 'female'], ['Jasper', 'male'], ['Luna', 'female'], ['Bruno', 'male'],
  ['Rosie', 'female'], ['Hugo', 'male'], ['Kiki', 'female'], ['Leo', 'male']
].map(([id, gender]) => ({ id, label: `${id}, ${gender}` }))

/**
 * KittenTTS 0.8 (KittenML), a StyleTTS 2 model with espeak phonemes. English only, 24 kHz. The
 * mini and micro graphs are float32; the nano graph is the int8 build from
 * `kitten-tts-nano-0.8-int8`. All three share the same eight voices.
 */
const kittenModel = (
  id: LocalTtsModelId,
  label: string,
  parameters: string,
  repo: string,
  revision: string,
  model: LocalModelFile,
  config: LocalModelFile,
  voicesFile: LocalModelFile
): KittenTtsModel => ({
  id,
  label,
  description: 'English voices',
  parameters,
  license: 'Apache-2.0',
  homepage: `https://huggingface.co/${repo}`,
  repo,
  revision,
  runtime: 'kitten',
  config: config.path,
  model: model.path,
  voicesFile: voicesFile.path,
  defaultVoice: 'Bella',
  voices: KITTEN_VOICES,
  files: [config, model, voicesFile]
})

export const KITTEN_TTS_MINI: KittenTtsModel = kittenModel(
  'kitten-tts-mini',
  'Kitten TTS Mini',
  '80M',
  'KittenML/kitten-tts-mini-0.8',
  'c02725660cea441db4c383af69f1f26f5cd00947',
  { path: 'kitten_tts_mini_v0_8.onnx', size: 78268016, sha256: '0f5bbae4fc4800c98dbc544a87ecfa79510de2fb8222db30d12e5bfe9177df91' },
  { path: 'config.json', size: 470, sha256: '6b160bc9b19e24ecb21e84bc14f8a7da21fdf47ec72d42450bc5cf514b61804a' },
  { path: 'voices.npz', size: 3278902, sha256: '40ad2638952b77b7b2f30127e2608e169fc69dd256b53bd8aaa3409a33193c42' }
)

export const KITTEN_TTS_MICRO: KittenTtsModel = kittenModel(
  'kitten-tts-micro',
  'Kitten TTS Micro',
  '40M',
  'KittenML/kitten-tts-micro-0.8',
  '1ccf72b2c2048fd17efac7de2fab32d10e225084',
  { path: 'kitten_tts_micro_v0_8.onnx', size: 41384970, sha256: '95481626fee1ba70ce683e69c534fc7cb38433c46ce42d3abbeafb4b9f1a4123' },
  { path: 'config.json', size: 473, sha256: '1f0bd2208348f9211cb0da64fcd1536eb28228571cc6b09e767eb6e203a0a532' },
  { path: 'voices.npz', size: 3278902, sha256: '112710c1be8ad0e967c190fb0fd95cbe5848ec4791b93209f20b28b7da20dac1' }
)

export const KITTEN_TTS_NANO: KittenTtsModel = kittenModel(
  'kitten-tts-nano',
  'Kitten TTS Nano',
  '15M',
  'KittenML/kitten-tts-nano-0.8-int8',
  '84781d74e29ee25217551556398b42f80593a813',
  { path: 'kitten_tts_nano_v0_8.onnx', size: 24369971, sha256: 'f7b0afcbee92870b32b8e0276d855b954dc25470c9f051b376ac7eee537c76fc' },
  { path: 'config.json', size: 688, sha256: 'b66006ccbeccd4de5fc3c9272059c47f5725df7215fd889785c03602652fab64' },
  { path: 'voices.npz', size: 3278902, sha256: '8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f' }
)

/**
 * Supertonic 3 (Supertone), 31 languages at 44.1 kHz. The weights are the public ONNX assets,
 * pinned in the archive repository that Supertone moved them to; `Supertone/supertonic-3` holds
 * the same files. Mousse always asks for the language-agnostic `na` tag, so every voice speaks
 * any of the supported languages. The weights are under OpenRAIL-M; the example code is MIT.
 */
export const SUPERTONIC_3: SupertonicTtsModel = {
  id: 'supertonic-3',
  label: 'Supertonic 3',
  description: '31 languages',
  parameters: '99M',
  license: 'OpenRAIL-M',
  homepage: 'https://huggingface.co/Supertone/supertonic-3',
  repo: 'supertone-oss-archive/supertonic-3',
  revision: 'aafc6e32416a594460b32413efc49d7fe4ce6d46',
  runtime: 'supertonic',
  durationPredictor: 'onnx/duration_predictor.onnx',
  textEncoder: 'onnx/text_encoder.onnx',
  vectorEstimator: 'onnx/vector_estimator.onnx',
  vocoder: 'onnx/vocoder.onnx',
  config: 'onnx/tts.json',
  indexer: 'onnx/unicode_indexer.json',
  voiceStyles: 'voice_styles',
  defaultVoice: 'F1',
  voices: ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'].map((id) => ({ id, label: `${id}, ${id[0] === 'F' ? 'female' : 'male'}` })),
  files: [
    { path: 'onnx/tts.json', size: 8253, sha256: '42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09' },
    { path: 'onnx/unicode_indexer.json', size: 277676, sha256: '9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f' },
    { path: 'onnx/duration_predictor.onnx', size: 3700147, sha256: 'c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db' },
    { path: 'onnx/text_encoder.onnx', size: 36416150, sha256: 'c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff' },
    { path: 'onnx/vector_estimator.onnx', size: 256534781, sha256: '883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c' },
    { path: 'onnx/vocoder.onnx', size: 101424195, sha256: '085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba' },
    { path: 'voice_styles/F1.json', size: 292046, sha256: 'bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2' },
    { path: 'voice_styles/F2.json', size: 292423, sha256: '7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6', optional: true },
    { path: 'voice_styles/F3.json', size: 290794, sha256: '12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab', optional: true },
    { path: 'voice_styles/F4.json', size: 291808, sha256: 'c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b', optional: true },
    { path: 'voice_styles/F5.json', size: 291479, sha256: '45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d', optional: true },
    { path: 'voice_styles/M1.json', size: 291748, sha256: 'e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b', optional: true },
    { path: 'voice_styles/M2.json', size: 292055, sha256: 'b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50', optional: true },
    { path: 'voice_styles/M3.json', size: 290198, sha256: 'ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b', optional: true },
    { path: 'voice_styles/M4.json', size: 291522, sha256: 'ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303', optional: true },
    { path: 'voice_styles/M5.json', size: 291469, sha256: 'dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2', optional: true }
  ]
}

/**
 * Pocket TTS voices, as Kyutai names them (characters of Les Miserables). Every language package
 * has the same eight names; each is that language's own recording of the voice state.
 */
const POCKET_VOICES: readonly LocalTtsVoice[] = [
  ['alba', 'Alba', 'female'], ['azelma', 'Azelma', 'female'], ['cosette', 'Cosette', 'female'], ['eponine', 'Eponine', 'female'],
  ['fantine', 'Fantine', 'female'], ['javert', 'Javert', 'male'], ['jean', 'Jean', 'male'], ['marius', 'Marius', 'male']
].map(([id, name, gender]) => ({ id, label: `${name}, ${gender}` }))

const POCKET_REPO = 'Alias-Alias/pocket-3-3-0-tts-onnx'
const POCKET_REVISION = '71a4d6d11a76e26b98709fa163477c77d16bdbdb'

/** Sizes and hashes of the files every language package shares in shape; the graphs differ per language. */
interface PocketPackage {
  language: PocketTtsLanguage
  name: string
  bundle: Pick<LocalModelFile, 'size' | 'sha256'>
  tokenizer: Pick<LocalModelFile, 'size' | 'sha256'>
  flowLmFlow: string
  flowLmMain: string
  mimiDecoder: string
  textConditioner: string
  voices: string
}

const POCKET_PACKAGES: readonly PocketPackage[] = [
  {
    language: 'en', name: 'English',
    bundle: { size: 13438, sha256: 'ccbb828d6dceee19688ee6eee884bb8de16edcc0f21fac5ed713a8739d978b2e' },
    tokenizer: { size: 245020, sha256: 'f498428e1eafee50492f7be13dc9bfafcfc12e508cd0eb1b01c92ecd5d8c6687' },
    flowLmFlow: '7edfcbccb1d40a84b2b59ac1e921963287471ff0cb266603d7fd4282a131d716',
    flowLmMain: 'c9328891492caaa7580284d81d47d01679f570f297023d68fc4c7ce503113dc8',
    mimiDecoder: 'b27d1c38b96947a08bc54a7b660b553866a47b3b368b2170b89b09f5c7f35b56',
    textConditioner: 'a060f0926e87a12309c54a681dde9daba8e32821e1e2348224fd6c30a3a7a28b',
    voices: '720343118b8ec5177397d3898d43b0d13c7948f76794956610e5f0e795100cf1'
  },
  {
    language: 'fr', name: 'French',
    bundle: { size: 13638, sha256: '0894c2fc533b0a94d1f120fa9f959f4125ccff2443ac5362925989a5fcdd7fae' },
    tokenizer: { size: 246403, sha256: '6211acffe9cb95172f71f0051f18e26ea305b2b32ea00b331ee976551c70887f' },
    flowLmFlow: '8c72996bdcae9ea4a981b6afc0a40986523525aaa5491c09ef9546c14becd272',
    flowLmMain: '1c6611cc3d524843e990e3abfdc15ce84f16f7a9250b5970b0255df4759fe70b',
    mimiDecoder: 'd7b00abae02b2916f0be6d42bfbe14e87e0b4f1aaa25b1d5778a1f128edb6bb6',
    textConditioner: '6127b51df140da0123123aa929a9453fc9a63a7cfebdc33f8a1f3fb46c5f2139',
    voices: 'a43532290caa733c6670bc52427f0ed9f709c43867049f3e511f85568fcf9c5c'
  },
  {
    language: 'de', name: 'German',
    bundle: { size: 13623, sha256: '7e43fa70568f3a1800a7dfeab6b3f97e2b5f1ff682c11db9cf22103d53f5fea5' },
    tokenizer: { size: 245966, sha256: '2d77849811e3d1b6ae80e5b11b203f57e1847901104d8a0573b34f46f8dddb53' },
    flowLmFlow: '6198087a456287420d14b98083cd534bee3e92fa107dca1324f03a27c65c8315',
    flowLmMain: '96cb9a628438ca4b26d7ed3160d79bd8ad2e0f097d08a8faea95e00c944ea84e',
    mimiDecoder: '3d0f9574384d73c91404514b933e239333d9580bc42c8fcc161e5402ff67d6b9',
    textConditioner: '0479f6bc635fedf130086c357d013a6a0c54568b301d9b255ffd67d732965378',
    voices: 'a45485ca28c8f046f6e45089d7b01ea45e9a2d36f1ac4cb0947a956b27f4a70d'
  },
  {
    language: 'es', name: 'Spanish',
    bundle: { size: 13654, sha256: '196151a61b907afb2b0ccb4570a4c39993de69d705b371d38ae459120f6aac23' },
    tokenizer: { size: 246610, sha256: '9ade09bbdc64ab2b59952b90773fa0890b780ece4fd5aef0d36a00c6ad5f0531' },
    flowLmFlow: 'b3f028c3cdd909ffa10dffa8055edc9147f273e43bda852733e6a4a36cc3d292',
    flowLmMain: 'f37c8b4a2409de010f638529daf947b863396a78b8b659a77ed6e35362174629',
    mimiDecoder: 'f2f1b6e380a6388557768534d24036cb8b549b9f4eb49bedbb7ed3c4fb06336a',
    textConditioner: '8e98c0abd4ba06fde1db0decb75e3b211e6097ba15854fc9266aa1d16feaeae4',
    voices: '49a8e4d3562074a1e8d041edb4fad3877b327daf4cd898893ff10273216ae178'
  },
  {
    language: 'it', name: 'Italian',
    bundle: { size: 13624, sha256: '5dce446b175a8b9fd8766bde7ce3ee15fb396f2228b77777028c26eb88acfc4f' },
    tokenizer: { size: 246586, sha256: '4bc1c0d4d54f9480183e94c94cfabf74fd89b0912537d4ef607d1982c4a381ec' },
    flowLmFlow: 'b4da5f938b81d895eee0a8c6267162c6466382b761114affb96049db9e649431',
    flowLmMain: '80c1ebae13a0033f7746f2b7a886e3d7fa3523c9d7be2122bec9412ad82c46b8',
    mimiDecoder: 'c258c72d1b8079eb16a08fc9c6a255e918d897f53f784abcb5eaae2f3a0e9344',
    textConditioner: 'f716f278fa279495889fbe8f4426da68d4ca5112b962121991ec8fed002ff090',
    voices: 'cf8f292f5d91d887f8370ebbd4329928421a87f564d475f53a7d456bf144acac'
  },
  {
    language: 'pt', name: 'Portuguese',
    bundle: { size: 13624, sha256: '4b23a635bd375e5d476416cc960ad7488aabd4441aea2861eaf54d98734ea34b' },
    tokenizer: { size: 247014, sha256: 'b33e269f7f042a763080d71ba087d74d2f6759674b238a723c028e436b1a25ab' },
    flowLmFlow: 'f2e2a3da0fb5c1e6b472f1921459f7e6c051fa54c25e08186b46d559d620b379',
    flowLmMain: '15357eb39cbd574bc4193fef960d6b332a861c84bfcf99e9417316bac129d1d8',
    mimiDecoder: '6974a4330bbbfe91fcc46084b26e769c8eefd6121bd3ad42e84861f9f05854b2',
    textConditioner: '22ee9182a3dadc37ba06cdf3ff9c0e0ac0622f006a2eb29d2f5e0a13ba642d3e',
    voices: '402d569dcb5d25c5b93cae6995d6d4d499cf1bfc591ed8edf2ce50547a8b3651'
  },
  {
    language: 'nl', name: 'Dutch',
    bundle: { size: 13624, sha256: '48581badbfe176db6df37ac0f784893fe2c681ae1e845263c4cd36106d8c1705' },
    tokenizer: { size: 245206, sha256: 'e6f610b98c427641b4ab0e1024dca7843e3d6b620871a14b204932e42c5a1736' },
    flowLmFlow: 'd0b3e7da6ef29c0c0a2e6f721b9c3b3835b93c3f3f2854f5882e11222f7450ea',
    flowLmMain: 'b6ae39189f6881ec0d87fa50ac690db239c6759c110e179714752b8b5d36e75c',
    mimiDecoder: '2cf5feebf7ba7486491c87a49036b0afae3093546aff3f5a46ec5e967b6c3ca5',
    textConditioner: '3bd2960e2ea136a8f870149f4238789f6dbcc54c1b643a4639b7be028e52fbb2',
    voices: '1e7f812d5824a931fef68337291896bd88521c9f031d545877e7f46b144ed38c'
  }
]

/** Sizes shared by every language package: the quantized graphs and the voices file have the same shapes. */
const POCKET_SIZES = { flowLmFlow: 10040048, flowLmMain: 76397201, mimiDecoder: 22638621, textConditioner: 16388338, voices: 52404520 }

/**
 * Pocket TTS (Kyutai) 3.3.0 as exported to INT8 ONNX by Alias-Alias for browsers and native
 * runtimes, pinned to one commit of that repository. The export keeps Kyutai's official weights
 * and voices (CC BY 4.0); the repository records the source revisions and checksums. English plus
 * six more languages, each a separate package of about 180 MB. Pocket TTS has no speed control, so
 * Mousse changes the pace of the finished audio instead.
 */
const pocketModel = (pack: PocketPackage): PocketTtsModel => {
  const path = (name: string): string => `${pack.language}/${name}`
  return {
    id: `pocket-tts-${pack.language}`,
    label: `Pocket TTS ${pack.name}`,
    description: `${pack.name} voices`,
    parameters: '100M',
    license: 'CC-BY-4.0',
    homepage: 'https://huggingface.co/kyutai/pocket-tts',
    repo: POCKET_REPO,
    revision: POCKET_REVISION,
    runtime: 'pocket',
    language: pack.language,
    bundle: path('bundle.json'),
    tokenizer: path('tokenizer.json'),
    voicesFile: path('voices.bin'),
    textConditioner: path('text_conditioner_int8.onnx'),
    flowLmMain: path('flow_lm_main_int8.onnx'),
    flowLmFlow: path('flow_lm_flow_int8.onnx'),
    mimiDecoder: path('mimi_decoder_int8.onnx'),
    defaultVoice: 'alba',
    voices: POCKET_VOICES,
    files: [
      { path: path('bundle.json'), ...pack.bundle },
      { path: path('tokenizer.json'), ...pack.tokenizer },
      { path: path('text_conditioner_int8.onnx'), size: POCKET_SIZES.textConditioner, sha256: pack.textConditioner },
      { path: path('flow_lm_main_int8.onnx'), size: POCKET_SIZES.flowLmMain, sha256: pack.flowLmMain },
      { path: path('flow_lm_flow_int8.onnx'), size: POCKET_SIZES.flowLmFlow, sha256: pack.flowLmFlow },
      { path: path('mimi_decoder_int8.onnx'), size: POCKET_SIZES.mimiDecoder, sha256: pack.mimiDecoder },
      { path: path('voices.bin'), size: POCKET_SIZES.voices, sha256: pack.voices }
    ]
  }
}

export const POCKET_TTS_MODELS: readonly PocketTtsModel[] = POCKET_PACKAGES.map(pocketModel)

export const LOCAL_TTS_MODELS: readonly LocalTtsModel[] = [
  KOKORO_82M, KITTEN_TTS_MINI, KITTEN_TTS_MICRO, KITTEN_TTS_NANO, SUPERTONIC_3, ...POCKET_TTS_MODELS
]

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
