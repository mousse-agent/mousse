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

  it('reads a range of an asset, with the size of the whole file, and nothing past its end', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-assets-'))
    roots.push(root)
    await writeFile(join(root, 'pixel.png'), Buffer.from([10, 11, 12, 13, 14, 15]))
    const service = new FileService()

    const middle = await service.readAssetRange(root, 'pixel.png', 2, 3)
    expect([...middle.data]).toEqual([12, 13, 14])
    expect(middle).toMatchObject({ mimeType: 'image/png', size: 6 })
    expect([...(await service.readAssetRange(root, 'pixel.png', 4, 100)).data]).toEqual([14, 15])
    expect((await service.readAssetRange(root, 'pixel.png', 6, 10)).data).toHaveLength(0)
    expect((await service.readAssetRange(root, 'pixel.png', 99, 10)).data).toHaveLength(0)
    const pieces = await Promise.all([0, 2, 4].map((offset) => service.readAssetRange(root, 'pixel.png', offset, 2)))
    expect([...Buffer.concat(pieces.map((piece) => piece.data))]).toEqual([10, 11, 12, 13, 14, 15])
  })

  it('applies the same guards to a range as to the whole asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-assets-'))
    roots.push(root)
    await writeFile(join(root, 'archive.zip'), 'not really a zip')
    const service = new FileService()
    await expect(service.readAssetRange(root, 'archive.zip', 0, 4)).rejects.toThrow(/does not support/)
    await expect(service.readAssetRange(root, '../outside.pdf', 0, 4)).rejects.toThrow()
  })
})
