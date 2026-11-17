import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { completeInlineCode, keepLiteralBackslashes, Markdown } from '../src/renderer/chat/components/agent-elements/markdown'

function render(content: string, streaming = false): string {
  return renderToStaticMarkup(createElement(Markdown, { content, streaming }))
}

function decode(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** The text of every element with `className`, in order. */
function texts(markup: string, tag: string, className?: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*${className ? `class="[^"]*${className}[^"]*"` : ''}[^>]*>([\\s\\S]*?)</${tag}>`, 'g')
  return [...markup.matchAll(re)].map((m) => decode(m[1]!.replace(/<[^>]+>/g, '')))
}

function plain(markup: string): string {
  return decode(markup.replace(/<[^>]+>/g, ''))
}

const INLINE = [
  'C:\\Users\\me\\file.txt',
  '\\d+\\.\\w*',
  '/^a\\/b$/',
  '\\\\',
  '\\n',
  '\\t',
  '\\"',
  '"a \\"b\\" c"',
  "'it\\'s'",
  '\\frac{a}{b}',
  'C:\\dir\\',
]

describe('chat Markdown keeps backslashes and slashes as written', () => {
  it('in inline code', () => {
    const markup = render(`Inline: ${INLINE.map((code) => `\`${code}\``).join(', ')}.`)
    expect(texts(markup, 'code', 'an-md-code')).toEqual(INLINE)
  })

  it('adds no stray backtick after a code span that ends in a backslash', () => {
    for (const streaming of [false, true]) {
      const markup = render('Paths: `C:\\dir\\` and `\\\\`.\n\nThe end.', streaming)
      expect(plain(markup)).toContain('The end.')
      expect(plain(markup)).not.toContain('`')
    }
  })

  it('in fenced code', () => {
    const blocks = [
      'C:\\Users\\me\\file.txt\n\\\\server\\share\\dir',
      'const re = /^a\\/b$/\nconst s = "a \\"b\\" c" + \'it\\\'s\' + "\\\\" + "\\n" + "\\t"',
      '{"path": "C:\\\\Users\\\\me\\\\file.txt", "re": "\\\\d+\\\\.\\\\w*", "quote": "a \\"b\\" c"}',
      'docker run \\\n  --rm \\\n  img:latest echo "a \\"b\\" c"',
      '\\frac{a}{b} + \\sqrt{x}',
    ]
    const langs = ['text', 'js', 'json', 'bash', 'latex']
    const content = blocks.map((code, i) => `\`\`\`${langs[i]}\n${code}\n\`\`\``).join('\n\n')
    const shown = plain(render(content))
    for (const code of blocks) {
      for (const line of code.split('\n')) expect(shown).toContain(line)
    }
  })

  it('in a tilde fence', () => {
    expect(plain(render('~~~\nC:\\a\\/b "x\\"y"\n~~~'))).toContain('C:\\a\\/b "x\\"y"')
  })

  it('in a quote and in plain prose', () => {
    const markup = render([
      '> A quote with C:\\Users\\me and /usr/local/bin and a\\b/c and /^a\\/b$/.',
      '',
      'The path "C:\\Users\\me\\file.txt", the regex "/^a\\/b$/", "a \\"b\\" c" and \'it\\\'s\'.',
    ].join('\n'))
    expect(texts(markup, 'blockquote')[0]).toContain('A quote with C:\\Users\\me and /usr/local/bin and a\\b/c and /^a\\/b$/.')
    expect(plain(markup)).toContain('The path "C:\\Users\\me\\file.txt", the regex "/^a\\/b$/", "a \\"b\\" c" and \'it\\\'s\'.')
  })

  it('keeps drive and network paths, a double backslash and a regex with one dollar', () => {
    const shown = plain(render([
      'Paths: C:\\me\\.t3\\shot.png and C:\\work\\_drafts\\*.md and \\\\server\\share and a\\/b.',
      '',
      'Use \\d+ and /^a\\/b$/ to match. She said \\"hi\\" and a double backslash \\\\ here.',
    ].join('\n')))
    expect(shown).toContain('Paths: C:\\me\\.t3\\shot.png and C:\\work\\_drafts\\*.md and \\\\server\\share and a\\/b.')
    expect(shown).toContain('Use \\d+ and /^a\\/b$/ to match. She said \\"hi\\" and a double backslash \\\\ here.')
  })

  it('still reads Markdown escapes in prose', () => {
    const markup = render('\\*not italic\\* and \\_not italic\\_ and 2 \\* 3 and \\`tick\\`.')
    expect(markup).not.toContain('<em')
    expect(plain(markup)).toContain('*not italic* and _not italic_ and 2 * 3 and `tick`.')
  })
})

describe('keepLiteralBackslashes', () => {
  it('escapes a backslash before a character Markdown gives no meaning, and any escape in a path', () => {
    expect(keepLiteralBackslashes('a\\/b \\"q\\" it\\\'s \\* \\_ x\\\\y C:\\x')).toBe('a\\\\/b \\\\"q\\\\" it\\\\\'s \\* \\_ x\\\\\\\\y C:\\x')
    expect(keepLiteralBackslashes('C:\\me\\.t3 and \\\\host\\_x and not\\_a path')).toBe('C:\\me\\\\.t3 and \\\\\\\\host\\\\_x and not\\_a path')
  })

  it('leaves code spans, code spans across lines, indented lines, tilde fences and math alone', () => {
    const text = 'x `a\\/b` y\n`one\ntwo \\/` z\n\n    indented \\/\n~~~\nfenced \\/\n~~~\n$x \\\\ y$ \\/\n$$\na \\\\ b\n$$\n\\[ a \\\\ b \\]'
    expect(keepLiteralBackslashes(text)).toBe(text)
  })
})

describe('completeInlineCode', () => {
  it('closes a span still being written', () => {
    expect(completeInlineCode('see `abc')).toBe('see `abc`')
    expect(completeInlineCode('see ``a ` b')).toBe('see ``a ` b``')
  })

  it('treats a backslash inside a span as text and outside one as an escape', () => {
    expect(completeInlineCode('`C:\\dir\\` and `\\\\`')).toBe('`C:\\dir\\` and `\\\\`')
    expect(completeInlineCode('an escaped \\` tick')).toBe('an escaped \\` tick')
  })

  it('ignores fenced code and spans left open in an earlier paragraph', () => {
    expect(completeInlineCode('```\na ` b\n```\ntext')).toBe('```\na ` b\n```\ntext')
    expect(completeInlineCode('an open ` here\n\nnext paragraph')).toBe('an open ` here\n\nnext paragraph')
    expect(completeInlineCode('```ts\nconst a = `x')).toBe('```ts\nconst a = `x')
  })
})
