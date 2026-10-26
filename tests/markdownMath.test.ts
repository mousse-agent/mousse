import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { remarkMousseMath } from '../src/renderer/markdown/math/remark-mousse-math'
import {
  hideUnclosedMathFence,
  mayContainMath,
  parseBlocksKeepingMath
} from '../src/renderer/markdown/math/math-detect'

type Node = {
  type: string
  value?: string
  url?: string
  children?: Node[]
  position?: { start: { offset: number }; end: { offset: number } }
  data?: { hProperties?: { className?: string[] }; hChildren?: Array<{ properties?: { metastring?: string } }> }
}

const withMath = unified().use(remarkParse).use(remarkGfm).use(remarkMousseMath)
const withoutMath = unified().use(remarkParse).use(remarkGfm)

function parse(markdown: string, processor: typeof withMath = withMath): Node {
  return processor.runSync(processor.parse(markdown), markdown) as unknown as Node
}

function walk(node: Node, found: Node[] = []): Node[] {
  found.push(node)
  for (const child of node.children ?? []) walk(child, found)
  return found
}

function mathNodes(markdown: string): Node[] {
  return walk(parse(markdown)).filter((node) => node.type === 'math' || node.type === 'inlineMath')
}

/** `[type:value]` for each math node, in document order. */
function summary(markdown: string): string[] {
  return mathNodes(markdown).map((node) => `${node.type}:${node.value}`)
}

function textOf(node: Node): string {
  return node.value ?? (node.children ?? []).map(textOf).join('')
}

describe('math delimiters', () => {
  it.each([
    ['$x$', ['inlineMath:x']],
    ['\\(x\\)', ['inlineMath:x']],
    ['$5$', ['inlineMath:5']],
    ['$x_i$', ['inlineMath:x_i']],
    ['$a\\$b$', ['inlineMath:a\\$b']],
    ['Area is $\\pi r^2$ here', ['inlineMath:\\pi r^2']],
    ['Area is \\(\\pi r^2\\) here', ['inlineMath:\\pi r^2']],
    ['Wrapped \\(a +\nb\\) formula', ['inlineMath:a +\nb']],
    ['Display $$x$$ in a line', ['inlineMath:x']],
    ['Display \\[x\\] in a line', ['inlineMath:x']],
    ['Padded $$ x $$ in a line', ['inlineMath:x']]
  ])('inline: %j', (markdown, expected) => {
    expect(summary(markdown)).toEqual(expected)
  })

  it('styles $$…$$ and \\[…\\] inside a line as display, the others as inline', () => {
    const classes = (markdown: string) => mathNodes(markdown)[0].data?.hProperties?.className
    expect(classes('a $x$ b')).toEqual(['language-math', 'math-inline', 'language-math-delim-dollar'])
    expect(classes('a \\(x\\) b')).toEqual(['language-math', 'math-inline', 'language-math-delim-paren'])
    expect(classes('a $$x$$ b')).toEqual([
      'language-math',
      'math-display',
      'language-math-display',
      'language-math-delim-dollars'
    ])
    expect(classes('a \\[x\\] b')).toEqual([
      'language-math',
      'math-display',
      'language-math-display',
      'language-math-delim-bracket'
    ])
  })

  it.each([
    ['$$\nx\n$$', 'math:x'],
    ['\\[\nx\n\\]', 'math:x'],
    ['$$ 1+1 $$', 'math:1+1'],
    ['\\[ 1+1 \\]', 'math:1+1'],
    ['$$x$$', 'math:x'],
    ['\\[x\\]', 'math:x'],
    ['$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$', 'math:\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}'],
    ['$$\n- y\n# z\n$$', 'math:- y\n# z'],
    ['$$\na\n---\nb\n$$', 'math:a\n---\nb'],
    ['\\[\na\n=\nb\n\\]', 'math:a\n=\nb'],
    ['$$\nx\n\ny\n$$', 'math:x\n\ny'],
    ['$$\nx = 1 \\\\\ny = 2 $$', 'math:x = 1 \\\\\ny = 2']
  ])('own-line block: %j', (markdown, expected) => {
    const tree = parse(markdown)
    expect(tree.children?.map((node) => node.type)).toEqual(['math'])
    expect(summary(markdown)).toEqual([expected])
  })

  it('does not read \\[ … = … \\] as a setext heading', () => {
    const tree = parse('\\[\na\n=\nb\n\\]')
    expect(walk(tree).some((node) => node.type === 'heading')).toBe(false)
  })

  it('tags blocks with the delimiters used', () => {
    const meta = (markdown: string) => mathNodes(markdown)[0].data?.hChildren?.[0].properties?.metastring
    expect(meta('$$\nx\n$$')).toBe('dollars')
    expect(meta('\\[\nx\n\\]')).toBe('bracket')
  })

  it('keeps an inline $$a$$ and a later block apart', () => {
    const tree = parse('Text $$a$$ then\n\n$$\nb\n$$')
    expect(tree.children?.map((node) => node.type)).toEqual(['paragraph', 'math'])
    expect(summary('Text $$a$$ then\n\n$$\nb\n$$')).toEqual(['inlineMath:a', 'math:b'])
  })

  it('works inside blockquotes and list items', () => {
    expect(summary('> $$ x $$')).toEqual(['math:x'])
    expect(summary('> $$\n> x\n> $$')).toEqual(['math:x'])
    expect(summary('> note \\(y\\)')).toEqual(['inlineMath:y'])
    expect(summary('- item\n\n  $$\n  x\n  $$\n')).toEqual(['math:x'])
  })

  it('needs text after an opening fence to close on the same line', () => {
    expect(summary('$$ is the PID in bash.\n\nlater\n\n$$\nx\n$$')).toEqual(['math:x'])
    expect(summary('\\[ see below\n\nmore\n\\[\nx\n\\]')).toEqual(['math:x'])
  })

  it('still reads a multi-line formula that opens on a text line as inline display math', () => {
    expect(summary('$$ a +\nb $$')).toEqual(['inlineMath:a +\nb'])
  })

  it('lets a block interrupt a paragraph', () => {
    const tree = parse('para\n$$\nx\n$$\nafter')
    expect(tree.children?.map((node) => node.type)).toEqual(['paragraph', 'math', 'paragraph'])
  })
})

