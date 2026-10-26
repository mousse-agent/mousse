// @vitest-environment jsdom
import type { ClipboardEvent } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { copyMathAsTex } from '../src/renderer/markdown/math/copyMathAsTex'

const INLINE =
  '<span class="an-math" data-math-tex="E=mc^2" data-math-source="\\(E=mc^2\\)">' +
  '<span class="katex"><span class="katex-mathml">E=mc2</span><span class="katex-html">E = mc²</span></span></span>'
const BLOCK =
  '<div class="an-math" data-math-tex="\\sum_i x_i" data-math-source="$$\n\\sum_i x_i\n$$">' +
  '<span class="katex-display">∑ xᵢ</span></div>'

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.className = 'an-markdown'
  root.innerHTML = html
  document.body.append(root)
  return root
}

function select(start: Node, startOffset: number, end: Node, endOffset: number): void {
  const range = document.createRange()
  range.setStart(start, startOffset)
  range.setEnd(end, endOffset)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

function copy(root: HTMLElement): { data: Record<string, string>; prevented: boolean } {
  const data: Record<string, string> = {}
  let prevented = false
  const event = {
    currentTarget: root,
    clipboardData: { setData: (type: string, value: string) => { data[type] = value } },
    preventDefault: () => { prevented = true }
  } as unknown as ClipboardEvent<HTMLElement>
  copyMathAsTex(event)
  return { data, prevented }
}

afterEach(() => {
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
})

describe('copying math', () => {
  it('copies the TeX of a selection inside one formula', () => {
    const root = mount(`<p>Energy ${INLINE} here.</p>`)
    const html = root.querySelector('.katex-html')!.firstChild!
    select(html, 0, html, 3)
    const { data, prevented } = copy(root)
    expect(prevented).toBe(true)
    expect(data['text/plain']).toBe('E=mc^2')
  })

  it('copies formulas as written when the selection covers text too', () => {
    const root = mount(`<p>Energy ${INLINE} and more.</p>${BLOCK}<p>After.</p>`)
    const first = root.querySelector('p')!.firstChild!
    const last = root.querySelectorAll('p')[1].firstChild!
    select(first, 0, last, 6)
    const { data, prevented } = copy(root)
    expect(prevented).toBe(true)
    const text = data['text/plain']
    expect(text).toContain('Energy \\(E=mc^2\\) and more.')
    expect(text).toContain('$$\n\\sum_i x_i\n$$')
    expect(text).toContain('After.')
    expect(text).not.toContain('E=mc2')
    expect(text).not.toContain('∑')
    expect(data['text/html']).toContain('\\(E=mc^2\\)')
    expect(data['text/html']).not.toContain('katex')
  })

  it('copies a formula whole when the selection starts inside it', () => {
    const root = mount(`<p>Energy ${INLINE} and more.</p>`)
    const inside = root.querySelector('.katex-html')!.firstChild!
    const after = root.querySelector('p')!.lastChild!
    select(inside, 2, after, 4)
    const { data } = copy(root)
    expect(data['text/plain']).toBe('\\(E=mc^2\\) and')
  })

  it('leaves a selection without formulas to the browser', () => {
    const root = mount(`<p>Plain text.</p>${BLOCK}`)
    const text = root.querySelector('p')!.firstChild!
    select(text, 0, text, 5)
    const { data, prevented } = copy(root)
    expect(prevented).toBe(false)
    expect(data).toEqual({})
  })

  it('ignores selections outside the Markdown', () => {
    const root = mount(`<p>Energy ${INLINE}</p>`)
    const outside = document.createElement('p')
    outside.textContent = 'elsewhere'
    document.body.append(outside)
    select(outside.firstChild!, 0, outside.firstChild!, 4)
    expect(copy(root).prevented).toBe(false)
  })
})
