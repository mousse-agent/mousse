/**
 * What makes theme CSS load something from outside Mousse, checked on its tokens. The renderer runs it on the CSS as
 * written (`withoutExternalLoads`), then on what the browser produced after parsing (`sanitizeThemeCss`), rule by rule
 * and on the whole result; the daemon runs it on a theme an agent writes, to say what will be dropped.
 *
 * The text is split into tokens the way the CSS syntax does it (strings, escapes, comments, unquoted `url(` tokens and
 * bracket nesting), so a string cannot hide an address and an escaped quote does not end one. The only url() allowed is
 * one quoted `data:` address. The CSS is also checked once more with its comments removed, so a name split by a
 * comment (`u/**\/rl(`) is refused too. A false alarm drops one harmless declaration or rule; a miss would let a theme
 * fetch a URL.
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

/** At-rules that load or point at another resource. */
const BLOCKED_AT_RULES: ReadonlySet<string> = new Set(['import', 'namespace'])

const REPLACEMENT = String.fromCharCode(0xfffd)

type Token =
  | { kind: 'space' | 'comment'; start: number; end: number }
  | { kind: 'string'; value: string; start: number; end: number }
  /** An unquoted `url(…)`, complete or broken: never allowed. */
  | { kind: 'url'; start: number; end: number }
  | { kind: 'function' | 'ident' | 'at'; name: string; start: number; end: number }
  | { kind: 'delim'; char: string; start: number; end: number }

/** The input as the CSS syntax reads it: CR LF, CR and FF become LF, and NUL becomes U+FFFD. */
function preprocess(text: string): string {
  return text.replace(/\r\n?|\f/g, '\n').split(String.fromCharCode(0)).join(REPLACEMENT)
}

const isSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\n'
const isHex = (ch: string | undefined): boolean => ch !== undefined && /^[0-9a-fA-F]$/.test(ch)
const isNameStart = (ch: string | undefined): boolean => ch !== undefined && (/^[a-zA-Z_]$/.test(ch) || ch.charCodeAt(0) >= 0x80)
const isNameChar = (ch: string | undefined): boolean => ch !== undefined && (isNameStart(ch) || /^[0-9-]$/.test(ch))
const isValidEscape = (text: string, at: number): boolean => text[at] === '\\' && at + 1 < text.length && text[at + 1] !== '\n'

/** The escape whose backslash is at `at` - 1: what it stands for and where it ends. */
function consumeEscape(text: string, at: number): { char: string; next: number } {
  if (at >= text.length) return { char: REPLACEMENT, next: at }
  if (!isHex(text[at])) return { char: text[at], next: at + 1 }
  let end = at
  while (end < text.length && end - at < 6 && isHex(text[end])) end++
  const code = parseInt(text.slice(at, end), 16)
  if (isSpace(text[end])) end++
  const char = code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? REPLACEMENT : String.fromCodePoint(code)
  return { char, next: end }
}

function startsIdent(text: string, at: number): boolean {
  const ch = text[at]
  if (ch === '-') return isNameStart(text[at + 1]) || text[at + 1] === '-' || isValidEscape(text, at + 1)
  return isNameStart(ch) || isValidEscape(text, at)
}

function consumeName(text: string, at: number): { name: string; next: number } {
  let name = ''
  let i = at
  while (i < text.length) {
    if (isNameChar(text[i])) { name += text[i]; i++ } else if (isValidEscape(text, i)) {
      const escape = consumeEscape(text, i + 1)
      name += escape.char
      i = escape.next
    } else break
  }
  return { name, next: i }
}

/** A string token from the quote at `at`; a newline ends it unfinished, as in CSS. */
function consumeString(text: string, at: number): { value: string; next: number } {
  const quote = text[at]
  let value = ''
  let i = at + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === quote) return { value, next: i + 1 }
    if (ch === '\n') return { value, next: i }
    if (ch === '\\') {
      if (i + 1 >= text.length) { i++; continue }
      if (text[i + 1] === '\n') { i += 2; continue }
      const escape = consumeEscape(text, i + 1)
      value += escape.char
      i = escape.next
      continue
    }
    value += ch
    i++
  }
  return { value, next: i }
}

/** An unquoted url token from just after its `(`: up to the `)` that ends it, broken or not. */
function consumeUrl(text: string, at: number): number {
  let i = at
  while (i < text.length) {
    if (text[i] === ')') return i + 1
    if (isValidEscape(text, i)) { i = consumeEscape(text, i + 1).next; continue }
    i++
  }
  return i
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const start = i
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      tokens.push({ kind: 'comment', start, end: i })
    } else if (isSpace(ch)) {
      while (isSpace(text[i])) i++
      tokens.push({ kind: 'space', start, end: i })
    } else if (ch === '"' || ch === "'") {
      const string = consumeString(text, i)
      i = string.next
      tokens.push({ kind: 'string', value: string.value, start, end: i })
    } else if (ch === '@' && startsIdent(text, i + 1)) {
      const name = consumeName(text, i + 1)
      i = name.next
      tokens.push({ kind: 'at', name: name.name.toLowerCase(), start, end: i })
    } else if (startsIdent(text, i)) {
      const name = consumeName(text, i)
      i = name.next
      const lower = name.name.toLowerCase()
      if (text[i] !== '(') tokens.push({ kind: 'ident', name: lower, start, end: i })
      else if (lower === 'url') {
        let after = i + 1
        while (isSpace(text[after])) after++
        if (text[after] === '"' || text[after] === "'") {
          i += 1
          tokens.push({ kind: 'function', name: lower, start, end: i })
        } else {
          i = consumeUrl(text, i + 1)
          tokens.push({ kind: 'url', start, end: i })
        }
      } else {
        i += 1
        tokens.push({ kind: 'function', name: lower, start, end: i })
      }
    } else {
      i += 1
      tokens.push({ kind: 'delim', char: ch, start, end: i })
    }
  }
  return tokens
}

