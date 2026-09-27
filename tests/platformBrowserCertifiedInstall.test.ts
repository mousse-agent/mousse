import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installCertifiedChrome, pinnedChromeDownload } from '../src/browser-worker/binary/install'
import { chromeExecutableRelPath } from '../src/browser-worker/binary/platform'
import { certifiedInstallDir, certifiedMetadataPath } from '../src/browser-worker/binary/resolver'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('certified worker Chrome ZIP installation', () => {
  it('extracts a real ZIP with the host utility and persists the downloaded digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-certified-zip-'))
    roots.push(root)
    const descriptor = pinnedChromeDownload()
    const executable = chromeExecutableRelPath(descriptor.platform)
    const archive = zipSync({ [executable]: new TextEncoder().encode('fixture chrome bytes') })
    const fetcher = vi.fn(async () => new Response(archive.slice().buffer))
    vi.stubGlobal('fetch', fetcher)
    const metadata = await installCertifiedChrome(root)
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(descriptor.url)
    expect(await readFile(join(certifiedInstallDir(root), executable), 'utf8')).toBe('fixture chrome bytes')
    expect(metadata.sha256).toBe(createHash('sha256').update(archive).digest('hex'))
    expect(JSON.parse(await readFile(certifiedMetadataPath(root), 'utf8'))).toEqual(metadata)

    // A failed replacement must leave the verified installation and its metadata usable.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not a ZIP archive')))
    await expect(installCertifiedChrome(root)).rejects.toThrow(/Chrome ZIP extraction/)
    expect(await readFile(join(certifiedInstallDir(root), executable), 'utf8')).toBe('fixture chrome bytes')
    expect(JSON.parse(await readFile(certifiedMetadataPath(root), 'utf8'))).toEqual(metadata)
  })
})
