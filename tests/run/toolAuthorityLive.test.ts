/**
 * docs/plans/tool-api.md §1.3: a subagent is known by its lineage, and the owner's own preferences never pass down to a
 * subagent. A subagent's lacks are reported up its tree (§2.4), `person` is a declared need, and a definition turn's
 * list is held to its grants in the registry.
 */
import { describe, expect, it } from 'vitest'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { AppToolTurns, ToolRegistry, type AppToolHost, type AppToolTurn, type LacksReport, type MousseTool } from '../../src/mms/run/mcp/appTools'
import { appletTools } from '../../src/mms/run/mcp/appTools/applets'
import { skillTools } from '../../src/mms/run/mcp/appTools/skills'
import { formatInboxNotice } from '../../src/mms/run/delegation/notice'
import { appTurn, denied } from './appToolsFixture'

const tool = (name: string, access: MousseTool['access'], extra: Partial<MousseTool> = {}): MousseTool =>
  ({ name, description: name, inputSchema: {}, access, class: 'mutation', handler: () => ({ text: 'ok' }), ...extra }) as MousseTool

function registryFor(options: { subagent?: boolean }) {
  const turns = new AppToolTurns()
  turns.register(appTurn({ threadId: 'child', runId: 'run-child', ...(options.subagent ? { subagent: true } : {}) }))
  const registry = new ToolRegistry({
    activeRunId: (threadId) => `run-${threadId}`,
    turns,
    permissionModeFor: () => 'full',
    subagentThread: () => options.subagent === true
  })
    .register(tool('starts', 'startsThreads'))
    .register(tool('writes', 'writesThreads'))
    .register(tool('theme', 'changesSettings', { capabilities: ['themes'] }))
  const call = (name: string) =>
    registry.call(name, {}, {
      credential: { threadId: 'child', runId: 'run-child', provider: 'codex', accessLevel: 'lineage', binding: 'drained_turn', current: () => true },
      toolCallId: 'c',
      signal: new AbortController().signal
    })
  return { registry, call, turn: () => turns.get('run-child')! }
}

/**
 * A subagent `child` of `parent`, with a run each. `personOf` says which runs hold
 * `person` as the owner reads it; the registry adds that a subagent never does.
 */
function tree(options: { personOf?: (threadId: string) => boolean } = {}) {
  const turns = new AppToolTurns()
  turns.register(appTurn({ threadId: 'parent', runId: 'run-parent' }))
  turns.register(appTurn({ threadId: 'child', runId: 'run-child', subagent: true, modeFacts: { readOnly: false, agent: true, build: false } }))
  const reports: LacksReport[] = []
  const registry = new ToolRegistry({
    activeRunId: (threadId) => `run-${threadId}`,
    turns,
    permissionModeFor: () => 'full',
    subagentThread: (threadId) => threadId === 'child',
    parentThread: (threadId) => (threadId === 'child' ? 'parent' : undefined),
    personHeld: (caller) => options.personOf?.(caller.threadId) === true,
    reportLacks: (report) => void reports.push(report)
  })
    .register(tool('starts', 'startsThreads'))
    .register(tool('theme', 'changesSettings', { capabilities: ['themes'] }))
    .register(tool('archive', 'managesOthers', { needsPerson: true }))
    .register(tool('rename_or_run', 'writesThreads', { needsPerson: (args) => args.run === true }))
    .register(tool('facts', 'reads', { available: (turn) => (turn.modeFacts?.readOnly ? 'Not in a read-only turn.' : true) }))
  const call = (threadId: string, name: string, args: Record<string, unknown> = {}) =>
    registry.call(name, args, {
      credential: { threadId, runId: `run-${threadId}`, provider: 'codex', accessLevel: 'lineage', binding: 'drained_turn', current: () => true },
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

  it('`person`: its parent when a person started the parent\'s turn, else the root', async () => {
    const held = tree({ personOf: (threadId) => threadId === 'parent' || threadId === 'child' })
    expect((await denied(held.call('child', 'archive')))?.refused).toMatchObject({ code: 'lacks_capability', lacks: 'person' })
    expect(held.reports.map((report) => report.to)).toEqual(['parent'])
    const none = tree()
    await denied(none.call('child', 'archive'))
    expect(none.reports.map((report) => report.to)).toEqual(['root'])
  })

  it('never for a thread that is not a subagent', async () => {
    const { call, reports } = tree()
    expect((await denied(call('parent', 'archive')))?.refused.code).toBe('lacks_capability')
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

describe('a definition turn\'s per-turn list (§1.3 "Removed": `offered` is the per-turn definition filter)', () => {
  it('holds only what its grants name, and never a delegation tool even when granted', () => {
    const turns = new AppToolTurns()
    const grants = { builtinTools: [{ id: 'task_list' }, { id: 'integrate_delegation' }], mcpTools: [] }
    turns.register(appTurn({ threadId: 't', runId: 'r', definition: { grants, mcpTools: [] } as never }))
    const registry = new ToolRegistry({ activeRunId: () => 'r', turns })
      .register(tool('task_list', 'reads'))
      .register(tool('task_create', 'actsAsCaller'))
      .register(tool('integrate_delegation', 'actsAsCaller', { class: 'delegation' }))
    expect(registry.listForTurn('t', 'r').map((listed) => listed.name)).toEqual(['task_list'])
    // Another turn of the thread gets its stable list.
    expect(registry.listForTurn('t', undefined).map((listed) => listed.name)).toEqual(['task_list', 'task_create', 'integrate_delegation'])
  })
})

describe('skills in a read-only turn (§1.5)', () => {
  it('are offered to a runtime that lists tools per turn, as in an Agent turn', () => {
    const tools = skillTools({ skills: () => ({}) } as unknown as AppToolHost)
    const readOnly = appTurn({ threadId: 'child', runId: 'r', modeFacts: { readOnly: true, agent: false, build: false }, enabledSkills: [{ name: 'review' }] as never }) as AppToolTurn
    for (const skill of tools) expect(skill.offered!(readOnly)).toBe(true)
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
