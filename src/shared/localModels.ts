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
  /**
   * Figures the model dialog compares. Each is optional: a missing one shows as a dash and a
   * row nobody has drops out. Only published or measured figures go here, with their source.
   */
  compare?: LocalModelFigures
}

export interface LocalModelFigures {
  /** Languages the model handles; `name` when it is one, e.g. "English". */
  languages?: { count: number; name?: string }
  /** Average English word error rate in percent, from a published benchmark. */
  englishWer?: number
  /** Dictation: measured time from the stop click to the text, in milliseconds. */
  stopWaitMs?: number
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
