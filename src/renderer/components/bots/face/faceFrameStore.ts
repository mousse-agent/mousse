/**
 * Saved face pictures, kept between runs (see `faceRenderer.ts`). Each still frame the shared
 * renderer draws is saved as a PNG under its exact spec, so at the next launch a known face shows
 * its real picture at once, while the shader still compiles (seconds on Direct3D 11).
 *
 * - Every record carries the art version it was drawn with; records of any other version are
 *   ignored and deleted when the store opens, so a picture never outlives an art change.
 * - The store is bounded: least recently used records go first past `MAX_SAVED_FRAMES` records or
 *   `MAX_SAVED_BYTES` bytes. The look picker draws 23 faces per look; a 36 px tile is about 5 KB.
 * - Any storage failure (no IndexedDB, a full disk, a corrupt record) leaves the store empty or
 *   forgets the record: faces then draw as they would with no saved picture.
 *
 * The records live in the renderer's IndexedDB, in the Electron user data of the app (or of the
 * development run) that drew them.
 */

export const MAX_SAVED_FRAMES = 400
export const MAX_SAVED_BYTES = 4 * 1024 * 1024

export interface SavedFrameRecord {
  key: string
  version: string
  data: Blob
  bytes: number
  /** When it was saved or last shown, in ms since the epoch. */
  usedAt: number
}

/** Where the records are kept: IndexedDB in the app, a map in tests. Each method may reject. */
export interface FaceFrameBackend {
  all(): Promise<SavedFrameRecord[]>
  put(records: SavedFrameRecord[]): Promise<void>
  remove(keys: string[]): Promise<void>
}

/** A decoded picture, drawn with `drawImage`. */
export type SavedFrameImage = CanvasImageSource & { readonly width: number; readonly height: number }

export interface FaceFrameCodec {
  encode(canvas: HTMLCanvasElement): Promise<Blob | null>
  decode(data: Blob): Promise<SavedFrameImage | null>
}

/** The renderer's view of the saved pictures. */
export interface FaceFrameStore {
  /** Whether the saved records have been listed, or failed to be (then the store is empty). */
  settled(): boolean
  /** Calls `listener` once settled (at once when it already is); returns a function that stops it. */
  onSettled(listener: () => void): () => void
  has(key: string): boolean
  /** The decoded picture, or null when there is none or it can't be decoded (then it is forgotten). */
  image(key: string): Promise<SavedFrameImage | null>
  /** Saves the picture in `canvas` under `key`, unless one is saved already. */
  save(key: string, canvas: HTMLCanvasElement): void
  /** Drops a record, for example one decoded at the wrong size. */
  forget(key: string): void
}

export interface FaceFrameStoreOptions {
  now?: () => number
  maxFrames?: number
  maxBytes?: number
}

export class SavedFaceFrames implements FaceFrameStore {
  private readonly records = new Map<string, SavedFrameRecord>()
  private readonly listeners = new Set<() => void>()
  private readonly saving = new Set<string>()
  private readonly now: () => number
  private readonly maxFrames: number
  private readonly maxBytes: number
  private isSettled = false
  /** Storage failed: nothing more is read or written. */
  private off = false
  private bytes = 0

  constructor(
    private readonly backend: FaceFrameBackend | null,
    private readonly version: string,
    private readonly codec: FaceFrameCodec,
    options: FaceFrameStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.maxFrames = options.maxFrames ?? MAX_SAVED_FRAMES
    this.maxBytes = options.maxBytes ?? MAX_SAVED_BYTES
    if (!backend) {
      this.off = true
      this.settle()
      return
    }
    void this.open(backend)
  }

  private async open(backend: FaceFrameBackend): Promise<void> {
    try {
      const all = await backend.all()
      const stale: string[] = []
      for (const record of all) {
        if (record && record.version === this.version && typeof record.key === 'string' && record.data instanceof Blob) {
          this.records.set(record.key, { ...record, bytes: record.data.size, usedAt: Number(record.usedAt) || 0 })
          this.bytes += record.data.size
        } else if (record && typeof record.key === 'string') {
          stale.push(record.key)
        }
      }
      if (stale.length > 0) void backend.remove(stale).catch(() => undefined)
      this.evict()
    } catch {
      this.off = true
      this.records.clear()
      this.bytes = 0
    }
    this.settle()
  }

