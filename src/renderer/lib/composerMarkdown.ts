/**
 * Light Markdown for the composer: the backdrop behind the textarea paints these spans, so every
 * style here must keep each character's width (no real bold or italic faces, no font changes).
 * The textarea keeps the text, caret, selection and undo; only the look comes from here.
 */

export type MarkdownKind =
  | 'marker'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'codeblock'
  | 'heading'
  | 'quote'
  | 'list'
  | 'link'

export interface MarkdownSpan {
  start: number
  end: number
  kinds: MarkdownKind[]
}

/** Above this size the draft is painted plain: a huge paste should not cost a span per token. */
export const COMPOSER_MARKDOWN_MAX_LENGTH = 20_000

const FENCE = /^\s{0,3}(```|~~~)/
const HEADING = /^(\s{0,3}#{1,6})(\s+)/
const QUOTE = /^(\s*>)(\s?)/
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?/

interface InlineRule {
  kind: MarkdownKind
  pattern: RegExp
  /** Length of the opening and closing markers. */
  open: number
  close: number
  /** Inline styles inside (code stays literal). */
  nested: boolean
}

const INLINE_RULES: InlineRule[] = [
  { kind: 'code', pattern: /`[^`\n]+`/y, open: 1, close: 1, nested: false },
  { kind: 'bold', pattern: /\*\*(?=\S)[^\n]*?\S\*\*|\*\*\S\*\*/y, open: 2, close: 2, nested: true },
  { kind: 'bold', pattern: /__(?=\S)[^\n]*?\S__(?!\w)|__\S__(?!\w)/y, open: 2, close: 2, nested: true },
  { kind: 'strike', pattern: /~~(?=\S)[^\n]*?\S~~|~~\S~~/y, open: 2, close: 2, nested: true },
  { kind: 'italic', pattern: /\*(?=[^\s*])[^*\n]*?[^\s*]\*|\*[^\s*]\*/y, open: 1, close: 1, nested: true },
  { kind: 'italic', pattern: /_(?=[^\s_])[^_\n]*?[^\s_]_(?!\w)|_[^\s_]_(?!\w)/y, open: 1, close: 1, nested: true }
]

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/y

function push(spans: MarkdownSpan[], start: number, end: number, kinds: MarkdownKind[]): void {
  if (end <= start) return
  const last = spans[spans.length - 1]
  if (last && last.end === start && sameKinds(last.kinds, kinds)) {
    last.end = end
    return
  }
  spans.push({ start, end, kinds })
}

function sameKinds(a: MarkdownKind[], b: MarkdownKind[]): boolean {
  return a.length === b.length && a.every((kind, index) => kind === b[index])
}

/** `_` emphasis only opens at a word start, as in CommonMark (snake_case stays plain). */
function opensAt(text: string, index: number, rule: InlineRule): boolean {
  if (text[index] !== '_') return true
  return index === 0 || !/\w/.test(text[index - 1])
}

function inline(text: string, from: number, to: number, base: MarkdownKind[], spans: MarkdownSpan[]): void {
  let plainStart = from
  let index = from
  while (index < to) {
    const char = text[index]
    let matched = false
    if (char === '`' || char === '*' || char === '_' || char === '~') {
      for (const rule of INLINE_RULES) {
        if (base.includes(rule.kind) && rule.kind !== 'code') continue
        if (!opensAt(text, index, rule)) continue
        rule.pattern.lastIndex = index
        const match = rule.pattern.exec(text)
        if (!match || index + match[0].length > to) continue
        const end = index + match[0].length
        push(spans, plainStart, index, base)
        const kinds = [...base, rule.kind]
        push(spans, index, index + rule.open, [...kinds, 'marker'])
        if (rule.nested) inline(text, index + rule.open, end - rule.close, kinds, spans)
        else push(spans, index + rule.open, end - rule.close, kinds)
        push(spans, end - rule.close, end, [...kinds, 'marker'])
        index = end
        plainStart = end
        matched = true
        break
      }
    } else if (char === '[') {
      LINK.lastIndex = index
      const match = LINK.exec(text)
      if (match && index + match[0].length <= to) {
        push(spans, plainStart, index, base)
        const labelEnd = index + 1 + match[1].length
        const kinds = [...base, 'link' as const]
        push(spans, index, index + 1, [...base, 'marker'])
        push(spans, index + 1, labelEnd, kinds)
        push(spans, labelEnd, index + match[0].length, [...base, 'marker'])
        index += match[0].length
        plainStart = index
        matched = true
      }
    }
    if (!matched) index += 1
  }
  push(spans, plainStart, to, base)
}

