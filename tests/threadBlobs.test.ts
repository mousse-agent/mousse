import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadDbClient } from '../src/mms/data/threadDb/threadDbClient'
import { ThreadDbStore } from '../src/mms/data/threadDb/threadDbStore'
import { ThreadDbEngine } from '../src/mms/data/threadDb/threadDbEngine'
import { BLOB_TEXT_THRESHOLD, blobPath, collectBlobs, encodeRow, missingPlaceholder, writeBlob } from '../src/mms/data/threadDb/threadBlobs'
import { legacyFingerprint } from '../src/mms/data/legacyThreadData'
import type { ChatMessage, NativeLlmContext } from '../src/shared/types'
import { getActiveMessages } from '../src/mms/orchestrator/nativeContext'

const image = (bytes = 150_000): string => randomBytes(bytes).toString('base64')
const message = (id: string, content: string, extra: Record<string, unknown> = {}): ChatMessage =>
  ({ id, role: 'user', content, timestamp: '2026-01-01T00:00:00.000Z', ...extra }) as ChatMessage

function blobFiles(dir: string): string[] {
  const root = join(dir, 'blobs')
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((prefix) => readdirSync(join(root, prefix)).filter((name) => !name.startsWith('.')))
}

function rawPayloads(dir: string): string[] {
  const db = new DatabaseSync(join(dir, 'thread.db'), { readOnly: true })
  try {
    return (db.prepare('SELECT payload FROM items').all() as Array<{ payload: string }>).map((row) => row.payload)
  } finally {
    db.close()
  }
}

function makeOld(path: string): void {
  const old = new Date(Date.now() - 2 * 60 * 60_000)
  utimesSync(path, old, old)
}