describe('prose that must stay text', () => {
  it.each([
    'It costs $5 and $10.',
    'Budget $5-$10 per seat, or $20,000-$30,000 a year.',
    'Plans are $5/$10 monthly.',
    'Run $browser then $deploy on it.',
    'Set $HOME before running.',
    'Pay $ 5 or $ 6 today.',
    'As shown in \\[1\\] and \\[2, 3\\].',
    'Escaped \\$x\\$',
    'Escaped \\\\(x\\\\)',
    'Prices $5, $6 and $7$8.',
    'A lone $',
    'Two dollars $$ and nothing else'
  ])('%j has no math', (markdown) => {
    expect(summary(markdown)).toEqual([])
  })

  it('keeps the text of prices exactly', () => {
    expect(textOf(parse('It costs $5 and $10.'))).toBe('It costs $5 and $10.')
    expect(textOf(parse('Budget $5-$10 per seat, or $20,000-$30,000 a year.'))).toBe(
      'Budget $5-$10 per seat, or $20,000-$30,000 a year.'
    )
  })

  it('shows escaped delimiters as the characters they escape', () => {
    expect(textOf(parse('Escaped \\$x\\$'))).toBe('Escaped $x$')
    expect(textOf(parse('Escaped \\\\(x\\\\)'))).toBe('Escaped \\(x\\)')
    expect(textOf(parse('As shown in \\[1\\] and \\[2, 3\\].'))).toBe('As shown in [1] and [2, 3].')
  })

  it('finds math after an escaped dollar', () => {
    expect(summary('Pay \\$$x$ now.')).toEqual(['inlineMath:x'])
    expect(textOf(parse('Pay \\$$x$ now.'))).toBe('Pay $x now.')
  })

  it('leaves unfinished delimiters as text', () => {
    for (const markdown of ['$$\nx', '$$ x', '\\(x', '\\[\nx', '$x', '\\[x', '$$x$', '$x$$']) {
      expect(summary(markdown)).toEqual([])
    }
  })
})

