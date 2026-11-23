import { describe, expect, it } from 'vitest'
import {
  THREAD_CHIP_HEAD,
  chipThreadLinks,
  expandThreadChips,
  findThreadChips,
  rangeOverChips,
  threadChipParts,
  threadChipTokenFor,
  type ThreadChipLabel,
  type ThreadChipRegistry
} from '../src/renderer/lib/composerThreadChips'

/**
 * A thread link in the composer's text becomes a stand-in token the backdrop draws as the thread's chip; the text that is
 * sent, copied or saved gets the exact link back.
 */

const listed: Record<string, ThreadChipLabel> = {
  'thread-b': { title: 'Design notes' },
  'thread-c': { title: 'Design notes' },
  'nod_0123456789abcdefghjkmnpqrs:thread-r': { title: 'Remote work', computer: 'Studio Mac' }
}

function chip(text: string, within?: { start: number; end: number }) {
  const registry: ThreadChipRegistry = new Map()
  const register = (link: string, label: ThreadChipLabel) => {
    const token = threadChipTokenFor(link, label, registry)
    registry.set(token, link)
    return token
  }
  const result = chipThreadLinks(text, (id) => listed[id] ?? null, register, within)
  return { ...result, registry, spans: findThreadChips(result.value, registry) }
}

describe('thread links in the composer', () => {
  it.each([
    ['a listed thread', 'see mousse://thread/thread-b now', ['thread-b']],
    ['a thread of another computer', 'see mousse://thread/nod_0123456789abcdefghjkmnpqrs:thread-r', ['nod_0123456789abcdefghjkmnpqrs:thread-r']],
    ['a trailing slash, kept on send', 'mousse://thread/thread-b/', ['thread-b']],
    ['a thread this computer cannot find', 'see mousse://thread/thread-gone', []],
    ['a link in inline code', 'run `mousse://thread/thread-b` here', []],
    ['a Markdown link target', '[notes](mousse://thread/thread-b)', []],
    ['two threads with the same title', 'mousse://thread/thread-b and mousse://thread/thread-c', ['thread-b', 'thread-c']]
  ])('%s', (_case, text, chipped) => {
    const { value, registry, spans } = chip(text)
    expect(spans.map((span) => span.threadId)).toEqual(chipped)
    expect(new Set(spans.map((span) => span.token)).size).toBe(spans.length)
    // What is sent is the text as written.
    expect(expandThreadChips(value, registry)).toBe(text)
  })

  it('a chip reads as the thread, with the computer for another computer’s thread, and its parts make the token', () => {
    const { spans } = chip('mousse://thread/nod_0123456789abcdefghjkmnpqrs:thread-r')
    const parts = threadChipParts(spans[0].token)
    expect(parts.head).toBe(THREAD_CHIP_HEAD)
    expect(Object.values(parts).join('')).toBe(spans[0].token)
    expect(parts.title.replace(/\s/g, ' ').trim()).toBe('Remote work')
    expect(parts.computer.replace(/[\s\p{Cf}]+/gu, ' ').trim()).toBe('· Studio Mac')
  })

  it('a long title is cut short; the chip never holds a breaking space', () => {
    const registry: ThreadChipRegistry = new Map()
    const token = threadChipTokenFor('mousse://thread/x', { title: 'A very long thread title that keeps going on and on' }, registry)
    const { title } = threadChipParts(token)
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(32)
    expect(token).not.toContain(' ')
  })

  it('only links touching the given range become chips: a link typing just finished', () => {
    const text = 'mousse://thread/thread-b then mousse://thread/thread-c '
    const { spans } = chip(text, { start: text.length - 1, end: text.length - 1 })
    expect(spans.map((span) => span.threadId)).toEqual(['thread-c'])
  })

  it('an offset maps past a chip it was inside, and keeps its place in the text around it', () => {
    const text = 'ab mousse://thread/thread-b cd'
    const { value, map, spans } = chip(text)
    const end = spans[0].index + spans[0].length
    expect(map(1)).toBe(1)
    expect(map(5)).toBe(end)
    expect(value.slice(map(text.length - 2))).toBe('cd')
  })

  it('a range that cuts into a chip grows to hold all of it', () => {
    const { spans } = chip('ab mousse://thread/thread-b cd')
    const span = spans[0]
    expect(rangeOverChips(spans, 1, span.index + 2)).toEqual({ start: 1, end: span.index + span.length })
    expect(rangeOverChips(spans, span.index + 2, span.index + span.length + 2)).toEqual({ start: span.index, end: span.index + span.length + 2 })
  })
})
