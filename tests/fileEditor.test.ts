import { describe, expect, it } from 'vitest'
import { isBinaryContent, languageForPath } from '../src/renderer/utils/fileEditor'

describe('file editor helpers', () => {
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
