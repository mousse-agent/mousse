import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractChromeZip } from '../src/mms/browser/install/archive'
import { removeOwnedTree } from '../src/mms/browser/install/fsSafety'
import { canCreateSymlinks, file, link, rawZip } from './fixtures/browser/rawZip'

// The archive model refuses every link the filesystem would resolve outside
// the tree before anything is written, so no archive reaches the on-disk check
// that runs after the links exist. It guards against the model and the disk
// disagreeing; these tests make the filesystem's answer disagree on purpose.
const disk = vi.hoisted(() => ({ realpath: undefined as ((path: string, real: (path: string) => string) => string | undefined) | undefined }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const native = (path: string): string => {
    const override = disk.realpath?.(String(path), (inner) => actual.realpathSync.native(inner))
    return override ?? actual.realpathSync.native(path)
  }
  const realpathSync = Object.assign((path: string) => actual.realpathSync(path), { native })
  return { ...actual, realpathSync, default: { ...actual, realpathSync } }
})

const roots: string[] = []
afterEach(async () => {
  disk.realpath = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function staging(): Promise<{ root: string; out: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mousse-archive-disk-'))
  roots.push(root)
  return { root, out: join(root, 'staging', 'extracted') }
}

const archive = rawZip([file('app/real', 'payload'), file('app/other', 'other'), link('app/a', 'real'), link('app/b', 'other')])

const isLinkB = (path: string): boolean => /[\\/]app[\\/]b$/.test(path)

async function linksUnder(directory: string): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true, recursive: true })).filter((entry) => entry.isSymbolicLink()).map((entry) => entry.name)
}

describe.skipIf(!canCreateSymlinks())('on-disk link check after extraction', () => {
  it.each([
    ['resolves outside the extraction root', (path: string) => isLinkB(path) ? tmpdir() : undefined, /points outside the extraction root: app[\\/]b/],
    ['resolves to its own folder', (path: string, real: (path: string) => string) => isLinkB(path) ? real(dirname(path)) : undefined, /own folder or a folder above it: app[\\/]b/],
    ['does not resolve', (path: string) => { if (isLinkB(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }, /does not resolve inside the extraction root: app[\\/]b/]
  ])('refuses a link that %s, unlinks every link it made, and leaves staging removable', async (_label, realpath, error) => {
    const { root, out } = await staging()
    disk.realpath = realpath
    await expect(extractChromeZip(archive, out, { maxEntries: 100, maxExtractedBytes: 1024 * 1024, allowContainedSymlinks: true })).rejects.toThrow(error)
    expect(await linksUnder(out)).toEqual([])
    expect((await readdir(join(out, 'app'))).sort()).toEqual(['other', 'real'])
    disk.realpath = undefined
    await removeOwnedTree(join(root, 'staging'), root)
    expect(await readdir(root)).toEqual([])
  })
})
