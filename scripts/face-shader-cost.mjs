// The bot face shader's size with every function call inlined, the way ANGLE's Direct3D 11 backend
// hands it to Microsoft's FXC on Windows. FXC inlines every call and its compile time grows faster
// than linearly with the straight-line code that results, so this counts each call site in full and
// each loop body once (a loop compiles about once however many trips it has).
//
//   node scripts/face-shader-cost.mjs [file]   # default: src/renderer/components/bots/face/miceShader.ts
//
// `file` may be a .ts file holding `MICE_FRAGMENT_SHADER = \`...\``, an .html file with a
// `<script id="fs">` shader, or plain GLSL. Prints, per function, its own statements and tokens and
// the totals with its callees inlined, plus how many copies of each function `main` ends up with.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function shaderSource(text) {
  const ts = text.match(/MICE_FRAGMENT_SHADER = `([\s\S]*?)`/)
  if (ts) return ts[1]
  const html = text.match(/<script id="fs"[^>]*>([\s\S]*?)<\/script>/)
  return html ? html[1] : text
}

const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'return', 'break', 'continue', 'discard'])

/** Splits GLSL into functions: name, body tokens. Comments and preprocessor lines are dropped. */
function parse(src) {
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*#[^\n]*/gm, '')
  const tokens = code.match(/[A-Za-z_]\w*|\d*\.\d+(?:e[+-]?\d+)?|\d+\.?(?:e[+-]?\d+)?|[+\-*/<>=!&|]=|&&|\|\||\+\+|--|\S/g) ?? []
  const functions = new Map()
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '{') depth++
    else if (t === '}') depth--
    else if (depth === 0 && /^[A-Za-z_]\w*$/.test(t) && tokens[i + 1] === '(' && i > 0 && /^[A-Za-z_]\w*$/.test(tokens[i - 1])) {
      // A definition: type name ( ... ) { ... }. A prototype ends in ';' and is skipped.
      let j = i + 1
      let paren = 0
      for (; j < tokens.length; j++) {
        if (tokens[j] === '(') paren++
        else if (tokens[j] === ')' && --paren === 0) break
      }
      if (tokens[j + 1] !== '{') continue
      let k = j + 1
      let d = 0
      for (; k < tokens.length; k++) {
        if (tokens[k] === '{') d++
        else if (tokens[k] === '}' && --d === 0) break
      }
      functions.set(t, tokens.slice(j + 2, k))
      i = k
    }
  }
  return functions
}

/** Statements: each ';' outside a for header's parentheses, plus each if/for/else that opens a block. */
function ownCost(body, names) {
  let statements = 0
  let paren = 0
  const calls = new Map()
  for (let i = 0; i < body.length; i++) {
    const t = body[i]
    if (t === '(') paren++
    else if (t === ')') paren--
    else if (t === ';' && paren === 0) statements++
    else if ((t === 'if' || t === 'for' || t === 'while') && body[i + 1] === '(') statements++
    if (names.has(t) && body[i + 1] === '(' && !KEYWORDS.has(t)) calls.set(t, (calls.get(t) ?? 0) + 1)
  }
  return { statements, tokens: body.length, calls }
}

export function shaderCost(src) {
  const functions = parse(src)
  const names = new Set(functions.keys())
  const own = new Map([...functions].map(([name, body]) => [name, ownCost(body, names)]))
  const memo = new Map()
  const inlined = (name, stack = []) => {
    if (memo.has(name)) return memo.get(name)
    if (stack.includes(name)) throw new Error('recursion through ' + name)
    const o = own.get(name)
    const copies = new Map([[name, 1]])
    let statements = o.statements
    let tokens = o.tokens
    for (const [callee, n] of o.calls) {
      const c = inlined(callee, [...stack, name])
      statements += n * c.statements
      tokens += n * c.tokens
      for (const [f, k] of c.copies) copies.set(f, (copies.get(f) ?? 0) + n * k)
    }
    const result = { statements, tokens, copies }
    memo.set(name, result)
    return result
  }
  const rows = [...functions.keys()].map((name) => {
    const o = own.get(name)
    const i = inlined(name)
    return { name, ownStatements: o.statements, ownTokens: o.tokens, calls: Object.fromEntries(o.calls), statements: i.statements, tokens: i.tokens }
  })
  const main = inlined('main')
  return { rows, total: { statements: main.statements, tokens: main.tokens }, copies: Object.fromEntries(main.copies) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? fileURLToPath(new URL('../src/renderer/components/bots/face/miceShader.ts', import.meta.url))
  const { rows, total, copies } = shaderCost(shaderSource(readFileSync(file, 'utf8')))
  const pad = (s, n) => String(s).padStart(n)
  console.log('function     own st  own tok   inlined st  inlined tok  copies in main  calls')
  for (const r of rows) {
    console.log(r.name.padEnd(12) + pad(r.ownStatements, 7) + pad(r.ownTokens, 9) + pad(r.statements, 13) + pad(r.tokens, 13) + pad(copies[r.name] ?? 0, 16) + '  ' + Object.entries(r.calls).map(([f, n]) => f + '×' + n).join(' '))
  }
  console.log('total (main, every call inlined): ' + total.statements + ' statements, ' + total.tokens + ' tokens')
}
