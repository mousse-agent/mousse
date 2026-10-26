import { describe, expect, it } from 'vitest'
import { mathFenceToDisplay, normalizeMathDelimiters } from '../src/renderer/utils/markdownMath'

describe('normalizeMathDelimiters', () => {
  it('turns single-dollar math into inline $$ math', () => {
    expect(normalizeMathDelimiters('Euler: $e^{i\\pi} + 1 = 0$.')).toBe('Euler: $$e^{i\\pi} + 1 = 0$$.')
  })

  it('leaves prices and ranges as text', () => {
    for (const text of ['It costs $5 and $10.', 'Budget $5-$10 per seat', 'Pay $20, not $ 30$']) {
      expect(normalizeMathDelimiters(text)).toBe(text)
    }
  })

  it('leaves escaped dollars and existing $$ math alone', () => {
    expect(normalizeMathDelimiters('\\$x\\$ and $$y$$')).toBe('\\$x\\$ and $$y$$')
  })

  it('converts \\( \\) and \\[ \\] delimiters', () => {
    expect(normalizeMathDelimiters('Area \\(\\pi r^2\\) here')).toBe('Area $$\\pi r^2$$ here')
    expect(normalizeMathDelimiters('Sum:\n\\[\n\\sum_{i=1}^n i\n\\]\nDone')).toBe(
      'Sum:\n\n$$\n\\sum_{i=1}^n i\n$$\n\nDone',
    )
  })

  it('does not touch inline code', () => {
    const text = 'Run `echo $HOME $PATH` and `\\(x\\)` then $a$'
    expect(normalizeMathDelimiters(text)).toBe('Run `echo $HOME $PATH` and `\\(x\\)` then $$a$$')
  })
})

describe('mathFenceToDisplay', () => {
  it('converts ```math fences to display blocks', () => {
    expect(mathFenceToDisplay('```math\nx^2\n```')).toBe('$$\nx^2\n$$')
  })

  it('ignores other fences', () => {
    expect(mathFenceToDisplay('```ts\nconst a = 1\n```')).toBeNull()
  })
})
