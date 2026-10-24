import {
  LOCAL_STT_MODELS,
  findLocalSttModel,
  sttModelsFromProviders,
  type DictationSelection,
  type LocalSttModelId
} from '../../shared/dictation'
import { localModelBytes, type LocalModelManifest, type LocalModelState, type LocalModelStatus } from '../../shared/localModels'
import {
  LOCAL_TTS_MODELS,
  PROVIDER_TTS_MAX_CHARS,
  findLocalTtsModel,
  ttsModelsFromProviders,
  type LocalTtsModelId,
  type ProviderSpeechRequest,
  type ProviderSpeechResult,
  type ReadAloudSelection
} from '../../shared/readAloud'
import type { LlmProviderOption } from '../../shared/settings'
import {
  PHONE_SPEECH_AUDIO_PART_BYTES,
  type PhoneSpeechAudioPart,
  type PhoneSpeechErrorCode,
  type PhoneSpeechKind,
  type PhoneSpeechLocalModel,
  type PhoneSpeechOptions,
  type PhoneSpeechProviderModel,
  type PhoneSpeechRefusal,
  type PhoneSpeechSelection,
  type SpeechJobInput
} from '../../shared/speechRelay'
import { markdownToSpeechText, splitSpeechChunks } from '../readAloud/speechText'
import type { SpeechPreferences } from '../speech/speechPreferences'
import { ipcErrorMessage } from '../utils/voiceErrors'
import { base64ToBytes, bytesToBase64, encodeWav } from './audioEncoding'

/**
 * What a phone speech job needs from this window: the profile's model choices and speech
 * preferences, the local model files and the engines. The window passes the real ones; tests pass
 * fakes.
 */
export interface PhoneSpeechDeps {
  /** The profile this window shows now; the selection setters save under it. */
  profileId(): string
  dictationSelection(): DictationSelection | null
  setDictationSelection(selection: DictationSelection): void
  readAloudSelection(): ReadAloudSelection | null
  setReadAloudSelection(selection: ReadAloudSelection): void
  preferences(): SpeechPreferences
  /** The voice read aloud uses with `selection` under `preferences`. */
  voiceFor(preferences: SpeechPreferences, selection: ReadAloudSelection): string | undefined
  providers(): Promise<readonly LlmProviderOption[]>
  localModels(kind: PhoneSpeechKind): Promise<LocalModelStatus[]>
  download(kind: PhoneSpeechKind, modelId: string): Promise<LocalModelStatus>
  cancelDownload(kind: PhoneSpeechKind, modelId: string): Promise<unknown>
  onLocalStatus(kind: PhoneSpeechKind, listener: (status: LocalModelStatus) => void): () => void
  transcribe(recording: Blob, selection: DictationSelection, onPartial: (text: string) => void, signal: AbortSignal): Promise<string>
  /** Hands over each clip and waits for `onClip` before going on, so a slow phone holds synthesis back. */
  synthesizeLocal(
    modelId: LocalTtsModelId,
    text: string,
    options: {
      signal: AbortSignal
      voice: string | undefined
      speed: number
      onClip: (samples: Float32Array, sampleRate: number) => void | Promise<void>
    }
  ): Promise<void>
  synthesizeProvider(request: ProviderSpeechRequest): Promise<ProviderSpeechResult>
}

export interface PhoneSpeechIo {
  signal: AbortSignal
  /** Sends progress to the phone; resolves false once the phone stopped listening. */
  progress(data: unknown): Promise<boolean>
}

/** Download progress is sent at most this often, plus every state change. */
const DOWNLOAD_PROGRESS_MS = 250

const refuse = (code: PhoneSpeechErrorCode, error: string): PhoneSpeechRefusal => ({ ok: false, code, error })
const cancelled = (): PhoneSpeechRefusal => refuse('failed', 'The request was cancelled.')

/**
 * Sends progress one message at a time without holding the job up: while a send is out, newer
 * messages replace each other and only the latest goes next. For messages that each say where
 * things stand, like the text so far or a download state.
 */
