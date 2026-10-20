import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  localModelBytes,
  localModelFileUrl,
  type LocalModelFile,
  type LocalModelManifest,
  type LocalModelState,
  type LocalModelStatus
} from '../../shared/localModels'

const COMPLETE_MARKER = '.complete'
const PROGRESS_INTERVAL_MS = 250

export interface LocalModelManagerOptions<M extends LocalModelManifest> {
  /** Directory that holds one folder per model id. See `defaultLocalModelsRoot`. */
  rootDir: string
  models: readonly M[]
  fetchImpl?: typeof fetch
  onStatus?: (status: StatusOf<M>) => void
  progressIntervalMs?: number
}

type StatusOf<M extends LocalModelManifest> = LocalModelStatus<M['id']>

interface ActiveDownload<M extends LocalModelManifest> {
  controller: AbortController
  promise: Promise<StatusOf<M>>
  cancelled: boolean
}

class DownloadVerificationError extends Error {}

/** `<MOUSSE_HOME or ~/.mousse>/models/<kind>`: text-to-speech and speech-to-text weights live apart. */
export function defaultLocalModelsRoot(kind: 'tts' | 'stt'): string {
  return join(process.env.MOUSSE_HOME ?? join(homedir(), '.mousse'), 'models', kind)
}

export class LocalModelManager<M extends LocalModelManifest> {
  private readonly rootDir: string
  private readonly models: readonly M[]
  private readonly fetchImpl: typeof fetch
  private readonly onStatus?: (status: StatusOf<M>) => void
  private readonly progressIntervalMs: number
  private readonly active = new Map<string, ActiveDownload<M>>()
  /** Optional files being fetched on first read, by model directory and path. */
  private readonly fetching = new Map<string, Promise<void>>()
  private readonly lastState = new Map<string, LocalModelState>()

  constructor(options: LocalModelManagerOptions<M>) {
    this.rootDir = options.rootDir
    this.models = options.models
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.onStatus = options.onStatus
    this.progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS
  }

  modelDir(model: M): string {
    return join(this.rootDir, model.id, model.revision)
  }

  async list(): Promise<StatusOf<M>[]> {
    return Promise.all(this.models.map((model) => this.status(model.id)))
  }

  async status(modelId: string): Promise<StatusOf<M>> {
    const model = this.requireModel(modelId)
    const current = this.lastState.get(model.id)
    if (this.active.has(model.id) && current?.status === 'downloading') return { modelId: model.id, state: current }
    if (current?.status === 'error') return { modelId: model.id, state: current }
    const state: LocalModelState = (await this.isInstalled(model)) ? { status: 'downloaded' } : { status: 'not-downloaded' }
    return { modelId: model.id, state }
  }

  download(modelId: string): Promise<StatusOf<M>> {
    const model = this.requireModel(modelId)
    const existing = this.active.get(model.id)
    if (existing) return existing.promise
    const controller = new AbortController()
    const entry: ActiveDownload<M> = { controller, cancelled: false, promise: undefined as unknown as Promise<StatusOf<M>> }
    this.active.set(model.id, entry)
    entry.promise = this.run(model, entry).finally(() => {
      if (this.active.get(model.id) === entry) this.active.delete(model.id)
    })
    return entry.promise
  }

  cancel(modelId: string): void {
    const entry = this.active.get(this.requireModel(modelId).id)
    if (!entry) return
    entry.cancelled = true
    entry.controller.abort()
  }

  /** Cancels a running download, then removes everything stored for the model. */
  async delete(modelId: string): Promise<StatusOf<M>> {
    const model = this.requireModel(modelId)
    const entry = this.active.get(model.id)
    if (entry) {
      entry.cancelled = true
      entry.controller.abort()
      await entry.promise.catch(() => undefined)
    }
    const root = resolve(this.rootDir)
    const target = join(root, model.id)
    if (dirname(target) !== root) {
      throw new Error(`Refusing to delete ${target}`)
    }
    await rm(target, { recursive: true, force: true })
    return this.publish(model, { status: 'not-downloaded' })
  }

  /** Aborts every running download and waits for the cleanup. */
  async dispose(): Promise<void> {
    const running = [...this.active.values()]
    for (const entry of running) {
      entry.cancelled = true
      entry.controller.abort()
    }
    await Promise.allSettled(running.map((entry) => entry.promise))
  }

  async readFile(modelId: string, path: string): Promise<Uint8Array> {
    const model = this.requireModel(modelId)
    const file = typeof path === 'string' ? model.files.find((entry) => entry.path === path) : undefined
    if (!file) throw new Error(`${model.label} has no file named ${JSON.stringify(path)}`)
    if (!(await this.isInstalled(model))) {
      throw new Error(`${model.label} is not downloaded. Download it under Settings, Models.`)
    }
    if (file.optional) await this.fetchOptionalFile(model, file)
    const bytes = await readFile(join(this.modelDir(model), file.path))
    if (bytes.byteLength !== file.size) throw new Error(`${model.label} file ${file.path} is damaged. Download the model again.`)
    return bytes
  }

  private requireModel(modelId: string): M {
    const model = this.models.find((entry) => entry.id === modelId)
    if (!model) throw new Error(`Unknown local model: ${String(modelId)}`)
    return model
  }

