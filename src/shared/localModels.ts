/**
 * Local speech models: weights downloaded from a pinned Hugging Face revision, verified file by
 * file, and run in the renderer. Read aloud (text-to-speech) and dictation (speech-to-text) each
 * keep their own list; the download, verification and storage rules are shared.
 */

export interface LocalModelFile {
  /** Path inside the Hugging Face repository, e.g. `onnx/model_quantized.onnx`. */
  path: string
  size: number
  sha256: string
  /**
   * Not needed for the model to count as downloaded, such as an extra voice. A full download
   * includes it; otherwise it is fetched and verified the first time it is read.
   */
  optional?: boolean
}

export interface LocalModelManifest {
  id: string
  label: string
  description: string
  parameters: string
  license: string
  /** Model card shown to the user. */
  homepage: string
  /** Hugging Face repository the files are downloaded from. */
  repo: string
  /** Pinned commit of `repo`, so every download gets the same verified bytes. */
  revision: string
  files: readonly LocalModelFile[]
}

export function localModelFileUrl(model: LocalModelManifest, path: string): string {
  return `https://huggingface.co/${model.repo}/resolve/${model.revision}/${path}`
}

export function localModelBytes(model: LocalModelManifest): number {
  return model.files.reduce((total, file) => total + file.size, 0)
}

export type LocalModelState =
  | { status: 'not-downloaded' }
  | { status: 'downloading'; receivedBytes: number; totalBytes: number }
  | { status: 'downloaded' }
  | { status: 'error'; message: string }

export interface LocalModelStatus<Id extends string = string> {
  modelId: Id
  state: LocalModelState
}