describe('thread blobs', () => {
  let dir: string
  let client: ThreadDbClient
  let store: ThreadDbStore

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-blobs-')))
    client = new ThreadDbClient({ script: null })
    store = new ThreadDbStore(client)
    client.callSync('create', dir)
  })

  afterEach(async () => {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps images and long text out of the rows and gives them back exactly', () => {
    const data = image()
    const long = 'x'.repeat(BLOB_TEXT_THRESHOLD + 1)
    const messages = [
      message('img', 'look', { images: [{ name: 'a.png', mimeType: 'image/png', data }] }),
      message('long', long),
      message('short', 'short text')
    ]
    store.save(dir, { messages })
    const payloads = rawPayloads(dir)
    expect(payloads.some((payload) => payload.includes(data.slice(0, 200)))).toBe(false)
    expect(payloads.some((payload) => payload.includes('xxxxxxxxxx'))).toBe(false)
    expect(payloads.some((payload) => payload.includes('short text'))).toBe(true)
    expect(blobFiles(dir)).toHaveLength(2)
    expect(new ThreadDbStore(client).load(dir).messages).toEqual(messages)
  })

  it('stores one file for the same image in two messages', () => {
    const data = image()
    store.save(dir, {
      messages: [
        message('a', 'one', { images: [{ name: 'a.png', mimeType: 'image/png', data }] }),
        message('b', 'two', { images: [{ name: 'b.png', mimeType: 'image/png', data }] })
      ]
    })
    expect(blobFiles(dir)).toHaveLength(1)
  })

  it('keeps image data that is not exact base64 byte for byte', () => {
    const data = `${image(3000)}\n`
    const messages = [message('a', 'x', { images: [{ name: 'a.png', mimeType: 'image/png', data }] })]
    store.save(dir, { messages })
    expect(new ThreadDbStore(client).load(dir).messages[0]!.images![0]!.data).toBe(data)
  })

  it('never reads an ordinary value as a blob reference', () => {
    const looksLikeRef = { $mousseBlob: 'sha256:' + 'a'.repeat(64), bytes: 10 }
    const messages = [message('a', '', { toolCall: { details: [looksLikeRef], response: '' } })]
    store.save(dir, { messages })
    expect(new ThreadDbStore(client).load(dir).messages).toEqual(messages)
    expect(blobFiles(dir)).toHaveLength(0)
  })

  it('moves images in the model context too', () => {
    const data = image()
    const llmContext = { version: 2, messages: [{ role: 'user', content: [{ type: 'image', data, mimeType: 'image/png' }] }], fidelity: 'native', activeStartIndex: 0 } as unknown as NativeLlmContext
    store.save(dir, { messages: [], llmContext })
    expect(rawPayloads(dir).some((payload) => payload.includes(data.slice(0, 200)))).toBe(false)
    expect(new ThreadDbStore(client).load(dir).llmContext).toEqual(llmContext)
  })

  it('opens a thread whose blob is gone, and a later save keeps the reference', () => {
    const data = image()
    store.save(dir, { messages: [message('a', 'x', { images: [{ name: 'a.png', mimeType: 'image/png', data }] })] })
    const [hash] = blobFiles(dir)
    const saved = blobPath(dir, hash!)
    const bytes = readFileSync(saved)
    rmSync(saved)
    const reader = new ThreadDbStore(client)
    const loaded = reader.load(dir).messages
    expect(loaded[0]!.images![0]!.data).toBe(missingPlaceholder('base64', hash!))
    // An unrelated edit of the same row is saved with the reference, not with the empty placeholder.
    loaded[0]!.content = 'edited'
    reader.save(dir, { messages: loaded })
    mkdirSync(dirname(saved), { recursive: true })
    writeFileSync(saved, bytes)
    const back = new ThreadDbStore(client).load(dir).messages
    expect(back[0]!.content).toBe('edited')
    expect(back[0]!.images![0]!.data).toBe(data)
  })

  it('shows a placeholder for long text whose blob is gone', () => {
    store.save(dir, { messages: [message('a', 'y'.repeat(BLOB_TEXT_THRESHOLD + 10))] })
    const [hash] = blobFiles(dir)
    rmSync(blobPath(dir, hash!))
    expect(new ThreadDbStore(client).load(dir).messages[0]!.content).toBe(missingPlaceholder('text', hash!))
  })

  it('keeps each missing reference with its own value when the values move', () => {
    const first = image()
    const second = image()
    store.save(dir, { messages: [message('a', 'x', { images: [{ name: '1.png', mimeType: 'image/png', data: first }, { name: '2.png', mimeType: 'image/png', data: second }] })] })
    const saved = new Map(blobFiles(dir).map((hash) => [hash, readFileSync(blobPath(dir, hash))]))
    for (const hash of saved.keys()) rmSync(blobPath(dir, hash))
    const reader = new ThreadDbStore(client)
    const loaded = reader.load(dir).messages
    // The first image is removed; the second moves to its place.
    loaded[0]!.images!.splice(0, 1)
    reader.save(dir, { messages: loaded })
    for (const [hash, bytes] of saved) {
      mkdirSync(dirname(blobPath(dir, hash)), { recursive: true })
      writeFileSync(blobPath(dir, hash), bytes)
    }
    const back = new ThreadDbStore(client).load(dir).messages[0]!.images!
    expect(back.map((entry) => [entry.name, entry.data])).toEqual([['2.png', second]])
  })

  it('keeps text UTF-8 cannot hold exactly in the row', () => {
    const text = `${'z'.repeat(BLOB_TEXT_THRESHOLD)}\ud800 lone`
    store.save(dir, { messages: [message('a', text)] })
    expect(blobFiles(dir)).toHaveLength(0)
    expect(new ThreadDbStore(client).load(dir).messages[0]!.content).toBe(text)
  })

  it('finds text kept in a blob when searching the transcript', () => {
    store.save(dir, { messages: [message('long', `${'x'.repeat(BLOB_TEXT_THRESHOLD)} the needle`)] })
    expect(client.callSync('searchTranscript', dir, 'the needle', 10).map((hit) => hit.id)).toEqual(['long'])
  })

  it('never removes a prefix folder another writer has just put a blob in', () => {
    const data = image()
    const hash = encodeRow({ data, mimeType: 'image/png' } as never).blobs[0]!.sha256
    writeBlob(dir, { sha256: hash, kind: 'base64', data })
    // Nothing refers to it, but it is fresh: collection keeps both the file and its folder.
    expect(collectBlobs(dir, new Set(), 60 * 60_000)).toBe(0)
    expect(existsSync(blobPath(dir, hash))).toBe(true)
  })

  it('collects blobs no row refers to once they are old, and never one a row refers to', () => {
    const kept = image()
    const dropped = image()
    store.save(dir, {
      messages: [
        message('keep', 'k', { images: [{ name: 'k.png', mimeType: 'image/png', data: kept }] }),
        message('drop', 'd', { images: [{ name: 'd.png', mimeType: 'image/png', data: dropped }] })
      ]
    })
    for (const hash of blobFiles(dir)) makeOld(blobPath(dir, hash))
    const loaded = store.load(dir).messages.filter((m) => m.id !== 'drop')
    store.save(dir, { messages: loaded })
    expect(blobFiles(dir)).toHaveLength(1)
    // A blob written moments ago (a save still committing elsewhere) is not taken, even unreferenced.
    writeBlob(dir, { sha256: encodeRow({ data: dropped, mimeType: 'image/png' } as never).blobs[0]!.sha256, kind: 'base64', data: dropped })
    expect(client.callSync('collectBlobs', dir)).toBe(0)
    expect(client.callSync('collectBlobs', dir, 0)).toBe(1)
    expect(new ThreadDbStore(client).load(dir).messages[0]!.images![0]!.data).toBe(kept)
  })
})

