/**
 * A picture saved in a bot's files folder (`saveBotPicture`) whose write fails part way (a full disk) leaves no broken file
 * behind, and a tool's picture that could not be saved is not promised to the owner (`keepToolImages`). The disk is
 * scripted: `writeSync` writes the first bytes, then fails, as a full disk does.
 */
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keepToolImages, resetToolImages, takeToolImages } from '../../src/mms/bots/chat/toolImages'
import { saveBotPicture } from '../../src/mms/bots/images/pictures'

const disk = vi.hoisted(() => ({ full: false }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const writeSync = (fd: number, buffer: Uint8Array, offset?: number): number => {
    if (!disk.full) return fs.writeSync(fd, buffer, offset)
    fs.writeSync(fd, buffer.subarray(0, 4))
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
  }
  return { ...fs, default: { ...fs, writeSync }, writeSync }
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const NOW = new Date(2026, 10, 26, 9, 30, 0)

const folders: string[] = []
afterEach(() => {
  disk.full = false
  resetToolImages()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function filesFolder(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-picture-')))
  folders.push(root)
  return join(root, 'files')
}

/** Every file under the files folder's pictures of `NOW`'s day. */
const pictures = (files: string) => readdirSync(join(files, 'images', '2026-11-26'))

describe('a picture saved in a bot\'s files folder', () => {
  it('whose write fails part way leaves no file behind; written whole, it is there', () => {
    const files = filesFolder()
    disk.full = true
    expect(() => saveBotPicture(files, 'chart', 'png', PNG, NOW)).toThrow(/no space/)
    expect(pictures(files)).toEqual([])
    // The control: the same picture on a disk with room.
    disk.full = false
    const saved = saveBotPicture(files, 'chart', 'png', PNG, NOW)
    expect(pictures(files)).toEqual(['chart-093000.png'])
    expect(readFileSync(saved).equals(PNG)).toBe(true)
  })

  it('from a tool, not saved, is not promised to the owner and the bot is told', () => {
    const files = filesFolder()
    disk.full = true
    const note = keepToolImages({ activationId: 'act-full', filesFolder: files, source: 'browser-screenshot', images: [{ data: PNG.toString('base64') }], now: NOW })
    expect(note).not.toContain('Your owner sees')
    expect(note).toContain('could not be saved')
    expect(takeToolImages('act-full')).toEqual([])
    expect(pictures(files)).toEqual([])
  })
})
