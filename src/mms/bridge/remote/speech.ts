import type { NodeCapability } from '../../../shared/net'
import { NetError } from '../../../shared/net'
import {
  PHONE_SPEECH_AUDIO_MIME,
  PHONE_SPEECH_KINDS,
  PHONE_SPEECH_MAX_RECORDING_BYTES,
  PHONE_SPEECH_MAX_TEXT_BYTES,
  PHONE_SPEECH_METHODS,
  PHONE_SPEECH_UPLOAD_CHUNK_CHARS,
  type PhoneSpeechKind
} from '../../../shared/speechRelay'
import type { RpcContext, RpcMethod } from '../../net/contracts'
import type { SpeechRelay } from '../../speech/SpeechRelay'

/**
 * Speech for paired phones. Listing the choices only reads; choosing a model, downloading one and
 * running a model are part of using the chat with voice, so they need `chat`, like sending a
 * message with images. Nothing here reaches provider credentials, files or settings beyond the
 * dictation and read aloud model choice.
 */
export const PHONE_SPEECH_CAPABILITIES = {
  [PHONE_SPEECH_METHODS.options]: { capability: 'read', mutating: false },
  [PHONE_SPEECH_METHODS.choose]: { capability: 'chat', mutating: true },
  [PHONE_SPEECH_METHODS.download]: { capability: 'chat', mutating: true },
  [PHONE_SPEECH_METHODS.upload]: { capability: 'chat', mutating: true },
  [PHONE_SPEECH_METHODS.transcribe]: { capability: 'chat', mutating: true },
  [PHONE_SPEECH_METHODS.speak]: { capability: 'chat', mutating: true }
} as const satisfies Record<string, { capability: NodeCapability; mutating: boolean }>

const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
/** Provider catalog ids, e.g. `whisper-1` or `canopylabs/orpheus-v1-english`; only compared with the offered list. */
const MODEL_ID = /^[\w./:@+-]{1,256}$/
/** Local model ids from the manifests, e.g. `kokoro-82m`. */
const LOCAL_MODEL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
/** Pieces in the longest recording, with room for a short last piece. */
const MAX_UPLOAD_PARTS =
  Math.ceil(PHONE_SPEECH_MAX_RECORDING_BYTES / ((PHONE_SPEECH_UPLOAD_CHUNK_CHARS * 3) / 4)) + 1

function bad(): never {
  throw new NetError('bad_request')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad()
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) bad()
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) if (!allowed.has(key)) bad()
  for (const key of required) if (!Object.hasOwn(value, key)) bad()
}

function kind(value: unknown): PhoneSpeechKind {
  if (!(PHONE_SPEECH_KINDS as readonly unknown[]).includes(value)) bad()
  return value as PhoneSpeechKind
}

function modelId(value: unknown, pattern = MODEL_ID): string {
  if (typeof value !== 'string' || !pattern.test(value)) bad()
  return value
}

function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) bad()
  return value as number
}

