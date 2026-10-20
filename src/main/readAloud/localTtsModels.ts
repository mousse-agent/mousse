import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  LOCAL_TTS_MODELS,
  localTtsFileUrl,
  localTtsModelBytes,
  type LocalTtsModel,
  type LocalTtsModelFile,
  type LocalTtsModelState,
  type LocalTtsModelStatus
} from '../../shared/readAloud'

const COMPLETE_MARKER = '.complete'
const PROGRESS_INTERVAL_MS = 250

export interface LocalTtsModelManagerOptions {
  /** Directory that holds one folder per model id. Defaults to `<MOUSSE_HOME>/models/tts`. */
  rootDir?: string
  models?: readonly LocalTtsModel[]
  fetchImpl?: typeof fetch
  onStatus?: (status: LocalTtsModelStatus) => void
  progressIntervalMs?: number
}

interface ActiveDownload {
  controller: AbortController
  promise: Promise<LocalTtsModelStatus>
  cancelled: boolean
}

class DownloadVerificationError extends Error {}

export function defaultLocalTtsRoot(): string {
  return join(process.env.MOUSSE_HOME ?? join(homedir(), '.mousse'), 'models', 'tts')
}

export class LocalTtsModelManager {
  private readonly rootDir: string
  private readonly models: readonly LocalTtsModel[]
  private readonly fetchImpl: typeof fetch
  private readonly onStatus?: (status: LocalTtsModelStatus) => void
  private readonly progressIntervalMs: number
  private readonly active = new Map<string, ActiveDownload>()
  private readonly lastState = new Map<string, LocalTtsModelState>()

  constructor(options: LocalTtsModelManagerOptions = {}) {
    this.rootDir = options.rootDir ?? defaultLocalTtsRoot()
    this.models = options.models ?? LOCAL_TTS_MODELS
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.onStatus = options.onStatus
    this.progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS
  }

  modelDir(model: LocalTtsModel): string {
    return join(this.rootDir, model.id, model.revision)
  }

  async list(): Promise<LocalTtsModelStatus[]> {
    return Promise.all(this.models.map((model) => this.status(model.id)))
  }

  async status(modelId: string): Promise<LocalTtsModelStatus> {
    const model = this.requireModel(modelId)
    const current = this.lastState.get(model.id)
    if (this.active.has(model.id) && current?.status === 'downloading') return { modelId: model.id, state: current }
    if (current?.status === 'error') return { modelId: model.id, state: current }
    const state: LocalTtsModelState = (await this.isInstalled(model)) ? { status: 'downloaded' } : { status: 'not-downloaded' }
    return { modelId: model.id, state }
  }

  download(modelId: string): Promise<LocalTtsModelStatus> {
    const model = this.requireModel(modelId)
    const existing = this.active.get(model.id)
    if (existing) return existing.promise
    const controller = new AbortController()
    const entry: ActiveDownload = { controller, cancelled: false, promise: undefined as unknown as Promise<LocalTtsModelStatus> }
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
  async delete(modelId: string): Promise<LocalTtsModelStatus> {
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
    if (!(await this.isInstalled(model))) throw new Error(`${model.label} is not downloaded`)
    const bytes = await readFile(join(this.modelDir(model), file.path))
    if (bytes.byteLength !== file.size) throw new Error(`${model.label} file ${file.path} is damaged. Download the model again.`)
    return bytes
  }

  private requireModel(modelId: string): LocalTtsModel {
    const model = this.models.find((entry) => entry.id === modelId)
    if (!model) throw new Error(`Unknown text-to-speech model: ${String(modelId)}`)
    return model
  }

  private async isInstalled(model: LocalTtsModel): Promise<boolean> {
    const dir = this.modelDir(model)
    if (!(await fileSize(join(dir, COMPLETE_MARKER)).then((size) => size !== undefined))) return false
    for (const file of model.files) {
      if ((await fileSize(join(dir, file.path))) !== file.size) return false
    }
    return true
  }

  private publish(model: LocalTtsModel, state: LocalTtsModelState): LocalTtsModelStatus {
    this.lastState.set(model.id, state)
    const status: LocalTtsModelStatus = { modelId: model.id, state }
    this.onStatus?.(status)
    return status
  }

  private async run(model: LocalTtsModel, entry: ActiveDownload): Promise<LocalTtsModelStatus> {
    const dir = this.modelDir(model)
    const totalBytes = localTtsModelBytes(model)
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

  private async hasVerifiedFile(path: string, file: LocalTtsModelFile): Promise<boolean> {
    if ((await fileSize(path)) !== file.size) return false
    return (await hashFile(path)) === file.sha256
  }

  private async downloadFile(
    model: LocalTtsModel,
    file: LocalTtsModelFile,
    finalPath: string,
    signal: AbortSignal,
    onBytes: (bytes: number) => void
  ): Promise<void> {
    const partPath = `${finalPath}.part`
    await rm(partPath, { force: true })
    const response = await this.fetchImpl(localTtsFileUrl(model, file.path), { signal })
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

  private async removePartFiles(dir: string, model: LocalTtsModel): Promise<void> {
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
