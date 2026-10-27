import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readAssetInPieces } from '../src/main/ipc/assetPieces'
import { FILE_ASSET_PIECE_BYTES } from '../src/shared/fileAssets'

function sourcesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return sourcesUnder(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

describe('the Electron main process and folders', () => {
  it('never reads, writes or runs Git in a folder itself: the daemon does, for a thread or a project', () => {
    const offenders = sourcesUnder(fileURLToPath(new URL('../src/main', import.meta.url)))
      .filter((path) => /mms[\\/]files[\\/]FileService|mms[\\/]git[\\/]GitService|\bfileService\b|\bgitService\b/.test(readFileSync(path, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('sends the daemon a thread or a project, never a folder, for every files and Git read', () => {
    const source = readFileSync(new URL('../src/main/ipc/registerGuiIpc.ts', import.meta.url), 'utf8')
    for (const channel of ['fs:listDir', 'fs:readFile', 'fs:readAsset', 'fs:writeFile', 'app:getFilesRoot', 'git:status', 'git:log', 'git:branches', 'git:diffStats', 'git:lastCommitMessage']) {
      expect(source, channel).toContain(`'${channel}'`)
    }
    expect(source).not.toMatch(/resolveFilesRoot|resolveGitCwd|homedir/)
  })
})

describe('a preview read in pieces', () => {
  const piece = (bytes: Buffer, size = bytes.length) => ({ mimeType: 'image/png', size, data: bytes.toString('base64') })

  it('is one request for a file that fits a piece', async () => {
    const requests: Array<[number, number]> = []
    const asset = await readAssetInPieces(async (offset, length) => { requests.push([offset, length]); return piece(Buffer.from([1, 2, 3])) })
    expect([...asset.data]).toEqual([1, 2, 3])
    expect(asset).toMatchObject({ mimeType: 'image/png', size: 3 })
    expect(requests).toEqual([[0, FILE_ASSET_PIECE_BYTES]])
  })

  it('asks for each next piece where the last one ended and joins them in order', async () => {
    const whole = Buffer.from(Array.from({ length: 25 }, (_, i) => i))
    const requests: number[] = []
    const asset = await readAssetInPieces(async (offset) => { requests.push(offset); return piece(whole.subarray(offset, offset + 10), whole.length) })
    expect(requests).toEqual([0, 10, 20])
    expect(Buffer.from(asset.data).equals(whole)).toBe(true)
  })

  it('is empty for an empty file', async () => {
    const asset = await readAssetInPieces(async () => piece(Buffer.alloc(0)))
    expect(asset.data).toHaveLength(0)
    expect(asset.size).toBe(0)
  })

  it('stops when the file shrinks under the read', async () => {
    await expect(readAssetInPieces(async (offset) => (offset === 0 ? piece(Buffer.alloc(4), 10) : piece(Buffer.alloc(0), 10)))).rejects.toThrow(/changed while/)
  })
})
