/**
 * Relayed tool names and listing (SPEC §15.5): `<server>__<tool>` within 45 characters, sorted,
 * collisions and long names hashed deterministically, unusable tools dropped with a reason, at most
 * 128 tools, provenance on every description, and a digest of names and schemas only.
 */
import { describe, expect, it } from 'vitest'
import type { McpToolDescriptor } from '../../src/shared/integrations'
import { CLAUDE_RELAY_TOOL_PREFIX } from '../../src/mms/run/mcp/attachment'
import {
  allocateRelayTools,
  RELAY_MAX_DESCRIPTION_CHARS,
  RELAY_MAX_RESULT_CHARS,
  RELAY_MAX_SCHEMA_BYTES,
  RELAY_MAX_TOOLS,
  RELAY_NAME_BUDGET,
  RELAY_SEPARATOR,
  relayListingDigest,
  relayPermissionKey
} from '../../src/mms/run/mcp/relay/names'

const OBJECT = { type: 'object', properties: { q: { type: 'string' } } }

function tool(serverName: string, toolName: string, overrides: Partial<McpToolDescriptor> = {}): McpToolDescriptor {
  const installationId = overrides.installationId ?? `inst-${serverName}`
  return {
    id: `${installationId}:${toolName}`,
    serverId: `srv-${serverName}`,
    serverName,
    toolName,
    providerName: `mcp__${serverName}__${toolName}__abcd1234`,
    description: `${toolName} on ${serverName}`,
    inputSchema: OBJECT,
    installationId,
    configRevision: `rev-${serverName}`,
    ...overrides
  }
}

