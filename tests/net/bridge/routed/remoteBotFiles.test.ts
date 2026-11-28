/**
 * The copies of another computer's bots' files kept here: only real pictures, within their limits (the least recently
 * shown go first), and nothing written back for a bot or a computer dropped while a read or a copy was under way.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RemoteBotFiles, type RemoteFilePage } from '../../../../src/mms/bridge/routed/remoteBotFiles'
import type { NodeId } from '../../../../src/shared/net'

const NODE = 'n_laptop' as NodeId
const BOT = 'bot-0123456789ab'
const PAGE = 40 * 1024

const png = (size: number, fill = 7): Buffer => {
  const data = Buffer.alloc(size, fill)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data)
  return data
}

describe('the copies of another computer’s bots’ files', () => {
  let dir: string
  let folder: string
  let there: Map<string, { name: string; data: Buffer }>
  let reads: string[]
  let online: boolean
  /** While set, a read of a first page waits for it. */
  let gate: Promise<void> | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'remote-bot-files-'))
    folder = join(dir, 'remote-files')
    there = new Map()
    reads = []
    online = true
    gate = undefined
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const files = (limits: { maxBytes?: number; maxFiles?: number } = {}): RemoteBotFiles =>
    new RemoteBotFiles({
      folder,
      online: () => online,
      ...limits,
      read: async (_node, _botId, ref, offset): Promise<RemoteFilePage> => {
        reads.push(`${ref}@${offset}`)
        if (offset === 0 && gate) await gate
        const file = there.get(ref)
        if (!file) throw new Error('gone')
        return { name: file.name, mime: 'image/png', size: file.data.length, offset, dataB64: file.data.subarray(offset, offset + PAGE).toString('base64') }
      }
    })
  const kept = (): string[] => (existsSync(join(folder, NODE, BOT)) ? readdirSync(join(folder, NODE, BOT)) : [])

  it('keeps a picture only when its bytes are one, whatever its name says', async () => {
    const cache = files()
    there.set('fake.png', { name: 'fake.png', data: Buffer.from('%PDF-1.7 not a picture') })
    await expect(cache.fetch(NODE, BOT, 'fake.png')).rejects.toMatchObject({ code: 'conflict' })
    expect(kept()).toEqual([])
    there.set('real.png', { name: 'real.png', data: png(100) })
    expect((await cache.fetch(NODE, BOT, 'real.png')).size).toBe(100)
  })

  it('keeps at most so many copies: the least recently shown goes', async () => {
    const cache = files({ maxFiles: 2 })
    for (const ref of ['a.png', 'b.png', 'c.png']) there.set(ref, { name: ref, data: png(100) })
    const a = await cache.fetch(NODE, BOT, 'a.png')
    const b = await cache.fetch(NODE, BOT, 'b.png')
    // Shown again: b is now the least recent.
    await cache.fetch(NODE, BOT, 'a.png')
    await cache.fetch(NODE, BOT, 'c.png')
    expect([existsSync(a.path), existsSync(b.path)]).toEqual([true, false])
    expect(kept()).toHaveLength(2)
  })

  it('keeps at most so many bytes: the least recently shown go', async () => {
    const cache = files({ maxBytes: 250 })
    for (const ref of ['a.png', 'b.png', 'c.png']) there.set(ref, { name: ref, data: png(100) })
    const a = await cache.fetch(NODE, BOT, 'a.png')
    const b = await cache.fetch(NODE, BOT, 'b.png')
    const c = await cache.fetch(NODE, BOT, 'c.png')
    expect([existsSync(a.path), existsSync(b.path), existsSync(c.path)]).toEqual([false, true, true])
  })

  for (const how of ['bot', 'computer'] as const) {
    it(`writes nothing for a ${how} dropped while its file is read`, async () => {
      const cache = files()
      there.set('a.png', { name: 'a.png', data: png(100) })
      let open!: () => void
      gate = new Promise((resolve) => (open = resolve))
      const fetching = cache.fetch(NODE, BOT, 'a.png')
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(reads).toEqual(['a.png@0'])
      if (how === 'bot') cache.dropBots(NODE, [BOT])
      else cache.dropComputer(NODE)
      open()
      await expect(fetching).rejects.toMatchObject({ code: 'bot_not_found' })
      expect(existsSync(join(folder, NODE))).toBe(false)
    })
  }

  it('writes nothing for a bot dropped while a file just sent is copied in', async () => {
    const cache = files()
    const from = join(dir, 'sent.png')
    writeFileSync(from, png(100))
    const seeding = cache.seed(NODE, BOT, 'attachments/m1/sent.png', 'sent.png', from)
    cache.dropBots(NODE, [BOT])
    await seeding
    expect(existsSync(join(folder, NODE, BOT))).toBe(false)
  })

  it('keeps a file whose name ends like a half-written one, and shows it while its computer is away', async () => {
    const cache = files()
    there.set('notes.part', { name: 'notes.part', data: Buffer.from('plain text') })
    const first = await cache.fetch(NODE, BOT, 'notes.part')
    expect(first.name).toBe('notes.part')
    online = false
    reads = []
    // A new cache, as after a restart: the copy is listed from the disk.
    const again = await files().fetch(NODE, BOT, 'notes.part')
    expect(again.path).toBe(first.path)
    expect(reads).toEqual([])
  })
})
