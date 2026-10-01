import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { FileArtifactStore } from '../execution/ArtifactStore'
import { OwnedWorkBarrier } from '../execution/OwnedWorkBarrier'
import { assertOwnedPath, assertProfileId } from '../profiles/pathSafety'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import type { ArtifactReference } from '../../shared/execution/types'
import type { BrowserObservation, BrowserScreenshot } from '../../shared/browser/types'
import type { BrowserToolContext } from '../../shared/browser/automation'
import { BrowserAutomationError } from './automation/BrowserSessionManager'
import { canonicalJson, sha256Hex } from '../../shared/agents/hashes'

/** Constructed from an authorized session by the host, never directly from RPC claims. */
export interface BrowserArtifactScope {
  profileId: string
  threadId: string
  runId?: string
  sessionId: string
}

interface IndexRecord { version: 1; scope: BrowserArtifactScope; ref: ArtifactReference; integrity: string }
interface ScreenshotImport { screenshot: BrowserScreenshot; ref: ArtifactReference }
interface RetainedRoot { path: string; real: string; dev: number; ino: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ID = /^[a-zA-Z0-9:_-]{1,160}$/
const MAX_BYTES = 100 * 1024 * 1024
const INDEX_BYTES = 16 * 1024

/** Adds exact session/thread ownership to the shared profile artifact store. */
export class BrowserArtifactService {
  private readonly work = new OwnedWorkBarrier()
  private readonly store: FileArtifactStore
  private readonly indexRoot: string
  private readonly retainedIndexRoot: RetainedRoot
  private readonly retainedWorkerRoot: RetainedRoot
  private readonly imported = new Map<string, { id: string; screenshot: BrowserScreenshot }>()
  private readonly importing = new Map<string, Promise<ScreenshotImport>>()

  constructor(private readonly options: { profileId: string; profileRoot: string; workerArtifactRoot: string }) {
    assertProfileId(options.profileId)
    this.indexRoot = assertOwnedPath(options.profileRoot, join(options.profileRoot, 'browser', 'artifact-index'))
    mkdirSync(this.indexRoot, { recursive: true })
    this.retainedIndexRoot = this.retainRoot(this.indexRoot, 'Browser artifact index')
    this.store = new FileArtifactStore(options)
    const workerRoot = assertOwnedPath(options.profileRoot, options.workerArtifactRoot)
    mkdirSync(workerRoot, { recursive: true })
    this.retainedWorkerRoot = this.retainRoot(workerRoot, 'Browser worker artifact root')
  }

  beginShutdown(): void { this.work.beginShutdown() }
  getActiveCount(): number { return this.work.count }
  async dispose(): Promise<void> { this.beginShutdown(); await this.work.waitForIdle() }

  /** SessionManager calls this only after checking the observation's session owner. */
  async decorateObservation(context: BrowserToolContext, observation: BrowserObservation): Promise<BrowserObservation> {
    if (!observation.screenshot) return observation
    const scope = { profileId: context.execution.profileId, threadId: context.execution.threadId, runId: context.execution.runId, sessionId: observation.sessionId }
    if (UUID.test(observation.screenshot.artifactId)) {
      const ref = this.describe(scope, observation.screenshot.artifactId)
      if (ref.byteLength > this.limit(context.policy.maxArtifactBytes)) throw this.denied('Screenshot exceeds the execution artifact budget')
      return observation
    }
    const imported = await this.importWorkerScreenshot(scope, observation.screenshot, context.policy.maxArtifactBytes)
    return { ...observation, screenshot: imported.screenshot }
  }

  put(scope: BrowserArtifactScope, input: { bytes: Uint8Array; mediaType: string; displayName: string }, maxBytes: number): Promise<ArtifactReference> {
    const bound = this.limit(maxBytes), owner = this.scope(scope)
    if (input.bytes.byteLength > bound) throw this.denied('Browser artifact exceeds its byte budget')
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(input.mediaType) || input.displayName.length < 1 || input.displayName.length > 512) throw this.denied('Invalid browser artifact metadata')
    const snapshot = { bytes: new Uint8Array(input.bytes), mediaType: input.mediaType, displayName: input.displayName }
    return this.work.run('browser-artifact-write', async () => {
      this.assertIndex()
      const ref = await this.store.put({ profileId: owner.profileId, runId: owner.runId, ...snapshot })
      this.assertIndex()
      const body = { version: 1 as const, scope: owner, ref }
      atomicWriteJsonSync(this.indexPath(ref.id), { ...body, integrity: sha256Hex(canonicalJson(body)) } satisfies IndexRecord)
      return ref
    })
  }

