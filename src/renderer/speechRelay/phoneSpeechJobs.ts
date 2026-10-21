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
  transcribe(recording: Blob, selection: DictationSelection, onPartial: (text: string) => void): Promise<string>
  synthesizeLocal(
    text: string,
    options: { signal: AbortSignal; voice: string | undefined; speed: number; onClip: (samples: Float32Array, sampleRate: number) => void }
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
async function choose(kind: PhoneSpeechKind, choice: Record<string, unknown>, deps: PhoneSpeechDeps): Promise<unknown> {
  if (choice.source === 'provider') {
    const providers = await deps.providers()
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
  if ((await localStates(kind, deps)).get(manifest.id)?.status !== 'downloaded')
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
  if (current?.status === 'downloaded') return { ok: true, state: current }
  let lastSent = 0
  let lastStatus = ''
  const unsubscribe = deps.onLocalStatus(kind, (status) => {
    if (status.modelId !== modelId) return
    const now = Date.now()
    if (status.state.status === lastStatus && now - lastSent < DOWNLOAD_PROGRESS_MS) return
    lastSent = now
    lastStatus = status.state.status
    void io.progress({ type: 'status', state: status.state })
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
  if (!job.audioBase64) return refuse('invalid', 'The recording is empty.')
  const recording = new Blob([base64ToBytes(job.audioBase64)], { type: String(job.params.mimeType ?? 'audio/webm') })
  try {
    const text = await deps.transcribe(recording, selection, (partial) => {
      if (!io.signal.aborted) void io.progress({ type: 'partial', text: partial })
    })
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
  const text = markdownToSpeechText(String(job.params.text ?? ''))
  if (!text) return refuse('invalid', 'There is nothing to read aloud in this message.')
  const preferences = deps.preferences()
  const voice = deps.voiceFor(preferences, selection)
  const stop = new AbortController()
  const onAbort = (): void => stop.abort()
  io.signal.addEventListener('abort', onAbort, { once: true })
  let clips = 0
  // Clips go out one after another; synthesis keeps running ahead meanwhile.
  let sending: Promise<void> = Promise.resolve()
  const queue = (bytes: Uint8Array, mimeType: string, rate: number): void => {
    const clip = clips++
    sending = sending.then(async () => {
      if (stop.signal.aborted) return
      if (!(await sendClip(io, clip, bytes, mimeType, rate))) stop.abort()
    })
  }
  try {
    if (selection.source === 'local') {
      await deps.synthesizeLocal(text, {
        signal: stop.signal,
        voice,
        speed: preferences.speed,
        onClip: (samples, sampleRate) => queue(encodeWav(samples, sampleRate), 'audio/wav', 1)
      })
    } else {
      const chunks = splitSpeechChunks(text, PROVIDER_TTS_MAX_CHARS)
      const request = (index: number): Promise<ProviderSpeechResult> | null => {
        if (index >= chunks.length) return null
        const pending = deps.synthesizeProvider({ providerId: selection.providerId, modelId: selection.modelId, text: chunks[index], voice })
        pending.catch(() => undefined)
        return pending
      }
      let current = request(0)
      for (let index = 0; current && !stop.signal.aborted; index += 1) {
        const result = await current
        current = request(index + 1)
        queue(result.audio, result.mimeType, preferences.speed)
      }
    }
    await sending
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
  try {
    switch (job.op) {
      case 'options':
        return await options(job.kind, deps)
      case 'choose':
        return await choose(job.kind, (job.params.selection ?? {}) as Record<string, unknown>, deps)
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