describe('size limits', () => {
  it('leaves oversized formulas as text', () => {
    expect(summary(`\\(${'x'.repeat(6000)}\\)`)).toEqual([])
    expect(summary(`$$\n${'x\n'.repeat(11000)}$$`)).toEqual([])
    expect(summary(`\\(${'x'.repeat(4000)}\\)`)).toHaveLength(1)
  })
})

describe('syntax that math must not touch', () => {
  it('leaves code spans alone', () => {
    expect(summary('`$x$` and `$HOME` and `\\(x\\)`')).toEqual([])
    expect(summary('Use `$a` then `$b$`')).toEqual([])
  })

  it('does not close math on a delimiter inside a code span', () => {
    const tree = parse('\\(a `\\)` b')
    expect(walk(tree).some((node) => node.type === 'inlineCode' && node.value === '\\)')).toBe(true)
    expect(summary('\\(a `\\)` b')).toEqual([])
  })

  it('handles dollars next to code spans', () => {
    const tree = parse('$a`$HOME`')
    expect(walk(tree).some((node) => node.type === 'inlineCode' && node.value === '$HOME')).toBe(true)
    expect(summary('$a`$HOME`')).toEqual([])
  })

  it('leaves link destinations and autolinks alone', () => {
    for (const markdown of [
      '[users](https://x/y?$select=id)',
      '<https://x/y?$select=id>',
      '[docs](https://example.com/\\(a\\))'
    ]) {
      expect(summary(markdown)).toEqual([])
    }
    const link = walk(parse('[users](https://x/y?$select=id)')).find((node) => node.type === 'link')
    expect(link?.url).toBe('https://x/y?$select=id')
    const docs = walk(parse('[docs](https://example.com/\\(a\\))')).find((node) => node.type === 'link')
    expect(docs?.url).toBe('https://example.com/(a)')
  })

  it('keeps a www link whole and still finds math after it', () => {
    const tree = parse('www.example.com/?$select=id and $x$')
    const link = walk(tree).find((node) => node.type === 'link')
    expect(link?.url).toBe('http://www.example.com/?$select=id')
    expect(summary('www.example.com/?$select=id and $x$')).toEqual(['inlineMath:x'])
  })

  it('does not close a lone dollar across a URL', () => {
    expect(summary('see $x and https://a.example/?$b$ now')).toEqual([])
  })

  it('leaves fenced and indented code alone', () => {
    expect(summary('```\n$$\nx\n$$\n$y$\n```')).toEqual([])
    expect(summary('~~~\n\\[\nx\n\\]\n~~~')).toEqual([])
    expect(summary('    $$\n    x\n    $$')).toEqual([])
    expect(summary('```math\nx^2\n```')).toEqual([])
  })

  it('leaves HTML alone', () => {
    expect(summary('<span title="$x$">a</span>')).toEqual([])
    expect(summary('<div>\n$$\nx\n$$\n</div>')).toEqual([])
  })
})

describe('source offsets', () => {
  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r']
  ])('tags display style correctly with %s line endings', (_name, eol) => {
    const source = `😀 emoji ${eol}and $$x$$ then \\(y\\) and \\[z\\]${eol}${eol}$$${eol}b${eol}$$`
    const nodes = mathNodes(source)
    expect(nodes.map((node) => node.value)).toEqual(['x', 'y', 'z', 'b'])
    expect(nodes.map((node) => source.slice(node.position!.start.offset, node.position!.end.offset))).toEqual([
      '$$x$$',
      '\\(y\\)',
      '\\[z\\]',
      `$$${eol}b${eol}$$`
    ])
    expect(nodes.map((node) => node.data?.hProperties?.className?.includes('language-math-display'))).toEqual([
      true,
      false,
      true,
      undefined
    ])
    expect(nodes[3].data?.hChildren?.[0].properties?.metastring).toBe('dollars')
  })

  it('does not count the emoji as two columns of drift', () => {
    const source = '😀😀 $x$ and \\[y\\]'
    const [first, second] = mathNodes(source)
    expect(source.slice(first.position!.start.offset)).toMatch(/^\$x\$/)
    expect(second.data?.hProperties?.className).toContain('language-math-delim-bracket')
  })
})

