import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileService } from '../src/mms/files/FileService'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('FileService rich assets', () => {
  it('reads supported binary previews without UTF-8 decoding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-assets-'))
    roots.push(root)
    await writeFile(join(root, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]))

    const asset = await new FileService().readAsset(root, 'pixel.png')
    expect(asset.mimeType).toBe('image/png')
    expect(asset.size).toBe(6)
    expect([...asset.data]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 255])
  })

  it('rejects unsupported assets and paths outside the files root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-assets-'))
    roots.push(root)
    await writeFile(join(root, 'archive.zip'), 'not really a zip')

    await expect(new FileService().readAsset(root, 'archive.zip')).rejects.toThrow(/does not support/)
    await expect(new FileService().readAsset(root, '../outside.pdf')).rejects.toThrow()
  })
})
