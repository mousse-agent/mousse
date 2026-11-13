import { existsSync } from 'node:fs'
import { lstat, mkdtemp, readFile, readdir, readlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { extractChromeZip } from '../src/mms/browser/install/archive'
import { S_IFBLK, S_IFCHR, S_IFIFO, S_IFREG, S_IFSOCK, canCreateSymlinks, dir, file, link, rawZip, type RawZipEntry } from './fixtures/browser/rawZip'

// The extractor takes the platform's choice as a parameter (links are allowed
// only for macOS archives), so these checks run on every platform. Only the
// cases that create links on disk need symlink support.
const symlinksAvailable = canCreateSymlinks()

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function freshOut(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mousse-archive-'))
  roots.push(root)
  return join(root, 'extracted')
}

function extract(archive: Uint8Array, out: string, allowContainedSymlinks = true) {
  return extractChromeZip(archive, out, { maxEntries: 1000, maxExtractedBytes: 1024 * 1024, allowContainedSymlinks })
}

/** Refused while reading the archive: nothing, not even the output folder, is written. */
async function expectRefusedBeforeWrite(entries: RawZipEntry[], error: RegExp, allowContainedSymlinks = true): Promise<void> {
  const out = await freshOut()
  await expect(extract(rawZip(entries), out, allowContainedSymlinks)).rejects.toThrow(error)
  expect(existsSync(out)).toBe(false)
}

const real = file('app/real', 'payload')

describe('Chrome archive names', () => {
  it('refuses the empty-segment link shape that re-enters through the staging folder name', async () => {
    await expectRefusedBeforeWrite([
      dir('c/'), dir('c/d/'),
      link('c/d//up', '..'),
      link('c/d/E', 'up/../../extracted/c/d/real'),
      file('c/d/real'),
      file('c/extracted/c/d/real')
    ], /empty or "\." segment: c\/d\/\/up/)
  })

  it.each([
    ['an empty segment in a file name', file('app//real')],
    ['a leading "." segment', file('./app/real')],
    ['an inner "." segment', file('app/./real')],
    ['a trailing "." segment', dir('app/.')],
    ['a doubled trailing slash', dir('app//')]
  ])('refuses %s', async (_label, entry) => {
    await expectRefusedBeforeWrite([entry], /empty or "\." segment/)
  })

  it('refuses a trailing slash on a file and a directory mode without one', async () => {
    await expectRefusedBeforeWrite([{ name: 'app/data/', data: 'x', mode: S_IFREG | 0o644 }], /file entry is named as a directory/)
    await expectRefusedBeforeWrite([{ name: 'app/data/', mode: S_IFREG | 0o644 }], /file entry is named as a directory/)
    await expectRefusedBeforeWrite([{ name: 'app/data', mode: 0o040755 }], /directory entry is named as a file/)
  })

  it.each([
    ['names that differ only in case', [file('App/x'), file('app/y')]],
    ['a file and a directory that differ only in case', [file('app/Data'), file('app/data/inner')]]
  ])('refuses %s', async (_label, entries) => {
    await expectRefusedBeforeWrite(entries, /case-colliding/)
  })

  it.each([
    ['long s and s', [file('app/ſ'), file('app/s')]],
    ['final sigma and sigma', [file('app/ς'), file('app/σ')]],
    ['composed and decomposed accents', [file('app/café'), file('app/café')]],
    ['a single non-ASCII name', [file('app/é')]],
    ['a control character', [file('app/a\u0007b')]]
  ])('refuses names that a normalising filesystem could merge: %s', async (_label, entries) => {
    await expectRefusedBeforeWrite(entries, /not plain ASCII/)
  })
})

describe('Chrome archive entries that share a path', () => {
  it.each([
    ['a file then a link', [file('app/p'), link('app/p', 'real'), real]],
    ['a link then a file', [link('app/p', 'real'), file('app/p'), real]],
    ['a directory then a link', [dir('app/p/'), link('app/p', 'real'), real]],
    ['a link then a directory', [link('app/p', 'real'), dir('app/p/'), real]]
  ])('refuses %s on one path', async (_label, entries) => {
    await expectRefusedBeforeWrite(entries, /duplicate or case-colliding/)
  })

  it.each([
    ['a link then an entry below it', [link('app/p', 'sub'), dir('app/sub/'), file('app/p/x')]],
    ['an entry below a path then a link on it', [file('app/p/x'), dir('app/sub/'), link('app/p', 'sub')]]
  ])('refuses %s', async (_label, entries) => {
    await expectRefusedBeforeWrite(entries, /written through a symlink entry/)
  })

  it('refuses a file used as a directory', async () => {
    await expectRefusedBeforeWrite([file('app/p'), file('app/p/x')], /uses a file as a directory/)
  })
})

describe('Chrome archive link targets', () => {
  it.each([
    ['a NUL', 'real\u0000x'],
    ['a backslash', 'sub\\real'],
    ['a colon', 'C:real'],
    ['an absolute path', '/etc/passwd']
  ])('refuses a target with %s', async (_label, target) => {
    await expectRefusedBeforeWrite([real, link('app/l', target)], /absolute or not portable/)
  })

  it.each([
    ['empty', ''],
    ['over 1024 bytes', 'a/'.repeat(512) + 'b']
  ])('refuses a target that is %s', async (_label, target) => {
    await expectRefusedBeforeWrite([real, link('app/l', target)], /invalid length/)
  })

  it.each([
    ['a "." segment', './real'],
    ['an empty segment', 'sub//real'],
    ['a trailing slash', 'sub/'],
    ['a non-ASCII name', 'réal']
  ])('refuses a target with %s', async (_label, target) => {
    await expectRefusedBeforeWrite([real, dir('app/sub/'), file('app/sub/real'), link('app/l', target)], /not a plain relative path/)
  })

  it('refuses targets that the filesystem would resolve differently', async () => {
    await expectRefusedBeforeWrite([real, link('app/l', 'Real')], /differs in case/)
    await expectRefusedBeforeWrite([real, link('app/l', 'missing/../real')], /missing from the archive/)
    await expectRefusedBeforeWrite([real, link('app/l', 'real/../real')], /goes through a file/)
    await expectRefusedBeforeWrite([real, link('app/l', '../../outside')], /outside the extraction root/)
    await expectRefusedBeforeWrite([real, link('app/l', '..')], /extraction root/)
  })

  it('refuses links when the platform does not allow them', async () => {
    await expectRefusedBeforeWrite([real, link('app/l', 'real')], /Archive contains a symlink entry: app\/l/, false)
  })
})

describe('Chrome archive links to their own folder or above', () => {
  it.each([
    ['its parent folder', 'top/a/loop', '..'],
    ['its own folder by name', 'top/a/loop', '../a'],
    ['a folder two levels up', 'top/a/b/loop', '../..']
  ])('refuses a link to %s', async (_label, name, target) => {
    await expectRefusedBeforeWrite([file('top/a/b/x'), link(name, target)], /own folder or a folder above it/)
  })

  it('refuses two links that point into each other\'s folders', async () => {
    await expectRefusedBeforeWrite([
      dir('top/a/'), dir('top/b/'),
      link('top/a/p', '../b'),
      link('top/b/q', '../a')
    ], /folder that holds links/)
  })

  it('refuses a two-link loop', async () => {
    await expectRefusedBeforeWrite([link('top/a', 'b'), link('top/b', 'a')], /too long or loops/)
  })
})

function chain(length: number): RawZipEntry[] {
  const entries: RawZipEntry[] = [file('top/real', 'end')]
  for (let index = 0; index < length; index += 1) entries.push(link(`top/l${index}`, index === length - 1 ? 'real' : `l${index + 1}`))
  return entries
}

describe('Chrome archive link limits', () => {
  it('refuses a chain that needs 17 hops after the first link', async () => {
    await expectRefusedBeforeWrite(chain(18), /too long or loops: top\/l0/)
  })

  it('refuses more than 256 links', async () => {
    const entries: RawZipEntry[] = [real]
    for (let index = 0; index < 257; index += 1) entries.push(link(`app/l${index}`, 'real'))
    await expectRefusedBeforeWrite(entries, /too many symlink entries/)
  })
})

describe('Chrome archive headers and file types', () => {
  it('refuses a local header whose name differs from the central directory', async () => {
    await expectRefusedBeforeWrite([real, file('app/safe', 'x', { localName: 'app/evil' })], /central and local headers disagree: app\/safe/)
  })

  it('refuses a local header whose compression method differs from the central directory', async () => {
    await expectRefusedBeforeWrite([real, link('app/l', 'real', { method: 8, localMethod: 0 })], /central and local headers disagree: app\/l/)
  })

  it('refuses a local entry missing from the central directory without writing it', async () => {
    const out = await freshOut()
    await expect(extract(rawZip([real, file('app/hidden', 'planted', { omitFromCentral: true })]), out)).rejects.toThrow(/unexpected entry: app\/hidden/)
    expect(existsSync(join(out, 'app/hidden'))).toBe(false)
  })

  it('refuses a second local entry with the same name', async () => {
    const out = await freshOut()
    await expect(extract(rawZip([real, file('app/real', 'swapped', { omitFromCentral: true })]), out)).rejects.toThrow(/unexpected entry: app\/real/)
  })

  it('refuses an entry whose data is longer than the central directory says', async () => {
    const out = await freshOut()
    await expect(extract(rawZip([file('app/real', 'longer than declared', { centralUncompressedSize: 3 })]), out)).rejects.toThrow(/size changed while inflating/)
  })

  it.each([
    ['a FIFO', S_IFIFO],
    ['a character device', S_IFCHR],
    ['a block device', S_IFBLK],
    ['a socket', S_IFSOCK]
  ])('refuses %s entry', async (_label, type) => {
    await expectRefusedBeforeWrite([real, { name: 'app/special', mode: type | 0o644 }], /unsupported file type/)
  })
})

describe.skipIf(!symlinksAvailable)('Chrome archive links that are accepted', () => {
  it('creates stored and deflated link targets', async () => {
    const out = await freshOut()
    await extract(rawZip([real, dir('app/sub/'), file('app/sub/inner', 'in'), link('app/stored', 'real'), link('app/deflated', 'sub/inner', { method: 8 })]), out)
    expect(await readlink(join(out, 'app/stored'))).toBe('real')
    // Windows keeps a relative link target with its own separator; the archive's is POSIX.
    expect((await readlink(join(out, 'app/deflated'))).replaceAll('\\', '/')).toBe('sub/inner')
    expect(await readFile(join(out, 'app/deflated'), 'utf8')).toBe('in')
  })

  it('accepts a chain of 16 hops after the first link', async () => {
    const out = await freshOut()
    await extract(rawZip(chain(17)), out)
    expect(await readFile(join(out, 'top/l0'), 'utf8')).toBe('end')
  })

  it('accepts the macOS framework layout, including a link to a folder through another link', async () => {
    const out = await freshOut()
    const fw = 'chrome-mac-arm64/App.app/Contents/Frameworks/F.framework'
    await extract(rawZip([
      link(`${fw}/Resources`, 'Versions/Current/Resources'),
      link(`${fw}/Helpers`, 'Versions/Current/Helpers'),
      link(`${fw}/F`, 'Versions/Current/F'),
      link(`${fw}/Versions/Current`, '157.0.0.1'),
      file(`${fw}/Versions/157.0.0.1/F`, 'binary'),
      file(`${fw}/Versions/157.0.0.1/Resources/r.pak`, 'pak'),
      dir(`${fw}/Versions/157.0.0.1/Helpers/`)
    ]), out)
    expect(await readFile(join(out, fw, 'Resources/r.pak'), 'utf8')).toBe('pak')
    expect((await lstat(join(out, fw, 'Versions/Current'))).isSymbolicLink()).toBe(true)
    expect((await readdir(join(out, fw), { withFileTypes: true })).filter((entry) => entry.isSymbolicLink()).map((entry) => entry.name).sort()).toEqual(['F', 'Helpers', 'Resources'])
  })
})