function latestOnly(io: PhoneSpeechIo): (data: unknown) => void {
  let sending = false
  let next: { data: unknown } | null = null
  const pump = async (): Promise<void> => {
    sending = true
    try {
      while (next) {
        const { data } = next
        next = null
        if (io.signal.aborted || !(await io.progress(data))) return
      }
    } finally {
      sending = false
      next = null
    }
  }
  return (data) => {
    next = { data }
    if (!sending) void pump()
  }
}

function localManifests(kind: PhoneSpeechKind): readonly LocalModelManifest[] {
  return kind === 'dictation' ? LOCAL_STT_MODELS : LOCAL_TTS_MODELS
}

function selectionOf(kind: PhoneSpeechKind, deps: PhoneSpeechDeps): DictationSelection | ReadAloudSelection | null {
  return kind === 'dictation' ? deps.dictationSelection() : deps.readAloudSelection()
}

function providerModels(kind: PhoneSpeechKind, providers: readonly LlmProviderOption[]): PhoneSpeechProviderModel[] {
  return kind === 'dictation' ? sttModelsFromProviders(providers) : ttsModelsFromProviders(providers)
}

async function localStates(kind: PhoneSpeechKind, deps: PhoneSpeechDeps): Promise<Map<string, LocalModelState>> {
  const statuses = await deps.localModels(kind).catch(() => [] as LocalModelStatus[])
  return new Map(statuses.map((status) => [status.modelId, status.state]))
}

function publicSelection(selection: DictationSelection | ReadAloudSelection | null): PhoneSpeechSelection | null {
  if (!selection) return null
  return selection.source === 'provider'
    ? { source: 'provider', providerId: selection.providerId, modelId: selection.modelId, label: selection.label }
    : { source: 'local', modelId: selection.modelId, label: selection.label }
}

async function options(kind: PhoneSpeechKind, deps: PhoneSpeechDeps): Promise<PhoneSpeechOptions> {
  const [providers, states] = await Promise.all([deps.providers().catch(() => [] as readonly LlmProviderOption[]), localStates(kind, deps)])
  const local: PhoneSpeechLocalModel[] = localManifests(kind).map((model) => ({
    id: model.id,
    label: model.label,
    description: model.description,
    parameters: model.parameters,
    license: model.license,
    homepage: model.homepage,
    bytes: localModelBytes(model),
    state: states.get(model.id) ?? { status: 'not-downloaded' }
  }))
  const selection = selectionOf(kind, deps)
  const voice = kind === 'readAloud' && selection ? deps.voiceFor(deps.preferences(), selection as ReadAloudSelection) : undefined
  return {
    ok: true,
    kind,
    selection: publicSelection(selection),
    ...(voice ? { voice } : {}),
    providers: providerModels(kind, providers),
    local
  }
}

/** Saves a choice the phone made, under the same rules as the desktop chooser. */
async function choose(
  kind: PhoneSpeechKind,
  choice: Record<string, unknown>,
  deps: PhoneSpeechDeps,
  io: PhoneSpeechIo,
  profileId: string
): Promise<unknown> {
  // The window can switch profile while a lookup is out, and the setters save under the profile it
  // shows by then. The choice belongs to the profile that took the job, so it is dropped otherwise.
  const switched = (): PhoneSpeechRefusal | null =>
    io.signal.aborted || deps.profileId() !== profileId
      ? refuse('failed', 'This window switched profiles before the choice was saved.')
      : null
  if (choice.source === 'provider') {
    const providers = await deps.providers()
    const dropped = switched()
    if (dropped) return dropped
    const model = providerModels(kind, providers).find((entry) => entry.providerId === choice.providerId && entry.modelId === choice.modelId)
    if (!model) return refuse('invalid', 'That model is no longer offered by the providers on this computer.')
    const selection = { source: 'provider' as const, providerId: model.providerId, modelId: model.modelId, label: `${model.providerLabel} · ${model.label}` }
    if (kind === 'dictation') deps.setDictationSelection(selection)
    else deps.setReadAloudSelection(selection)
    return { ok: true, selection: publicSelection(selection) }
  }
  const modelId = String(choice.modelId)
  const manifest = kind === 'dictation' ? findLocalSttModel(modelId) : findLocalTtsModel(modelId)
  if (!manifest) return refuse('invalid', 'This computer does not offer that model.')
  const states = await localStates(kind, deps)
  const dropped = switched()
  if (dropped) return dropped
  if (states.get(manifest.id)?.status !== 'downloaded')
    return refuse('unavailable', `${manifest.label} is not downloaded on this computer yet.`)
  if (kind === 'dictation') {
    const selection: DictationSelection = { source: 'local', modelId: manifest.id as LocalSttModelId, label: manifest.label }
    deps.setDictationSelection(selection)
    return { ok: true, selection: publicSelection(selection) }
  }
  const selection: ReadAloudSelection = { source: 'local', modelId: manifest.id as LocalTtsModelId, label: manifest.label }
  deps.setReadAloudSelection(selection)
  return { ok: true, selection: publicSelection(selection) }
}

