import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectProjectIcon, PROJECT_ICON_DETECTOR_VERSION, projectIconFor } from '../src/mms/data/projectIcon'
import { appFolders, htmlIconLinks, iconSize, insideProject, tauriIcons, webManifestIcons } from '../src/mms/data/projectIconManifests'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import type { Project } from '../src/shared/types'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)])
const WEBP = Buffer.from('RIFF\0\0\0\0WEBPVP8 \0\0\0\0')

let root: string

function put(path: string, content: string | Buffer): void {
  const file = join(root, path)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

const json = (value: unknown) => JSON.stringify(value)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mousse-icon-manifest-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('icons a project declares', () => {
  it('Expo app.json: expo.icon, relative to the manifest', async () => {
    put('app.json', json({ expo: { name: 'app', icon: './assets/images/app-icon.png', web: { favicon: './assets/images/fav.png' } } }))
    put('assets/images/app-icon.png', PNG)
    put('assets/images/fav.png', PNG)
    expect((await detectProjectIcon(root))?.path).toBe('assets/images/app-icon.png')
  })

  it('Expo app.config.json without the expo key, falling back to web.favicon', async () => {
    put('app.config.json', json({ icon: './missing.png', web: { favicon: './assets/fav.png' } }))
    put('assets/fav.png', PNG)
    expect((await detectProjectIcon(root))?.path).toBe('assets/fav.png')
  })

  it('a web app manifest: the largest square plain icon, root-relative paths served from public/', async () => {
    put('public/manifest.json', json({
      icons: [
        { src: '/icons/i-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/i-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/mask-1024.png', sizes: '1024x1024', type: 'image/png', purpose: 'maskable' }
      ]
    }))
    put('public/icons/i-192.png', PNG)
    put('public/icons/i-512.png', PNG)
    put('public/icons/mask-1024.png', PNG)
    expect((await detectProjectIcon(root))?.path).toBe('public/icons/i-512.png')
  })

  it('site.webmanifest at the root, an SVG first', async () => {
    put('site.webmanifest', json({ icons: [{ src: 'big.png', sizes: '512x512' }, { src: 'mark.svg', sizes: 'any', type: 'image/svg+xml' }] }))
    put('big.png', PNG)
    put('mark.svg', SVG)
    expect((await detectProjectIcon(root))?.path).toBe('mark.svg')
  })

  it('index.html <link rel="icon">, served from public/ (Vite)', async () => {
    put('index.html', '<!doctype html><html><head><link rel="apple-touch-icon" href="/touch.png"><link rel=icon type="image/webp" href="/brand/fav.webp?v=2" /></head></html>')
    put('public/brand/fav.webp', WEBP)
    put('public/touch.png', PNG)
    expect((await detectProjectIcon(root))?.path).toBe('public/brand/fav.webp')
  })

  it('public/index.html with %PUBLIC_URL% (Create React App), and an SVG beside a declared raster icon', async () => {
    put('public/index.html', '<link rel="shortcut icon" href="%PUBLIC_URL%/favicon-32.ico">')
    put('public/favicon-32.ico', Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(16)]))
    expect((await detectProjectIcon(root))?.path).toBe('public/favicon-32.ico')
    put('public/favicon-32.svg', SVG)
    expect((await detectProjectIcon(root))?.path).toBe('public/favicon-32.svg')
  })

  it("electron-builder's build.icon in package.json, without an extension", async () => {
    put('package.json', json({ name: 'app', build: { icon: 'art/app' } }))
    put('art/app.png', PNG)
    expect((await detectProjectIcon(root))?.path).toBe('art/app.png')
  })

  it("Tauri's bundle.icon[]: the largest PNG, never the .icns", async () => {
    put('src-tauri/tauri.conf.json', json({ bundle: { icon: ['icons/32x32.png', 'icons/128x128@2x.png', 'icons/icon.icns'] } }))
    put('src-tauri/icons/32x32.png', PNG)
    put('src-tauri/icons/128x128@2x.png', PNG)
    expect((await detectProjectIcon(root))?.path).toBe('src-tauri/icons/128x128@2x.png')
  })

  it('Flutter web icons and Expo default paths', async () => {
    put('web/icons/Icon-192.png', PNG)
    expect((await detectProjectIcon(root))?.path).toBe('web/icons/Icon-192.png')
    rmSync(join(root, 'web'), { recursive: true })
    put('assets/adaptive-icon.png', PNG)
    expect((await detectProjectIcon(root))?.path).toBe('assets/adaptive-icon.png')
  })

  it("a monorepo's web app (workspaces), as in smiletrack: web/index.html names /favicon.webp, web/public has favicon.svg", async () => {
    put('package.json', json({ name: 'mono', workspaces: ['api', 'web', 'packages/*'] }))
    put('api/package.json', json({ name: 'api' }))
    put('web/index.html', '<link rel="icon" type="image/webp" href="/favicon.webp" />')
    put('web/public/favicon.webp', WEBP)
    put('web/public/favicon.svg', SVG)
    expect((await detectProjectIcon(root))?.path).toBe('web/public/favicon.svg')
  })

  it("a monorepo app folder's own public favicon when nothing declares it", async () => {
    put('frontend/public/favicon.png', PNG)
    expect((await detectProjectIcon(root))?.path).toBe('frontend/public/favicon.png')
  })

  it('declared icons come after a root logo and before the generic places', async () => {
    put('favicon.ico', Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(16)]))
    put('app.json', json({ expo: { icon: './assets/brand.png' } }))
    put('assets/brand.png', PNG)
    expect((await detectProjectIcon(root))?.path).toBe('assets/brand.png')
    put('acme_logo_icon.svg', SVG)
    expect((await detectProjectIcon(root))?.path).toBe('acme_logo_icon.svg')
  })

  it('never follows a declared path out of the project, by .. or by a link', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mousse-icon-manifest-outside-'))
    try {
      writeFileSync(join(outside, 'icon.png'), PNG)
      symlinkSync(outside, join(root, 'linked'), 'junction')
      put('app.json', json({ expo: { icon: '../icon.png', web: { favicon: './linked/icon.png' } } }))
      put('index.html', `<link rel="icon" href="file://${outside}/icon.png"><link rel="icon" href="https://example.com/x.png">`)
      expect(await detectProjectIcon(root)).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('shrugs off a manifest that is not JSON or too large', async () => {
    put('app.json', '{ not json')
    put('public/manifest.json', `{"icons":[{"src":"/a.png"}],"pad":"${'x'.repeat(300 * 1024)}"}`)
    put('public/a.png', PNG)
    put('assets/icon.png', PNG)
    expect((await detectProjectIcon(root))?.path).toBe('assets/icon.png')
  })
})

