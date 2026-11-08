import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  detectProjectIcon,
  imageMime,
  projectIconCandidates,
  projectIconFor,
  readIconFile,
  rootLogoCandidates,
  toStoredIconPath
} from '../src/mms/data/projectIcon'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { PROJECT_ICON_MAX_BYTES } from '../src/shared/projectIcon'
import type { Project } from '../src/shared/types'

const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)])
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(16)])

let root: string

function put(path: string, content: string | Buffer): void {
  const file = join(root, path)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mousse-project-icon-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('project icon detection', () => {
  it('tries every place as SVG before any PNG, and PNG before ICO', () => {
    const candidates = projectIconCandidates()
    expect(candidates[0]).toBe('favicon.svg')
    expect(candidates.indexOf('assets/logo.svg')).toBeLessThan(candidates.indexOf('favicon.png'))
    expect(candidates.indexOf('public/favicon.png')).toBeLessThan(candidates.indexOf('favicon.ico'))
    expect(candidates).toContain('src/app/icon.svg')
    expect(candidates).toContain('resources/icon.png')
  })

  it('ranks a root logo icon first, then a named logo', () => {
    expect(rootLogoCandidates(['README.md', 'acme-logo.svg', 'mousse_logo_icon.svg', 'logo.png'])).toEqual([
      'mousse_logo_icon.svg',
      'acme-logo.svg'
    ])
  })

  it("finds the Mousse repository's own logo before its PNG app icon", async () => {
    put('mousse_logo_icon.svg', SVG)
    put('resources/icon.png', PNG)
    put('resources/icon.ico', ICO)
    const icon = await detectProjectIcon(root)
    expect(icon).toMatchObject({ source: 'auto', path: 'mousse_logo_icon.svg' })
    expect(icon?.dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true)
  })

  it('prefers a favicon SVG in public/ over a root PNG, matching names whatever their case', async () => {
    put('favicon.png', PNG)
    put('public/Favicon.SVG', SVG)
    expect((await detectProjectIcon(root))?.path).toBe('public/Favicon.SVG')
  })

  it('skips a candidate that is not really an image and takes the next', async () => {
    put('favicon.svg', 'not an svg at all')
    put('favicon.ico', ICO)
    expect(await detectProjectIcon(root)).toMatchObject({ path: 'favicon.ico' })
  })

  it('never shows a file outside the project that a link in it points to', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mousse-icon-outside-'))
    try {
      writeFileSync(join(outside, 'favicon.svg'), SVG)
      // A junction needs no rights on Windows; elsewhere it is an ordinary folder link.
      symlinkSync(outside, join(root, 'public'), 'junction')
      put('assets/real/favicon.svg', SVG)
      symlinkSync(join(root, 'assets', 'real'), join(root, 'static'), 'junction')
      expect((await detectProjectIcon(root))?.path).toBe('static/favicon.svg')
      const recorded: Project = { id: 'p1', name: 'p', path: root, createdAt: '', order: 0, detectedIconPath: 'public/favicon.svg', iconDetectedAt: new Date().toISOString() }
      expect(await projectIconFor(recorded, { recordDetectedIcon: () => undefined })).toMatchObject({ path: 'static/favicon.svg' })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('finds nothing in a folder without an icon, or one that is gone', async () => {
    put('src/index.ts', 'export {}')
    expect(await detectProjectIcon(root)).toBeNull()
    expect(await detectProjectIcon(join(root, 'missing'))).toBeNull()
  })
})

describe('icon file guard', () => {
  it('knows images by their bytes, never by their extension', () => {
    expect(imageMime(PNG)).toBe('image/png')
    expect(imageMime(ICO)).toBe('image/x-icon')
    expect(imageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(imageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(imageMime(Buffer.from('﻿  <!-- logo --><svg viewBox="0 0 1 1"/>'))).toBe('image/svg+xml')
    expect(imageMime(Buffer.from('<html><svg></svg></html>'))).toBeNull()
    expect(imageMime(Buffer.from('#!/bin/sh\necho hi'))).toBeNull()
    // An ICO header that claims more images than the file holds.
    expect(imageMime(Buffer.concat([Buffer.from([0, 0, 1, 0, 9, 0]), Buffer.alloc(16)]))).toBeNull()
  })

  it('refuses a file over the size cap, an empty file and a folder', async () => {
    put('big.png', Buffer.concat([PNG, Buffer.alloc(PROJECT_ICON_MAX_BYTES)]))
    put('empty.svg', '')
    mkdirSync(join(root, 'dir.svg'))
    expect(await readIconFile(join(root, 'big.png'))).toBeNull()
    expect(await readIconFile(join(root, 'empty.svg'))).toBeNull()
    expect(await readIconFile(join(root, 'dir.svg'))).toBeNull()
    expect(await readIconFile(join(root, 'nope.png'))).toBeNull()
  })

  it('reads a renamed image as what it really is', async () => {
    put('logo.svg', PNG)
    expect((await readIconFile(join(root, 'logo.svg')))?.mime).toBe('image/png')
  })
})

describe('project icon choice', () => {
  const project = (fields: Partial<Project> = {}): Project => ({ id: 'p1', name: 'p', path: root, createdAt: '', order: 0, ...fields })
  const recorder = () => {
    const calls: Array<string | null> = []
    return { calls, recordDetectedIcon: (_id: string, path: string | null) => { calls.push(path) } }
  }

  it('stores a file inside the project relative to it, and one outside as absolute', () => {
    expect(toStoredIconPath(root, join(root, 'art', 'mark.png'))).toBe('art/mark.png')
    const outside = join(tmpdir(), 'elsewhere.png')
    expect(toStoredIconPath(root, outside)).toBe(outside)
  })

  it('shows the folder when icons are off, and the chosen file over the found one', async () => {
    put('favicon.svg', SVG)
    put('art/mark.png', PNG)
    expect(await projectIconFor(project({ iconOff: true }), recorder())).toBeNull()
    expect(await projectIconFor(project({ iconPath: 'art/mark.png' }), recorder())).toMatchObject({ source: 'custom', path: 'art/mark.png' })
  })

  it('falls back to the folder when the chosen file is gone', async () => {
    put('favicon.svg', SVG)
    expect(await projectIconFor(project({ iconPath: 'gone.png' }), recorder())).toBeNull()
  })

  it('remembers what it found and trusts it until it is old', async () => {
    put('favicon.svg', SVG)
    const first = recorder()
    expect(await projectIconFor(project(), first)).toMatchObject({ path: 'favicon.svg' })
    expect(first.calls).toEqual(['favicon.svg'])
    const now = Date.now()
    const fresh = recorder()
    expect(await projectIconFor(project({ iconDetectedAt: new Date(now).toISOString() }), fresh, now)).toBeNull()
    expect(fresh.calls).toEqual([])
    const stale = recorder()
    await projectIconFor(project({ iconDetectedAt: new Date(now - 7 * 3600_000).toISOString() }), stale, now)
    expect(stale.calls).toEqual(['favicon.svg'])
  })
})

describe('project icon methods', () => {
  const setup = () => {
    const home = join(root, 'home')
    mkdirSync(home)
    const folder = join(root, 'repo')
    mkdirSync(folder)
    writeFileSync(join(folder, 'favicon.svg'), SVG)
    writeFileSync(join(folder, 'notes.txt'), 'secret')
    const projects = new ProjectManager(home)
    const { id } = projects.openProject(folder)
    const call = (clientType: 'gui' | 'bridge', method: string, params: object) =>
      dispatchMethod({ mms: { projects } as never, globalSequence: () => 0, connection: { clientType } as never }, method, params)
    return { id, folder, projects, call }
  }

  it('answers a window on this computer and nobody else', async () => {
    const { id, call } = setup()
    expect(await call('gui', 'projects.icon', { projectId: id })).toMatchObject({ icon: { source: 'auto', path: 'favicon.svg' } })
    expect(await call('bridge', 'projects.icon', { projectId: id })).toEqual({ icon: null })
    await expect(call('bridge', 'projects.setIcon', { projectId: id, mode: 'off' })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('refuses a chosen file that is not an image', async () => {
    const { id, folder, projects, call } = setup()
    await expect(call('gui', 'projects.setIcon', { projectId: id, mode: 'custom', path: join(folder, 'notes.txt') }))
      .rejects.toMatchObject({ code: 'invalid_params' })
    expect(projects.getProject(id)?.iconPath).toBeUndefined()
    await call('gui', 'projects.setIcon', { projectId: id, mode: 'off' })
    expect(await call('gui', 'projects.icon', { projectId: id })).toEqual({ icon: null })
  })
})

describe('ProjectManager icon settings', () => {
  it('saves a chosen icon, icons off and back to found, and opening the project again looks again', () => {
    const home = join(root, 'home')
    mkdirSync(home)
    const folder = join(root, 'repo')
    mkdirSync(folder)
    const manager = new ProjectManager(home)
    const { id } = manager.openProject(folder)
    const saved = () => (JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')) as Project[])[0]!

    manager.setProjectIcon(id, { mode: 'custom', path: join(folder, 'icon.png') })
    expect(saved()).toMatchObject({ iconPath: 'icon.png' })
    expect(saved().iconOff).toBeUndefined()

    manager.setProjectIcon(id, { mode: 'off' })
    expect(saved()).toMatchObject({ iconOff: true })
    expect(saved().iconPath).toBeUndefined()

    manager.setProjectIcon(id, { mode: 'auto' })
    expect(saved().iconOff).toBeUndefined()
    expect(saved().iconPath).toBeUndefined()

    manager.recordDetectedIcon(id, 'favicon.svg')
    expect(saved()).toMatchObject({ detectedIconPath: 'favicon.svg' })
    expect(saved().iconDetectedAt).toBeTruthy()

    manager.openProject(folder)
    expect(saved().iconDetectedAt).toBeUndefined()
    expect(new ProjectManager(home).getProject(id)).toMatchObject({ detectedIconPath: 'favicon.svg' })
  })
})
