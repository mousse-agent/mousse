import { describe, expect, it, vi } from 'vitest'
import { WebTools, htmlToText } from '../src/mms/orchestrator/WebTools'

function credentials(values: Record<string, unknown> = {}) {
  return { read: async (id: string) => values[id] } as never
}

const mcpResponse = (text = 'Result') => new Response(JSON.stringify({ result: { content: [{ type: 'text', text }] } }), {
  headers: { 'content-type': 'application/json' }
})

describe('WebTools', () => {
  it('exposes search and fetch schemas', () => {
    expect(new WebTools(credentials()).getToolDefinitions().map((tool) => tool.name)).toEqual(['web_search', 'web_fetch'])
  })

  it('uses the Exa MCP endpoint and never includes its key in output', async () => {
    const fetcher = vi.fn(async () => mcpResponse())
    const tools = new WebTools(credentials({ 'web-tool:exa': { type: 'api_key', key: 'secret-exa' } }), fetcher as never)
    const result = await tools.execute('web_search', { query: 'mousse', provider: 'exa', numResults: 3 })
    expect(fetcher.mock.calls[0]![0]).toBe('https://mcp.exa.ai/mcp')
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ 'x-api-key': 'secret-exa' })
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ params: { name: 'web_search_exa', arguments: { query: 'mousse', numResults: 3 } } })
    expect(result.text).toBe('Result')
    expect(result.text).not.toContain('secret-exa')
  })

  it('prefers configured Parallel and honors explicit Exa selection', async () => {
    const fetcher = vi.fn(async () => mcpResponse())
    const tools = new WebTools(credentials({ 'web-tool:parallel': { type: 'api_key', key: 'parallel-key' } }), fetcher as never)
    await tools.execute('web_search', { query: 'one' })
    await tools.execute('web_search', { query: 'two', provider: 'exa' })
    expect(fetcher.mock.calls[0]![0]).toBe('https://search.parallel.ai/mcp')
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ authorization: 'Bearer parallel-key' })
    expect(fetcher.mock.calls[1]![0]).toBe('https://mcp.exa.ai/mcp')
  })

  it('rejects unsafe URLs and supports markdown and text conversion', async () => {
    const fetcher = vi.fn(async () => new Response('<h1>Hello &amp; hi</h1><script>bad()</script><p>World</p>', { headers: { 'content-type': 'text/html' } }))
    const tools = new WebTools(credentials(), fetcher as never)
    expect(await tools.execute('web_fetch', { url: 'file:///etc/passwd' })).toMatchObject({ isError: true })
    expect(await tools.execute('web_fetch', { url: 'http://127.0.0.1/private' })).toMatchObject({ isError: true })
    expect((await tools.execute('web_fetch', { url: 'https://example.com', format: 'text' })).text).toBe('Hello & hi\nWorld')
    expect((await tools.execute('web_fetch', { url: 'https://example.com' })).text).toBe('# Hello & hi\n\nWorld')
    expect(htmlToText('<b>A&nbsp;B</b>')).toBe('A B')
  })

  it('preserves MCP tool errors returned over SSE', async () => {
    const fetcher = vi.fn(async () => new Response(
      'event: message\ndata:{"result":{"content":[{"type":"text","text":"rate limited"}],"isError":true},"jsonrpc":"2.0","id":1}\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    ))
    await expect(new WebTools(credentials(), fetcher as never).execute('web_search', { query: 'mousse' }))
      .resolves.toEqual({ text: 'rate limited', isError: true })
  })

  it('rejects responses larger than 5 MiB', async () => {
    const fetcher = vi.fn(async () => new Response('small', { headers: { 'content-length': String(5 * 1024 * 1024 + 1) } }))
    const result = await new WebTools(credentials(), fetcher as never).execute('web_fetch', { url: 'https://example.com' })
    expect(result).toMatchObject({ isError: true })
    expect(result.text).toContain('5 MiB')
  })
})
