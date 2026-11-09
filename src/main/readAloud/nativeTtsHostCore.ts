import type { NativeTtsHostEvent, NativeTtsHostModel, NativeTtsHostRequest } from './nativeTtsProtocol'

/**
 * The part of the native read aloud host that does not load the engine: it answers main's
 * messages, voices requests one at a time, and serves the model's files from main instead of the
 * network. `nativeTtsHost.ts` supplies `load`.
 */

/** A loaded model. */
export interface NativeSynthesizer {
  /** Voices one segment; samples are mono in -1..1. */
  synthesize: (text: string, voice: string, speed: number) => Promise<{ samples: Float32Array; sampleRate: number }>
}

export interface NativeTtsHostOptions {
  post: (event: NativeTtsHostEvent) => void
  load: (model: NativeTtsHostModel) => Promise<NativeSynthesizer>
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A `fetch` that answers only the model's own files, with bytes from `requestFile`. A URL is served
 * when it is exactly `https://huggingface.co/<repo>/resolve/<revision>/<path>` and the decoded path
 * is one of `files`; every other request is refused. This keeps the libraries off the network; it
 * is not an operating-system sandbox.
 */
export function modelFileFetch(
  model: Pick<NativeTtsHostModel, 'repo' | 'files'>,
  requestFile: (path: string) => Promise<Uint8Array>
): typeof fetch {
  const paths = new Set(model.files)
  // kokoro-js asks for voices at `main` rather than the pinned revision, so any one segment is accepted.
  const modelUrl = new RegExp(`^https://huggingface\\.co/${escapeRegExp(model.repo)}/resolve/[^/?#]+/([^?#]+)$`)
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const match = modelUrl.exec(url)
    let path: string | undefined
    try {
      path = match ? decodeURIComponent(match[1]) : undefined
    } catch {
      path = undefined
    }
    if (path === undefined || !paths.has(path)) throw new Error(`The voice engine may not fetch ${url}`)
    const bytes = await requestFile(path)
    return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: { 'Content-Length': String(bytes.byteLength) } })
  }
}

/**
 * Wires the host to main. Returns the handler for main's messages. `init` replaces the global
 * `fetch` with `modelFileFetch` and starts loading; `ready` or `load-error` follows.
 */
export function runNativeTtsHost({ post, load }: NativeTtsHostOptions): (message: NativeTtsHostRequest) => void {
  let model: NativeTtsHostModel | null = null
  let synthesizer: Promise<NativeSynthesizer> | null = null
  const pendingFiles = new Map<number, { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }>()
  let nextFileRequest = 1
  let queue: Promise<void> = Promise.resolve()

  const requestFile = (path: string): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
      const reqId = nextFileRequest++
      pendingFiles.set(reqId, { resolve, reject })
      post({ type: 'file-request', reqId, path })
    })

  const speak = async (id: number, text: string, voice: string, speed: number): Promise<void> => {
    try {
      if (!model || !synthesizer) throw new Error('The voice model was not chosen')
      const loaded = await synthesizer
      const known = model.voices.includes(voice)
      const audio = await loaded.synthesize(text, known ? voice : model.defaultVoice, speed)
      post({ type: 'audio', id, samples: audio.samples, sampleRate: audio.sampleRate })
    } catch (error) {
      post({ type: 'error', id, message: errorMessage(error) })
    }
  }

  return (message) => {
    if (message.type === 'init') {
      if (model) return
      model = message.model
      globalThis.fetch = modelFileFetch(model, requestFile)
      synthesizer = load(model)
      synthesizer.then(
        () => post({ type: 'ready' }),
        (error: unknown) => post({ type: 'load-error', message: errorMessage(error) })
      )
    } else if (message.type === 'speak') {
      queue = queue.then(() => speak(message.id, message.text, message.voice, message.speed))
    } else if (message.type === 'file-response') {
      const pending = pendingFiles.get(message.reqId)
      if (!pending) return
      pendingFiles.delete(message.reqId)
      if (message.bytes) pending.resolve(message.bytes)
      else pending.reject(new Error(message.error ?? 'Model file unavailable'))
    }
  }
}
