import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

type JsonRpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string }

/**
 * stdio ↔ Streamable HTTP relay for runtimes that only start stdio MCP servers
 * (`mousse-cli engine mcp-stdio`, SPEC §15.1). Each newline-delimited JSON-RPC message read from
 * `input` is POSTed to the Mousse MCP server with the bearer token; each JSON-RPC response is
 * written to `output` as one line. Requests run concurrently (an `ask_user` call may block for a
 * long time). Resolves once `input` ends and every relayed request has settled.
 */
export async function runStdioBridge(options: {
  url: string
  token: string
  input: Readable
  output: Writable
  fetch?: typeof fetch
}): Promise<void> {
  const send = options.fetch ?? fetch
  const write = (message: unknown): void => {
    options.output.write(`${JSON.stringify(message)}\n`)
  }
  const pending = new Set<Promise<void>>()
  const relay = async (line: string): Promise<void> => {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    const id = message && typeof message === 'object' && 'id' in message ? message.id ?? null : undefined
    try {
      const response = await send(options.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream'
        },
        body: line
      })
      const text = await response.text()
      if (!text.trim()) {
        if (!response.ok && id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32000, message: `HTTP ${response.status}` } })
        return
      }
      const contentType = response.headers.get('content-type') ?? ''
      const bodies = contentType.includes('text/event-stream')
        ? text.split('\n').filter((row) => row.startsWith('data:')).map((row) => row.slice(5).trim()).filter(Boolean)
        : [text]
      for (const body of bodies) {
        const parsed = JSON.parse(body) as JsonRpcMessage
        // Errors without an id (401, 405) answer the request that caused them.
        write(parsed && typeof parsed === 'object' && parsed.id === null && id !== undefined ? { ...parsed, id } : parsed)
      }
    } catch (error) {
      if (id !== undefined)
        write({ jsonrpc: '2.0', id, error: { code: -32000, message: `Mousse MCP relay failed: ${error instanceof Error ? error.message : String(error)}` } })
    }
  }
  const lines = createInterface({ input: options.input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    const task = relay(line).finally(() => pending.delete(task))
    pending.add(task)
  }
  await Promise.all([...pending])
}
