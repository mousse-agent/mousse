import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalModelManager } from '../src/main/localModels/LocalModelManager'
import { localTtsFileUrl, type LocalTtsModel, type LocalTtsModelStatus } from '../src/shared/readAloud'

const sha = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')

const CONFIG = new TextEncoder().encode('{"hello":"world"}')
const WEIGHTS = new Uint8Array(5000).map((_, index) => index % 251)

function fakeModel(overrides: { weightsSha?: string } = {}): LocalTtsModel {
  return {
    id: 'kokoro-82m',
    label: 'Fake',
    description: 'test',
    parameters: '1M',
    license: 'MIT',
    homepage: 'https://example.test',
    repo: 'org/fake',
    revision: 'abc123',
    dtype: 'q8',
    defaultVoice: 'v',
    files: [
      { path: 'config.json', size: CONFIG.byteLength, sha256: sha(CONFIG) },
      { path: 'onnx/model.onnx', size: WEIGHTS.byteLength, sha256: overrides.weightsSha ?? sha(WEIGHTS) }
    ]
  }
}

function servedFetch(model: LocalTtsModel, bodies: Record<string, Uint8Array>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    for (const file of model.files) {
      if (url === localTtsFileUrl(model, file.path)) return new Response(bodies[file.path])
    }
    return new Response('missing', { status: 404 })
  }) as typeof fetch
}

const roots: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mousse-read-aloud-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)]
  )
}