/** Why these tokens could load something from outside Mousse, or null when they cannot. */
function refusal(tokens: Token[]): string | null {
  const next = (from: number): number => {
    let k = from
    while (k < tokens.length && (tokens[k].kind === 'space' || tokens[k].kind === 'comment')) k++
    return k
  }
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]
    if (token.kind === 'at' && BLOCKED_AT_RULES.has(token.name)) return 'loads another stylesheet'
    if (token.kind === 'url') return 'uses a url() that is not a quoted data: address'
    if (token.kind !== 'function') continue
    if (BLOCKED_FUNCTIONS.has(token.name)) return `uses ${token.name}()`
    if (token.name !== 'url') continue
    // url( then one quoted address that starts with data:, then ).
    const address = next(k + 1)
    const value = tokens[address]
    if (value?.kind !== 'string' || !value.value.toLowerCase().startsWith('data:')) return 'uses a url() that is not a quoted data: address'
    const close = tokens[next(address + 1)]
    if (close?.kind !== 'delim' || close.char !== ')') return 'uses a url() that is not a quoted data: address'
  }
  return null
}

/** Why `text` could load something from outside Mousse, or null when it cannot. */
export function externalLoadIn(text: string): string | null {
  const input = preprocess(text)
  const tokens = tokenize(input)
  const direct = refusal(tokens)
  if (direct) return direct
  // The same CSS without its comments: a name split by one (`u/**/rl(`) is refused as what it reads like.
  const joined = tokens.filter((token) => token.kind !== 'comment').map((token) => input.slice(token.start, token.end)).join('')
  return joined === input ? null : refusal(tokenize(joined))
}

/** A top-level piece of CSS: a statement ending in `;`, or a block with where its braces are. */
interface Piece {
  text: string
  /** Offsets of the block's `{` and its matching `}` in `text`; absent for a statement or an unfinished block. */
  open?: number
  close?: number
}

/**
 * The top-level pieces of `text`: statements end at a `;` and blocks at their matching `}`, outside strings, comments,
 * url tokens and any (), [] or {} nesting. Anything after the last piece is one more piece.
 */
function splitPieces(text: string): Piece[] {
  const pieces: Piece[] = []
  const stack: string[] = []
  let start = 0
  let open: number | undefined
  for (const token of tokenize(text)) {
    if (token.kind === 'function') { stack.push(')'); continue }
    if (token.kind !== 'delim') continue
    const ch = token.char
    if (ch === '{' || ch === '(' || ch === '[') {
      if (ch === '{' && stack.length === 0) open = token.start - start
      stack.push(ch === '{' ? '}' : ch === '(' ? ')' : ']')
    } else if (ch === '}' || ch === ')' || ch === ']') {
      // A closer that does not match the open bracket is part of the content, as in CSS.
      if (stack[stack.length - 1] !== ch) continue
      stack.pop()
      if (ch === '}' && stack.length === 0) {
        pieces.push({ text: text.slice(start, token.end), open, close: token.start - start })
        start = token.end
        open = undefined
      }
    } else if (ch === ';' && stack.length === 0) {
      pieces.push({ text: text.slice(start, token.end) })
      start = token.end
      open = undefined
    }
  }
  if (start < text.length) pieces.push({ text: text.slice(start) })
  return pieces
}

/**
 * The CSS as written, before any parser touches it, with every declaration, statement or rule that fails
 * `externalLoadIn` left out, as narrowly as possible: a bad declaration goes and its rule stays; a bad selector or
 * at-rule prelude takes its block with it. The quoting rule for url() is checked here, on the text as written,
 * because a browser writes `url(data:…)` back with quotes.
 */
export function withoutExternalLoads(text: string, dropped: Array<{ text: string; reason: string }> = [], depth = 0): string {
  return splitPieces(depth === 0 ? preprocess(text) : text).map((piece) => {
    const reason = externalLoadIn(piece.text)
    if (!reason) return piece.text
    const { open, close } = piece
    if (open === undefined || close === undefined || depth > 16 || externalLoadIn(piece.text.slice(0, open))) {
      dropped.push({ text: piece.text.replace(/\s+/g, ' ').trim().slice(0, 160), reason })
      return ''
    }
    return `${piece.text.slice(0, open + 1)}${withoutExternalLoads(piece.text.slice(open + 1, close), dropped, depth + 1)}${piece.text.slice(close)}`
  }).join('')
}

/** Most custom CSS a theme may carry, in characters. More is refused, never cut. */
export const THEME_CSS_MAX_LENGTH = 50_000

/** What every place that refuses over-long theme CSS says: the editor, an agent's theme_set, an import and settings. */
export function themeCssTooLong(length: number): string {
  return `Custom CSS is ${length.toLocaleString('en-US')} characters; the limit is ${THEME_CSS_MAX_LENGTH.toLocaleString('en-US')}.`
}