describe('streaming prefixes', () => {
  const inline = 'Energy \\(E = mc^2\\) and $$\\sum_i x_i$$ done.'

  it('parses every prefix of a sentence and shows math only after its closer', () => {
    const firstEnd = inline.indexOf('\\)') + 2
    const secondEnd = inline.lastIndexOf('$$') + 2
    for (let length = 0; length <= inline.length; length++) {
      const prefix = inline.slice(0, length)
      let nodes: Node[] = []
      expect(() => {
        nodes = mathNodes(prefix)
      }, JSON.stringify(prefix)).not.toThrow()
      const expected = length < firstEnd ? 0 : length < secondEnd ? 1 : 2
      expect(nodes.length, JSON.stringify(prefix)).toBe(expected)
    }
  })

  it.each([
    'Intro\n\n$$\n\\sum_i x_i\n$$\n\nDone',
    'Intro\n\n\\[\n\\sum_i x_i\n\\]\n\nDone',
    'Intro\n$$ x = 1 $$\nDone',
    '> quote\n> $$\n> x\n> $$\n\nDone',
    '- item\n\n  $$\n  x\n  $$\n\nDone'
  ])('shows a block only once its closing fence is complete: %j', (source) => {
    const closer = source.includes('\\]') ? source.indexOf('\\]') + 2 : source.indexOf('$$', source.indexOf('$$') + 2) + 2
    for (let length = 0; length <= source.length; length++) {
      const prefix = source.slice(0, length)
      expect(() => mathNodes(prefix), JSON.stringify(prefix)).not.toThrow()
      const count = mathNodes(prefix).length
      expect(count, JSON.stringify(prefix)).toBe(length >= closer ? 1 : 0)
    }
  })

  it('treats a prefix that ends right after a backslash as text', () => {
    expect(summary('a \\(x\\')).toEqual([])
    expect(summary('a \\[x\\')).toEqual([])
    expect(summary('a $x\\')).toEqual([])
  })
})

describe('tables', () => {
  it('typesets math in a cell', () => {
    expect(summary('| a | b |\n|---|---|\n| $x$ | 2 |')).toEqual(['inlineMath:x'])
  })

  function cellCounts(markdown: string, processor: typeof withMath = withMath): number[] {
    return walk(parse(markdown, processor))
      .filter((node) => node.type === 'tableRow')
      .map((row) => row.children?.length ?? 0)
  }

  it('keeps a pipe inside math in its cell', () => {
    const table = '| a | b |\n|---|---|\n| $|x|$ | 2 |\n| \\(|y| + |z|\\) | 3 |'
    expect(cellCounts(table)).toEqual([2, 2, 2])
    expect(summary(table)).toEqual(['inlineMath:|x|', 'inlineMath:|y| + |z|'])
  })

  it('keeps a pipe inside math in a head cell', () => {
    const table = '| $|x|$ | b |\n|---|---|\n| 1 | 2 |'
    expect(cellCounts(table)).toEqual([2, 2])
    expect(summary(table)).toEqual(['inlineMath:|x|'])
  })

  it('still splits cells at pipes that are not inside math', () => {
    expect(cellCounts('| a | b | c |\n|---|---|---|\n| $5 | $10 | x |')).toEqual([3, 3])
    expect(cellCounts('| a | b |\n|---|---|\n| \\$x | y$ |')).toEqual([2, 2])
    expect(cellCounts('| a | b |\n|---|---|\n| \\(x | y |')).toEqual([2, 2])
    expect(cellCounts('| a | b |\n|---|---|\n| a\\|b | c |')).toEqual([2, 2])
  })

  it('does not let math in a cell reach into the next line', () => {
    const table = '| a | b |\n|---|---|\n| \\(x | y |\n| z\\) | w |'
    expect(cellCounts(table)).toEqual([2, 2, 2])
    expect(summary(table)).toEqual([])
  })

  it('parses every prefix of a streamed table with math', () => {
    const table = '| a | $|x|$ |\n|---|---|\n| \\(|y|\\) | $5 |'
    for (let end = 0; end <= table.length; end++) {
      expect(() => parse(table.slice(0, end))).not.toThrow()
    }
  })

  it('parses tables without math exactly as GFM does', () => {
    const tables = [
      '| a | b |\n|---|---|\n| 1 | 2 |',
      '| a | b |\n|---|\n| 1 | 2 |',
      'a | b\n:-- | --:\n1 | 2 | 3\n4',
      '| a |\n| - |\n> quote',
      'text\n| a |\n| - |\n| b |',
      '    | a |\n    | - |',
      '| `a|b` | c |\n|---|---|\n| d | e |',
      '- | a |\n  | - |\n  | b |'
    ]
    for (const table of tables) {
      expect(parse(table)).toEqual(parse(table, withoutMath))
    }
  })

  it('accepts an escaped pipe inside math', () => {
    expect(summary('| a | b |\n|---|---|\n| $\\|x\\|$ | 2 |')).toEqual(['inlineMath:\\|x\\|'])
  })
})

