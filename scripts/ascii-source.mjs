import { readFileSync, writeFileSync } from 'node:fs'
import { parseAst } from 'vite'

/**
 * V8 keeps the text of every script it loads for as long as the process runs. Node hands it over at one byte per
 * character only when the file is pure ASCII: a single `§` or `→`, even in a comment, makes it two bytes per
 * character. The daemon's two largest chunks (about 9.6 million characters) took about 19 MB instead of 9.6 MB.
 *
 * This rewrites each non-ASCII character as a `\uXXXX` escape, which means the same thing in a string, an untagged
 * template, a regular expression, an identifier and a comment. A tagged template can read its raw text
 * (`String.raw`), so a character inside one is left as it is. The result is parsed again, so a character in a place
 * where an escape is not allowed fails the build instead of shipping a broken bundle.
 */
export function toAsciiSource(code) {
  if (!/[^\x00-\x7f]/.test(code)) return code
  const kept = taggedTemplateRanges(code)
  let out = ''
  let last = 0
  for (const match of code.matchAll(/[^\x00-\x7f]/gu)) {
    const at = match.index
    if (kept.some(([start, end]) => at >= start && at < end)) continue
    // `\§` is an identity escape: drop its backslash, or the new escape would read as an escaped backslash.
    let slashes = 0
    while (code[at - 1 - slashes] === '\\') slashes++
    out += code.slice(last, slashes % 2 ? at - 1 : at) + escapeCodeUnits(match[0])
    last = at + match[0].length
  }
  out += code.slice(last)
  if (out === code) return code
  parseAst(out)
  return out
}

function escapeCodeUnits(char) {
  let text = ''
  for (let i = 0; i < char.length; i++) text += `\\u${char.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
  return text
}

function taggedTemplateRanges(code) {
  const ranges = []
  const visit = (node) => {
    // Holes in an array literal are null.
    if (!node) return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (node.type === 'TaggedTemplateExpression') {
      ranges.push([node.quasi.start, node.quasi.end])
      visit(node.tag)
      return
    }
    for (const key in node) {
      const value = node[key]
      if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parseAst(code))
  return ranges
}

/**
 * Rollup plugin for the electron-vite builds, which write no source maps, so shifted columns cost nothing. It runs
 * when the bundle is final: Vite's own esbuild pass in `renderChunk` turns string escapes back into characters.
 */
export function asciiSourcePlugin() {
  return {
    name: 'ascii-source',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk') chunk.code = toAsciiSource(chunk.code)
      }
    }
  }
}

/**
 * esbuild plugin: rewrites `outfile` after esbuild writes it. A rewritten character shifts the source map's columns
 * on its own line only, and almost all of them are in comments.
 */
export function asciiSourceEsbuildPlugin() {
  return {
    name: 'ascii-source',
    setup(build) {
      const outfile = build.initialOptions.outfile
      build.onEnd((result) => {
        if (result.errors.length || !outfile) return
        const code = readFileSync(outfile, 'utf8')
        const out = toAsciiSource(code)
        if (out !== code) writeFileSync(outfile, out)
      })
    }
  }
}
