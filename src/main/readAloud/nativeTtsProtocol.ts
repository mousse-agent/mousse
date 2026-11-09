/**
 * Messages between main and a native read aloud host (`nativeTtsHost.ts`), a utility process that
 * runs Kokoro on onnxruntime-node. One host runs one model and voices one request at a time.
 */

/** The model a host runs, as main describes it. The host has no path to the model's files. */
export interface NativeTtsHostModel {
  id: string
  /** Hugging Face repository the library asks for; only its files in `files` are served. */
  repo: string
  /** transformers.js dtype that selects the ONNX file. */
  dtype: string
  defaultVoice: string
  voices: readonly string[]
  /** Paths of every file of the model, the only ones the host may ask for. */
  files: readonly string[]
}

/** Main to host. `init` comes first; the host starts loading the model at once. */
export type NativeTtsHostRequest =
  | { type: 'init'; model: NativeTtsHostModel }
  | { type: 'speak'; id: number; text: string; voice: string; speed: number }
  | { type: 'file-response'; reqId: number; bytes?: Uint8Array; error?: string }

/** Host to main. */
export type NativeTtsHostEvent =
  | { type: 'ready' }
  | { type: 'load-error'; message: string }
  | { type: 'file-request'; reqId: number; path: string }
  | { type: 'audio'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'error'; id: number; message: string }
