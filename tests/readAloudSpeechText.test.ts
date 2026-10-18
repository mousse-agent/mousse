import { describe, expect, it } from 'vitest'
import { CODE_BLOCK_PLACEHOLDER, markdownToSpeechText } from '../src/renderer/readAloud/speechText'

describe('markdownToSpeechText', () => {
  it('keeps plain prose and collapses whitespace', () => {
    expect(markdownToSpeechText('Hello   there.\nSecond line.\n\n\nNew paragraph.')).toBe('Hello there. Second line.\n\nNew paragraph.')
  })

  it('replaces fenced code blocks with a placeholder', () => {
    const text = markdownToSpeechText('Run this:\n\n```ts\nconst a = 1\n\nconsole.log(a)\n```\n\nThen done.')
    expect(text).toBe(`Run this:\n\n${CODE_BLOCK_PLACEHOLDER}\n\nThen done.`)
    expect(text).not.toContain('console')
  })

  it('treats an unclosed fence as code to the end and honors tilde fences', () => {
    expect(markdownToSpeechText('Before\n```\nnever closed\nmore')).toBe(`Before\n\n${CODE_BLOCK_PLACEHOLDER}`)
    expect(markdownToSpeechText('~~~\n```\ninner\n```\n~~~\nAfter')).toBe(`${CODE_BLOCK_PLACEHOLDER}\n\nAfter`)
  })

  it('drops images and keeps link text without the URL', () => {
    expect(markdownToSpeechText('See ![diagram](a.png) the [docs](https://example.com/x) now.')).toBe('See the docs now.')
    expect(markdownToSpeechText('Visit https://example.com/page today')).toBe('Visit link today')
  })

  it('strips inline code, emphasis and strikethrough markers', () => {
    expect(markdownToSpeechText('Use `npm test` and **bold** with *italic* and ~~gone~~ plus _under_ text.')).toBe(
      'Use npm test and bold with italic and gone plus under text.'
    )
    expect(markdownToSpeechText('Keep snake_case_name and 2*3*4 intact.')).toBe('Keep snake_case_name and 2*3*4 intact.')
  })

  it('removes heading, quote and list markers and ends items as sentences', () => {
    const text = markdownToSpeechText('# Title\n\n> quoted line\n\n- first\n- [x] second item.\n1. numbered')
    expect(text).toBe('Title.\n\nquoted line\n\nfirst.\n\nsecond item.\n\nnumbered.')
  })

  it('flattens tables and drops dividers and rules', () => {
    const text = markdownToSpeechText('| Name | Size |\n| --- | :---: |\n| a | 1 |\n\n---\n\nEnd')
    expect(text).toBe('Name, Size.\n\na, 1.\n\nEnd')
  })

  it('removes HTML tags and decodes common entities', () => {
    expect(markdownToSpeechText('<div>Fish &amp; chips</div><br/>Done')).toBe('Fish & chips Done')
  })

  it('returns an empty string when nothing is speakable', () => {
    expect(markdownToSpeechText('')).toBe('')
    expect(markdownToSpeechText('   \n\n')).toBe('')
    expect(markdownToSpeechText('![only](image.png)')).toBe('')
    expect(markdownToSpeechText('---')).toBe('')
  })
})