  private settle(): void {
    this.isSettled = true
    for (const listener of [...this.listeners]) listener()
    this.listeners.clear()
  }

  settled(): boolean {
    return this.isSettled
  }

  onSettled(listener: () => void): () => void {
    if (this.isSettled) {
      listener()
      return () => undefined
    }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  has(key: string): boolean {
    return this.records.has(key)
  }

  async image(key: string): Promise<SavedFrameImage | null> {
    const record = this.records.get(key)
    if (!record) return null
    let image: SavedFrameImage | null = null
    try {
      image = await this.codec.decode(record.data)
    } catch {
      image = null
    }
    if (!image) {
      this.forget(key)
      return null
    }
    if (this.records.get(key) === record && !this.off) {
      record.usedAt = this.now()
      void this.backend?.put([record]).catch(() => undefined)
    }
    return image
  }

  save(key: string, canvas: HTMLCanvasElement): void {
    if (this.off || !this.isSettled || this.records.has(key) || this.saving.has(key)) return
    this.saving.add(key)
    void this.codec
      .encode(canvas)
      .catch(() => null)
      .then(async (data) => {
        if (!data || this.off || this.records.has(key) || data.size > this.maxBytes) return
        const record: SavedFrameRecord = { key, version: this.version, data, bytes: data.size, usedAt: this.now() }
        this.records.set(key, record)
        this.bytes += record.bytes
        this.evict()
        if (!this.records.has(key)) return
        try {
          await this.backend!.put([record])
        } catch {
          // A full disk or a closed database: stop saving; what is in memory still shows this run.
          this.off = true
        }
      })
      .finally(() => this.saving.delete(key))
  }

  forget(key: string): void {
    const record = this.records.get(key)
    if (!record) return
    this.records.delete(key)
    this.bytes -= record.bytes
    void this.backend?.remove([key]).catch(() => undefined)
  }

  /** Drops the least recently used records until the store is within its bounds. */
  private evict(): void {
    if (this.records.size <= this.maxFrames && this.bytes <= this.maxBytes) return
    const oldest = [...this.records.values()].sort((a, b) => a.usedAt - b.usedAt)
    const removed: string[] = []
    for (const record of oldest) {
      if (this.records.size <= this.maxFrames && this.bytes <= this.maxBytes) break
      this.records.delete(record.key)
      this.bytes -= record.bytes
      removed.push(record.key)
    }
    if (removed.length > 0 && !this.off) void this.backend?.remove(removed).catch(() => undefined)
  }
}

const DB_NAME = 'mousse-bot-faces'
const DB_STORE = 'frames'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/** The records in one IndexedDB object store, keyed by the frame's key. */
export function indexedDbFrameBackend(idb: IDBFactory): FaceFrameBackend {
  let opened: Promise<IDBDatabase> | null = null
  const db = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE, { keyPath: 'key' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('face frame store blocked'))
    }))
  return {
    async all() {
      const tx = (await db()).transaction(DB_STORE, 'readonly')
      return request(tx.objectStore(DB_STORE).getAll() as IDBRequest<SavedFrameRecord[]>)
    },
    async put(records) {
      const tx = (await db()).transaction(DB_STORE, 'readwrite')
      const store = tx.objectStore(DB_STORE)
      for (const record of records) store.put(record)
      await done(tx)
    },
    async remove(keys) {
      const tx = (await db()).transaction(DB_STORE, 'readwrite')
      const store = tx.objectStore(DB_STORE)
      for (const key of keys) store.delete(key)
      await done(tx)
    }
  }
}

/** PNG, so a saved picture is exactly the frame that was drawn. */
export const browserFrameCodec: FaceFrameCodec = {
  encode: (canvas) => new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png')),
  decode: (data) => createImageBitmap(data)
}

/** A short, stable hash of `text` (FNV-1a, 32 bits), for the art version. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(36)}.${text.length.toString(36)}`
}
