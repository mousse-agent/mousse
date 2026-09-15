import { describe, expect, it, vi } from 'vitest'
import { WebTools, htmlToText } from '../src/mms/orchestrator/WebTools'

function credentials(values: Record<string, unknown> = {}) {
  return { read: async (id: string) => values[id] } as never
}

describe('WebTools', () => {
  it('exposes search and fetch schemas', () => {
    expect(new WebTools(credentials()).getToolDefinitions().map((tool) => tool.name))
      .toEqual(['web_search', 'web_fetch'])
  })

  it('prefers a configured Exa key and never includes it in tool output', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [{ title: 'Result' }] }), {
      headers: { 'content-type': 'application/json' }
    }))
    const tools = new WebTools(credentials({ exa: { type: 'api_key', key: 'secret-exa' }, parallel: { type: 'api_key', key: 'secret-parallel' } }), fetcher as never)
    const result = await tools.execute('web_search', { query: 'mousse', numResults: 3 })

    expect(fetcher).toHaveBeenCalledWith('https://api.exa.ai/search', expect.objectContaining({
      headers: expect.objectContaining({ 'x-api-key': 'secret-exa' })
    }))
    expect(result.text).toContain('Result')
    expect(result.text).not.toContain('secret-exa')
  })

  it('falls back to configured Parallel and honors an explicit provider', async () => {
    const fetcher = vi.fn(async () => new Response('{"results":[]}'))
    const tools = new WebTools(credentials({ parallel: { type: 'api_key', key: 'parallel-key' } }), fetcher as never)
    await tools.execute('web_search', { query: 'one' })
    await tools.execute('web_search', { query: 'two', provider: 'exa' })
    expect(fetcher.mock.calls[0]![0]).toBe('https://api.parallel.ai/v1beta/search')
    expect(fetcher.mock.calls[1]![0]).toBe('https://api.exa.ai/search')
  })

  it('rejects non-http fetches and converts HTML to readable text', async () => {
    const fetcher = vi.fn(async () => new Response('<style>x{}</style><h1>Hello &amp; hi</h1><script>bad()</script><p>World</p>', {
      headers: { 'content-type': 'text/html; charset=utf-8' }
    }))
    const tools = new WebTools(credentials(), fetcher as never)
    expect(await tools.execute('web_fetch', { url: 'file:///etc/passwd' })).toMatchObject({ isError: true })
    expect((await tools.execute('web_fetch', { url: 'https://example.com' })).text).toBe('Hello & hi\nWorld')
    expect(htmlToText('<b>A&nbsp;B</b>')).toBe('A B')
  })

  it('rejects responses larger than 2 MiB', async () => {
    const fetcher = vi.fn(async () => new Response('small', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }))
    const result = await new WebTools(credentials(), fetcher as never).execute('web_fetch', { url: 'https://example.com' })
    expect(result).toMatchObject({ isError: true })
    expect(result.text).toContain('2 MiB')
  })
})
