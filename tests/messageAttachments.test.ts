import { describe, expect, it } from 'vitest'
import {
  browserElementLabel,
  formatBrowserElementBlock,
  parseUserMessageContent
} from '../src/renderer/utils/messageAttachments'

describe('formatBrowserElementBlock / parseUserMessageContent', () => {
  it('serializes and parses a selected browser element into structured data', () => {
    const block = formatBrowserElementBlock({
      url: 'http://localhost:5173/',
      selector: 'button.submit',
      tagName: 'button',
      role: 'button',
      ariaLabel: 'Save changes',
      text: 'Save',
      outerHTML: '<button class="submit">Save</button>'
    })

    const content = `Please click this\n\n${block}`
    const parsed = parseUserMessageContent(content)

    expect(parsed.text).toBe('Please click this')
    expect(parsed.browserElements).toHaveLength(1)
    expect(parsed.browserElements[0]).toMatchObject({
      url: 'http://localhost:5173/',
      selector: 'button.submit',
      tagName: 'button',
      role: 'button',
      ariaLabel: 'Save changes',
      text: 'Save',
      outerHTML: '<button class="submit">Save</button>'
    })
  })

  it('parses multiple elements and strips them from visible text', () => {
    const a = formatBrowserElementBlock({
      url: 'http://localhost:5173/',
      selector: '#email',
      tagName: 'input',
      text: ''
    })
    const b = formatBrowserElementBlock({
      url: 'http://localhost:5173/login',
      selector: 'form button',
      tagName: 'button',
      text: 'Log in'
    })

    const parsed = parseUserMessageContent(`${a}\n\n${b}`)
    expect(parsed.text).toBe('')
    expect(parsed.browserElements.map((el) => el.tagName)).toEqual(['input', 'button'])
  })

  it('still parses legacy blocks without a closing marker', () => {
    const legacy = [
      '[Selected browser element]',
      'URL: http://localhost:5173/',
      'Selector: .hero h1',
      'Element: <h1>',
      'Text: Welcome'
    ].join('\n')

    const parsed = parseUserMessageContent(`Look here\n\n${legacy}`)
    expect(parsed.text).toBe('Look here')
    expect(parsed.browserElements).toEqual([
      {
        url: 'http://localhost:5173/',
        selector: '.hero h1',
        tagName: 'h1',
        text: 'Welcome'
      }
    ])
  })

  it('keeps attached-files parsing working alongside elements', () => {
    const block = formatBrowserElementBlock({
      url: 'https://example.com',
      selector: 'a.link',
      tagName: 'a',
      text: 'Docs'
    })
    const content = `Review\n\n[Attached files: notes.md, shot.png]\n\n${block}`
    const parsed = parseUserMessageContent(content)
    expect(parsed.text).toBe('Review')
    expect(parsed.attachedFiles).toEqual(['notes.md', 'shot.png'])
    expect(parsed.browserElements).toHaveLength(1)
  })
})

describe('browserElementLabel', () => {
  it('prefers text, then aria label, then tag', () => {
    expect(browserElementLabel({ tagName: 'button', text: 'Save', ariaLabel: 'Save form' })).toBe('Save')
    expect(browserElementLabel({ tagName: 'button', text: '', ariaLabel: 'Save form' })).toBe('Save form')
    expect(browserElementLabel({ tagName: 'div' })).toBe('<div>')
  })
})