describe('without the plugin', () => {
  it('finds no math nodes and keeps the source as text', () => {
    const source = 'Inline $x$ and \\(y\\)\n\n$$\nz\n$$'
    expect(walk(parse(source, withoutMath)).some((node) => node.type.toLowerCase().includes('math'))).toBe(false)
  })
})

describe('mayContainMath', () => {
  it.each([
    ['Euler $e^{i\\pi}$', true],
    ['\\(x\\)', true],
    ['\\[x\\]', true],
    ['```math\nx\n```', true],
    ['  ~~~ math\nx\n~~~', true],
    ['> ```math\n> x', true],
    ['No special characters here.', false],
    ['```ts\nconst a = 1\n```', false],
    ['A \\ backslash and a [bracket]', false]
  ])('%j -> %s', (content, expected) => {
    expect(mayContainMath(content)).toBe(expected)
  })
})

describe('hideUnclosedMathFence', () => {
  it('relabels a trailing unfinished math fence so its source shows', () => {
    expect(hideUnclosedMathFence('Before\n\n```math\n\\frac{1}{2')).toBe('Before\n\n```text\n\\frac{1}{2')
    expect(hideUnclosedMathFence('~~~ math\nx')).toBe('~~~ text\nx')
  })

  it('leaves closed math fences and other fences alone', () => {
    const closed = '```math\nx\n```\n\nafter'
    expect(hideUnclosedMathFence(closed)).toBe(closed)
    const other = '```ts\nconst a = 1'
    expect(hideUnclosedMathFence(other)).toBe(other)
  })

  it('relabels only the unfinished fence', () => {
    expect(hideUnclosedMathFence('```math\na\n```\n\n```math\nb')).toBe('```math\na\n```\n\n```text\nb')
  })
})

describe('parseBlocksKeepingMath', () => {
  it('keeps a \\[ display together when block syntax or blank lines cut it', () => {
    for (const source of ['\\[\na\n=\nb\n\\]', '\\[\nx\n\ny\n\\]', '\\[\n- y\n# z\n\\]']) {
      expect(parseBlocksKeepingMath(`${source}\n\nafter`)).toEqual([source, '\n\n', 'after'])
    }
  })

  it('leaves unrelated blocks apart and ignores \\[ in code', () => {
    expect(parseBlocksKeepingMath('one\n\ntwo')).toEqual(['one', '\n\n', 'two'])
    expect(parseBlocksKeepingMath('```\n\\[\n```\n\nnext')).toEqual(['```\n\\[\n```', '\n\n', 'next'])
  })
})
