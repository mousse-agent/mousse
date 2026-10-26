// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import DOMPurify from 'dompurify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MERMAID_SOURCE_LIMIT,
  peekDiagram,
  renderDiagram,
  resetDiagramCache,
  sanitizeDiagramSvg,
} from '../src/renderer/chat/components/agent-elements/mermaid-diagram'
import { mermaidRenderer } from '../src/renderer/chat/components/agent-elements/markdown-mermaid'

const HOSTILE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 40 40" onload="steal()">',
  '<a href="https://evil.example" xlink:href="https://evil.example"><text onclick="steal()">link</text></a>',
  '<image href="https://evil.example/pixel.png" xlink:href="https://evil.example/pixel.png"/>',
  '<foreignObject><div>html</div></foreignObject>',
  '<script>steal()</script>',
  '<style>text { fill: red }</style>',
  '<use xlink:href="#shape" href="#shape"/>',
  '<rect width="10" height="10" style="fill:red" onclick="steal()"/>',
  '</svg>',
].join('')

afterEach(() => {
  resetDiagramCache()
  vi.doUnmock('pele/lazy')
  vi.resetModules()
})

describe('diagram SVG sanitizing', () => {
  const clean = sanitizeDiagramSvg(HOSTILE_SVG, DOMPurify)

  it.each([
    ['links', /<a[\s>]/i],
    ['images', /<image/i],
    ['foreignObject', /foreignObject/i],
    ['scripts', /<script/i],
    ['style elements', /<style/i],
    ['event handlers', /\bon[a-z]+=/i],
    ['xlink:href', /xlink:href/i],
    ['href', /href=/i],
    ['external URLs', /evil\.example/],
  ])('strips %s', (_name, pattern) => {
    expect(clean).not.toMatch(pattern)
  })

  it('keeps the drawing itself, including inline style and its text', () => {
    expect(clean).toContain('<rect')
    expect(clean).toContain('style="fill:red"')
    expect(clean).toContain('link')
  })

  it('refuses to pass SVG through when there is no DOM to sanitize with', () => {
    const unsupported = { isSupported: false, sanitize: (dirty: unknown) => String(dirty) }
    expect(() => sanitizeDiagramSvg(HOSTILE_SVG, unsupported)).toThrow(/sanitizer/)
  })

  it('rejects output that sanitizes down to nothing', () => {
    expect(() => sanitizeDiagramSvg('<script>steal()</script>', DOMPurify)).toThrow(/empty/)
  })
})

describe('drawing diagrams', () => {
  it('draws a flowchart as sanitized SVG', async () => {
    const outcome = await renderDiagram('flowchart LR\n  A[Plan] --> B[Ship]')
    expect(outcome.status).toBe('ready')
    if (outcome.status !== 'ready') return
    expect(outcome.svg).toContain('<svg')
    expect(outcome.svg).toContain('Plan')
    expect(outcome.svg).not.toMatch(/<a[\s>]|<script|<foreignObject|href=/i)
  })

  it('leaves click links out of the drawing', async () => {
    const outcome = await renderDiagram(
      'flowchart LR\n  A[Docs] --> B[Home]\n  click A "https://evil.example" "open"',
    )
    expect(outcome.status).toBe('ready')
    if (outcome.status !== 'ready') return
    expect(outcome.svg).not.toMatch(/<a[\s>]|href=|evil\.example/i)
  })

  it('reports a syntax error with the renderer message', async () => {
    const outcome = await renderDiagram('flowchart LR\n  A -->')
    expect(outcome.status).toBe('error')
    if (outcome.status !== 'error') return
    expect(outcome.message).toMatch(/parse error/i)
  })

  it('reports source that is not a diagram', async () => {
    const outcome = await renderDiagram('this is not a diagram')
    expect(outcome).toMatchObject({ status: 'error' })
  })

  it('rejects oversized source without loading the renderer', async () => {
    const outcome = await renderDiagram(`flowchart LR\n${'  A --> B\n'.repeat(MERMAID_SOURCE_LIMIT / 8)}`)
    expect(outcome).toEqual({
      status: 'error',
      message: `Diagram source is longer than the limit of ${MERMAID_SOURCE_LIMIT} characters.`,
    })
  })

  it('draws a source once and serves repeats from memory', async () => {
    const source = 'flowchart LR\n  X --> Y'
    expect(peekDiagram(source)).toBeUndefined()
    const first = renderDiagram(source)
    expect(renderDiagram(source)).toBe(first)
    const outcome = await first
    expect(peekDiagram(source)).toBe(outcome)
  })

  it('reports a renderer that fails to load, and tries again on the next request', async () => {
    vi.resetModules()
    let loads = 0
    vi.doMock('pele/lazy', async (importOriginal) => {
      const real = await importOriginal<typeof import('pele/lazy')>()
      return {
        ...real,
        load: (type: Parameters<typeof real.load>[0]) =>
          loads++ === 0
            ? Promise.reject(new Error('Failed to fetch dynamically imported module'))
            : real.load(type),
      }
    })
    const fresh = await import('../src/renderer/chat/components/agent-elements/mermaid-diagram')
    const source = 'flowchart LR\n  A --> B'

    const failed = await fresh.renderDiagram(source)
    expect(failed).toMatchObject({ status: 'unavailable', message: expect.stringContaining('Failed to fetch') })
    expect(fresh.peekDiagram(source)).toBeUndefined()

    expect((await fresh.renderDiagram(source)).status).toBe('ready')
  })
})

describe('diagram block', () => {
  const Block = mermaidRenderer.component

  it('shows an unfinished fence as a plain code block and draws nothing', () => {
    const markup = renderToStaticMarkup(
      createElement(Block, { code: 'flowchart LR\n  A --> B', isIncomplete: true, language: 'mermaid' }),
    )
    expect(markup).toContain('data-mermaid-state="streaming"')
    expect(markup).toContain('data-streamdown="code-block"')
    expect(markup).toContain('flowchart LR')
    expect(markup).not.toContain('<svg')
    expect(markup).not.toContain('Show code')
  })

  it('registers for the mermaid fence language only', () => {
    expect(mermaidRenderer.language).toBe('mermaid')
  })
})
