import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UserMessage } from '../src/renderer/chat/components/agent-elements/user-message'
import { mousseToUIMessages } from '../src/renderer/chat/adapters/mousseToUI'
import type { ChatMessage } from '../src/shared/types'
import {
  extractChatReferences,
  formatChatReferences,
  formatMousseFileLink,
  parseChatReference,
  parseMousseFileLink
} from '../src/shared/chatReferences'
import { classifyLink, safeMarkdownUrl } from '../src/renderer/utils/chatLinks'

describe('chat references', () => {
  it('renders persisted attachment-only messages in the active chat UI', () => {
    const content = formatChatReferences([
      { id: 'project:p1', kind: 'project', title: 'My Project', projectId: 'p1', metadataPath: '/profile/projects.json' },
      { id: 'file:f1', kind: 'file', title: 'parser.ts', path: '/repo/parser.ts' },
      { id: 'terminal:t1', kind: 'terminal', title: 'Dev server', tabId: 't1', sessionId: 'pty-1' }
    ])
    const messages = mousseToUIMessages([{ id: 'm1', role: 'user', content, timestamp: new Date().toISOString() } as ChatMessage])
    expect(messages).toHaveLength(1)
    const markup = renderToStaticMarkup(createElement(UserMessage, { message: messages[0] }))
    expect(markup).toContain('My Project')
    expect(markup).toContain('parser.ts')
    expect(markup).toContain('Dev server')
    expect(markup).toContain('composer-reference-link')
    expect(markup).not.toContain('Mousse references data=')
  })
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

  it('rejects malformed payloads, missing resource IDs, and unsafe browser URLs', () => {
    expect(parseChatReference({ kind: 'file', title: 'missing path' })).toBeNull()
    expect(parseChatReference({ kind: 'project', title: 'missing id' })).toBeNull()
    expect(parseChatReference({ kind: 'thread', title: 'missing id' })).toBeNull()
    expect(parseChatReference({ kind: 'terminal', title: 'missing tab' })).toBeNull()
    expect(parseChatReference({ kind: 'agent', title: 'missing id' })).toBeNull()
    expect(parseChatReference({ kind: 'browser', title: 'missing url' })).toBeNull()
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
    expect(classifyLink('src/a.ts:9:2')).toEqual({ kind: 'relative-file', path: 'src/a.ts', line: 9, column: 2 })
    expect(classifyLink('/repo/src/a.ts:9')).toEqual({ kind: 'relative-file', path: '/repo/src/a.ts', line: 9, column: undefined })
  })

  it('routes only HTTP(S) as web and rejects executable schemes', () => {
    expect(classifyLink('https://example.com/docs').kind).toBe('web')
    expect(classifyLink('javascript:alert(1)').kind).toBe('reject')
    expect(classifyLink('data:text/html,bad').kind).toBe('reject')
    expect(classifyLink('file:///etc/passwd').kind).toBe('reject')
    expect(safeMarkdownUrl('mousse-file://open?path=src%2Fa.ts&line=2')).toBe('mousse-file://open?path=src%2Fa.ts&line=2')
    expect(safeMarkdownUrl('javascript:alert(1)')).toBe('')
  })
})
