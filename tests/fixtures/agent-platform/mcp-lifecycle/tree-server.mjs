#!/usr/bin/env node
/**
 * Harmless stdio MCP fixture that owns a grandchild writing heartbeat/profile files.
 * No network, credentials, or models.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, openSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (process.env.MCP_LIFECYCLE_ROLE === 'grandchild') {
  process.on('SIGTERM', () => {})
  process.on('SIGINT', () => {})
  process.on('SIGHUP', () => {})
  const heartbeat = process.env.MCP_LIFECYCLE_HEARTBEAT
  const profile = process.env.MCP_LIFECYCLE_PROFILE
  if (profile) openSync(profile, 'a')
  const tick = () => {
    if (heartbeat) appendFileSync(heartbeat, `${Date.now()}\n`)
  }
  tick()
  setInterval(tick, 50)
} else {
  startParent()
}

function startParent() {
  if (process.env.MCP_LIFECYCLE_START_LOG) {
    appendFileSync(
      process.env.MCP_LIFECYCLE_START_LOG,
      `${JSON.stringify({ type: 'started', pid: process.pid, at: Date.now() })}\n`
    )
  }

  const grandchild = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: {
      ...process.env,
      MCP_LIFECYCLE_ROLE: 'grandchild'
    },
    stdio: 'ignore',
    windowsHide: true,
    detached: false,
    shell: false
  })
  grandchild.unref()
  grandchild.once('spawn', () => {
    if (!process.env.MCP_LIFECYCLE_PIDS) return
    writeFileSync(
      process.env.MCP_LIFECYCLE_PIDS,
      `${JSON.stringify({ parent: process.pid, grandchild: grandchild.pid })}\n`
    )
  })

  const tools = [
    {
      name: 'echo',
      description: 'Echo arguments as structured content.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
    }
  ]

  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line.trim()) handleMessage(JSON.parse(line), tools)
      newline = buffer.indexOf('\n')
    }
  })
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handleMessage(message, tools) {
  if (message.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mousse-mcp-lifecycle-tree', version: '1.0.0' }
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
    const text = String(message.params?.arguments?.text ?? '')
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text }],
        structuredContent: { echoed: text },
        isError: false
      }
    })
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
