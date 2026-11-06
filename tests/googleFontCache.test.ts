import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GoogleFontCache, type FetchLike } from '../src/main/fonts/googleFontCache'

const roots: string[] = []

function root(): string {
  const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'mousse-fonts-')))
  roots.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const CSS = `
/* latin-ext */
@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/jbm/ext.woff2) format('woff2'); unicode-range: U+0100-02BA; }
/* latin */
@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/jbm/latin.woff2) format('woff2'); unicode-range: U+0000-00FF; }
/* latin-ext */
@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 700; src: url(https://fonts.gstatic.com/s/jbm/ext.woff2) format('woff2'); unicode-range: U+0100-02BA; }
/* latin */
@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 700; src: url(https://fonts.gstatic.com/s/jbm/latin.woff2) format('woff2'); unicode-range: U+0000-00FF; }
`

function fakeGoogle(options: { failFile?: string; cssStatus?: number } = {}) {
  const requests: string[] = []
  const fetch: FetchLike = async (url) => {
    requests.push(url)
    if (url.startsWith('https://fonts.googleapis.com/')) {
      const status = options.cssStatus ?? 200
      return { ok: status === 200, status, text: async () => CSS, arrayBuffer: async () => new ArrayBuffer(0) }
    }
    const fail = options.failFile !== undefined && url.endsWith(options.failFile)
    const bytes = new TextEncoder().encode(`font:${url}`)
    return { ok: !fail, status: fail ? 500 : 200, text: async () => '', arrayBuffer: async () => bytes.buffer as ArrayBuffer }
  }
  return { fetch, requests }
}

describe('Google font cache', () => {
  it('does not reach Google unless asked to download', async () => {
    const google = fakeGoogle()
    const cache = new GoogleFontCache({ root: root(), fetch: google.fetch })
    await expect(cache.load('JetBrains Mono', 'code', false)).resolves.toBeNull()
    expect(google.requests).toEqual([])
  })

  it('downloads the weights the role uses once, then serves them from disk', async () => {
    const directory = root()
    const google = fakeGoogle()
    const font = await new GoogleFontCache({ root: directory, fetch: google.fetch }).load('JetBrains Mono', 'code', true)
    expect(google.requests[0]).toBe('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap')
    // Each file is fetched once even though both weights list it.
    expect(google.requests.slice(1).sort()).toEqual(['https://fonts.gstatic.com/s/jbm/ext.woff2', 'https://fonts.gstatic.com/s/jbm/latin.woff2'])
    expect(font?.family).toBe('JetBrains Mono')
    expect(font?.faces.map((face) => [face.weight, face.unicodeRange])).toEqual([
      [400, 'U+0100-02BA'],
      [400, 'U+0000-00FF'],
      [700, 'U+0100-02BA'],
      [700, 'U+0000-00FF']
    ])
    expect(new TextDecoder().decode(font?.faces[1].data)).toBe('font:https://fonts.gstatic.com/s/jbm/latin.woff2')

    // A later start, offline: the cache alone answers.
    const offline = fakeGoogle()
    const cached = await new GoogleFontCache({ root: directory, fetch: offline.fetch }).load('jetbrains mono', 'code', false)
    expect(offline.requests).toEqual([])
    expect(cached?.faces).toHaveLength(4)
    expect(readdirSync(join(directory, 'jetbrains-mono'))).toEqual(['400-700'])
  })

  it('shares one download between concurrent requests', async () => {
    const google = fakeGoogle()
    const cache = new GoogleFontCache({ root: root(), fetch: google.fetch })
    const [a, b] = await Promise.all([cache.load('JetBrains Mono', 'code', true), cache.load('JetBrains Mono', 'code', true)])
    expect(a?.faces).toHaveLength(4)
    expect(b?.faces).toHaveLength(4)
    expect(google.requests.filter((url) => url.includes('googleapis'))).toHaveLength(1)
  })

  it('leaves nothing cached when a file fails to download', async () => {
    const directory = root()
    const cache = new GoogleFontCache({ root: directory, fetch: fakeGoogle({ failFile: 'latin.woff2' }).fetch })
    await expect(cache.load('JetBrains Mono', 'code', true)).rejects.toThrow(/HTTP 500/)
    expect(readdirSync(join(directory, 'jetbrains-mono'))).toEqual([])
    await expect(cache.load('JetBrains Mono', 'code', false)).resolves.toBeNull()
  })

  it('reports a refused stylesheet and families outside the catalog', async () => {
    const directory = root()
    const cache = new GoogleFontCache({ root: directory, fetch: fakeGoogle({ cssStatus: 400 }).fetch })
    await expect(cache.load('JetBrains Mono', 'code', true)).rejects.toThrow(/HTTP 400/)
    await expect(cache.load('Not A Real Family', 'code', true)).rejects.toThrow(/not in the Google Fonts list/)
    expect(existsSync(join(directory, 'not-a-real-family'))).toBe(false)
  })
})
