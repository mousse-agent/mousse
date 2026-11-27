import { describe, expect, it } from 'vitest'
import { mousseToolSubject, webSearchSites } from '../../src/renderer/chat/components/agent-elements/tools/mousse-tools'

describe('what a Mousse tool row names', () => {
  it.each([
    ['web_search', { query: 'robot vacuum prices', limit: 5 }, 'robot vacuum prices'],
    ['web_fetch', { url: 'https://example.com/a', format: 'markdown' }, 'https://example.com/a'],
    ['thread_create', { projectId: 'p1', title: 'Fix login', firstMessage: 'Please fix it' }, 'Fix login'],
    ['thread_create', { projectId: 'p1', firstMessage: 'Please fix the\nlogin page' }, 'Please fix the'],
    ['thread_send', { threadId: 't1', content: 'Any news?' }, 'Any news?'],
    ['load_skill', { name: 'work' }, 'work'],
    ['use_tool', { tool: 'thread_list', arguments: { query: 'design review' } }, 'thread_list: design review'],
    // Only ids: nothing readable to name (the row shows its arguments as any tool's).
    ['thread_read', { threadId: 't1' }, undefined],
    // Arguments cut to fit when saved.
    ['web_search', { truncated: true, preview: '{"query":"rob' }, undefined],
    ['web_search', undefined, undefined],
  ])('%s %j → %s', (tool, input, subject) => {
    expect(mousseToolSubject(tool, input)).toBe(subject)
  })

  it('cuts a long subject to one short line', () => {
    const subject = mousseToolSubject('web_search', { query: 'x'.repeat(500) })!
    expect(subject.length).toBeLessThanOrEqual(120)
    expect(subject.endsWith('…')).toBe(true)
  })
})

describe('the sites a web search found', () => {
  const hosts = (output: unknown) => webSearchSites(output).map((site) => `${site.title} @ ${site.host}`)

  it.each([
    ['a JSON result', JSON.stringify({ results: [{ title: 'A', url: 'https://www.a.test/x' }, { title: 'B', url: 'https://b.test/' }] }), ['A @ a.test', 'B @ b.test']],
    ['Title and URL lines', 'Title: A\nURL: https://a.test/x\n\nTitle: B\nURL: https://b.test/', ['A @ a.test', 'B @ b.test']],
    ['bare addresses, repeated', 'See https://a.test/x, and https://a.test/x.', ['a.test @ a.test']],
    ['an interrupted row’s wrapped text', { text: 'URL: https://a.test/' }, ['a.test @ a.test']],
    ['no address', 'No search results found.', []],
    ['an address that is not the web', 'URL: file:///etc/passwd\nURL: javascript:alert(1)', []],
    ['nothing', undefined, []],
  ])('%s', (_name, output, expected) => {
    expect(hosts(output)).toEqual(expected)
  })

  it('lists at most ten', () => {
    const output = Array.from({ length: 15 }, (_, i) => `URL: https://s${i}.test/`).join('\n')
    expect(webSearchSites(output)).toHaveLength(10)
  })
})
