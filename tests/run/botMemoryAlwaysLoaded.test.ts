import { afterEach, describe, expect, it } from 'vitest'
import { ALWAYS_LOAD_META, listedTool } from '../../src/mms/run/mcp/MousseMcpServer'
import { disposeFixtures, memoryFixture } from '../bots/memory/memoryFixture'
import { appToolRegistry, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

/**
 * Claude Code defers MCP tools behind its tool search unless a tool's `tools/list` entry carries
 * `_meta['anthropic/alwaysLoad']`. The bot's memory_save and memory_forget carry it, so a bot turn
 * has their full definitions without searching; every other Mousse tool is listed as before.
 */

let fx: DelegationFixture | undefined
afterEach(() => {
  fx?.dispose()
  fx = undefined
  disposeFixtures()
})

function registry() {
  fx = delegationFixture()
  const memory = memoryFixture()
  return appToolRegistry(fx.engine, fakeAppToolHost().host, { botMemory: { activationOf: () => undefined, memory: memory.store } }).registry
}

describe('bot memory tools in tools/list', () => {
  it('lists memory_save and memory_forget fully loaded on a bot thread', () => {
    const listed = registry().listFor({ readOnly: false, botRole: 'activation' }).map(listedTool)
    const save = listed.find((tool) => tool.name === 'memory_save')
    expect(save).toMatchObject({ _meta: { [ALWAYS_LOAD_META]: true }, inputSchema: { type: 'object', properties: { text: { type: 'string' }, kind: expect.anything() } } })
    expect(save?.description).toContain('kind owner')
    expect(listed.find((tool) => tool.name === 'memory_forget')?._meta).toEqual({ [ALWAYS_LOAD_META]: true })
    // The other memory tools stay behind tool search.
    for (const name of ['memory_search', 'memory_read', 'memory_list']) expect(listed.find((tool) => tool.name === name)).not.toHaveProperty('_meta')
  })

  it('leaves every other tool unchanged', () => {
    const all = registry().list()
    const loaded = all.filter((tool) => tool.alwaysLoad).map((tool) => tool.name)
    // And the tool catalogue, which is how a bot on Claude Code finds the rest (docs/plans/bot-context.md §15).
    // And the open items' tools: an ask is listed in the turn it is made, and a status answer reads the list first.
    expect(loaded.sort()).toEqual(['item_list', 'item_save', 'memory_forget', 'memory_save', 'tool_catalogue'])
    for (const tool of all.filter((entry) => !entry.alwaysLoad))
      expect(listedTool(tool)).toEqual({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
    expect(all.length).toBeGreaterThan(20)
  })
})