  private async isInstalled(model: M): Promise<boolean> {
    const dir = this.modelDir(model)
    if (!(await fileSize(join(dir, COMPLETE_MARKER)).then((size) => size !== undefined))) return false
    for (const file of model.files) {
      if (!file.optional && (await fileSize(join(dir, file.path))) !== file.size) return false
    }
    return true
  }

  /** Downloads and verifies an optional file that an earlier, smaller download did not include. */
  private async fetchOptionalFile(model: M, file: LocalModelFile): Promise<void> {
    const finalPath = join(this.modelDir(model), file.path)
    if ((await fileSize(finalPath)) === file.size) return
    const running = this.fetching.get(finalPath)
    if (running) return running
    const fetching = (async () => {
      await mkdir(dirname(finalPath), { recursive: true })
      try {
        await this.downloadFile(model, file, finalPath, new AbortController().signal, () => undefined)
      } catch (error) {
        await rm(`${finalPath}.part`, { force: true }).catch(() => undefined)
        throw new Error(`${describeFailure(error)} (${model.label}, ${file.path})`)
      }
    })().finally(() => this.fetching.delete(finalPath))
    this.fetching.set(finalPath, fetching)
    return fetching
  }

  private publish(model: M, state: LocalModelState): StatusOf<M> {
    this.lastState.set(model.id, state)
    const status: StatusOf<M> = { modelId: model.id, state }
    this.onStatus?.(status)
    return status
  }

  private async run(model: M, entry: ActiveDownload<M>): Promise<StatusOf<M>> {
    const dir = this.modelDir(model)
    const totalBytes = localModelBytes(model)
    const signal = entry.controller.signal
    let receivedBytes = 0
    let lastEmit = 0
    const progress = (force = false): void => {
      const now = Date.now()
      if (!force && now - lastEmit < this.progressIntervalMs) return
      lastEmit = now
      this.publish(model, { status: 'downloading', receivedBytes, totalBytes })
    }
    this.publish(model, { status: 'downloading', receivedBytes: 0, totalBytes })
    try {
      await mkdir(dir, { recursive: true })
      await rm(join(dir, COMPLETE_MARKER), { force: true })
      for (const file of model.files) {
        throwIfAborted(signal)
        const finalPath = join(dir, file.path)
        if (await this.hasVerifiedFile(finalPath, file)) {
          receivedBytes += file.size
          progress()
          continue
        }
        await rm(finalPath, { force: true })
        await mkdir(dirname(finalPath), { recursive: true })
        await this.downloadFile(model, file, finalPath, signal, (bytes) => {
          receivedBytes += bytes
          progress()
        })
      }
      await writeFile(join(dir, COMPLETE_MARKER), JSON.stringify({ revision: model.revision, completedAt: new Date().toISOString() }))
      return this.publish(model, { status: 'downloaded' })
    } catch (error) {
      await this.removePartFiles(dir, model)
      if (entry.cancelled || signal.aborted) return this.publish(model, { status: 'not-downloaded' })
      return this.publish(model, { status: 'error', message: describeFailure(error) })
    }
  }

  private async hasVerifiedFile(path: string, file: LocalModelFile): Promise<boolean> {
    if ((await fileSize(path)) !== file.size) return false
    return (await hashFile(path)) === file.sha256
  }

  private async downloadFile(
    model: M,
    file: LocalModelFile,
    finalPath: string,
    signal: AbortSignal,
    onBytes: (bytes: number) => void
  ): Promise<void> {
    const partPath = `${finalPath}.part`
    await rm(partPath, { force: true })
    const response = await this.fetchImpl(localModelFileUrl(model, file.path), { signal })
    if (!response.ok || !response.body) throw new DownloadVerificationError(`Download of ${file.path} failed with HTTP ${response.status}`)
    const reader = response.body.getReader()
    const hash = createHash('sha256')
    const output = await open(partPath, 'w', 0o600)
    let bytes = 0
    try {
      for (;;) {
        throwIfAborted(signal)
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > file.size) throw new DownloadVerificationError(`${file.path} is larger than expected`)
        hash.update(part.value)
        await output.writeFile(part.value)
        onBytes(part.value.byteLength)
      }
      await output.sync()
    } finally {
      await reader.cancel().catch(() => undefined)
      await output.close()
    }
    if (bytes !== file.size) throw new DownloadVerificationError(`${file.path} is incomplete (${bytes} of ${file.size} bytes)`)
    if (hash.digest('hex') !== file.sha256) throw new DownloadVerificationError(`${file.path} failed verification`)
    await rename(partPath, finalPath)
  }

  private async removePartFiles(dir: string, model: M): Promise<void> {
    await Promise.all(model.files.map((file) => rm(join(dir, `${file.path}.part`), { force: true }).catch(() => undefined)))
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError')
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : undefined
  } catch {
    return undefined
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

function describeFailure(error: unknown): string {
  if (error instanceof DownloadVerificationError) return `Download failed: ${error.message}. Try again.`
  const message = error instanceof Error ? error.message : String(error)
  return `Download failed: ${message.slice(0, 160)}. Check your connection and try again.`
}
