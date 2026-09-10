#!/usr/bin/env node
/**
 * Bounded stdio MCP fixture. No network, no credentials.
 * Tools: echo, picture, fail, hang.
 */
import { Buffer } from 'node:buffer'

const tools = [
  {
    name: 'echo',
    description: 'Echo arguments as structured content.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } }
    }
  },
  {
    name: 'picture',
    description: 'Return a tiny PNG image block.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'fail',
    description: 'Return isError without pretending success.',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } }
  },
  {
    name: 'hang',
    description: 'Wait until cancelled or the hang timeout.',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } } }
  }
]

const pending = new Map()
let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline).replace(/\r$/, '')
    buffer = buffer.slice(newline + 1)
    if (line.trim()) handleMessage(JSON.parse(line))
    newline = buffer.indexOf('\n')
  }
})

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handleMessage(message) {
  if (message.method === 'notifications/cancelled') {
    const id = message.params?.requestId
    const entry = pending.get(id)
    if (entry) {
      clearTimeout(entry.timer)
      pending.delete(id)
      write({
        jsonrpc: '2.0',
        id,
        error: { code: -32800, message: 'Request cancelled' }
      })
    }
    return
  }

  if (message.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mousse-mcp-fixture', version: '1.0.0' }
      }
    })
    return
  }

  if (message.method === 'notifications/initialized') return

  if (message.method === 'ping') {
    write({ jsonrpc: '2.0', id: message.id, result: {} })
    return
  }

  if (message.method === 'tools/list') {
    write({ jsonrpc: '2.0', id: message.id, result: { tools } })
    return
  }

  if (message.method === 'tools/call') {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
    if (name === 'hang') {
      const timer = setTimeout(() => {
        pending.delete(message.id)
        write({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: 'hung-complete' }] }
        })
      }, Number(args.ms ?? 8_000))
      pending.set(message.id, { timer })
      return
    }
    write({ jsonrpc: '2.0', id: message.id, result: callTool(name, args) })
    return
  }

  if (message.id != null) {
    write({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Unknown method ${message.method}` }
    })
  }
}

function callTool(name, args) {
  if (name === 'echo') {
    const text = String(args.text ?? '')
    return {
      content: [{ type: 'text', text }],
      structuredContent: { echoed: text },
      isError: false
    }
  }
  if (name === 'picture') {
    return {
      content: [
        {
          type: 'image',
          mimeType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
        },
        {
          type: 'resource_link',
          uri: 'fixture://image',
          name: 'pixel',
          mimeType: 'image/png'
        }
      ],
      isError: false
    }
  }
  if (name === 'fail') {
    return {
      content: [{ type: 'text', text: String(args.message ?? 'failed') }],
      isError: true
    }
  }
  return {
    content: [{ type: 'text', text: `Unknown tool ${name}` }],
    isError: true
  }
}
