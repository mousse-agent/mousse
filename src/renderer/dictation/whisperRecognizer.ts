import { AutoProcessor, AutoTokenizer, Tensor, WhisperForConditionalGeneration } from '@huggingface/transformers'
import type { WhisperSttModel } from '../../shared/dictation'

/**
 * Whisper through transformers.js. The speech recognition pipeline cannot be used as is: for a
 * multilingual model it falls back to English ("TODO: Implement language detection"), which would
 * turn French speech into English guesses. So the steps are run here: encode the audio once,
 * score the language tokens with one decoder step, then decode with the language that won.
 */

/** The parts of transformers.js's Whisper classes this file calls, so tests can stand in for them. */
export interface WhisperParts {
  processor: (samples: Float32Array) => Promise<{ input_features: unknown }>
  model: {
    generation_config: { decoder_start_token_id: number; lang_to_id: Record<string, number> }
    _prepare_encoder_decoder_kwargs_for_generation: (options: {
      inputs_tensor: unknown
      model_inputs: Record<string, unknown>
      model_input_name: string
      generation_config: Record<string, unknown>
    }) => Promise<{ encoder_outputs: unknown }>
    forward: (inputs: { encoder_outputs: unknown; decoder_input_ids: unknown }) => Promise<{ logits: { data: ArrayLike<number> | ArrayLike<bigint>; dims: number[] } }>
    generate: (options: Record<string, unknown>) => Promise<unknown>
  }
  tokenizer: { batch_decode: (tokens: unknown, options: { skip_special_tokens: boolean }) => string[] }
  /** Builds the one-token decoder prompt; transformers.js wants an int64 tensor. */
  startTokens: (id: number) => unknown
}

/**
 * The language whose token the decoder scored highest after the start token, as a code such as
 * `fr`. `langToId` maps `<|fr|>` style tokens to ids in the logits.
 */
export function detectWhisperLanguage(logits: ArrayLike<number>, langToId: Readonly<Record<string, number>>): string | undefined {
  let best: { code: string; score: number } | undefined
  for (const [token, id] of Object.entries(langToId)) {
    const code = /^<\|([a-z]{2,3})\|>$/.exec(token)?.[1]
    if (!code || id >= logits.length) continue
    if (!best || logits[id] > best.score) best = { code, score: logits[id] }
  }
  return best?.code
}

/** Transcribes up to 30 s of 16 kHz audio in the language it is spoken in; plain text, no timestamps. */
export async function transcribeWhisper(parts: WhisperParts, samples: Float32Array): Promise<string> {
  const { model, processor, tokenizer } = parts
  const { input_features: features } = await processor(samples)
  const { encoder_outputs: encoderOutputs } = await model._prepare_encoder_decoder_kwargs_for_generation({
    inputs_tensor: features,
    model_inputs: { input_features: features },
    model_input_name: 'input_features',
    generation_config: {}
  })

  const { logits } = await model.forward({
    encoder_outputs: encoderOutputs,
    decoder_input_ids: parts.startTokens(model.generation_config.decoder_start_token_id)
  })
  const language = detectWhisperLanguage(logits.data as ArrayLike<number>, model.generation_config.lang_to_id)

  const tokens = await model.generate({
    inputs: features,
    encoder_outputs: encoderOutputs,
    language,
    task: 'transcribe',
    return_timestamps: false
  })
  return tokenizer.batch_decode(tokens, { skip_special_tokens: true })[0] ?? ''
}

/** `device` is `wasm` in the app; Node scripts that use the Node build of transformers.js pass `cpu`. */
export async function loadWhisper(model: WhisperSttModel, device: 'wasm' | 'cpu' = 'wasm'): Promise<WhisperParts> {
  const [processor, tokenizer, whisper] = await Promise.all([
    AutoProcessor.from_pretrained(model.repo),
    AutoTokenizer.from_pretrained(model.repo),
    WhisperForConditionalGeneration.from_pretrained(model.repo, { dtype: model.dtype, device })
  ])
  return {
    processor: processor as unknown as WhisperParts['processor'],
    tokenizer: tokenizer as unknown as WhisperParts['tokenizer'],
    model: whisper as unknown as WhisperParts['model'],
    startTokens: (id) => new Tensor('int64', [BigInt(id)], [1, 1])
  }
}
