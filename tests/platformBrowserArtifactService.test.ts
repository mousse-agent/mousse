import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserArtifactService, type BrowserArtifactScope } from '../src/mms/browser/BrowserArtifactService'
import type { BrowserScreenshot } from '../src/shared/browser/types'

const profileId = '11111111-1111-4111-8111-111111111111'
const scope: BrowserArtifactScope = { profileId, threadId: 'thread_1', runId: 'run_1', sessionId: 'sess_1' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1cAAAAASUVORK5CYII=', 'base64')
const screenshot: BrowserScreenshot = { artifactId: 'art_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pixelWidth: 1, pixelHeight: 1, cssToImageScaleX: 1, cssToImageScaleY: 1 }
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mousse-browser-artifacts-'))
  roots.push(root)
  const workerArtifactRoot = join(root, 'browser', 'worker-artifacts')
  const options = { profileId, profileRoot: root, workerArtifactRoot }
  const service = new BrowserArtifactService(options)
  const dir = join(workerArtifactRoot, profileId, scope.sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, screenshot.artifactId + '.png'), png)
  return { root, service, options, workerArtifactRoot, dir }
}

describe('browser session artifact ownership', () => {
  it('imports exact worker screenshot bytes, replaces the worker ID, and survives service restart', async () => {
    const { service, options } = await fixture()
    const imported = await service.importWorkerScreenshot(scope, screenshot, 1024)
    expect(imported.screenshot.artifactId).toBe(imported.ref.id)
    expect(imported.ref.id).not.toBe(screenshot.artifactId)
    expect(imported.ref).toMatchObject({ profileId, runId: 'run_1', mediaType: 'image/png', byteLength: png.length })
    expect(Buffer.from((await service.read(scope, imported.ref.id, 1024)).bytes)).toEqual(png)
    expect((await service.importWorkerScreenshot(scope, screenshot, 1024)).ref.id).toBe(imported.ref.id)
    const restarted = new BrowserArtifactService(options)
    expect(restarted.describe(scope, imported.ref.id)).toEqual(imported.ref)
    expect(Buffer.from((await restarted.read(scope, imported.ref.id, 1024)).bytes)).toEqual(png)
  })

  it('rejects cross-profile, thread, run and session reads before returning artifact metadata or bytes', async () => {
    const { service } = await fixture()
    const { ref } = await service.importWorkerScreenshot(scope, screenshot, 1024)
    for (const other of [{ ...scope, profileId: 'other_profile' }, { ...scope, threadId: 'other_thread' },
      { ...scope, runId: 'other_run' }, { ...scope, runId: undefined }, { ...scope, sessionId: 'other_session' }]) {
      expect(() => service.describe(other, ref.id)).toThrow()
      await expect(Promise.resolve().then(() => service.read(other, ref.id, 1024))).rejects.toThrow()
    }
    expect(() => service.describe(scope, '../meta')).toThrow()
  })

  it('retains exact ownership for a main-agent browser session with no workflow run ID', async () => {
    const { service } = await fixture()
    const main = { ...scope, runId: undefined }
    const ref = await service.put(main, { bytes: png, mediaType: 'image/png', displayName: 'main.png' }, 1024)
    expect((await service.read(main, ref.id, 1024)).ref.runId).toBeUndefined()
    expect(() => service.describe(scope, ref.id)).toThrow()
  })

  it('deduplicates simultaneous imports and rejects a changed size claim for an existing source ID', async () => {
    const { service } = await fixture()
    const [first, second] = await Promise.all([service.importWorkerScreenshot(scope, screenshot, 1024), service.importWorkerScreenshot(scope, screenshot, 1024)])
    expect(first.ref.id).toBe(second.ref.id)
    await expect(service.importWorkerScreenshot(scope, { ...screenshot, pixelWidth: 2 }, 1024)).rejects.toThrow()
    await expect(service.importWorkerScreenshot(scope, { ...screenshot, cssToImageScaleX: 2 }, 1024)).rejects.toThrow()
    await expect(service.importWorkerScreenshot(scope, screenshot, 10)).rejects.toThrow()
  })

  it('bounds imported bytes and metadata and rejects mismatched screenshot dimensions', async () => {
    const { service, dir } = await fixture()
    await expect(service.importWorkerScreenshot(scope, screenshot, 10)).rejects.toThrow()
    await expect(service.importWorkerScreenshot(scope, { ...screenshot, pixelWidth: 2 }, 1024)).rejects.toThrow()
    writeFileSync(join(dir, screenshot.artifactId + '.png'), Buffer.alloc(1025))
    await expect(service.importWorkerScreenshot(scope, screenshot, 1024)).rejects.toThrow()
    expect(() => service.put(scope, { bytes: png, mediaType: 'image/png', displayName: 'x' }, 0)).toThrow()
    expect(() => service.put(scope, { bytes: png, mediaType: 'text/html\0bad', displayName: 'x' }, 1024)).toThrow()
  })

  it('rejects changed index ownership, oversized index and inconsistent shared artifact metadata', async () => {
    const { service, root } = await fixture()
    const { ref } = await service.importWorkerScreenshot(scope, screenshot, 1024)
    const index = join(root, 'browser', 'artifact-index', ref.id + '.json')
    const original = readFileSync(index, 'utf8')
    const edited = JSON.parse(original)
    edited.scope.threadId = 'other_thread'
    writeFileSync(index, JSON.stringify(edited))
    expect(() => service.describe(scope, ref.id)).toThrow()
    writeFileSync(index, ' '.repeat(17000))
    expect(() => service.describe(scope, ref.id)).toThrow()
    writeFileSync(index, 'null')
    expect(() => service.describe(scope, ref.id)).toThrow('ownership is invalid')
    writeFileSync(index, '{')
    expect(() => service.describe(scope, ref.id)).toThrow('ownership is invalid')
    writeFileSync(index, original)
    const meta = join(root, 'artifacts', ref.id, 'meta.json')
    const metadata = JSON.parse(readFileSync(meta, 'utf8'))
    metadata.displayName = 'changed.png'
    writeFileSync(meta, JSON.stringify(metadata))
    await expect(service.read(scope, ref.id, 1024)).rejects.toThrow()
  })

  it('rejects an internally rewritten index and replacement of retained storage roots', async () => {
    const { service, root, workerArtifactRoot } = await fixture()
    const { ref } = await service.importWorkerScreenshot(scope, screenshot, 1024)
    const index = join(root, 'browser', 'artifact-index', ref.id + '.json')
    const edited = JSON.parse(readFileSync(index, 'utf8'))
    edited.scope.threadId = 'other_thread'
    edited.ref.runId = 'other_run'
    writeFileSync(index, JSON.stringify(edited))
    expect(() => service.describe({ ...scope, threadId: 'other_thread', runId: 'other_run' }, ref.id)).toThrow()

    const indexRoot = join(root, 'browser', 'artifact-index')
    renameSync(indexRoot, indexRoot + '-original')
    mkdirSync(indexRoot)
    expect(() => service.describe(scope, ref.id)).toThrow('changed')
    renameSync(indexRoot, indexRoot + '-replacement')
    renameSync(indexRoot + '-original', indexRoot)

    renameSync(workerArtifactRoot, workerArtifactRoot + '-original')
    mkdirSync(workerArtifactRoot)
    const next = { ...screenshot, artifactId: 'art_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
    const nextDir = join(workerArtifactRoot, profileId, scope.sessionId)
    mkdirSync(nextDir, { recursive: true }); writeFileSync(join(nextDir, next.artifactId + '.png'), png)
    await expect(service.importWorkerScreenshot(scope, next, 1024)).rejects.toThrow('changed')
  })

  it('keeps an admitted import owned until its shared-store callback and index settle', async () => {
    const { service } = await fixture()
    const store = (service as unknown as { store: { put(input: unknown): Promise<unknown> } }).store
    const original = store.put.bind(store)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    store.put = async (input) => { await gate; return original(input) }
    const importing = service.importWorkerScreenshot(scope, screenshot, 1024)
    await Promise.resolve()
    expect(service.getActiveCount()).toBeGreaterThan(0)
    const disposal = service.dispose()
    let disposed = false; void disposal.then(() => { disposed = true })
    await Promise.resolve(); expect(disposed).toBe(false)
    release()
    await expect(importing).resolves.toMatchObject({ ref: { profileId } })
    await disposal
    expect(service.getActiveCount()).toBe(0)
  })

  it('rejects a worker artifact directory redirected to another owned fixture root', async () => {
    const { service, dir } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'mousse-browser-artifacts-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, screenshot.artifactId + '.png'), png)
    renameSync(dir, dir + '-original')
    symlinkSync(outside, dir, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.importWorkerScreenshot(scope, screenshot, 1024)).rejects.toThrow()
  })

  it('stops new imports and reads after disposal', async () => {
    const { service } = await fixture()
    const { ref } = await service.importWorkerScreenshot(scope, screenshot, 1024)
    await service.dispose()
    expect(service.getActiveCount()).toBe(0)
    expect(() => service.describe(scope, ref.id)).toThrow('shutting down')
    expect(() => service.read(scope, ref.id, 1024)).toThrow('shutting down')
    expect(() => service.importWorkerScreenshot(scope, screenshot, 1024)).toThrow('shutting down')
  })
})
