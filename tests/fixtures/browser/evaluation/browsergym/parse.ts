import { BROWSERGYM_HIGH_LEVEL_ACTIONS, type ParsedBrowserGymCall } from './protocol'

class ParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserGymActionParseError'
  }
}

function readString(source: string, start: number): { value: string; next: number } {
  const quote = source[start]
  let i = start + 1
  let out = ''
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      const next = source[i + 1]
      if (next === undefined) throw new ParseError('unterminated escape')
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '\\': '\\' }
      out += map[next] ?? next
      i += 2
      continue
    }
    if (ch === quote) return { value: out, next: i + 1 }
    out += ch
    i += 1
  }
  throw new ParseError('unterminated string')
}

function skipWs(source: string, i: number): number {
  while (i < source.length && /\s/.test(source[i])) i += 1
  return i
}

function readValue(source: string, start: number): { value: unknown; next: number } {
  let i = skipWs(source, start)
  const ch = source[i]
  if (ch === '"' || ch === "'") return readString(source, i)
  if (ch === '[') {
    i += 1
    const items: unknown[] = []
    i = skipWs(source, i)
    if (source[i] === ']') return { value: items, next: i + 1 }
    while (i < source.length) {
      const item = readValue(source, i)
      items.push(item.value)
      i = skipWs(source, item.next)
      if (source[i] === ',') { i += 1; continue }
      if (source[i] === ']') return { value: items, next: i + 1 }
      throw new ParseError('expected comma or closing bracket')
    }
    throw new ParseError('unterminated list')
  }
  if (source.startsWith('True', i)) return { value: true, next: i + 4 }
  if (source.startsWith('False', i)) return { value: false, next: i + 5 }
  if (source.startsWith('None', i) || source.startsWith('null', i)) return { value: null, next: i + 4 }
  const ident = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)
  const number = source.slice(i).match(/^-?\d+(?:\.\d+)?/)
  if (number && (!ident || ident[0].length < number[0].length || /^\d/.test(ident[0]))) {
    return { value: Number(number[0]), next: i + number[0].length }
  }
  throw new ParseError(`unexpected token at ${source.slice(i, i + 16)}`)
}

function readCall(source: string): ParsedBrowserGymCall {
  const match = source.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
  if (!match) throw new ParseError(`not a high-level action: ${source}`)
  const name = match[1]
  let i = match[0].length
  const args: unknown[] = []
  const kwargs: Record<string, unknown> = {}
  i = skipWs(source, i)
  if (source[i] === ')') return { name, args, kwargs, source: source.trim() }
  while (i < source.length) {
    i = skipWs(source, i)
    const rest = source.slice(i)
    const kw = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (kw) {
      i += kw[0].length
      const value = readValue(source, i)
      kwargs[kw[1]] = value.value
      i = skipWs(source, value.next)
    } else {
      const value = readValue(source, i)
      args.push(value.value)
      i = skipWs(source, value.next)
    }
    if (source[i] === ',') { i += 1; continue }
    if (source[i] === ')') return { name, args, kwargs, source: source.trim() }
    throw new ParseError(`expected comma or closing paren in ${source}`)
  }
  throw new ParseError(`unterminated call: ${source}`)
}

export function parseBrowserGymActions(source: string): ParsedBrowserGymCall[] {
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  if (!lines.length) throw new ParseError('Received an empty action.')
  return lines.map(readCall)
}

export function assertKnownAction(call: ParsedBrowserGymCall): void {
  if (!(BROWSERGYM_HIGH_LEVEL_ACTIONS as readonly string[]).includes(call.name)) {
    throw new ParseError(`Invalid action type '${call.name}'.`)
  }
}