async function download(kind: PhoneSpeechKind, modelId: string, deps: PhoneSpeechDeps, io: PhoneSpeechIo): Promise<unknown> {
  const manifest = localManifests(kind).find((model) => model.id === modelId)
  if (!manifest) return refuse('invalid', 'This computer does not offer that model.')
  const current = (await localStates(kind, deps)).get(modelId)
  if (io.signal.aborted) return cancelled()
  if (current?.status === 'downloaded') return { ok: true, state: current }
  const notify = latestOnly(io)
  let lastSent = 0
  let lastStatus = ''
  const unsubscribe = deps.onLocalStatus(kind, (status) => {
    if (status.modelId !== modelId) return
    const now = Date.now()
    if (status.state.status === lastStatus && now - lastSent < DOWNLOAD_PROGRESS_MS) return
    lastSent = now
    lastStatus = status.state.status
    notify({ type: 'status', state: status.state })
  })
  const onAbort = (): void => {
    void deps.cancelDownload(kind, modelId).catch(() => undefined)
  }
  io.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const status = await deps.download(kind, modelId)
    if (status.state.status === 'error') return refuse('failed', status.state.message)
    if (status.state.status !== 'downloaded') return refuse('failed', 'The download stopped before it finished.')
    return { ok: true, state: status.state }
  } catch (error) {
    return refuse('failed', ipcErrorMessage(error) || 'The download failed.')
  } finally {
    unsubscribe()
    io.signal.removeEventListener('abort', onAbort)
  }
}

/** Fails when a local model in use is not on disk; the chooser can then offer another. */
async function localModelReady(kind: PhoneSpeechKind, selection: DictationSelection | ReadAloudSelection, deps: PhoneSpeechDeps): Promise<PhoneSpeechRefusal | null> {
  if (selection.source !== 'local') return null
  if ((await localStates(kind, deps)).get(selection.modelId)?.status === 'downloaded') return null
  return refuse('no_model', `${selection.label} is not downloaded on this computer. Choose a model or download it again.`)
}

async function transcribe(job: SpeechJobInput, deps: PhoneSpeechDeps, io: PhoneSpeechIo): Promise<unknown> {
  const selection = deps.dictationSelection()
  if (!selection) return refuse('no_model', 'No dictation model is chosen on this computer yet.')
  const missing = await localModelReady('dictation', selection, deps)
  if (missing) return missing
  if (io.signal.aborted) return cancelled()
  if (!job.audioBase64) return refuse('invalid', 'The recording is empty.')
  const notify = latestOnly(io)
  const recording = new Blob([base64ToBytes(job.audioBase64)], { type: String(job.params.mimeType ?? 'audio/webm') })
  try {
    const text = await deps.transcribe(recording, selection, (partial) => notify({ type: 'partial', text: partial }), io.signal)
    return { ok: true, text: text.trim() }
  } catch (error) {
    return refuse('failed', ipcErrorMessage(error) || 'Dictation failed on the computer.')
  }
}

