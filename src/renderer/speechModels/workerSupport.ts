import { env } from '@huggingface/transformers'
import ortMjsUrl from '@onnxruntime-web-dist/ort-wasm-simd-threaded.mjs?url'
import ortWasmUrl from '@onnxruntime-web-dist/ort-wasm-simd-threaded.wasm?url'
import type { LocalModelFile } from '../../shared/localModels'

/**
 * Worker-side setup shared by the local speech model workers (Kokoro for read aloud, Moonshine for
 * dictation). transformers.js is pointed at the bundled WebAssembly runtime, and requests for the
 * model's Hugging Face files are answered with the copy the app downloaded and verified.
 */

/** Worker to page: asks the page for the bytes of one downloaded model file. */
export interface ModelFileRequest {
  type: 'file-request'
  reqId: number
  path: string
}

/** Page to worker: the answer to a `ModelFileRequest`. */
export interface ModelFileResponse {
  type: 'file-response'
  reqId: number
  bytes?: ArrayBuffer
  error?: string
}

export interface LocalModelWorkerOptions {
  repo: string
  files: readonly LocalModelFile[]
  /** Sends a message to the page. */
  post: (message: ModelFileRequest) => void
}

export interface LocalModelWorkerSupport {
  /** Handles a `file-response` message; returns false for any other message. */
  handleMessage: (message: { type: string }) => boolean
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Configures the ONNX runtime and redirects the model's file downloads to the page. Call once per worker. */
export function setupLocalModelWorker({ repo, files, post }: LocalModelWorkerOptions): LocalModelWorkerSupport {
  const filePaths = new Set(files.map((file) => file.path))
  const modelUrl = new RegExp(`^https://huggingface\\.co/${escapeRegExp(repo)}/resolve/[^/]+/([^?#]+)`)
  const pendingFiles = new Map<number, { resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void }>()
  let nextFileRequest = 1

  const requestFile = (path: string): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
      const reqId = nextFileRequest++
      pendingFiles.set(reqId, { resolve, reject })
      post({ type: 'file-request', reqId, path })
    })

  // Model files come only from the copy downloaded by the app, never from the network.
  const realFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const match = modelUrl.exec(url)
    if (!match) return realFetch(input, init)
    const path = decodeURIComponent(match[1])
    if (!filePaths.has(path)) return new Response(null, { status: 404 })
    try {
      const bytes = await requestFile(path)
      return new Response(bytes, { status: 200, headers: { 'Content-Length': String(bytes.byteLength) } })
    } catch {
      return new Response(null, { status: 404 })
    }
  }

  env.allowLocalModels = false
  env.useBrowserCache = false
  const wasm = env.backends.onnx.wasm
  if (wasm) {
    wasm.numThreads = 1
    wasm.proxy = false
    // The CPU build is bundled with the app; nothing is fetched from a CDN.
    wasm.wasmPaths = { mjs: ortMjsUrl, wasm: ortWasmUrl }
  }

  return {
    handleMessage: (message) => {
      if (message.type !== 'file-response') return false
      const response = message as ModelFileResponse
      const pending = pendingFiles.get(response.reqId)
      if (!pending) return true
      pendingFiles.delete(response.reqId)
      if (response.bytes) pending.resolve(response.bytes)
      else pending.reject(new Error(response.error ?? 'Model file unavailable'))
      return true
    }
  }
}