describe('thread blobs, second look', () => {
  let dir: string
  let client: ThreadDbClient
  let store: ThreadDbStore

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-blobs2-')))
    client = new ThreadDbClient({ script: null })
    store = new ThreadDbStore(client)
    client.callSync('create', dir)
  })

  afterEach(async () => {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const backUp = (): Map<string, Buffer> => new Map(blobFiles(dir).map((hash) => [hash, readFileSync(blobPath(dir, hash))]))
  const restore = (saved: Map<string, Buffer>): void => {
    for (const [hash, bytes] of saved) {
      mkdirSync(dirname(blobPath(dir, hash)), { recursive: true })
      writeFileSync(blobPath(dir, hash), bytes)
    }
  }

  it('keeps image data that is neither exact base64 nor valid UTF-8 in its row', () => {
    const data = `${'x'.repeat(1024)}\ud800`
    store.save(dir, { messages: [message('a', 'x', { images: [{ name: 'a.png', mimeType: 'image/png', data }] })] })
    expect(new ThreadDbStore(client).load(dir).messages[0]!.images![0]!.data).toBe(data)
  })

  it('keeps a missing reference when its row moves', () => {
    const data = image()
    store.save(dir, { messages: [message('a', 'x', { images: [{ name: 'a.png', mimeType: 'image/png', data }] }), message('b', 'y')] })
    const saved = backUp()
    for (const hash of saved.keys()) rmSync(blobPath(dir, hash))
    const loaded = store.load(dir).messages
    store.save(dir, { messages: [loaded[1]!, loaded[0]!] })
    restore(saved)
    expect(new ThreadDbStore(client).load(dir).messages.map((m) => m.images?.[0]?.data ?? m.id)).toEqual(['b', data])
  })

  it('tells a missing text blob from a missing image with the same bytes', () => {
    const text = 'x'.repeat(BLOB_TEXT_THRESHOLD + 1)
    const data = Buffer.from(text, 'utf8').toString('base64')
    store.save(dir, { messages: [message('a', text, { images: [{ name: 'a.png', mimeType: 'image/png', data }] })] })
    const saved = backUp()
    for (const hash of saved.keys()) rmSync(blobPath(dir, hash))
    const loaded = store.load(dir).messages
    loaded[0]!.role = 'assistant'
    store.save(dir, { messages: loaded })
    restore(saved)
    const back = new ThreadDbStore(client).load(dir).messages[0]!
    expect([back.content, back.images![0]!.data]).toEqual([text, data])
  })

  it('collects a blob left behind once it is old, on a later ordinary save', () => {
    const data = image()
    store.save(dir, { messages: [message('a', 'x', { images: [{ name: 'a.png', mimeType: 'image/png', data }] })] })
    store.save(dir, { messages: [] })
    for (const hash of blobFiles(dir)) makeOld(blobPath(dir, hash))
    // A new store (or an hour later) collects on its first save, whatever that save changes.
    const later = new ThreadDbStore(client)
    later.save(dir, { messages: [message('t', 'text only')] })
    expect(blobFiles(dir)).toEqual([])
  })

  it('repairs a damaged blob when the same content is saved again', () => {
    const data = image()
    store.save(dir, { messages: [message('a', 'x', { images: [{ name: 'a.png', mimeType: 'image/png', data }] })] })
    writeFileSync(blobPath(dir, blobFiles(dir)[0]!), 'damaged')
    store.save(dir, { messages: [message('b', 'y', { images: [{ name: 'b.png', mimeType: 'image/png', data }] })] })
    expect(new ThreadDbStore(client).load(dir).messages[0]!.images![0]!.data).toBe(data)
  })

  it('sends a missing image to the model as a note, never as image data', () => {
    const data = image()
    const llmContext = { version: 2, messages: [{ role: 'user', content: [{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text: 'look' }] }], fidelity: 'native', activeStartIndex: 0 } as unknown as NativeLlmContext
    store.save(dir, { llmContext })
    for (const hash of blobFiles(dir)) rmSync(blobPath(dir, hash))
    const active = getActiveMessages(new ThreadDbStore(client).load(dir).llmContext!)
    expect((active[0] as { content: unknown[] }).content).toEqual([{ type: 'text', text: '[image unavailable]' }, { type: 'text', text: 'look' }])
  })
})

describe('importing a thread with images', () => {
  it('moves the images to blobs and checks the import against the JSON', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-blob-import-')))
    try {
      const data = image()
      const messages = [message('a', 'x', { images: [{ name: 'a.png', mimeType: 'image/png', data }] })]
      writeFileSync(join(dir, 'messages.json'), JSON.stringify(messages))
      const engine = new ThreadDbEngine({ idleCloseMs: 0 })
      expect(engine.build(dir, { tmpName: 'thread.db.import-x', transactional: false, fingerprint: legacyFingerprint(dir) })).toMatchObject({ ok: true })
      expect(blobFiles(dir)).toHaveLength(1)
      // An import whose source changed meanwhile removes the blobs it wrote.
      rmSync(join(dir, 'blobs'), { recursive: true, force: true })
      const stale = engine.build(dir, { tmpName: 'thread.db.import-y', transactional: false, fingerprint: [] })
      expect(stale).toEqual({ ok: false, stale: true })
      expect(blobFiles(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