/** Streams one clip of audio to the phone in pieces; false once the phone stopped listening. */
async function sendClip(io: PhoneSpeechIo, clip: number, bytes: Uint8Array, mimeType: string, rate: number): Promise<boolean> {
  const parts = Math.max(1, Math.ceil(bytes.length / PHONE_SPEECH_AUDIO_PART_BYTES))
  for (let part = 0; part < parts; part += 1) {
    if (io.signal.aborted) return false
    const data = bytesToBase64(bytes.subarray(part * PHONE_SPEECH_AUDIO_PART_BYTES, (part + 1) * PHONE_SPEECH_AUDIO_PART_BYTES))
    const message: PhoneSpeechAudioPart = { type: 'audio', clip, part, last: part === parts - 1, mimeType, rate, data }
    if (!(await io.progress(message))) return false
  }
  return true
}

async function speak(job: SpeechJobInput, deps: PhoneSpeechDeps, io: PhoneSpeechIo): Promise<unknown> {
  const selection = deps.readAloudSelection()
  if (!selection) return refuse('no_model', 'No read aloud voice is chosen on this computer yet.')
  const missing = await localModelReady('readAloud', selection, deps)
  if (missing) return missing
  if (io.signal.aborted) return cancelled()
  const text = markdownToSpeechText(String(job.params.text ?? ''))
  if (!text) return refuse('invalid', 'There is nothing to read aloud in this message.')
  const preferences = deps.preferences()
  const voice = deps.voiceFor(preferences, selection)
  const stop = new AbortController()
  const onAbort = (): void => stop.abort()
  io.signal.addEventListener('abort', onAbort, { once: true })
  let clips = 0
  // Each clip is sent before the next is handed over, so audio waits in memory for the phone no
  // more than one clip plus the few the engine voices ahead.
  const send = async (bytes: Uint8Array, mimeType: string, rate: number): Promise<void> => {
    const clip = clips++
    if (stop.signal.aborted) return
    if (!(await sendClip(io, clip, bytes, mimeType, rate))) stop.abort()
  }
  try {
    if (selection.source === 'local') {
      await deps.synthesizeLocal(selection.modelId, text, {
        signal: stop.signal,
        voice,
        speed: preferences.speed,
        onClip: (samples, sampleRate) => send(encodeWav(samples, sampleRate), 'audio/wav', 1)
      })
    } else {
      const chunks = splitSpeechChunks(text, PROVIDER_TTS_MAX_CHARS)
      // The next chunk is requested while this one is sent; never more than one ahead.
      const request = (index: number): Promise<ProviderSpeechResult> | null => {
        if (index >= chunks.length || stop.signal.aborted) return null
        const pending = deps.synthesizeProvider({ providerId: selection.providerId, modelId: selection.modelId, text: chunks[index], voice })
        pending.catch(() => undefined)
        return pending
      }
      let current = request(0)
      for (let index = 0; current && !stop.signal.aborted; index += 1) {
        const result = await current
        current = request(index + 1)
        await send(result.audio, result.mimeType, preferences.speed)
      }
    }
    return { ok: true, clips }
  } catch (error) {
    stop.abort()
    return refuse('failed', ipcErrorMessage(error) || 'Read aloud failed on the computer.')
  } finally {
    io.signal.removeEventListener('abort', onAbort)
  }
}

/** Runs one phone speech job in this window and returns the answer for the phone. */
export async function runPhoneSpeechJob(job: SpeechJobInput, deps: PhoneSpeechDeps, io: PhoneSpeechIo): Promise<unknown> {
  if (io.signal.aborted) return cancelled()
  // A choice is saved for the profile the window shows when the job starts.
  const profileId = deps.profileId()
  try {
    switch (job.op) {
      case 'options':
        return await options(job.kind, deps)
      case 'choose':
        return await choose(job.kind, (job.params.selection ?? {}) as Record<string, unknown>, deps, io, profileId)
      case 'download':
        return await download(job.kind, String(job.params.modelId ?? ''), deps, io)
      case 'transcribe':
        return await transcribe(job, deps, io)
      case 'speak':
        return await speak(job, deps, io)
    }
    return refuse('invalid', 'Unknown speech request.')
  } catch (error) {
    return refuse('failed', ipcErrorMessage(error) || 'Speech failed on the computer.')
  }
}
