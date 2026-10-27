/**
 * PR 6 §2: neutral built-in tool names. Each driver maps a neutral name to its runtime's names (an
 * array: `search` is two tools on both runtimes); a name a runtime has no tool for is refused. Every
 * mapped name exists in the pinned runtime: Claude Code's in the SDK's `ToolInputSchemas`, Pi's in
 * its `tools/index.js`.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLAUDE_NATIVE_TOOLS } from '../../src/mms/harness/drivers/claudeCode'
import { PI_NATIVE_TOOLS, piDriver, type PiRpcDriverOptions } from '../../src/mms/harness/drivers/pi'
import { mapNeutralTools } from '../../src/mms/harness/policy'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { PiStubAdapter } from '../support/piStub'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { isNeutralTool, NEUTRAL_TOOLS, neutralToolIdempotent, type NeutralTool } from '../../src/shared/harness/tools'

const repoRoot = resolve(__dirname, '..', '..')

describe('neutral tool names', () => {
  it('lists the eight built-ins, and only reads are idempotent', () => {
    expect([...NEUTRAL_TOOLS]).toEqual(['read', 'list', 'search', 'edit', 'write', 'shell', 'web_fetch', 'web_search'])
    expect(NEUTRAL_TOOLS.filter(neutralToolIdempotent)).toEqual(['read', 'list', 'search', 'web_fetch', 'web_search'])
    expect(isNeutralTool('read')).toBe(true)
    expect(isNeutralTool('powershell')).toBe(false)
  })

  it('maps each to the runtimes\' own names', () => {
    expect(CLAUDE_NATIVE_TOOLS).toEqual({ read: ['Read'], list: ['Glob'], search: ['Glob', 'Grep'], edit: ['Edit'], write: ['Write'], shell: ['Bash'], web_fetch: ['WebFetch'], web_search: ['WebSearch'] })
    expect(PI_NATIVE_TOOLS).toEqual({ read: ['read'], list: ['ls'], search: ['find', 'grep'], edit: ['edit'], write: ['write'], shell: ['bash'] })
  })

  it('maps a set of tools once each, or names what the runtime lacks', () => {
    const claude = (neutral: NeutralTool) => CLAUDE_NATIVE_TOOLS[neutral] ?? []
    const pi = (neutral: NeutralTool) => PI_NATIVE_TOOLS[neutral] ?? []
    expect(mapNeutralTools(claude, ['read', 'list', 'search'])).toEqual({ ok: true, names: ['Read', 'Glob', 'Grep'] })
    expect(mapNeutralTools(pi, ['read', 'search', 'edit'])).toEqual({ ok: true, names: ['read', 'find', 'grep', 'edit'] })
    expect(mapNeutralTools(pi, ['read', 'web_fetch', 'web_search'])).toEqual({ ok: false, unmapped: ['web_fetch', 'web_search'] })
    // A driver without a mapping maps nothing.
    expect(mapNeutralTools(undefined, ['read'])).toEqual({ ok: false, unmapped: ['read'] })
    expect(mapNeutralTools(undefined, [])).toEqual({ ok: true, names: [] })
  })

  it('maps Pi\'s tools on its RPC engine only: the legacy loop runs Mousse\'s own tools', () => {
    const driver = piDriver({ rpc: {} as PiRpcDriverOptions })
    expect(driver.nativeToolNames!('search', { home: 'private', engine: 'rpc' })).toEqual(['find', 'grep'])
    expect(driver.nativeToolNames!('search', { home: 'default' })).toEqual([])
    expect(driver.nativeToolNames!('web_fetch', { home: 'private', engine: 'rpc' })).toEqual([])
  })

  it('the gateway refuses a tool the instance has no name for with policy_unenforceable', () => {
    const pi = new PiStubAdapter()
    const driver = { ...adapterDriver(pi), nativeToolNames: (neutral: NeutralTool) => PI_NATIVE_TOOLS[neutral] ?? [] }
    const instances = new ProviderInstanceService({
      store: { read: () => ({ instances: undefined }), write: () => {} },
      providerAuth: { credentials: { listProviderIds: () => ['openrouter'] } }
    })
    const harness = testHarness({ drivers: [driver], instances })
    expect(harness.nativeToolNames('pi:openrouter', ['read', 'edit'])).toEqual({ ok: true, names: ['read', 'edit'] })
    expect(harness.nativeToolNames('pi:openrouter', ['read', 'web_fetch'])).toMatchObject({
      ok: false,
      error: { code: 'policy_unenforceable', missing: ['toolControl'], instanceId: 'pi:openrouter', reason: expect.stringContaining('web_fetch') }
    })
  })
})

describe('the pinned runtimes have every mapped name', () => {
  it('Claude Code: each name has its input schema in the pinned SDK\'s ToolInputSchemas', () => {
    const source = readFileSync(join(repoRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts'), 'utf8')
    const union = /export type ToolInputSchemas =([^;]*);/.exec(source)?.[1]
    expect(union, 'ToolInputSchemas in sdk-tools.d.ts').toBeDefined()
    const schemas = new Set([...union!.matchAll(/\|\s*(\w+)/g)].map((match) => match[1]))
    // The SDK names a built-in's input after the tool (file tools carry a `File` prefix).
    const schemaOf: Record<string, string> = { Read: 'FileReadInput', Edit: 'FileEditInput', Write: 'FileWriteInput', Glob: 'GlobInput', Grep: 'GrepInput', Bash: 'BashInput', WebFetch: 'WebFetchInput', WebSearch: 'WebSearchInput' }
    const names = [...new Set(Object.values(CLAUDE_NATIVE_TOOLS).flat())]
    expect(names.sort()).toEqual(Object.keys(schemaOf).sort())
    for (const name of names) expect(schemas.has(schemaOf[name]), name).toBe(true)
  })

  it('Pi: each name is one of the pinned Pi\'s tools, and only powershell has no neutral name', () => {
    const source = readFileSync(join(repoRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js'), 'utf8')
    const list = /allToolNames = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1]
    expect(list, 'allToolNames in tools/index.js').toBeDefined()
    const pinned = [...list!.matchAll(/"([\w-]+)"/g)].map((match) => match[1])
    const mapped = [...new Set(Object.values(PI_NATIVE_TOOLS).flat())]
    for (const name of mapped) expect(pinned, name).toContain(name)
    expect(pinned.filter((name) => !mapped.includes(name))).toEqual(['powershell'])
  })
})