describe('LocalModelManager with a text-to-speech manifest', () => {
  it('downloads, verifies, marks complete, and serves manifest files', async () => {
    const model = fakeModel()
    const rootDir = tempRoot()
    const events: LocalTtsModelStatus[] = []
    const manager = new LocalModelManager({
      rootDir,
      models: [model],
      fetchImpl: servedFetch(model, { 'config.json': CONFIG, 'onnx/model.onnx': WEIGHTS }),
      onStatus: (status) => events.push(status),
      progressIntervalMs: 0
    })
    expect((await manager.list())[0]!.state).toEqual({ status: 'not-downloaded' })

    const first = manager.download('kokoro-82m')
    const second = manager.download('kokoro-82m')
    expect(second).toBe(first)
    expect((await first).state).toEqual({ status: 'downloaded' })

    const dir = join(rootDir, 'kokoro-82m', 'abc123')
    expect(existsSync(join(dir, '.complete'))).toBe(true)
    expect(existsSync(join(dir, 'onnx', 'model.onnx'))).toBe(true)
    expect(listFiles(dir).some((path) => path.endsWith('.part'))).toBe(false)
    expect((await manager.status('kokoro-82m')).state).toEqual({ status: 'downloaded' })

    expect(events[0]!.state).toEqual({ status: 'downloading', receivedBytes: 0, totalBytes: CONFIG.byteLength + WEIGHTS.byteLength })
    const progress = events.filter((event) => event.state.status === 'downloading')
    expect(progress.length).toBeGreaterThan(1)
    expect(events.at(-1)!.state).toEqual({ status: 'downloaded' })

    expect(Buffer.from(await manager.readFile('kokoro-82m', 'onnx/model.onnx')).equals(Buffer.from(WEIGHTS))).toBe(true)
  })

  it('reports an error and keeps no final file when the checksum does not match', async () => {
    const model = fakeModel({ weightsSha: sha('something else') })
    const rootDir = tempRoot()
    const manager = new LocalModelManager({
      rootDir,
      models: [model],
      fetchImpl: servedFetch(model, { 'config.json': CONFIG, 'onnx/model.onnx': WEIGHTS })
    })
    const result = await manager.download('kokoro-82m')
    expect(result.state.status).toBe('error')
    const dir = join(rootDir, 'kokoro-82m', 'abc123')
    expect(existsSync(join(dir, 'onnx', 'model.onnx'))).toBe(false)
    expect(existsSync(join(dir, '.complete'))).toBe(false)
    expect(listFiles(dir).some((path) => path.endsWith('.part'))).toBe(false)
    expect((await manager.status('kokoro-82m')).state.status).toBe('error')
    await expect(manager.readFile('kokoro-82m', 'config.json')).rejects.toThrow(/not downloaded/)
  })

  it('reports an error when the server sends the wrong number of bytes', async () => {
    const model = fakeModel()
    const manager = new LocalModelManager({
      rootDir: tempRoot(),
      models: [model],
      fetchImpl: servedFetch(model, { 'config.json': CONFIG, 'onnx/model.onnx': WEIGHTS.slice(0, 100) })
    })
    const result = await manager.download('kokoro-82m')
    expect(result.state.status).toBe('error')
  })

  it('cancels an in-flight download and cleans up', async () => {
    const model = fakeModel()
    const rootDir = tempRoot()
    let started!: () => void
    const reachedBody = new Promise<void>((resolve) => { started = resolve })
    const stallingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(CONFIG.slice(0, 4))
          started()
          signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
        }
      })
      return new Response(stream)
    }) as typeof fetch
    const manager = new LocalModelManager({ rootDir, models: [model], fetchImpl: stallingFetch })
    const pending = manager.download('kokoro-82m')
    await reachedBody
    manager.cancel('kokoro-82m')
    expect((await pending).state).toEqual({ status: 'not-downloaded' })
    expect(listFiles(join(rootDir, 'kokoro-82m', 'abc123'))).toEqual([])
    expect((await manager.status('kokoro-82m')).state).toEqual({ status: 'not-downloaded' })
  })

  it('reuses verified files and replaces damaged ones on a later attempt', async () => {
    const model = fakeModel()
    const rootDir = tempRoot()
    const dir = join(rootDir, 'kokoro-82m', 'abc123')
    await mkdir(join(dir, 'onnx'), { recursive: true })
    await writeFile(join(dir, 'config.json'), CONFIG)
    await writeFile(join(dir, 'onnx', 'model.onnx'), new Uint8Array(WEIGHTS.byteLength))
    const requested: string[] = []
    const inner = servedFetch(model, { 'config.json': CONFIG, 'onnx/model.onnx': WEIGHTS })
    const manager = new LocalModelManager({
      rootDir,
      models: [model],
      fetchImpl: ((input, init) => { requested.push(String(input)); return inner(input, init) }) as typeof fetch
    })
    expect((await manager.status('kokoro-82m')).state).toEqual({ status: 'not-downloaded' })
    expect((await manager.download('kokoro-82m')).state).toEqual({ status: 'downloaded' })
    expect(requested).toEqual([localTtsFileUrl(model, 'onnx/model.onnx')])
  })

  it('does not report a truncated install as downloaded', async () => {
    const model = fakeModel()
    const rootDir = tempRoot()
    const dir = join(rootDir, 'kokoro-82m', 'abc123')
    await mkdir(dirname(join(dir, 'onnx', 'model.onnx')), { recursive: true })
    await writeFile(join(dir, 'config.json'), CONFIG)
    await writeFile(join(dir, 'onnx', 'model.onnx'), WEIGHTS.slice(0, 10))
    await writeFile(join(dir, '.complete'), '{}')
    const manager = new LocalModelManager({ rootDir, models: [model] })
    expect((await manager.status('kokoro-82m')).state).toEqual({ status: 'not-downloaded' })
  })

  it('only reads manifest files from a downloaded model', async () => {
    const model = fakeModel()
    const rootDir = tempRoot()
    const manager = new LocalModelManager({
      rootDir,
      models: [model],
      fetchImpl: servedFetch(model, { 'config.json': CONFIG, 'onnx/model.onnx': WEIGHTS })
    })
    await expect(manager.readFile('kokoro-82m', 'config.json')).rejects.toThrow(/not downloaded/)
    await manager.download('kokoro-82m')
    for (const bad of ['../abc123/config.json', '../../secret', '/etc/passwd', 'onnx/../config.json', '.complete', 'missing.bin', '']) {
      await expect(manager.readFile('kokoro-82m', bad)).rejects.toThrow(/no file named/)
    }
    await expect(manager.readFile('nope', 'config.json')).rejects.toThrow(/Unknown local model/)
    expect(Buffer.from(await manager.readFile('kokoro-82m', 'config.json')).equals(Buffer.from(CONFIG))).toBe(true)
  })

  it('deletes a downloaded model and its siblings only', async () => {
    const model = fakeModel()
    const rootDir = tempRoot()
    const events: LocalTtsModelStatus[] = []
    const manager = new LocalModelManager({
      rootDir,
      models: [model],
      fetchImpl: servedFetch(model, { 'config.json': CONFIG, 'onnx/model.onnx': WEIGHTS }),
      onStatus: (status) => events.push(status)
    })
    await manager.download('kokoro-82m')
    await mkdir(join(rootDir, 'kokoro-82m', 'older-revision'), { recursive: true })
    await writeFile(join(rootDir, 'other-model.txt'), 'keep')

    const result = await manager.delete('kokoro-82m')
    expect(result).toEqual({ modelId: 'kokoro-82m', state: { status: 'not-downloaded' } })
    expect(events.at(-1)).toEqual(result)
    expect(existsSync(join(rootDir, 'kokoro-82m'))).toBe(false)
    expect(existsSync(join(rootDir, 'other-model.txt'))).toBe(true)
    expect((await manager.status('kokoro-82m')).state).toEqual({ status: 'not-downloaded' })
    await expect(manager.readFile('kokoro-82m', 'config.json')).rejects.toThrow(/not downloaded/)
    await expect(manager.delete('nope')).rejects.toThrow(/Unknown local model/)
  })

  it('cancels a running download when the model is deleted', async () => {
    const model = fakeModel()
    const rootDir = tempRoot()
    let started!: () => void
    const reachedBody = new Promise<void>((resolve) => { started = resolve })
    const stallingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(CONFIG.slice(0, 4))
          started()
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
        }
      })
      return new Response(stream)
    }) as typeof fetch
    const manager = new LocalModelManager({ rootDir, models: [model], fetchImpl: stallingFetch })
    const pending = manager.download('kokoro-82m')
    await reachedBody
    expect((await manager.delete('kokoro-82m')).state).toEqual({ status: 'not-downloaded' })
    expect((await pending).state).toEqual({ status: 'not-downloaded' })
    expect(existsSync(join(rootDir, 'kokoro-82m'))).toBe(false)
  })

  it('rejects unknown model ids', () => {
    const manager = new LocalModelManager({ rootDir: tempRoot(), models: [fakeModel()] })
    expect(() => manager.download('nope')).toThrow(/Unknown local model/)
    expect(() => manager.cancel('nope')).toThrow(/Unknown local model/)
  })
})
