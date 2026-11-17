/**
 * docs/plans/tool-api.md §1.3, PR 2b: narrowing from above is live (read at every call, not when the credential was
 * minted), a subagent is known by its lineage, and the owner's own preferences never pass down to a subagent.
 */
import { describe, expect, it } from 'vitest'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { AppToolTurns, ToolRegistry, type AppToolTurn, type MousseTool } from '../../src/mms/run/mcp/appTools'
import type { ModeCeiling } from '../../src/mms/run/types'
import { appTurn, denied } from './appToolsFixture'

const tool = (name: string, access: MousseTool['access'], extra: Partial<MousseTool> = {}): MousseTool =>
  ({ name, description: name, inputSchema: {}, access, class: 'mutation', handler: () => ({ text: 'ok' }), ...extra }) as MousseTool

function registryFor(options: { liveCeiling?: (threadId: string) => ModeCeiling | undefined; subagent?: boolean }) {
  const turns = new AppToolTurns()
  turns.register(appTurn({ threadId: 'child', runId: 'run-child', ...(options.subagent ? { subagent: true } : {}) }))
  const registry = new ToolRegistry({
    activeRunId: (threadId) => `run-${threadId}`,
    turns,
    permissionModeFor: () => 'full',
    ...(options.liveCeiling ? { liveCeiling: options.liveCeiling } : {}),
    subagentThread: () => options.subagent === true
  })
    .register(tool('starts', 'startsThreads'))
    .register(tool('writes', 'writesThreads'))
    .register(tool('theme', 'changesSettings', { capabilities: ['themes'] }))
  const call = (name: string) =>
    registry.call(name, {}, {
      credential: { threadId: 'child', runId: 'run-child', provider: 'codex', modeCeiling: 'default', accessLevel: 'lineage', binding: 'drained_turn', current: () => true },
      toolCallId: 'c',
      signal: new AbortController().signal
    })
  return { registry, call, turn: () => turns.get('run-child')! }
}

describe('narrowing from above', () => {
  it('a parent switching to Plan narrows its running child at the next call, with the credential minted before', async () => {
    let above: ModeCeiling | undefined
    const { registry, call, turn } = registryFor({ liveCeiling: () => above })
    await expect(call('starts')).resolves.toMatchObject({ text: 'ok' })
    above = 'plan'
    expect(await denied(call('starts'))).toMatchObject({ refused: { code: 'lacks_capability', lacks: 'threads.start' } })
    expect(registry.usableNow(turn())).not.toContain('starts')
    // A Plan turn still writes threads and delegates: only what Plan itself lacks is refused.
    await expect(call('writes')).resolves.toMatchObject({ text: 'ok' })
    above = undefined
    await expect(call('starts')).resolves.toMatchObject({ text: 'ok' })
    expect(registry.usableNow(turn())).toContain('starts')
  })

  it('narrows to Plan when what is above cannot be read', async () => {
    const { call } = registryFor({ liveCeiling: () => { throw new Error('lineage unreadable') } })
    expect(await denied(call('starts'))).toMatchObject({ refused: { code: 'lacks_capability', lacks: 'threads.start' } })
  })

  it('reads the ceiling of every ancestor of a subagent, and stops at a thread that is not one', () => {
    const lineage: Record<string, { parentThreadId: string; relationship: string }> = {
      grandchild: { parentThreadId: 'child', relationship: 'subagent' },
      child: { parentThreadId: 'root', relationship: 'subagent' },
      fork: { parentThreadId: 'root', relationship: 'fork' },
      loop: { parentThreadId: 'loop', relationship: 'subagent' }
    }
    const ceilings: Record<string, ModeCeiling> = { root: 'plan', child: 'default', loop: 'default' }
    const self = {
      runEngine: { delegations: { getLineage: (id: string) => lineage[id] }, getActiveRun: (id: string) => (ceilings[id] ? { runId: `run-${id}` } : undefined) },
      appToolTurns: { get: (runId: string) => ({ modeCeiling: ceilings[runId.slice('run-'.length)] }) as AppToolTurn }
    }
    const ancestorCeiling = (OrchestratorService.prototype as unknown as { ancestorCeiling(this: unknown, id: string): ModeCeiling | undefined }).ancestorCeiling
    expect(ancestorCeiling.call(self, 'grandchild')).toBe('plan')
    expect(ancestorCeiling.call(self, 'fork')).toBeUndefined()
    expect(ancestorCeiling.call(self, 'root')).toBeUndefined()
    ceilings.root = 'default'
    expect(ancestorCeiling.call(self, 'grandchild')).toBeUndefined()
    expect(() => ancestorCeiling.call(self, 'loop')).toThrow(/deeper than 64/)
  })
})

describe("the owner's preferences in a subagent", () => {
  it('are neither listed nor held, and the refusal names what is missing', async () => {
    const { registry, call } = registryFor({ subagent: true })
    expect(registry.listForThread('child').map((t) => t.name)).not.toContain('theme')
    expect(await denied(call('theme'))).toMatchObject({ refused: { code: 'lacks_capability', lacks: 'themes', fix: expect.stringMatching(/parent/) } })
  })

  it('stay with a thread that is not a subagent', async () => {
    const { registry, call } = registryFor({})
    expect(registry.listForThread('child').map((t) => t.name)).toContain('theme')
    await expect(call('theme')).resolves.toMatchObject({ text: 'ok' })
  })
})
