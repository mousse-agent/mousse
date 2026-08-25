import { describe, expect, it } from 'vitest'
import { isAssetView, isBinaryContent, languageForPath, viewKindForPath } from '../src/renderer/utils/fileEditor'

describe('file editor helpers', () => {
  it('classifies rich preview formats', () => {
    expect(viewKindForPath('docs/readme.md')).toBe('markdown')
    expect(viewKindForPath('site/index.HTML')).toBe('html')
    expect(viewKindForPath('manual.pdf')).toBe('pdf')
    expect(viewKindForPath('assets/photo.webp')).toBe('image')
    expect(viewKindForPath('demo.webm')).toBe('video')
    expect(viewKindForPath('src/main.ts')).toBe('text')
    expect(isAssetView(viewKindForPath('manual.pdf'))).toBe(true)
    expect(isAssetView(viewKindForPath('readme.md'))).toBe(false)
  })

  it('detects Monaco languages from paths case-insensitively', () => {
    expect(languageForPath('src/view.tsx')).toBe('typescript')
    expect(languageForPath('styles/APP.CSS')).toBe('css')
    expect(languageForPath('Dockerfile')).toBe('dockerfile')
    expect(languageForPath('unknown.custom')).toBe('plaintext')
  })

  it('recognizes binary content without rejecting ordinary unicode text', () => {
    expect(isBinaryContent('hello\0world')).toBe(true)
    expect(isBinaryContent('Hello, 世界')).toBe(false)
  })
})