/**
 * Splits the draft into styled spans that cover it end to end, in order. Unstyled text has no kinds.
 */
export function composerMarkdownSpans(text: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = []
  if (text.length > COMPOSER_MARKDOWN_MAX_LENGTH) {
    push(spans, 0, text.length, [])
    return spans
  }
  let inFence = false
  let lineStart = 0
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    const line = text.slice(lineStart, lineEnd)
    if (FENCE.test(line)) {
      push(spans, lineStart, lineEnd, ['codeblock', 'marker'])
      inFence = !inFence
    } else if (inFence) {
      push(spans, lineStart, lineEnd, ['codeblock'])
    } else {
      const heading = HEADING.exec(line)
      const quote = heading ? null : QUOTE.exec(line)
      const list = heading || quote ? null : LIST.exec(line)
      if (heading) {
        const markEnd = lineStart + heading[1].length
        push(spans, lineStart, markEnd, ['heading', 'marker'])
        push(spans, markEnd, markEnd + heading[2].length, [])
        inline(text, markEnd + heading[2].length, lineEnd, ['heading'], spans)
      } else if (quote) {
        const markEnd = lineStart + quote[1].length
        push(spans, lineStart, markEnd, ['quote', 'marker'])
        inline(text, markEnd, lineEnd, ['quote'], spans)
      } else if (list) {
        const markStart = lineStart + list[1].length
        const markEnd = markStart + list[2].length
        push(spans, lineStart, markStart, [])
        push(spans, markStart, markEnd, ['list'])
        const taskStart = markEnd + list[3].length
        push(spans, markEnd, taskStart, [])
        const contentStart = taskStart + (list[4]?.length ?? 0)
        push(spans, taskStart, contentStart, ['list'])
        inline(text, contentStart, lineEnd, [], spans)
      } else {
        inline(text, lineStart, lineEnd, [], spans)
      }
    }
    if (newline === -1) break
    push(spans, lineEnd, lineEnd + 1, [])
    lineStart = lineEnd + 1
  }
  return spans
}

export interface ListContinuation {
  /** Range of the draft to replace. */
  start: number
  end: number
  text: string
}

/**
 * A new line typed at the end of a list item starts the next item: `- ` again, `2.` after `1.`,
 * an unchecked box after a task. On an item with nothing after its marker, the marker is removed
 * instead, which ends the list. Anywhere else returns null and the new line is plain.
 */
export function listContinuation(value: string, selectionStart: number, selectionEnd: number): ListContinuation | null {
  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
  const before = value.slice(lineStart, selectionStart)
  if (before.includes('\n')) return null
  const match = LIST.exec(before)
  if (!match) return null
  if (isInsideFence(value, lineStart)) return null
  const [marker, indent, bullet, gap, task] = match
  const rest = before.slice(marker.length)
  const lineEndIndex = value.indexOf('\n', selectionEnd)
  const after = value.slice(selectionEnd, lineEndIndex === -1 ? value.length : lineEndIndex)
  if (rest.trim() === '' && after.trim() === '') {
    return { start: lineStart, end: selectionEnd, text: '' }
  }
  const ordered = /^(\d+)([.)])$/.exec(bullet)
  const nextBullet = ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : bullet
  const nextTask = task ? '[ ] ' : ''
  return { start: selectionStart, end: selectionEnd, text: `\n${indent}${nextBullet}${gap}${nextTask}` }
}

function isInsideFence(value: string, lineStart: number): boolean {
  let open = false
  for (const line of value.slice(0, lineStart).split('\n')) {
    if (FENCE.test(line)) open = !open
  }
  return open
}
