/**
 * Agent archive extraction (agent CLIs plan §4): only plain files and folders inside the staging
 * folder are written. Traversal, absolute, drive and UNC names, symlinks, hardlinks and special
 * files are refused; entry count and expanded size are counted while streaming; the launch target
 * must stay inside the install; a cancelled or failed extraction leaves no staging folder behind.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArchiveError, containedFile, entrySegments, extractArchive, stageArchive } from '../../src/mms/harness/agents/archive'
import { tarGzOf, zipOf, type ArchiveEntry } from './archiveFixtures'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-archive-'))
  dirs.push(dir)
  const write = (name: string, data: Buffer) => {
    const path = join(dir, name)
    writeFileSync(path, data)
    return path
  }
  return { dir, write, dest: join(dir, 'out') }
}

/** Nothing was written next to the destination (a traversal would land there). */
function onlyOut(dir: string, archive: string): void {
  expect(readdirSync(dir).sort()).toEqual([archive, 'out'].sort())
}

describe('agent archive extraction', () => {
  it('extracts nested files from tar.gz and zip, with modes capped at rwxr-xr-x and an npm prefix stripped', async () => {
    const { write, dest } = workspace()
    const tar = write('a.tar.gz', tarGzOf([
      { name: 'package/', type: '5' },
      { name: 'package/bin/', type: '5' },
      { name: 'package/bin/agent', data: '#!/bin/sh\n', mode: 0o4777 },
      { name: 'package/package.json', data: '{}' }
    ]))
    expect(await extractArchive(tar, dest, { format: 'tar.gz', stripPrefix: 'package/' })).toEqual({ files: 2, bytes: 12 })
    expect(readFileSync(join(dest, 'bin', 'agent'), 'utf8')).toBe('#!/bin/sh\n')
    if (process.platform !== 'win32') expect(statSync(join(dest, 'bin', 'agent')).mode & 0o7777).toBe(0o755)
    const zip = write('a.zip', zipOf([{ name: 'dist/', mode: 0o040755 }, { name: 'dist/agent.exe', data: 'MZ' }, { name: './readme.txt', data: 'hi' }]))
    const zipDest = join(dest, '..', 'zip-out')
    await extractArchive(zip, zipDest, { format: 'zip' })
    expect(readFileSync(join(zipDest, 'dist', 'agent.exe'), 'utf8')).toBe('MZ')
    expect(readFileSync(join(zipDest, 'readme.txt'), 'utf8')).toBe('hi')
  })

  it('refuses names that leave the folder, read with backslashes as slashes', async () => {
    for (const name of ['../evil', 'a/../../evil', '/etc/evil', 'C:/evil', 'C:\\evil', '..\\evil', '\\\\server\\share\\evil', 'ok/..\\..\\evil']) {
      expect(() => entrySegments(name), name).toThrow(ArchiveError)
      const { dir, write, dest } = workspace()
      const tar = write('a.tar.gz', tarGzOf([{ name, data: 'x' }]))
      await expect(extractArchive(tar, dest, { format: 'tar.gz' }), name).rejects.toThrow()
      onlyOut(dir, 'a.tar.gz')
    }
    for (const name of ['../evil', '/etc/evil', 'C:/evil', '..\\evil']) {
      const { dir, write, dest } = workspace()
      const zip = write('a.zip', zipOf([{ name, data: 'x' }]))
      await expect(extractArchive(zip, dest, { format: 'zip' }), name).rejects.toThrow()
      onlyOut(dir, 'a.zip')
    }
    // Entries outside the stripped prefix are refused too.
    expect(() => entrySegments('other/file', 'package/')).toThrow(ArchiveError)
    expect(entrySegments('package/', 'package/')).toBeNull()
  })

  it('refuses symlinks, hardlinks, devices and FIFOs', async () => {
    const cases: ArchiveEntry[] = [
      { name: 'link', type: '2', link: '../../etc/passwd' },
      { name: 'hard', type: '1', link: 'other' },
      { name: 'dev', type: '3' },
      { name: 'fifo', type: '6' }
    ]
    for (const entry of cases) {
      const { dir, write, dest } = workspace()
      const tar = write('a.tar.gz', tarGzOf([{ name: 'ok.txt', data: 'x' }, entry]))
      await expect(extractArchive(tar, dest, { format: 'tar.gz' }), entry.type).rejects.toThrow(/does not install/)
      onlyOut(dir, 'a.tar.gz')
    }
    const { write, dest } = workspace()
    const zip = write('a.zip', zipOf([{ name: 'link', data: '../../etc/passwd', mode: 0o120777 }]))
    await expect(extractArchive(zip, dest, { format: 'zip' })).rejects.toThrow(/symbolic link/)
    expect(existsSync(join(dest, 'link'))).toBe(false)
  })

  it('counts expanded bytes and entries while streaming (an expansion bomb stops early)', async () => {
    const { write, dest } = workspace()
    const big = write('big.tar.gz', tarGzOf([{ name: 'a', data: Buffer.alloc(4096, 1) }, { name: 'b', data: Buffer.alloc(4096, 1) }]))
    await expect(extractArchive(big, dest, { format: 'tar.gz', maxBytes: 6000 })).rejects.toThrow(/expands to more than/)
    const zipBomb = write('big.zip', zipOf([{ name: 'a', data: Buffer.alloc(8192, 1) }]))
    await expect(extractArchive(zipBomb, join(dest, '..', 'z'), { format: 'zip', maxBytes: 6000 })).rejects.toThrow(/expands to more than/)
    const many = write('many.tar.gz', tarGzOf(Array.from({ length: 6 }, (_, index) => ({ name: `f${index}`, data: 'x' }))))
    await expect(extractArchive(many, join(dest, '..', 'm'), { format: 'tar.gz', maxEntries: 5 })).rejects.toThrow(/more than 5 entries/)
  })

  it('keeps the launch target inside the install: a regular file, executable on POSIX', () => {
    const { dir } = workspace()
    const root = join(dir, 'root')
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin', 'agent'), 'x', { mode: 0o755 })
    writeFileSync(join(dir, 'outside'), 'x', { mode: 0o755 })
    expect(containedFile(root, ['bin', 'agent'], { executable: true })).toMatch(/agent$/)
    expect(() => containedFile(root, ['bin'])).toThrow(/not a file/)
    expect(() => containedFile(root, ['missing'])).toThrow(/has no missing/)
    if (process.platform !== 'win32') {
      writeFileSync(join(root, 'bin', 'plain'), 'x', { mode: 0o644 })
      expect(() => containedFile(root, ['bin', 'plain'], { executable: true })).toThrow(/not executable/)
    }
    let linked = false
    try {
      symlinkSync(join(dir, 'outside'), join(root, 'bin', 'escape'))
      linked = true
    } catch {
      // Windows without the symlink privilege: the extractor never writes links anyway.
    }
    if (linked) expect(() => containedFile(root, ['bin', 'escape'])).toThrow(/outside the install folder/)
  })

  it('removes the staging folder when extraction is cancelled or fails', async () => {
    const { dir, write } = workspace()
    const agentDir = join(dir, 'agents', 'demo')
    const tar = write('a.tar.gz', tarGzOf(Array.from({ length: 50 }, (_, index) => ({ name: `f${index}`, data: Buffer.alloc(64 * 1024, index) }))))
    const controller = new AbortController()
    controller.abort(new Error('Install cancelled'))
    await expect(stageArchive(tar, agentDir, { format: 'tar.gz', signal: controller.signal })).rejects.toThrow(/cancelled/)
    expect(readdirSync(agentDir)).toEqual([])
    const bad = write('bad.tar.gz', tarGzOf([{ name: 'ok', data: 'x' }, { name: '../evil', data: 'x' }]))
    await expect(stageArchive(bad, agentDir, { format: 'tar.gz' })).rejects.toThrow(ArchiveError)
    expect(readdirSync(agentDir)).toEqual([])
    const good = await stageArchive(write('good.tar.gz', tarGzOf([{ name: 'agent', data: 'x' }])), agentDir, { format: 'tar.gz' })
    expect(readFileSync(join(good.staging, 'dist', 'agent'), 'utf8')).toBe('x')
  })
})