/** Exact DTO checks, before admission. Returns the params unchanged. */
export function validatePhoneSpeechParams(method: string, value: unknown): Record<string, unknown> {
  const p = record(value)
  switch (method) {
    case PHONE_SPEECH_METHODS.options:
      exactKeys(p, ['kind'])
      kind(p.kind)
      return p
    case PHONE_SPEECH_METHODS.choose: {
      exactKeys(p, ['kind', 'selection'])
      kind(p.kind)
      const selection = record(p.selection)
      if (selection.source === 'provider') {
        exactKeys(selection, ['source', 'providerId', 'modelId'])
        if (
          typeof selection.providerId !== 'string' ||
          !/^[\w.-]{1,128}$/.test(selection.providerId)
        )
          bad()
        modelId(selection.modelId)
      } else if (selection.source === 'local') {
        exactKeys(selection, ['source', 'modelId'])
        modelId(selection.modelId, LOCAL_MODEL_ID)
      } else bad()
      return p
    }
    case PHONE_SPEECH_METHODS.download:
      exactKeys(p, ['kind', 'modelId'])
      kind(p.kind)
      modelId(p.modelId, LOCAL_MODEL_ID)
      return p
    case PHONE_SPEECH_METHODS.upload:
      exactKeys(p, ['upload', 'index', 'data'])
      if (typeof p.upload !== 'string' || !UPLOAD_ID.test(p.upload)) bad()
      integer(p.index, 0, MAX_UPLOAD_PARTS - 1)
      if (
        typeof p.data !== 'string' ||
        p.data.length === 0 ||
        p.data.length > PHONE_SPEECH_UPLOAD_CHUNK_CHARS ||
        p.data.length % 4 !== 0 ||
        !BASE64.test(p.data)
      )
        bad()
      return p
    case PHONE_SPEECH_METHODS.transcribe:
      exactKeys(p, ['upload', 'parts', 'mimeType'])
      if (typeof p.upload !== 'string' || !UPLOAD_ID.test(p.upload)) bad()
      integer(p.parts, 1, MAX_UPLOAD_PARTS)
      if (
        typeof p.mimeType !== 'string' ||
        p.mimeType.length > 128 ||
        !PHONE_SPEECH_AUDIO_MIME.test(p.mimeType)
      )
        bad()
      return p
    case PHONE_SPEECH_METHODS.speak:
      exactKeys(p, ['text'])
      if (
        typeof p.text !== 'string' ||
        !p.text.trim() ||
        Buffer.byteLength(p.text, 'utf8') > PHONE_SPEECH_MAX_TEXT_BYTES
      )
        bad()
      return p
    default:
      bad()
  }
}

/** Runs a validated phone speech request through the relay. Expected refusals are answers. */
async function handlePhoneSpeech(
  relay: SpeechRelay,
  method: string,
  params: Record<string, unknown>,
  context: RpcContext
): Promise<unknown> {
  if (context.signal.aborted) throw new NetError('cancelled')
  const submit = (
    op: Parameters<SpeechRelay['submit']>[0],
    speechKind: PhoneSpeechKind,
    jobParams: Record<string, unknown>,
    audio?: Buffer
  ) =>
    relay.submit(op, speechKind, jobParams, {
      signal: context.signal,
      progress: (data) => context.progress(data),
      ...(audio ? { audio } : {})
    })
  switch (method) {
    case PHONE_SPEECH_METHODS.options:
      return submit('options', params.kind as PhoneSpeechKind, {})
    case PHONE_SPEECH_METHODS.choose:
      return submit('choose', params.kind as PhoneSpeechKind, { selection: params.selection })
    case PHONE_SPEECH_METHODS.download:
      return submit('download', params.kind as PhoneSpeechKind, { modelId: params.modelId })
    case PHONE_SPEECH_METHODS.upload:
      return relay.appendUpload(
        context.caller.node,
        params.upload as string,
        params.index as number,
        Buffer.from(params.data as string, 'base64')
      )
    case PHONE_SPEECH_METHODS.transcribe: {
      const upload = params.upload as string
      const audio = relay.recording(context.caller.node, upload, params.parts as number)
      if (!Buffer.isBuffer(audio)) return audio
      const result = await submit('transcribe', 'dictation', { mimeType: params.mimeType }, audio)
      // Keep the recording when no window ran it or no model was chosen, so the phone can open
      // Mousse or choose a model and try again. The upload expires on its own.
      const refused =
        result && typeof result === 'object' && (result as { ok?: unknown }).ok === false
      const code = refused ? (result as { code?: unknown }).code : undefined
      if (code !== 'no_model' && code !== 'no_host' && code !== 'busy')
        relay.dropUpload(context.caller.node, upload)
      return result
    }
    case PHONE_SPEECH_METHODS.speak:
      return submit('speak', 'readAloud', { text: params.text })
    default:
      throw new NetError('forbidden')
  }
}

/** The phone speech RPC methods, deny-default like the rest of the remote surface. */
export function phoneSpeechMethods(
  relay: SpeechRelay
): Array<RpcMethod & { validate(params: unknown): unknown }> {
  return (
    Object.keys(PHONE_SPEECH_CAPABILITIES) as Array<keyof typeof PHONE_SPEECH_CAPABILITIES>
  ).map((method) => ({
    method,
    ...PHONE_SPEECH_CAPABILITIES[method],
    validate: (params) => validatePhoneSpeechParams(method, params),
    handle: (params, context) =>
      handlePhoneSpeech(relay, method, validatePhoneSpeechParams(method, params), context)
  }))
}
