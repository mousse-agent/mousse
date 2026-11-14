/**
 * What makes theme CSS load something from outside Mousse, checked on text. The renderer runs it on the CSS the
 * browser produced after parsing a theme (`sanitizeThemeCss`), rule by rule and then on the whole result; the daemon
 * runs it on a theme an agent writes, to say which rules will be dropped.
 *
 * The check is deliberately wider than the browser: it decodes CSS escapes first, so `\75 rl(` counts as `url(`, and
 * it refuses every function that can name a resource, also inside strings and comments. Comments stay in the text: in
 * CSS they split tokens (`u/**\/rl(` is no `url(`) and inside a `url()` they are part of the address. A false alarm
 * drops one harmless rule; a miss would let a theme fetch a URL.
 */

/** Functions that fetch or name a resource. `url()` is allowed only for `data:` and `#id`, the rest never. */
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

/** The argument of the `url(` that starts at `open` (the index just after the parenthesis), without quotes. */
function urlArgument(text: string, open: number): string {
  let depth = 1
  let end = open
  for (; end < text.length && depth > 0; end++) {
    if (text[end] === '(') depth++
    else if (text[end] === ')') depth--
  }
  return text.slice(open, depth === 0 ? end - 1 : end).trim().replace(/^["']|["']$/g, '').trim()
}

/** Why `text` could load something from outside Mousse, or null when it cannot. */
export function externalLoadIn(text: string): string | null {
  const normalized = normalizeCssText(text)
  if (BLOCKED_AT_RULES.test(normalized)) return 'loads another stylesheet'
  // Every function name, as the tokenizer reads one: a name directly followed by "(".
  const functions = /(?<![a-z0-9_\-\u0080-\uffff])(-?-?[a-z_\u0080-\uffff][a-z0-9_\-\u0080-\uffff]*)\(/g
  for (let match = functions.exec(normalized); match; match = functions.exec(normalized)) {
    const name = match[1]
    if (BLOCKED_FUNCTIONS.has(name)) return `uses ${name}()`
    if (name !== 'url') continue
    const target = urlArgument(normalized, match.index + match[0].length)
    if (target.startsWith('data:') || target.startsWith('#')) continue
    return 'loads a url() that is not data: or #id'
  }
  return null
}

/** Most theme CSS a theme may carry, in characters. */
export const THEME_CSS_MAX_LENGTH = 64_000