describe('manifest parsing', () => {
  it('reads sizes from a manifest value or a file name', () => {
    expect(iconSize('48x48 192x192')).toBe(192)
    expect(iconSize('icons/128x128@2x.png')).toBe(256)
    expect(iconSize('any')).toBe(0)
  })

  it('keeps every path inside the project', () => {
    expect(insideProject('web', './public/a.png')).toBe('web/public/a.png')
    expect(insideProject('web', '../../a.png')).toBeNull()
    expect(insideProject('', '/a.png')).toBe('a.png')
  })

  it('skips URLs, data URLs and templates in links and manifests', () => {
    expect(htmlIconLinks('<link rel="icon" href="data:image/png;base64,AA"><link rel="icon" href="{{ icon }}">', '', '')).toEqual([])
    expect(webManifestIcons({ icons: [{ src: 'https://cdn/x.png' }] }, '', '')).toEqual([])
    expect(tauriIcons({ tauri: { bundle: { icon: ['icons/icon.ico', 'icons/icon.icns'] } } }, 'src-tauri')).toEqual(['src-tauri/icons/icon.ico'])
  })

  it('takes app folders from literal workspaces and usual names, at most four', () => {
    expect(appFolders({ workspaces: ['api', 'web', 'packages/*'] }, new Set(['api', 'web', 'client']))).toEqual(['api', 'web', 'client'])
    expect(appFolders({ workspaces: { packages: ['a', 'b', 'c', 'd', 'e'] } }, new Set())).toEqual(['a', 'b', 'c', 'd'])
    expect(appFolders({ workspaces: ['../outside'] }, new Set())).toEqual([])
  })
})

describe('detector version', () => {
  const project = (fields: Partial<Project> = {}): Project => ({ id: 'p1', name: 'p', path: root, createdAt: '', order: 0, ...fields })

  it('looks again at once when "none found" came from older rules, instead of waiting out the 6 hours', async () => {
    put('app.json', json({ expo: { icon: './assets/brand.png' } }))
    put('assets/brand.png', PNG)
    const calls: Array<string | null> = []
    const recorder = { recordDetectedIcon: (_id: string, path: string | null) => { calls.push(path) } }
    const checkedNow = new Date().toISOString()
    // Older rules found nothing a minute ago: no detector version recorded.
    expect(await projectIconFor(project({ iconDetectedAt: checkedNow }), recorder)).toMatchObject({ path: 'assets/brand.png' })
    expect(calls).toEqual(['assets/brand.png'])
    // The same result recorded by the current rules is trusted.
    expect(await projectIconFor(project({ iconDetectedAt: checkedNow, iconDetector: PROJECT_ICON_DETECTOR_VERSION }), recorder)).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('ProjectManager records the rules version with what it found', () => {
    const home = join(root, 'home')
    mkdirSync(home)
    mkdirSync(join(root, 'repo'))
    const manager = new ProjectManager(home)
    const { id } = manager.openProject(join(root, 'repo'))
    manager.recordDetectedIcon(id, null)
    const saved = (JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')) as Project[])[0]!
    expect(saved.iconDetector).toBe(PROJECT_ICON_DETECTOR_VERSION)
    expect(saved.detectedIconPath).toBeUndefined()
  })
})
