/**
 * docs/plans/tool-api.md §1.3, PR 2b: narrowing from above is live (read at every call, not when the credential was
 * minted), a subagent is known by its lineage, and the owner's own preferences never pass down to a subagent. PR 2b-2:
 * what narrowing takes away mid-work is `revoked`, a subagent's lacks are reported up its tree (§2.4), `person` is a
 * declared need, and a definition turn's list is held to its grants in the registry.
 */
import { describe, expect, it } from 'vitest'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { AppToolTurns, plannedFromAbove, ToolRegistry, type AppToolHost, type AppToolTurn, type LacksReport, type MousseTool } from '../../src/mms/run/mcp/appTools'
import { appletTools } from '../../src/mms/run/mcp/appTools/applets'
import { skillTools } from '../../src/mms/run/mcp/appTools/skills'
import { formatInboxNotice } from '../../src/mms/run/delegation/notice'
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
  it.each([
    ['a thread above switched to Plan while the person answered: refused as taken away, and its handler never runs', 'plan', false],
    ['nothing changed while it asked: the approved call runs', undefined, true]
  ] as const)('a call that asked first: %s', async (_name, after, runs) => {
    let above: ModeCeiling | undefined
    let ran = 0
    const turns = new AppToolTurns()
    turns.register(appTurn({ threadId: 'child', runId: 'run-child' }))
    const registry = new ToolRegistry({
      activeRunId: (threadId) => `run-${threadId}`,
      turns,
      permissionModeFor: () => 'ask',
      liveCeiling: () => above,
      // The person answers; meanwhile the thread above changed (or did not).
      askApproval: async () => {
        above = after
        return { permission: 'allow' }
      }
    }).register(tool('settings', 'changesSettings', { handler: () => { ran += 1; return { text: 'ok' } } }))
    const outcome = registry.call('settings', {}, {
      credential: { threadId: 'child', runId: 'run-child', provider: 'codex', modeCeiling: 'default', accessLevel: 'lineage', binding: 'drained_turn', current: () => true },
      toolCallId: 'c',
      signal: new AbortController().signal
    })
    if (runs) await expect(outcome).resolves.toMatchObject({ text: 'ok' })
    else expect(await denied(outcome)).toMatchObject({ refused: { code: 'revoked', lacks: 'settings' } })
    expect(ran).toBe(runs ? 1 : 0)
  })

  it('a parent switching to Plan narrows its running child at the next call, with the credential minted before', async () => {
    let above: ModeCeiling | undefined
    const { registry, call, turn } = registryFor({ liveCeiling: () => above })
    await expect(call('starts')).resolves.toMatchObject({ text: 'ok' })
    above = 'plan'
    // Held when the turn started and taken away during the work: `revoked`, never retried in it (§2.4).
    expect(await denied(call('starts'))).toMatchObject({ refused: { code: 'revoked', retry: 'never', lacks: 'threads.start' } })
    expect(registry.usableNow(turn())).not.toContain('starts')
    // A Plan turn still writes threads and delegates: only what Plan itself lacks is refused.
    await expect(call('writes')).resolves.toMatchObject({ text: 'ok' })
    above = undefined
    await expect(call('starts')).resolves.toMatchObject({ text: 'ok' })
    expect(registry.usableNow(turn())).toContain('starts')
  })

  it('narrows to Plan when what is above cannot be read', async () => {
    const { call } = registryFor({ liveCeiling: () => { throw new Error('lineage unreadable') } })
    expect(await denied(call('starts'))).toMatchObject({ refused: { code: 'revoked', lacks: 'threads.start' } })
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

/**
 * A subagent `child` of `parent` (whose turn runs in `parentMode`), with a run each. `personOf` says which runs hold
 * `person` as the owner reads it; the registry adds that a subagent never does.
 */
function tree(options: { parentMode?: ModeCeiling; childCeiling?: ModeCeiling; personOf?: (threadId: string) => boolean; liveCeiling?: () => ModeCeiling | undefined } = {}) {
  const turns = new AppToolTurns()
  turns.register(appTurn({ threadId: 'parent', runId: 'run-parent', modeCeiling: options.parentMode ?? 'default' }))
  turns.register(appTurn({ threadId: 'child', runId: 'run-child', subagent: true, modeCeiling: options.childCeiling ?? 'default', modeFacts: { readOnly: false, agent: true, build: false } }))
  const reports: LacksReport[] = []
  const registry = new ToolRegistry({
    activeRunId: (threadId) => `run-${threadId}`,
    turns,
    permissionModeFor: () => 'full',
    subagentThread: (threadId) => threadId === 'child',
    parentThread: (threadId) => (threadId === 'child' ? 'parent' : undefined),
    personHeld: (caller) => options.personOf?.(caller.threadId) === true,
    reportLacks: (report) => void reports.push(report),
    ...(options.liveCeiling ? { liveCeiling: options.liveCeiling } : {})
  })
    .register(tool('starts', 'startsThreads'))
    .register(tool('theme', 'changesSettings', { capabilities: ['themes'] }))
    .register(tool('archive', 'managesOthers', { needsPerson: true }))
    .register(tool('rename_or_run', 'writesThreads', { needsPerson: (args) => args.run === true }))
    .register(tool('facts', 'reads', { available: (turn) => (turn.modeFacts?.readOnly ? 'Not in a read-only turn.' : true) }))
  const call = (threadId: string, name: string, args: Record<string, unknown> = {}, ceiling: ModeCeiling = 'default') =>
    registry.call(name, args, {
      credential: { threadId, runId: `run-${threadId}`, provider: 'codex', modeCeiling: ceiling, accessLevel: 'lineage', binding: 'drained_turn', current: () => true },
      toolCallId: 'c',
      signal: new AbortController().signal
    })
  return { registry, call, reports, turn: (threadId: string) => turns.get(`run-${threadId}`)! }
}

describe('a subagent refused what it lacks tells its tree (§2.4)', () => {
  it('its parent, which holds it, and the refusal says so', async () => {
    const { call, reports } = tree()
    const refusal = await denied(call('child', 'theme'))
    expect(refusal?.refused).toMatchObject({ code: 'lacks_capability', lacks: 'themes', message: expect.stringMatching(/Your parent holds this and was told/) })
    expect(refusal?.details).toMatchObject({ told: 'parent' })
    expect(reports).toEqual([{ threadId: 'child', runId: 'run-child', tool: 'theme', lacks: 'themes', fix: expect.any(String), to: 'parent', parentThreadId: 'parent' }])
  })

  it('the root of its tree when its parent lacks it too, with what would give it', async () => {
    const { call, reports } = tree({ parentMode: 'plan', childCeiling: 'plan' })
    const refusal = await denied(call('child', 'starts', {}, 'plan'))
    expect(refusal?.refused).toMatchObject({ code: 'lacks_capability', lacks: 'threads.start', message: expect.stringMatching(/root of your tree was told/) })
    expect(reports).toEqual([expect.objectContaining({ lacks: 'threads.start', to: 'root', parentThreadId: 'parent', fix: expect.stringMatching(/Agent turn/) })])
  })

  it('`person`: its parent when a person started the parent\'s turn, else the root', async () => {
    const held = tree({ personOf: (threadId) => threadId === 'parent' || threadId === 'child' })
    expect((await denied(held.call('child', 'archive')))?.refused).toMatchObject({ code: 'lacks_capability', lacks: 'person' })
    expect(held.reports.map((report) => report.to)).toEqual(['parent'])
    const none = tree()
    await denied(none.call('child', 'archive'))
    expect(none.reports.map((report) => report.to)).toEqual(['root'])
  })

  it('never for a thread that is not a subagent, nor for what was revoked', async () => {
    let above: ModeCeiling | undefined
    const { call, reports } = tree({ parentMode: 'plan', liveCeiling: () => above })
    expect((await denied(call('parent', 'starts', {}, 'plan')))?.refused.code).toBe('lacks_capability')
    above = 'plan'
    expect((await denied(call('child', 'starts')))?.refused).toMatchObject({ code: 'revoked', retry: 'never' })
    expect(reports).toEqual([])
  })
})

describe('the owner reports a subagent\'s lacks once, to its parent or the root (§2.4)', () => {
  const owner = () => {
    const lineage: Record<string, { parentThreadId: string; relationship: string }> = {
      grandchild: { parentThreadId: 'child', relationship: 'subagent' },
      child: { parentThreadId: 'root', relationship: 'subagent' }
    }
    const rows: Array<{ threadId: string; runId: string | null; kind: string; payload: unknown }> = []
    const proto = OrchestratorService.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
    const self: Record<string, unknown> = {
      reportedLacks: new Set<string>(),
      runEngine: {
        delegations: {
          getLineage: (id: string) => lineage[id],
          listForChildThread: (id: string) => (id === 'grandchild' ? [{ delegationId: 'd1', parentThreadId: 'child', parentRunId: 'run-child', status: 'running' }] : [])
        },
        inbox: { append: (row: (typeof rows)[number]) => void rows.push(row) }
      },
      threadStore: { getThread: (id: string) => ({ id, name: `Thread ${id}` }) }
    }
    for (const name of ['subagentParentOf', 'subagentRootOf', 'titleOf']) self[name] = proto[name].bind(self)
    const report = (extra: Partial<LacksReport> = {}) =>
      proto.reportSubagentLacks.call(self, { threadId: 'grandchild', runId: 'run-g', tool: 'thread_create', lacks: 'threads.start', fix: 'An Agent turn holds this.', to: 'parent', parentThreadId: 'child', ...extra })
    return { rows, report }
  }

  it('wakes the parent with a notice of its delegation, once per capability of the work', () => {
    const { rows, report } = owner()
    report()
    report()
    report({ lacks: 'themes', tool: 'theme_set' })
    expect(rows).toEqual([
      { threadId: 'child', runId: 'run-child', kind: 'reconcile_notice', payload: expect.objectContaining({ kind: 'child_lacks', childThreadId: 'grandchild', lacks: 'threads.start', to: 'parent', delegationId: 'd1' }) },
      expect.objectContaining({ threadId: 'child', payload: expect.objectContaining({ lacks: 'themes' }) })
    ])
    const text = formatInboxNotice({ inboxId: 'i1', threadId: 'child', runId: 'run-child', kind: 'reconcile_notice', payload: rows[0].payload, status: 'pending', createdAt: '', deliveredBy: null }, { titleOf: () => 'Builder' })
    expect(text).toMatch(/kind="subagent_lacks"/)
    expect(text).toMatch(/Subagent "Builder" \(thread grandchild\) was refused thread_create: it does not hold threads\.start\.\s+This thread holds threads\.start/)
  })

  it('tells the root of the tree, with what would give it, when no thread above holds it', () => {
    const { rows, report } = owner()
    report({ to: 'root' })
    expect(rows).toEqual([{ threadId: 'root', runId: null, kind: 'reconcile_notice', payload: expect.objectContaining({ to: 'root', fix: 'An Agent turn holds this.' }) }])
    const text = formatInboxNotice({ inboxId: 'i1', threadId: 'root', runId: null, kind: 'reconcile_notice', payload: rows[0].payload, status: 'pending', createdAt: '', deliveredBy: null })
    expect(text).toMatch(/no thread above it holds threads\.start\.\s+What would give it: An Agent turn holds this\.\s+Tell the user if it matters\./)
  })
})

describe('`person` as a declared need (§1.3 "Provenance")', () => {
  it('is held by a turn a person started in a thread that is not a subagent, and never by a subagent', async () => {
    const { call, registry, turn } = tree({ personOf: () => true })
    await expect(call('parent', 'archive')).resolves.toMatchObject({ text: 'ok' })
    expect(registry.usableNow(turn('parent'))).toContain('archive')
    // The owner says the child's run is a person's: a subagent still does not hold it, and does not list it.
    expect((await denied(call('child', 'archive')))?.refused).toMatchObject({ code: 'lacks_capability', lacks: 'person', fix: expect.any(String) })
    expect(registry.usableNow(turn('child'))).not.toContain('archive')
    expect(registry.listForThread('child').map((listed) => listed.name)).not.toContain('archive')
  })

  it('is needed only by the variants that declare it', async () => {
    const { call, registry, turn } = tree()
    await expect(call('parent', 'rename_or_run', { run: false })).resolves.toMatchObject({ text: 'ok' })
    expect((await denied(call('parent', 'rename_or_run', { run: true })))?.refused).toMatchObject({ code: 'lacks_capability', lacks: 'person' })
    expect(registry.usableNow(turn('parent'))).toContain('rename_or_run')
    expect(registry.usableNow(turn('parent'))).not.toContain('archive')
  })
})

describe('a parent\'s Plan reaches its child\'s mode facts (§1.3 "Subagents")', () => {
  it('the child\'s turn is checked as a Plan turn\'s, read-only, until the parent leaves Plan', async () => {
    let above: ModeCeiling | undefined
    const { call, registry, turn } = tree({ liveCeiling: () => above })
    await expect(call('child', 'facts')).resolves.toMatchObject({ text: 'ok' })
    above = 'plan'
    expect((await denied(call('child', 'facts')))?.refused).toMatchObject({ code: 'revoked', message: expect.stringMatching(/Not in a read-only turn/) })
    expect(registry.usableNow(turn('child'))).not.toContain('facts')
    expect(plannedFromAbove(turn('child'))).toMatchObject({ mode: 'plan', modeCeiling: 'plan', modeFacts: { readOnly: true, agent: false, build: false } })
    above = undefined
    await expect(call('child', 'facts')).resolves.toMatchObject({ text: 'ok' })
  })
})

describe('a definition turn\'s per-turn list (§1.3 "Removed": `offered` is the per-turn definition filter)', () => {
  it('holds only what its grants name, and never a delegation tool even when granted', () => {
    const turns = new AppToolTurns()
    const grants = { builtinTools: [{ id: 'task_list' }, { id: 'answer_subagent' }], mcpTools: [] }
    turns.register(appTurn({ threadId: 't', runId: 'r', definition: { grants, mcpTools: [] } as never }))
    const registry = new ToolRegistry({ activeRunId: () => 'r', turns })
      .register(tool('task_list', 'reads'))
      .register(tool('task_create', 'actsAsCaller'))
      .register(tool('answer_subagent', 'actsAsCaller', { class: 'delegation' }))
    expect(registry.listForTurn('t', 'r').map((listed) => listed.name)).toEqual(['task_list'])
    // Another turn of the thread gets its stable list.
    expect(registry.listForTurn('t', undefined).map((listed) => listed.name)).toEqual(['task_list', 'task_create', 'answer_subagent'])
  })
})

describe('skills in a Plan or read-only turn (§1.5)', () => {
  it('are offered to a runtime that lists tools per turn, as in an Agent turn', () => {
    const tools = skillTools({ skills: () => ({}) } as unknown as AppToolHost)
    const plan = appTurn({ threadId: 'child', runId: 'r', mode: 'plan', modeFacts: { readOnly: true, agent: false, build: false }, enabledSkills: [{ name: 'review' }] as never }) as AppToolTurn
    for (const skill of tools) expect(skill.offered!(plan)).toBe(true)
  })
})

describe('applets in a subagent (§1.5)', () => {
  it('are offered and usable, as in the thread that delegated it', () => {
    const subagent = appTurn({ threadId: 'child', runId: 'r', subagent: true, onPublishApplet: () => ({ queued: true }), onReadApplet: () => ({}) }) as AppToolTurn
    for (const applet of appletTools()) {
      expect(applet.offered?.(subagent) ?? true).toBe(true)
      expect(applet.available?.(subagent) ?? true).toBe(true)
    }
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
