/**
 * What makes theme CSS load something from outside Mousse, checked on text. The renderer runs it on the CSS the
 * browser produced after parsing a theme (`sanitizeThemeCss`), rule by rule and then on the whole result; the daemon
 * runs it on a theme an agent writes, to say which rules will be dropped.
 *
 * The check is deliberately wider than the browser: it removes comments outside strings and decodes CSS escapes first,
 * so `\75 rl(` and `u/**\/rl(` count as `url(`, and it refuses every function that can name a resource, also inside
 * strings. The only url() it allows is one quoted `data:` address. A false alarm drops one harmless declaration or rule;
 * a miss would let a theme fetch a URL.
 */

/** Functions that fetch or name a resource. `url()` is allowed only for a quoted `data:` address, the rest never. */
const BLOCKED_FUNCTIONS: ReadonlySet<string> = new Set([
  'src',
  'image-set',
  '-webkit-image-set',
  'image',
  'cross-fade',
  '-webkit-cross-fade',
  'element',
  '-moz-element',
  'paint',
  // Typed attr() can turn page text into a value; a theme has no need for it.
  'attr'
])

/** At-rules that load or point at another resource, refused wherever they appear in the text. */
const BLOCKED_AT_RULES = /@(?:import|namespace)\b/

/**
 * The text with CSS escapes decoded (`\75 ` → `u`, `\r` → `r`, an escaped newline removed), lower-cased.
 * NUL and code points beyond Unicode become U+FFFD, as the CSS tokenizer does.
 */
export function normalizeCssText(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const hex = /^[0-9a-fA-F]{1,6}/.exec(text.slice(i + 1, i + 7))
    if (hex) {
      const code = parseInt(hex[0], 16)
      out += code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : String.fromCodePoint(code)
      i += hex[0].length
      // One whitespace after a hex escape belongs to the escape.
      const next = text[i + 1]
      if (next === ' ' || next === '\t' || next === '\n' || next === '\f') i += 1
      else if (next === '\r') i += text[i + 2] === '\n' ? 2 : 1
      continue
    }
    const next = text[i + 1]
    if (next === undefined) continue
    if (next === '\n' || next === '\f') { i += 1; continue }
    if (next === '\r') { i += text[i + 2] === '\n' ? 2 : 1; continue }
    out += next
    i += 1
  }
  return out.toLowerCase()
}

/**
 * The text with comments removed outside strings: a comment between letters (`u/**\/rl(`) is read as no gap at all, so
 * a split name is caught, while a comment inside a quoted address stays part of that address.
 */
export function stripCommentsOutsideStrings(text: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      out += ch + (text[i + 1] ?? '')
      i += 1
      continue
    }
    if (quote) {
      out += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
      continue
    }
    out += ch
  }
  return out
}

const ASCII_SPACE = /[\t\n\f\r ]/

/**
 * Where a `url(` whose argument starts at `open` ends, when that argument is one quoted `data:` address
 * (`url("data:…")`, ASCII spaces allowed around it); null for anything else. An unquoted address, `#id`, http(s), a
 * relative path, or a quote that ends before the closing parenthesis are all refused.
 */
function quotedDataUrlEnd(text: string, open: number): number | null {
  let i = open
  while (i < text.length && ASCII_SPACE.test(text[i])) i++
  const quote = text[i]
  if (quote !== '"' && quote !== "'") return null
  const close = text.indexOf(quote, i + 1)
  if (close < 0 || !text.slice(i + 1, close).startsWith('data:')) return null
  let j = close + 1
  while (j < text.length && ASCII_SPACE.test(text[j])) j++
  return text[j] === ')' ? j + 1 : null
}

/** Why `text` could load something from outside Mousse, or null when it cannot. */
export function externalLoadIn(text: string): string | null {
  const normalized = normalizeCssText(stripCommentsOutsideStrings(text))
  if (BLOCKED_AT_RULES.test(normalized)) return 'loads another stylesheet'
  // Every function name, as the tokenizer reads one: a name directly followed by "(".
  const functions = /(?<![a-z0-9_\-\u0080-\uffff])(-?-?[a-z_\u0080-\uffff][a-z0-9_\-\u0080-\uffff]*)\(/g
  for (let match = functions.exec(normalized); match; match = functions.exec(normalized)) {
    const name = match[1]
    if (BLOCKED_FUNCTIONS.has(name)) return `uses ${name}()`
    if (name !== 'url') continue
    const end = quotedDataUrlEnd(normalized, match.index + match[0].length)
    if (end === null) return 'uses a url() that is not a quoted data: address'
    // The address itself is not scanned again: an SVG in it may name its own parts with url(#id).
    functions.lastIndex = end
  }
  return null
}

/**
 * The top-level pieces of `text`, each a statement ending in `;` or a block ending in its `}`, with strings, escapes
 * and comments respected; anything after the last piece is one more piece.
 */
export function splitCssPieces(text: string): string[] {
  const pieces: string[] = []
  let start = 0
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') { i += 1; continue }
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      if (depth > 0) depth--
      if (depth === 0) { pieces.push(text.slice(start, i + 1)); start = i + 1 }
    } else if (ch === ';' && depth === 0) {
      pieces.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) pieces.push(text.slice(start))
  return pieces
}

/** The `{` that opens a block piece, outside strings and comments; -1 for a statement. */
function blockOpen(piece: string): number {
  let quote: string | null = null
  for (let i = 0; i < piece.length; i++) {
    const ch = piece[i]
    if (ch === '\\') { i += 1; continue }
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '/' && piece[i + 1] === '*') {
      const end = piece.indexOf('*/', i + 2)
      i = end < 0 ? piece.length : end + 1
      continue
    }
    if (ch === '{') return i
  }
  return -1
}

/**
 * The CSS as written, before any parser touches it, with every declaration, statement or rule that fails
 * `externalLoadIn` left out, as narrowly as possible: a bad declaration goes and its rule stays; a bad selector or
 * at-rule prelude takes its block with it. The quoting rule for url() is checked here, on the text as written,
 * because a browser writes `url(data:…)` back with quotes.
 */
export function withoutExternalLoads(text: string, dropped: Array<{ text: string; reason: string }> = [], depth = 0): string {
  return splitCssPieces(text).map((piece) => {
    const reason = externalLoadIn(piece)
    if (!reason) return piece
    const open = blockOpen(piece)
    const close = piece.lastIndexOf('}')
    if (open < 0 || close < open || depth > 16 || externalLoadIn(piece.slice(0, open))) {
      dropped.push({ text: piece.replace(/\s+/g, ' ').trim().slice(0, 160), reason })
      return ''
    }
    return `${piece.slice(0, open + 1)}${withoutExternalLoads(piece.slice(open + 1, close), dropped, depth + 1)}${piece.slice(close)}`
  }).join('')
}

/** Most custom CSS a theme may carry, in characters. More is refused, never cut. */
export const THEME_CSS_MAX_LENGTH = 50_000

/** What every place that refuses over-long theme CSS says: the editor, an agent's theme_set, an import and settings. */
export function themeCssTooLong(length: number): string {
  return `Custom CSS is ${length.toLocaleString('en-US')} characters; the limit is ${THEME_CSS_MAX_LENGTH.toLocaleString('en-US')}.`
}