  describe(scope: BrowserArtifactScope, artifactId: string): ArtifactReference {
    this.work.assertAccepting()
    return { ...this.index(this.scope(scope), artifactId).ref }
  }

  read(scope: BrowserArtifactScope, artifactId: string, maxBytes: number): Promise<{ ref: ArtifactReference; bytes: Uint8Array }> {
    const owner = this.scope(scope), bound = this.limit(maxBytes)
    return this.work.run('browser-artifact-read', async () => {
      const record = this.index(owner, artifactId)
      if (record.ref.byteLength > bound) throw this.denied('Browser artifact exceeds its read budget')
      const result = await this.store.get(artifactId, owner.profileId, { runId: owner.runId, maxBytes: bound })
      const fields = ['id', 'profileId', 'runId', 'mediaType', 'byteLength', 'sha256', 'displayName', 'createdAt'] as const
      if (fields.some((field) => result.ref[field] !== record.ref[field])) throw this.denied('Browser artifact metadata changed')
      return result
    })
  }

  /** Only the canonical worker PNG for this already-authorized session is imported. */
  importWorkerScreenshot(scope: BrowserArtifactScope, screenshot: BrowserScreenshot, maxBytes: number): Promise<ScreenshotImport> {
    const owner = this.scope(scope), bound = this.limit(maxBytes)
    if (!screenshot.artifactId.startsWith('art_') || !UUID.test(screenshot.artifactId.slice(4))) throw this.denied('Invalid worker screenshot identity')
    if (![screenshot.pixelWidth, screenshot.pixelHeight].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 32768)
      || ![screenshot.cssToImageScaleX, screenshot.cssToImageScaleY].every((n) => Number.isFinite(n) && n > 0)) throw this.denied('Invalid screenshot dimensions')
    const source = structuredClone(screenshot)
    const key = `${owner.threadId}\0${owner.runId ?? ''}\0${owner.sessionId}\0${source.artifactId}`
    this.work.assertAccepting()
    const pending = this.importing.get(key)
    if (pending) return pending.then((result) => {
      if (result.ref.byteLength > bound || !this.sameScreenshotGeometry(result.screenshot, source)) throw this.denied('Concurrent screenshot import does not match its byte budget or dimensions')
      return { screenshot: { ...source, artifactId: result.ref.id }, ref: { ...result.ref } }
    })
    const operation = this.work.run('browser-screenshot-import', async () => {
      const prior = this.imported.get(key)
      if (prior) {
        const ref = this.index(owner, prior.id).ref
        if (ref.byteLength > bound || !this.sameScreenshotGeometry(prior.screenshot, source)) throw this.denied('Browser screenshot exceeds its byte budget or changed dimensions')
        return { screenshot: { ...source, artifactId: prior.id }, ref }
      }
      const file = assertOwnedPath(this.options.profileRoot, join(this.options.workerArtifactRoot, owner.profileId, owner.sessionId, `${source.artifactId}.png`))
      this.assertRoot(this.retainedWorkerRoot, 'Browser worker artifact root')
      const bytes = this.readBounded(file, bound)
      this.assertRoot(this.retainedWorkerRoot, 'Browser worker artifact root')
      if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
        || bytes.readUInt32BE(16) !== source.pixelWidth || bytes.readUInt32BE(20) !== source.pixelHeight) throw this.denied('Worker screenshot bytes do not match their declared image')
      // This nested admission is synchronous before its first await. A shutdown
      // after the shared-store write still waits for the index to finish.
      const ref = await this.put(owner, { bytes, mediaType: 'image/png', displayName: 'browser-observation.png' }, bound)
      this.imported.set(key, { id: ref.id, screenshot: { ...source } })
      return { screenshot: { ...source, artifactId: ref.id }, ref }
    })
    this.importing.set(key, operation)
    void operation.finally(() => { if (this.importing.get(key) === operation) this.importing.delete(key) }).catch(() => undefined)
    return operation
  }

  private scope(input: BrowserArtifactScope): BrowserArtifactScope {
    if (input.profileId !== this.options.profileId || !ID.test(input.threadId) || !ID.test(input.sessionId)
      || (input.runId !== undefined && !ID.test(input.runId))) throw this.denied('Browser artifact scope is invalid')
    return { profileId: input.profileId, threadId: input.threadId, sessionId: input.sessionId, ...(input.runId === undefined ? {} : { runId: input.runId }) }
  }

  private limit(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BYTES) throw this.denied('Invalid browser artifact byte budget')
    return value
  }

  private indexPath(id: string): string {
    if (!UUID.test(id)) throw this.denied('Invalid browser artifact identity')
    return assertOwnedPath(this.options.profileRoot, join(this.indexRoot, `${id}.json`))
  }

  private assertIndex(): void {
    this.assertRoot(this.retainedIndexRoot, 'Browser artifact index')
  }

  private index(scope: BrowserArtifactScope, id: string): IndexRecord {
    this.assertIndex()
    const file = this.indexPath(id)
    if (!existsSync(file)) throw this.denied('Browser artifact is unavailable')
    let parsed: unknown
    try { parsed = JSON.parse(this.readBounded(file, INDEX_BYTES).toString('utf8')) }
    catch { throw this.denied('Browser artifact ownership is invalid') }
    this.assertIndex()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw this.denied('Browser artifact ownership is invalid')
    const value = parsed as Partial<IndexRecord>
    const exact = (value: object, keys: string[]) => Object.keys(value).sort().join('\0') === keys.sort().join('\0')
    const scopeKeys = scope.runId === undefined ? ['profileId', 'sessionId', 'threadId'] : ['profileId', 'runId', 'sessionId', 'threadId']
    const refKeys = scope.runId === undefined
      ? ['byteLength', 'createdAt', 'displayName', 'id', 'mediaType', 'profileId', 'sha256']
      : ['byteLength', 'createdAt', 'displayName', 'id', 'mediaType', 'profileId', 'runId', 'sha256']
    const body = { version: value.version, scope: value.scope, ref: value.ref }
    if (!exact(value, ['integrity', 'ref', 'scope', 'version']) || !value.scope || typeof value.scope !== 'object' || !exact(value.scope, scopeKeys)
      || !value.ref || typeof value.ref !== 'object' || !exact(value.ref, refKeys)
      || typeof value.integrity !== 'string' || value.integrity !== sha256Hex(canonicalJson(body))
      || value.version !== 1 || value.scope.profileId !== scope.profileId
      || value.scope.threadId !== scope.threadId || value.scope.runId !== scope.runId || value.scope.sessionId !== scope.sessionId
      || value.ref.id !== id || value.ref.profileId !== scope.profileId || value.ref.runId !== scope.runId
      || !Number.isSafeInteger(value.ref.byteLength) || value.ref.byteLength < 0 || value.ref.byteLength > MAX_BYTES
      || !/^[a-f0-9]{64}$/.test(value.ref.sha256) || typeof value.ref.mediaType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value.ref.mediaType)
      || typeof value.ref.displayName !== 'string' || value.ref.displayName.length < 1 || Buffer.byteLength(value.ref.displayName, 'utf8') > 1024
      || typeof value.ref.createdAt !== 'string' || !Number.isFinite(Date.parse(value.ref.createdAt))) throw this.denied('Browser artifact ownership is invalid')
    return value as IndexRecord
  }

  private retainRoot(path: string, label: string): RetainedRoot {
    const details = lstatSync(path)
    if (!details.isDirectory() || details.isSymbolicLink()) throw this.denied(`${label} is not a regular directory`)
    return { path, real: realpathSync.native(path), dev: details.dev, ino: details.ino }
  }

  private assertRoot(root: RetainedRoot, label: string): void {
    assertOwnedPath(this.options.profileRoot, root.path)
    const details = lstatSync(root.path)
    const samePath = process.platform === 'win32'
      ? realpathSync.native(root.path).toLowerCase() === root.real.toLowerCase()
      : realpathSync.native(root.path) === root.real
    if (!details.isDirectory() || details.isSymbolicLink() || details.dev !== root.dev || details.ino !== root.ino || !samePath) throw this.denied(`${label} changed`)
  }

  private sameScreenshotGeometry(left: BrowserScreenshot, right: BrowserScreenshot): boolean {
    return left.pixelWidth === right.pixelWidth && left.pixelHeight === right.pixelHeight
      && left.cssToImageScaleX === right.cssToImageScaleX && left.cssToImageScaleY === right.cssToImageScaleY
  }

  private readBounded(file: string, limit: number): Buffer {
    assertOwnedPath(this.options.profileRoot, file)
    const before = lstatSync(file)
    if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw this.denied('Artifact is not a bounded regular file')
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = fstatSync(fd)
      assertOwnedPath(this.options.profileRoot, file)
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw this.denied('Artifact changed before reading')
      const bytes = Buffer.alloc(stat.size + 1)
      let read = 0
      while (read < bytes.length) { const count = readSync(fd, bytes, read, bytes.length - read, read); if (!count) break; read += count }
      if (read !== stat.size || fstatSync(fd).size !== stat.size) throw this.denied('Artifact changed while reading')
      return bytes.subarray(0, read)
    } finally { closeSync(fd) }
  }

  private denied(message: string): BrowserAutomationError { return new BrowserAutomationError({ code: 'artifact_denied', message }) }
}
