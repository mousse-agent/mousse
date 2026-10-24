import type { LocalModelState } from './localModels'
import { PROVIDER_STT_MAX_BYTES } from './dictation'

/**
 * Phone speech: a paired phone dictates and listens to messages with the speech models of this
 * computer. The phone's requests reach the daemon over Net; the daemon hands each one to an open
 * Mousse window, which runs it with the same model, voice and speed the window uses itself
 * (dictation and read aloud keep their model choice per profile in the window).
 */

/** `dictation` is speech-to-text, `readAloud` is text-to-speech. */
export type PhoneSpeechKind = 'dictation' | 'readAloud'
export const PHONE_SPEECH_KINDS: readonly PhoneSpeechKind[] = ['dictation', 'readAloud']

/** A model choice as the phone names it; the window adds the label it shows. */
export type PhoneSpeechChoice =
  | { source: 'provider'; providerId: string; modelId: string }
  | { source: 'local'; modelId: string }

/** Methods a phone calls. */
export const PHONE_SPEECH_METHODS = {
  options: 'speech.options',
  choose: 'speech.choose',
  download: 'speech.download',
  upload: 'speech.upload',
  transcribe: 'speech.transcribe',
  speak: 'speech.speak'
} as const

/** Work the daemon hands to a window. */
export type SpeechJobOp = 'options' | 'choose' | 'download' | 'transcribe' | 'speak'

/** Methods the window uses to serve phone speech requests (local GUI connection only). */
export const SPEECH_HOST_METHODS = ['speech.host.wait', 'speech.host.take', 'speech.host.progress', 'speech.host.finish'] as const
export type SpeechHostMethod = (typeof SPEECH_HOST_METHODS)[number]

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

/** Base64 characters per uploaded piece of a recording; keeps each request inside one Net frame. */
export const PHONE_SPEECH_UPLOAD_CHUNK_CHARS = 48 * 1024
/** Largest recording, in bytes. Matches what a provider model accepts. */
export const PHONE_SPEECH_MAX_RECORDING_BYTES = PROVIDER_STT_MAX_BYTES
/** Recordings a phone may be uploading at once. */
export const PHONE_SPEECH_MAX_UPLOADS = 4
/** An upload nobody finished or transcribed is dropped after this long. */
export const PHONE_SPEECH_UPLOAD_TTL_MS = 10 * 60_000
/** Longest message read aloud for a phone, in UTF-8 bytes of markdown; one request fits one Net frame. */
export const PHONE_SPEECH_MAX_TEXT_BYTES = 40 * 1024
/** Requests the computer works on for phones at once, per profile. */
export const PHONE_SPEECH_MAX_JOBS = 8
/** Raw audio bytes per streamed piece; base64 keeps it well inside one Net frame. */
export const PHONE_SPEECH_AUDIO_PART_BYTES = 30 * 1024
/** Largest JSON progress or result a window sends for one job. */
export const SPEECH_HOST_MAX_MESSAGE_BYTES = 60 * 1024
/** How long a window's wait request stays open when no work arrives. */
export const SPEECH_HOST_WAIT_MS = 20_000
/** A window counts as serving phones while it waits or waited this recently. */
export const SPEECH_HOST_FRESH_MS = 5_000
/** A job no window picked up by then fails. */
export const SPEECH_JOB_TAKE_TIMEOUT_MS = 10_000

/** Recording types the computer can decode (MediaRecorder output on Android and desktop browsers). */
export const PHONE_SPEECH_AUDIO_MIME = /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav|aac)(;\s*codecs="?[a-z0-9.]+"?)?$/i

// ---------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------

/**
 * Expected refusals are answers, not errors, so their message reaches the phone:
 * - `no_host`: no Mousse window is open on the computer.
 * - `no_model`: no model is chosen for this feature yet; the phone offers the chooser.
 * - `unavailable`: the chosen model cannot run (not downloaded, provider signed out, ...).
 * - `invalid`: the request names something the computer does not offer.
 * - `busy`: too much speech work is already running.
 * - `failed`: the model ran and failed.
 */
export type PhoneSpeechErrorCode = 'no_host' | 'no_model' | 'unavailable' | 'invalid' | 'busy' | 'failed'

export interface PhoneSpeechRefusal {
  ok: false
  code: PhoneSpeechErrorCode
  error: string
}

export interface PhoneSpeechProviderModel {
  providerId: string
  providerLabel: string
  modelId: string
  label: string
}

export interface PhoneSpeechLocalModel {
  id: string
  label: string
  description: string
  parameters: string
  license: string
  homepage: string
  bytes: number
  state: LocalModelState
}

export interface PhoneSpeechSelection {
  source: 'provider' | 'local'
  providerId?: string
  modelId: string
  label: string
}

/** `speech.options`: what the chooser shows, and the model in use (null before the first choice). */
export interface PhoneSpeechOptions {
  ok: true
  kind: PhoneSpeechKind
  selection: PhoneSpeechSelection | null
  /** Read aloud only: the voice the computer reads with for the selected model. */
  voice?: string
  providers: PhoneSpeechProviderModel[]
  local: PhoneSpeechLocalModel[]
}

/** Progress of `speech.download`. */
export interface PhoneSpeechDownloadProgress {
  type: 'status'
  state: LocalModelState
}

/** Progress of `speech.transcribe`: the text of the pieces transcribed so far. */
export interface PhoneSpeechPartial {
  type: 'partial'
  text: string
}

/**
 * Progress of `speech.speak`: one piece of a clip of audio. Clips play in order; a clip's pieces
 * join into one file of `mimeType` (WAV for local models, the provider's format otherwise).
 * `rate` is the playback rate the phone applies with pitch kept (the computer's read aloud speed
 * for provider audio; local audio is already spoken at that speed).
 */
export interface PhoneSpeechAudioPart {
  type: 'audio'
  clip: number
  part: number
  last: boolean
  mimeType: string
  rate: number
  data: string
}

// ---------------------------------------------------------------------------------------------
// Window side
// ---------------------------------------------------------------------------------------------

/** A job as `speech.host.wait` announces it. */
export interface SpeechJobNotice {
  id: string
  op: SpeechJobOp
  kind: PhoneSpeechKind
}

/** A job as `speech.host.take` hands it over. */
export interface SpeechJobInput extends SpeechJobNotice {
  /** `choose`: the choice; `download`: `{ modelId }`; `speak`: `{ text }`; `transcribe`: `{ mimeType }`. */
  params: Record<string, unknown>
  /** `transcribe` only: the recording. */
  audioBase64?: string
}