describe('relay names', () => {
  it('has the agreed limits', () => {
    expect(RELAY_SEPARATOR).toBe('__')
    expect(RELAY_NAME_BUDGET).toBe(45)
    expect(CLAUDE_RELAY_TOOL_PREFIX.length + RELAY_NAME_BUDGET).toBe(64)
    expect(RELAY_MAX_TOOLS).toBe(128)
    expect(RELAY_MAX_DESCRIPTION_CHARS).toBe(1024)
    expect(RELAY_MAX_SCHEMA_BYTES).toBe(16 * 1024)
    expect(RELAY_MAX_RESULT_CHARS).toBe(64_000)
    expect(relayPermissionKey('inst-1')).toBe('relay:inst-1')
  })

  it('names tools <server>__<tool>, sorted by server then tool, and keeps what they resolve to', () => {
    const { tools, dropped } = allocateRelayTools([tool('linear', 'search'), tool('github', 'create_issue'), tool('github', 'add-comment')])
    expect(dropped).toEqual([])
    expect(tools.map((relayed) => relayed.name)).toEqual(['github__add_comment', 'github__create_issue', 'linear__search'])
    expect(tools[0]).toEqual({
      name: 'github__add_comment',
      description: '[MCP server "github"] add-comment on github',
      inputSchema: OBJECT,
      installationId: 'inst-github',
      serverName: 'github',
      toolName: 'add-comment',
      providerName: 'mcp__github__add-comment__abcd1234',
      configRevision: 'rev-github'
    })
  })

  it('never puts the separator inside a part', () => {
    const { tools } = allocateRelayTools([tool('my__server', 'do__it'), tool('__x__', '--y--')])
    for (const relayed of tools) {
      expect(relayed.name.split(RELAY_SEPARATOR), relayed.name).toHaveLength(2)
      expect(relayed.name).toMatch(/^[A-Za-z0-9]+(_[A-Za-z0-9]+)*__[A-Za-z0-9]+(_[A-Za-z0-9]+)*$/)
    }
    // Sorted by the server's own name: `__x__` before `my__server`.
    expect(tools.map((relayed) => relayed.name)).toEqual(['x__y', 'my_server__do_it'])
  })

  it('gives two installations with the same server part each a hash of their installation', () => {
    const { tools } = allocateRelayTools([
      tool('github', 'search', { installationId: 'inst-a' }),
      tool('git-hub', 'search', { installationId: 'inst-b' }),
      tool('git_hub', 'search', { installationId: 'inst-c' }),
      tool('linear', 'search')
    ])
    const names = tools.map((relayed) => relayed.name)
    expect(new Set(names).size).toBe(4)
    // `github` is its own part; `git-hub` and `git_hub` both sanitize to `git_hub`.
    expect(names).toContain('github__search')
    expect(names).toContain('linear__search')
    const hashed = names.filter((name) => name.startsWith('git_hub'))
    expect(hashed).toHaveLength(2)
    for (const name of hashed) expect(name).toMatch(/^git_hub_[0-9a-f]{6}__search$/)
    // The same installations get the same names whatever order they are listed in.
    const again = allocateRelayTools([tool('git_hub', 'search', { installationId: 'inst-c' }), tool('git-hub', 'search', { installationId: 'inst-b' })])
    expect(again.tools.map((relayed) => relayed.name).sort()).toEqual([...hashed].sort())
  })

  it('hashes a second tool name that sanitizes like the first', () => {
    const { tools, dropped } = allocateRelayTools([tool('fs', 'read-file'), tool('fs', 'read_file')])
    expect(dropped).toEqual([])
    const names = tools.map((relayed) => relayed.name)
    expect(names[0]).toBe('fs__read_file')
    expect(names[1]).toMatch(/^fs__read_file_[0-9a-f]{6}$/)
  })

  it('keeps long names within the budget, deterministic and distinct', () => {
    const longTool = 'get_the_very_long_named_resource_from_the_remote_service'
    const input = [
      tool('short', longTool),
      tool('short', `${longTool}_v2`),
      tool('an_extraordinarily_long_server_name_for_testing', 'search')
    ]
    const first = allocateRelayTools(input).tools
    const second = allocateRelayTools([...input].reverse()).tools
    expect(second).toEqual(first)
    const names = first.map((relayed) => relayed.name)
    expect(new Set(names).size).toBe(3)
    for (const name of names) {
      expect(name.length, name).toBeLessThanOrEqual(RELAY_NAME_BUDGET)
      expect(name.split(RELAY_SEPARATOR), name).toHaveLength(2)
    }
    // A server part over 24 characters is cut and keeps a hash of its installation.
    expect(names.find((name) => name.startsWith('an_'))).toMatch(/^an_extraordinaril_[0-9a-f]{6}__search$/)
    expect(names.filter((name) => name.startsWith('short__')).every((name) => /_[0-9a-f]{6}$/.test(name))).toBe(true)
  })

  it('drops tools with a schema error, an oversized schema or a duplicate, with the reason', () => {
    const big = { type: 'object', properties: { blob: { type: 'string', description: 'x'.repeat(RELAY_MAX_SCHEMA_BYTES) } } }
    const { tools, dropped } = allocateRelayTools([
      tool('s', 'ok'),
      tool('s', 'broken', { schemaError: 'bad $ref' }),
      tool('s', 'huge', { inputSchema: big }),
      tool('s', 'ok', { id: 'dup' })
    ])
    expect(tools.map((relayed) => relayed.name)).toEqual(['s__ok'])
    expect(dropped.map((entry) => entry.id).sort()).toEqual(['dup', 'inst-s:broken', 'inst-s:huge'].sort())
    for (const entry of dropped) expect(entry.reason).toBeTruthy()
  })

  it('lists at most 128 tools, the first in order', () => {
    const many = Array.from({ length: RELAY_MAX_TOOLS + 5 }, (_, index) => tool('srv', `t${String(index).padStart(3, '0')}`))
    const { tools, dropped } = allocateRelayTools(many)
    expect(tools).toHaveLength(RELAY_MAX_TOOLS)
    expect(tools.at(-1)!.name).toBe('srv__t127')
    expect(dropped.map((entry) => entry.id)).toEqual(['inst-srv:t128', 'inst-srv:t129', 'inst-srv:t130', 'inst-srv:t131', 'inst-srv:t132'])
  })

  it('prefixes descriptions with the server, strips control characters and caps the length', () => {
    const { tools } = allocateRelayTools([
      tool('evil"srv', 'a', { description: 'line one\nline\u0007 two\u001b[31m\u009b' }),
      tool('long', 'b', { description: 'y'.repeat(5000) }),
      tool('none', 'c', { description: undefined })
    ])
    const byTool = Object.fromEntries(tools.map((relayed) => [relayed.toolName, relayed.description]))
    expect(byTool.a).toBe('[MCP server "evil\'srv"] line one\nline two[31m')
    expect(byTool.b).toHaveLength(RELAY_MAX_DESCRIPTION_CHARS)
    expect(byTool.b!.startsWith('[MCP server "long"] yyy')).toBe(true)
    expect(byTool.c).toBe('[MCP server "none"] ')
  })

  it('gives a tool without an object schema an open object schema', () => {
    const { tools } = allocateRelayTools([tool('s', 'a', { inputSchema: undefined }), tool('s', 'b', { inputSchema: { type: 'string' } })])
    for (const relayed of tools) expect(relayed.inputSchema).toEqual({ type: 'object', additionalProperties: true })
  })

  it('digests names and schemas, not descriptions or order', () => {
    const base = allocateRelayTools([tool('a', 'x'), tool('b', 'y')]).tools
    const digest = relayListingDigest(base)
    expect(digest).toMatch(/^[0-9a-f]{12}$/)
    expect(relayListingDigest([...base].reverse())).toBe(digest)
    expect(relayListingDigest(base.map((relayed) => ({ ...relayed, description: 'changed' })))).toBe(digest)
    expect(relayListingDigest(allocateRelayTools([tool('a', 'x'), tool('b', 'y', { inputSchema: { type: 'object' } })]).tools)).not.toBe(digest)
    expect(relayListingDigest(allocateRelayTools([tool('a', 'x'), tool('b', 'z')]).tools)).not.toBe(digest)
    expect(relayListingDigest([])).toMatch(/^[0-9a-f]{12}$/)
  })
})
