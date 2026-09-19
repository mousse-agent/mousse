import { describe, expect, it } from 'vitest'
import {
  extractChatReferences,
  formatChatReferences,
  formatMousseFileLink,
  parseChatReference,
  parseMousseFileLink
} from '../src/shared/chatReferences'
import { classifyLink } from '../src/renderer/lib/linkRouting'

describe('chat references', () => {
  it('round trips typed references while appending useful model context', () => {
    const block = formatChatReferences([{
      id: 'thread:t1', kind: 'thread', title: 'Fix parser', threadId: 't1',
      projectId: 'p1', metadataPath: 'C:\\profiles\\alice\\thread-data\\repositories\\p1\\t1\\meta.json'
    }])
    expect(block).toContain('Path: C:\\profiles\\alice')
    const parsed = extractChatReferences(`Please inspect this\n\n${block}`)
    expect(parsed.text).toBe('Please inspect this')
    expect(parsed.references).toEqual([expect.objectContaining({ kind: 'thread', threadId: 't1', title: 'Fix parser' })])
  })

  it('rejects malformed payloads and unsafe browser URLs', () => {
    expect(parseChatReference({ kind: 'file', title: 'missing path' })).toBeNull()
    expect(parseChatReference({ kind: 'browser', title: 'bad', url: 'javascript:alert(1)' })).toBeNull()
    expect(parseChatReference({ kind: 'wat', title: 'bad' })).toBeNull()
  })

  it('supports encoded Windows paths and source locations', () => {
    const href = formatMousseFileLink('C:\\repo name\\src\\a.ts', 12, 3)
    expect(parseMousseFileLink(href)).toEqual({ path: 'C:\\repo name\\src\\a.ts', line: 12, column: 3 })
    expect(classifyLink('C:\\repo\\src\\a.ts:42:7')).toEqual({
      kind: 'relative-file', path: 'C:\\repo\\src\\a.ts', line: 42, column: 7
    })
    expect(classifyLink('src/a.ts#L9C2')).toEqual({ kind: 'relative-file', path: 'src/a.ts', line: 9, column: 2 })
  })

  it('routes only HTTP(S) as web and rejects executable schemes', () => {
    expect(classifyLink('https://example.com/docs').kind).toBe('web')
    expect(classifyLink('javascript:alert(1)').kind).toBe('reject')
    expect(classifyLink('data:text/html,bad').kind).toBe('reject')
    expect(classifyLink('file:///etc/passwd').kind).toBe('reject')
  })
})
