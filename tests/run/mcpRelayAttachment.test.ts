/**
 * The MCP relay in every runtime's MCP configuration (SPEC §15.5): a second `mousse-relay` entry with
 * the same bearer when the attachment carries `relay`, and output byte-identical to the plain
 * attachment's without it.
 */
import { describe, expect, it } from 'vitest'
import {
  acpMcpServers,
  claudeMcpServers,
  CLAUDE_MOUSSE_TOOL_PREFIX,
  CLAUDE_RELAY_TOOL_PREFIX,
  codexMcpConfigOverrides,
  cursorMcpServers,
  isMousseServerTool,
  MOUSSE_MCP_TOKEN_ENV,
  MOUSSE_MCP_TOOL_TIMEOUT_MS,
  MOUSSE_RELAY_SERVER_NAME,
  RELAY_CALL_TIMEOUT_MS,
  type CliCommand
} from '../../src/mms/run/mcp/attachment'

const PLAIN = { url: 'http://127.0.0.1:4567/mcp', token: 'tok-secret' }
const RELAYED = { ...PLAIN, relay: { url: 'http://127.0.0.1:4567/mcp/relay', revision: 'rev-1' } }
const CLI: CliCommand = { command: '/bin/mousse', args: ['--cli'], env: { MOUSSE_CLI: '1' } }
const AUTH = 'Bearer tok-secret'

describe('MCP relay attachment', () => {
  it('names the relay and its Claude prefix, and tells Mousse servers\' tools apart', () => {
    expect(MOUSSE_RELAY_SERVER_NAME).toBe('mousse-relay')
    expect(CLAUDE_RELAY_TOOL_PREFIX).toBe('mcp__mousse-relay__')
    expect(CLAUDE_RELAY_TOOL_PREFIX).toHaveLength(19)
    expect(RELAY_CALL_TIMEOUT_MS).toBe(240_000)
    expect(isMousseServerTool(`${CLAUDE_MOUSSE_TOOL_PREFIX}thread_read`)).toBe(true)
    expect(isMousseServerTool(`${CLAUDE_RELAY_TOOL_PREFIX}github__create_issue`)).toBe(true)
    for (const other of ['mcp__github__create_issue', 'mcp__mousse_relay__x', 'mcp__mousse-relayx__y', 'Bash', 'mousse__thread_read'])
      expect(isMousseServerTool(other), other).toBe(false)
  })

  it('leaves every runtime\'s configuration byte-identical without a relay', () => {
    expect(JSON.stringify(claudeMcpServers(PLAIN))).toBe(JSON.stringify({ mousse: { type: 'http', url: PLAIN.url, headers: { Authorization: AUTH }, timeout: 3_600_000 } }))
    expect(JSON.stringify(cursorMcpServers(PLAIN))).toBe(JSON.stringify({ mousse: { type: 'http', url: PLAIN.url, headers: { Authorization: AUTH } } }))
    expect(JSON.stringify(acpMcpServers(PLAIN, { http: true }))).toBe(JSON.stringify([{ name: 'mousse', type: 'http', url: PLAIN.url, headers: [{ name: 'Authorization', value: AUTH }] }]))
    expect(JSON.stringify(acpMcpServers(PLAIN, { http: false, cli: CLI }))).toBe(JSON.stringify([{
      name: 'mousse', command: '/bin/mousse', args: ['--cli', 'engine', 'mcp-stdio', '--url', PLAIN.url], env: [{ name: 'MOUSSE_CLI', value: '1' }, { name: MOUSSE_MCP_TOKEN_ENV, value: 'tok-secret' }]
    }]))
    expect(JSON.stringify(codexMcpConfigOverrides(PLAIN))).toBe(JSON.stringify({
      'mcp_servers.mousse.url': PLAIN.url,
      'mcp_servers.mousse.http_headers': { Authorization: AUTH },
      'mcp_servers.mousse.tool_timeout_sec': 3600,
      'mcp_servers.mousse.default_tools_approval_mode': 'approve'
    }))
    for (const none of [null, undefined]) {
      expect(claudeMcpServers(none)).toEqual({})
      expect(cursorMcpServers(none)).toEqual({})
      expect(acpMcpServers(none, { http: true })).toEqual([])
      expect(codexMcpConfigOverrides(none)).toEqual({})
    }
  })

  it('Claude Code and Cursor get a second HTTP server under the same bearer', () => {
    expect(claudeMcpServers(RELAYED)).toEqual({
      mousse: { type: 'http', url: PLAIN.url, headers: { Authorization: AUTH }, timeout: 3_600_000 },
      'mousse-relay': { type: 'http', url: RELAYED.relay.url, headers: { Authorization: AUTH }, timeout: MOUSSE_MCP_TOOL_TIMEOUT_MS }
    })
    expect(cursorMcpServers(RELAYED)).toEqual({
      mousse: { type: 'http', url: PLAIN.url, headers: { Authorization: AUTH } },
      'mousse-relay': { type: 'http', url: RELAYED.relay.url, headers: { Authorization: AUTH } }
    })
  })

  it('an ACP agent gets a second HTTP server, or a second stdio bridge pointed at the relay', () => {
    expect(acpMcpServers(RELAYED, { http: true })).toEqual([
      { name: 'mousse', type: 'http', url: PLAIN.url, headers: [{ name: 'Authorization', value: AUTH }] },
      { name: 'mousse-relay', type: 'http', url: RELAYED.relay.url, headers: [{ name: 'Authorization', value: AUTH }] }
    ])
    const env = [{ name: 'MOUSSE_CLI', value: '1' }, { name: MOUSSE_MCP_TOKEN_ENV, value: 'tok-secret' }]
    const stdio = acpMcpServers(RELAYED, { http: false, cli: CLI })
    expect(stdio).toEqual([
      { name: 'mousse', command: '/bin/mousse', args: ['--cli', 'engine', 'mcp-stdio', '--url', PLAIN.url], env },
      { name: 'mousse-relay', command: '/bin/mousse', args: ['--cli', 'engine', 'mcp-stdio', '--url', RELAYED.relay.url], env }
    ])
    // The token stays out of every argument list.
    for (const server of stdio) expect('args' in server ? server.args.join(' ') : '').not.toContain('tok-secret')
  })

  it('Codex gets pre-approved relay keys with Mousse\'s timeout: the approval card counts against it', () => {
    expect(codexMcpConfigOverrides(RELAYED)).toEqual({
      'mcp_servers.mousse.url': PLAIN.url,
      'mcp_servers.mousse.http_headers': { Authorization: AUTH },
      'mcp_servers.mousse.tool_timeout_sec': 3600,
      'mcp_servers.mousse.default_tools_approval_mode': 'approve',
      'mcp_servers.mousse-relay.url': RELAYED.relay.url,
      'mcp_servers.mousse-relay.http_headers': { Authorization: AUTH },
      'mcp_servers.mousse-relay.tool_timeout_sec': 3600,
      'mcp_servers.mousse-relay.default_tools_approval_mode': 'approve'
    })
  })
})
