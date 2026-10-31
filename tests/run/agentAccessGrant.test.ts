/**
 * The agent access level end to end (docs/run-engine/SPEC.md §15.1): a real `OrchestratorService`, Run
 * Engine and effect worker, with scripted adapters. Covers how a turn's grant is computed from the
 * profile and the delegations that gave a thread its work, that a child never exceeds its parent's
 * grant, that lowering the setting reaches a running turn, that the grant survives a restart, and that
 * the Mousse MCP server stamps it on the credential and enforces it.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import type { DelegationToolHost } from '../../src/mms/run/mcp/appTools/delegation'
import { TURN_TOKEN_KEY } from '../../src/mms/run/mcp/appTools'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MCP_ERROR_CODES, MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import type { AgentAccessLevel } from '../../src/shared/settings'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

type Script = (input: TurnInput, host: AdapterHost) => Promise<string>

/** A provider stand-in whose script gets the turn's host (its delegation tools, its MCP bridge). */
class ScriptedAdapter implements ProviderAdapter {
  readonly turns: TurnInput[] = []
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities, private readonly script: Script) {}

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const text = await this.script(input, host)
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    const native = this.capabilities.historyInjection === 'native'
    if (!native) host.context.nativeHistoryAfterTurn(text)
    return {
      text,
      aborted: false,
      modelName: 'Scripted',
      totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'scripted',
      nativeMessages: native ? [...input.messages, { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() } as never] : [],
      providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

interface Started {
  childThreadId: string
  childRunId: string
  delegationId: string
}

describe('agent access grant (SPEC §15.1)', () => {
  let home: string | undefined
  let previousHome: string | undefined
  const stops: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const profileHome = (): string => {
    home = mkdtempSync(join(tmpdir(), 'mousse-agent-access-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    mkdirSync(join(home, 'project'))
    return home
  }

  /** The profile's agent access setting, changed in place the way a settings update would. */
  const setProfile = (d: Phase6Daemon, level: AgentAccessLevel, projectIds: string[] = []): void => {
    ;(d.orch as unknown as { settingsStore: { get(): { agentAccess: unknown } } }).settingsStore.get().agentAccess = { level, projectIds, answerApprovals: false }
  }
  const grant = (d: Phase6Daemon, threadId: string, ceiling: 'plan' | 'default' = 'default'): AgentAccessLevel =>
    (d.orch as unknown as { grantFor(threadId: string, ceiling: string): AgentAccessLevel }).grantFor(threadId, ceiling)
  const levelsOf = (d: Phase6Daemon, parentThreadId: string): Array<AgentAccessLevel | null> =>
    d.engine.delegations.listForParentThread(parentThreadId).map((task) => task.accessLevel)

  /** A pi parent in a project (and a Claude-shaped adapter for children); `onParent` runs inside its first turn. */
  const daemon = (
    onParent: (delegation: DelegationToolHost, d: Phase6Daemon, threadId: string) => Promise<void>,
    options: { onPiChild?: Script; pid?: number; dir?: string } = {}
  ) => {
    const dir = options.dir ?? profileHome()
    let created: Phase6Daemon | undefined
    const pi = new ScriptedAdapter('pi', PI_TEST_CAPABILITIES, async (input, host) => {
      if (input.prompt !== 'Delegate it') return options.onPiChild ? options.onPiChild(input, host) : 'Looked.'
      await onParent(host.tools.delegation!, created!, input.threadId)
      return 'Delegated.'
    })
    const claude = new ScriptedAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, async () => 'Done.')
    const d = phase6Daemon(dir, [pi, claude], { pid: options.pid })
    created = d
    stops.push(d.stop)
    const project = d.projects.openProject(join(dir, 'project'))
    return { d, pi, claude, project, dir }
  }

  const start = async (d: Phase6Daemon, projectId: string, level: AgentAccessLevel, prompt = 'Delegate it') => {
    setProfile(d, level)
    const thread = d.store.createThread('Parent', projectId)
    await d.orch.send(prompt, false, { threadId: thread.id, clientRequestId: `send:${thread.id}:${prompt}` })
    return thread
  }

  const delegate = (delegation: DelegationToolHost, id: string, patch: Record<string, unknown> = {}) =>
    delegation.delegateTask({ prompt: `Work on ${id}`, title: id, workspace: 'isolated', role: 'implement', instanceId: 'claude', ...patch } as never, { toolCallId: id }) as Promise<Started>

  const finished = (d: Phase6Daemon, child: Started) => waitFor(() => d.engine.getRun(child.childRunId)?.status === 'completed', `${child.childThreadId} to finish`)

  it('a turn granted lineage hands out lineage, even when the profile is raised while it runs', async () => {
    const out: Started[] = []
    const { d, project } = daemon(async (delegation, d) => {
      setProfile(d, 'manage')
      out.push(await delegate(delegation, 'late'))
    })
    const thread = await start(d, project.id, 'lineage')
    expect(levelsOf(d, thread.id)).toEqual(['lineage'])
    await finished(d, out[0])
    // The child's own turns are granted min(profile now, what its delegation gave it).
    expect(grant(d, out[0].childThreadId)).toBe('lineage')
  }, 30_000)

  it('a manage turn hands each child the level it holds now: lowering the setting narrows the next child at once', async () => {
    const out: Started[] = []
    const { d, project } = daemon(async (delegation, d) => {
      out.push(await delegate(delegation, 'first'))
      setProfile(d, 'read')
      out.push(await delegate(delegation, 'second'))
      setProfile(d, 'lineage')
      out.push(await delegate(delegation, 'third'))
    })
    const thread = await start(d, project.id, 'manage')
    expect(levelsOf(d, thread.id)).toEqual(['manage', 'read', 'lineage'])
    for (const child of out) await finished(d, child)
    // Whatever the profile says later, a child is never granted more than its delegation gave it.
    setProfile(d, 'manage')
    expect(out.map((child) => grant(d, child.childThreadId))).toEqual(['manage', 'read', 'lineage'])
    setProfile(d, 'read')
    expect(out.map((child) => grant(d, child.childThreadId))).toEqual(['read', 'read', 'lineage'])
    setProfile(d, 'lineage')
    expect(out.map((child) => grant(d, child.childThreadId))).toEqual(['lineage', 'lineage', 'lineage'])
  }, 30_000)

  it('three generations: a grandchild never exceeds its parent, whatever the profile says between', async () => {
    const out: { child?: Started; grandchild?: Started } = {}
    const { d, project } = daemon(
      async (delegation) => {
        out.child = await delegate(delegation, 'child', { instanceId: 'pi:openai' })
      },
      {
        onPiChild: async (input, host) => {
          if (input.prompt === 'Nest') out.grandchild = await delegate(host.tools.delegation!, 'grandchild')
          return 'Nested.'
        }
      }
    )
    const thread = await start(d, project.id, 'manage')
    await finished(d, out.child!)
    expect(levelsOf(d, thread.id)).toEqual(['manage'])
    // The profile drops, the child takes a new turn and starts its own subagent: it hands out what it holds.
    setProfile(d, 'read')
    await d.orch.send('Nest', false, { threadId: out.child!.childThreadId, clientRequestId: 'nest' })
    expect(levelsOf(d, out.child!.childThreadId)).toEqual(['read'])
    await finished(d, out.grandchild!)
    // The profile rises again: neither child nor grandchild is ever granted more than it was given.
    setProfile(d, 'manage')
    expect(grant(d, out.child!.childThreadId)).toBe('manage')
    expect(grant(d, out.grandchild!.childThreadId)).toBe('read')
  }, 30_000)

  it('a child delegated under a read profile stays read after the profile is raised', async () => {
    const out: Started[] = []
    const { d, project } = daemon(async (delegation) => {
      out.push(await delegate(delegation, 'reader'))
    })
    const thread = await start(d, project.id, 'read')
    expect(levelsOf(d, thread.id)).toEqual(['read'])
    await finished(d, out[0])
    setProfile(d, 'manage')
    expect(grant(d, out[0].childThreadId)).toBe('read')
  }, 30_000)

  it('a follow-up keeps the narrower of the first and the latest level, so a subagent never grows', async () => {
    const out: { first?: Started; again?: { delegationId?: string } } = {}
    const { d, project } = daemon(async (delegation, d, threadId) => {
      out.first = await delegate(delegation, 'worker')
      await finished(d, out.first)
      // The profile is lowered, then the same subagent is asked to continue.
      setProfile(d, 'read')
      out.again = await delegation.continueSubagent({ subagent: out.first.childThreadId, prompt: 'Keep going' }, { toolCallId: 'follow-up-1' }) as { delegationId?: string }
      await waitFor(() => d.engine.delegations.listForChildThread(out.first!.childThreadId).every((task) => task.status !== 'running'), 'the follow-up to finish')
      expect(threadId).toBeTruthy()
    })
    await start(d, project.id, 'manage')
    const rows = d.engine.delegations.listForChildThread(out.first!.childThreadId)
    expect(rows.map((task) => task.accessLevel)).toEqual(['manage', 'read'])
    setProfile(d, 'manage')
    expect(grant(d, out.first!.childThreadId)).toBe('read')
    // A follow-up under a raised profile is bounded by the level the subagent was first given and by its caller's.
    expect(rows[1].delegationId).toBe(out.again?.delegationId)
  }, 30_000)

  it('a plan ceiling and a read-only child are capped at read', async () => {
    const out: Record<string, Started> = {}
    const { d, project } = daemon(async (delegation) => {
      out.shared = await delegate(delegation, 'looker', { workspace: 'shared', role: 'research' })
      out.isolated = await delegate(delegation, 'writer')
    })
    const thread = await start(d, project.id, 'manage')
    // The delegation records the caller's level; the read-only child is held to read when it runs.
    expect(levelsOf(d, thread.id)).toEqual(['manage', 'manage'])
    await finished(d, out.shared)
    await finished(d, out.isolated)
    expect(grant(d, out.shared.childThreadId)).toBe('read')
    expect(grant(d, out.isolated.childThreadId)).toBe('manage')
    // A plan turn may read other threads but never manage them.
    expect(grant(d, thread.id, 'plan')).toBe('read')
    expect(grant(d, thread.id, 'default')).toBe('manage')
    setProfile(d, 'lineage')
    expect(grant(d, thread.id, 'plan')).toBe('lineage')
  }, 30_000)

  it('a delegation from before levels existed, an unreadable setting and a failing lookup all grant lineage', async () => {
    const out: Started[] = []
    const { d, project } = daemon(async (delegation) => {
      out.push(await delegate(delegation, 'old'))
    })
    await start(d, project.id, 'manage')
    await finished(d, out[0])
    setProfile(d, 'manage')
    expect(grant(d, out[0].childThreadId)).toBe('manage')
    d.engine.store.db.database.prepare('UPDATE delegations SET access_level = NULL').run()
    expect(grant(d, out[0].childThreadId)).toBe('lineage')
    // A thread with no delegations at all is a person's thread: the profile's level.
    expect(grant(d, d.store.createThread('Loose', project.id).id)).toBe('manage')

    const orch = d.orch as unknown as { settingsStore: { get(): unknown }; runEngine: unknown }
    const settings = orch.settingsStore
    const original = settings.get
    settings.get = () => { throw new Error('settings unreadable') }
    try {
      expect(grant(d, out[0].childThreadId)).toBe('lineage')
    } finally {
      settings.get = original
    }
    const engine = orch.runEngine as { delegations: { listForChildThread: unknown } }
    const lookup = engine.delegations.listForChildThread
    engine.delegations.listForChildThread = () => { throw new Error('database unavailable') }
    try {
      expect(grant(d, out[0].childThreadId)).toBe('lineage')
    } finally {
      engine.delegations.listForChildThread = lookup
    }
  }, 30_000)

  it('a thread a remote send drives is capped at lineage for every later turn, and what it delegates inherits the cap', async () => {
    const out: Started[] = []
    const { d, project } = daemon(async (delegation) => {
      out.push(await delegate(delegation, 'from-remote'))
    })
    setProfile(d, 'manage')
    const mine = d.store.createThread('Mine', project.id)
    const chat = d.store.createThread('Remote chat', project.id)
    expect(grant(d, chat.id)).toBe('manage')
    const result = await d.orch.runRemoteTurn(chat.id, 'Delegate it', d.store, {})
    expect(result.error).toBeUndefined()
    // The turn's own grant and its child's are lineage although the profile says manage.
    expect(levelsOf(d, chat.id)).toEqual(['lineage'])
    await finished(d, out[0])
    expect(grant(d, chat.id)).toBe('lineage')
    expect(grant(d, out[0].childThreadId)).toBe('lineage')
    // The cap is on the thread: it holds for turns that are not remote turns, and after a restart.
    expect(d.store.getThread(chat.id)?.accessCeiling).toBe('lineage')
    expect(new ThreadDataStore(d.projects).getThread(chat.id)?.accessCeiling).toBe('lineage')
    await d.orch.send('A message typed in the app', false, { threadId: chat.id, clientRequestId: 'app-send' })
    expect(grant(d, chat.id)).toBe('lineage')
    // A person's own thread keeps the profile's level.
    expect(grant(d, mine.id)).toBe('manage')
    expect(d.store.getThread(mine.id)?.accessCeiling).toBeUndefined()
  }, 30_000)

  it('a later follow-up never restores a level an earlier one narrowed, in any order of profile changes', async () => {
    const out: { child?: Started } = {}
    const { d, project } = daemon(async (delegation, d) => {
      out.child = await delegate(delegation, 'worker')
      await finished(d, out.child)
      const settled = () => waitFor(() => d.engine.delegations.listForChildThread(out.child!.childThreadId).every((task) => task.status !== 'running'), 'the follow-up to finish')
      setProfile(d, 'read')
      await delegation.continueSubagent({ subagent: out.child.childThreadId, prompt: 'Narrowed follow-up' }, { toolCallId: 'follow-1' })
      await settled()
      // The profile is back at manage and the same subagent is asked again.
      setProfile(d, 'manage')
      await delegation.continueSubagent({ subagent: out.child.childThreadId, prompt: 'Follow-up after the profile rose' }, { toolCallId: 'follow-2' })
      await settled()
    })
    await start(d, project.id, 'manage')
    const child = out.child!.childThreadId
    const rows = () => d.engine.delegations.listForChildThread(child).map((task) => task.accessLevel)
    expect(rows()).toEqual(['manage', 'read', 'read'])
    setProfile(d, 'manage')
    expect(grant(d, child)).toBe('read')
    // A message a person types in the subagent's thread is recorded as a follow-up too, at the narrowest level so far.
    await d.orch.send('A person asks again', false, { threadId: child, clientRequestId: 'person-follow-up', source: 'gui' })
    await waitFor(() => d.engine.delegations.listForChildThread(child).every((task) => task.status !== 'running'), 'the person follow-up to finish')
    expect(rows()).toEqual(['manage', 'read', 'read', 'read'])
    expect(grant(d, child)).toBe('read')
  }, 60_000)

  it('a turn that starts under lineage hands out lineage even when the setting is raised while the turn is starting', async () => {
    const out: Started[] = []
    const { d, project } = daemon(async (delegation) => {
      out.push(await delegate(delegation, 'racer'))
    })
    // The turn registers its grant, then awaits (binding, context, skills); the setting rises in between.
    d.orch.once('turn-started', () => setProfile(d, 'manage'))
    const thread = await start(d, project.id, 'lineage')
    expect(levelsOf(d, thread.id)).toEqual(['lineage'])
    await finished(d, out[0])
    // The next turn of the parent is granted what the setting says by then.
    expect(grant(d, thread.id)).toBe('manage')
    expect(grant(d, out[0].childThreadId)).toBe('lineage')
  }, 30_000)

  describe('a run that continues another is never granted more than the run it continues', () => {
    const pauseOf = { reason: 'usage_limit' as const, until: '2099-01-01T00:00:00.000Z', estimated: false, count: 1, autoResume: false }
    /** A run of `threadId` that is paused, as a turn that hit a usage limit leaves it; `grant` is what its turn was granted. */
    const pausedRun = async (d: Phase6Daemon, threadId: string, grant?: AgentAccessLevel) => {
      const sent = await d.engine.dispatch({ kind: 'send', threadId, clientRequestId: `paused:${threadId}`, source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      d.engine.markStarting(sent.runId)
      d.engine.markRunning(sent.runId)
      if (grant) d.engine.recordAccessGrant(sent.runId, grant)
      return d.engine.pauseRun({ runId: sent.runId, pause: pauseOf })
    }

    it('records the grant of each turn on its run, narrower for a plan turn', async () => {
      const { d, project } = daemon(async () => undefined)
      setProfile(d, 'manage')
      const thread = d.store.createThread('Recorder', project.id)
      const normal = await d.orch.send('Hello', false, { threadId: thread.id, clientRequestId: 'normal' })
      const plan = await d.orch.send({ content: 'Plan it', mode: 'plan' }, false, { threadId: thread.id, clientRequestId: 'plan' })
      expect(d.engine.getRun(normal.runId!)?.accessGrant).toBe('manage')
      expect(d.engine.getRun(plan.runId!)?.accessGrant).toBe('read')
      // A run's recorded grant only ever narrows, and recording it is not a status write: no epoch, no event.
      const epoch = d.engine.getRun(normal.runId!)!.epoch
      const events = d.engine.listEvents(thread.id).length
      expect(d.engine.recordAccessGrant(normal.runId!, 'read')).toBe('read')
      expect(d.engine.recordAccessGrant(normal.runId!, 'manage')).toBe('read')
      expect(d.engine.getRun(normal.runId!)).toMatchObject({ accessGrant: 'read', epoch })
      expect(d.engine.listEvents(thread.id)).toHaveLength(events)
    })

    it.each([['resume', 'the timer'], ['resume_now', 'a person']])('a paused run resumed by %s (%s) keeps the run\'s grant when the setting has risen', async (source) => {
      const out: Started[] = []
      const { d, project } = daemon(async (delegation) => {
        out.push(await delegate(delegation, `after-${source}`))
      })
      setProfile(d, 'lineage')
      const thread = d.store.createThread('Paused', project.id)
      const paused = await pausedRun(d, thread.id, 'lineage')
      // The setting is raised while the run waits for the limit to reset.
      setProfile(d, 'manage')
      expect(grant(d, thread.id)).toBe('manage')
      const response = await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: `resume:${paused.runId}`, source, continuationOfRunId: paused.runId })
      const continued = d.engine.getRun(response.runId!)!
      expect(continued.outcome).toMatchObject({ continuationOf: paused.runId })
      expect(continued.accessGrant).toBe('lineage')
      // What the continuing turn delegates carries the paused run's level, not the setting's.
      expect(levelsOf(d, thread.id)).toEqual(['lineage'])
      await finished(d, out[0])
      expect(grant(d, out[0].childThreadId)).toBe('lineage')
      // The thread's next ordinary turn is granted what the setting says by then.
      const next = await d.orch.send('Hello again', false, { threadId: thread.id, clientRequestId: 'next' })
      expect(d.engine.getRun(next.runId!)?.accessGrant).toBe('manage')
    }, 60_000)

    it('a Continue after a restart is held to the interrupted run\'s grant, and a run whose grant was never recorded is lineage', async () => {
      const { d, project } = daemon(async () => undefined)
      setProfile(d, 'lineage')
      const thread = d.store.createThread('Interrupted', project.id)
      const first = await d.orch.send('Hello', false, { threadId: thread.id, clientRequestId: 'first' })
      expect(d.engine.getRun(first.runId!)?.accessGrant).toBe('lineage')
      setProfile(d, 'manage')
      const continued = await d.orch.send('Continue where you left off.', false, { threadId: thread.id, clientRequestId: 'continue-first', continuationOfRunId: first.runId })
      expect(d.engine.getRun(continued.runId!)?.accessGrant).toBe('lineage')
      // A run that was cut off before its turn recorded anything gives its continuation nothing wider.
      const orphan = d.store.createThread('Cut off early', project.id)
      const early = await d.engine.dispatch({ kind: 'send', threadId: orphan.id, clientRequestId: 'early', source: 'gui' })
      if (early.status !== 'accepted') throw new Error('send rejected')
      d.engine.markStarting(early.runId)
      d.engine.markRunning(early.runId)
      d.engine.markTerminal(early.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
      const after = await d.orch.send('Continue where you left off.', false, { threadId: orphan.id, clientRequestId: 'continue-early', continuationOfRunId: early.runId })
      expect(d.engine.getRun(after.runId!)?.accessGrant).toBe('lineage')
      expect(grant(d, orphan.id)).toBe('manage')
    }, 60_000)
  })

  describe('the read tools over the real store', () => {
    const NOW = '2026-10-12T00:00:00.000Z'
    const withMessages = (d: Phase6Daemon, threadId: string, texts: string[]) =>
      d.store.saveThreadData(threadId, { ...d.store.loadThreadData(threadId), messages: texts.map((content, index) => ({ id: `m${index}`, role: 'user', content, timestamp: NOW }) as never) })

    it('project authorization is applied before the search limit, so excluded matches never use up the slots', async () => {
      const { d, project, dir } = daemon(async () => undefined)
      mkdirSync(join(dir, 'other'))
      const other = d.projects.openProject(join(dir, 'other'))
      for (let index = 0; index < 12; index += 1) d.store.createThread(`needle excluded ${String(index).padStart(2, '0')}`, project.id)
      const wanted = d.store.createThread('needle wanted', other.id)
      const host = d.orch.mcpToolHost()
      const allowed = (thread: { projectId?: string }) => thread.projectId === other.id
      // A search that only filters afterwards sees nothing but excluded matches in its first page.
      expect(d.store.searchThreads('needle', 5, { hideSubagents: true, titlesOnly: true }).some((hit) => hit.threadId === wanted.id)).toBe(false)
      const found = host.searchThreads!('needle', 5, { allow: allowed, titlesOnly: true })
      expect(found.map((hit) => hit.threadId)).toEqual([wanted.id])
    }, 60_000)

    it('titles-only reads no transcript, and a bounded search reads only the most recently updated threads', async () => {
      const { d, project } = daemon(async () => undefined)
      const old = d.store.createThread('Old chat', project.id)
      const recent = d.store.createThread('Recent chat', project.id)
      withMessages(d, old.id, ['the needle in the old chat'])
      withMessages(d, recent.id, ['the needle in the recent chat'])
      d.store.updateThreadMeta(old.id, { name: 'Old chat' })
      d.store.updateThreadMeta(recent.id, { name: 'Recent chat' })
      const messageHits = (options: Parameters<NonNullable<ReturnType<Phase6Daemon['orch']['mcpToolHost']>['searchThreads']>>[2]) =>
        d.orch.mcpToolHost().searchThreads!('needle', 50, options).filter((hit) => hit.matchType === 'message').map((hit) => hit.threadId).sort()
      expect(messageHits({ titlesOnly: true })).toEqual([])
      expect(messageHits({})).toEqual([old.id, recent.id].sort())
      // One transcript only: the thread updated last.
      const hits = messageHits({ maxMessageThreads: 1 })
      expect(hits).toEqual([d.store.listAllThreads().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].id])
    })

    it('reading a transcript for another thread does not load that thread into memory', async () => {
      const { d, project } = daemon(async () => undefined)
      const reader = d.store.createThread('Reader', project.id)
      const target = d.store.createThread('Target', project.id)
      withMessages(d, target.id, ['first', 'second'])
      const sessions = (d.orch as unknown as { sessions: Map<string, unknown> }).sessions
      sessions.delete(target.id)
      const messages = d.orch.mcpToolHost().threadMessages!(target.id)
      expect(messages.map((message) => message.content)).toEqual(['first', 'second'])
      expect(sessions.has(target.id)).toBe(false)
      expect(reader.id).not.toBe(target.id)
    })
  })

  describe('forks', () => {
    const settledThread = async (d: Phase6Daemon, projectId: string, level: AgentAccessLevel) => {
      setProfile(d, level)
      const thread = d.store.createThread('Source', projectId)
      await d.orch.send('Hello', false, { threadId: thread.id, clientRequestId: `source:${thread.id}` })
      return thread
    }
    const fork = (d: Phase6Daemon, sourceThreadId: string, id: string, accessLevel?: AgentAccessLevel) =>
      d.engine.forkThread({ sourceThreadId, clientRequestId: id, seedFrom: 'current_head', ...(accessLevel ? { accessLevel } : {}) })

    it('a fork of a restricted subagent keeps its limit, and so does a fork of that fork, after a restart', async () => {
      const out: Started[] = []
      const { d, project } = daemon(async (delegation) => {
        out.push(await delegate(delegation, 'limited'))
      })
      await start(d, project.id, 'lineage')
      await finished(d, out[0])
      setProfile(d, 'manage')
      expect(grant(d, out[0].childThreadId)).toBe('lineage')
      const first = await fork(d, out[0].childThreadId, 'fork-1')
      expect(grant(d, first.threadId)).toBe('lineage')
      expect(d.store.getThread(first.threadId)?.accessCeiling).toBe('lineage')
      // A fork of the fork (it needs a finished run of its own to fork after).
      const run = d.engine.store.createRun({ threadId: first.threadId, source: 'gui' })
      d.engine.markStarting(run.runId)
      d.engine.markRunning(run.runId)
      d.engine.markTerminal(run.runId, 'completed')
      const second = await fork(d, first.threadId, 'fork-2')
      expect(grant(d, second.threadId)).toBe('lineage')
      expect(new ThreadDataStore(d.projects).getThread(second.threadId)?.accessCeiling).toBe('lineage')
    }, 60_000)

    it('a fork keeps the limit of the narrower agent that makes it, and a person\'s fork of a person\'s thread keeps the profile in charge', async () => {
      const { d, project } = daemon(async () => undefined)
      const source = await settledThread(d, project.id, 'manage')
      const byAgent = await fork(d, source.id, 'fork-by-read-agent', 'read')
      expect(d.store.getThread(byAgent.threadId)?.accessCeiling).toBe('read')
      expect(grant(d, byAgent.threadId)).toBe('read')
      // An agent whose own level has since dropped forks with that level, not the one it was granted.
      setProfile(d, 'lineage')
      const lowered = await fork(d, source.id, 'fork-after-drop', 'manage')
      expect(d.store.getThread(lowered.threadId)?.accessCeiling).toBe('lineage')
      // An unknown level on the forking agent fails closed.
      setProfile(d, 'manage')
      const unknown = await fork(d, source.id, 'fork-bad-level', 'root' as never)
      expect(d.store.getThread(unknown.threadId)?.accessCeiling).toBe('lineage')
      // A person's fork records no limit beyond the profile's (stored as manage).
      const byPerson = await fork(d, source.id, 'fork-by-person')
      expect(d.store.getThread(byPerson.threadId)?.accessCeiling).toBe('manage')
      expect(grant(d, byPerson.threadId)).toBe('manage')
      setProfile(d, 'read')
      expect(grant(d, byPerson.threadId)).toBe('read')
    }, 60_000)

    it('a fork or subagent with no trustworthy grant (nothing stored, no delegation) is lineage', async () => {
      const out: Started[] = []
      const { d, project } = daemon(async (delegation) => {
        out.push(await delegate(delegation, 'orphan'))
      })
      const source = await start(d, project.id, 'manage')
      await finished(d, out[0])
      expect(grant(d, out[0].childThreadId)).toBe('manage')
      // A subagent whose delegation rows are gone.
      d.engine.store.db.database.prepare('DELETE FROM delegations WHERE child_thread_id = ?').run(out[0].childThreadId)
      expect(grant(d, out[0].childThreadId)).toBe('lineage')
      // A fork from before ceilings were stored.
      const legacy = d.store.createThread('Old fork', project.id)
      d.engine.delegations.createLineage({ threadId: legacy.id, parentThreadId: source.id, parentRunId: 'run-x', relationship: 'fork' })
      expect(grant(d, legacy.id)).toBe('lineage')
      expect(d.store.getThread(legacy.id)?.accessCeiling).toBeUndefined()
    }, 30_000)
  })

  it('a bot thread is always lineage, and so is a child it delegates; an unreadable bot index grants lineage too', async () => {
    const out: Started[] = []
    const { d, project } = daemon(async (delegation) => {
      out.push(await delegate(delegation, 'consult'))
    })
    setProfile(d, 'manage')
    const bot = d.store.createThread('Bot activation', project.id)
    const person = d.store.createThread('Person', project.id)
    d.orch.setBotThreads({ roleOf: (threadId) => (threadId === bot.id ? 'activation' : undefined) })
    expect(grant(d, bot.id)).toBe('lineage')
    expect(grant(d, person.id)).toBe('manage')
    // What a bot thread delegates carries the bot's level, whatever the profile says later.
    await d.orch.send('Delegate it', false, { threadId: bot.id, clientRequestId: 'bot-send' })
    expect(levelsOf(d, bot.id)).toEqual(['lineage'])
    await finished(d, out[0])
    expect(grant(d, out[0].childThreadId)).toBe('lineage')
    d.orch.setBotThreads({ roleOf: () => { throw new Error('bot index unreadable') } })
    expect(grant(d, person.id)).toBe('lineage')
    d.orch.setBotThreads(null)
    expect(grant(d, person.id)).toBe('manage')
  }, 30_000)

  it('the level a delegation carries survives a daemon restart', async () => {
    const out: Started[] = []
    const first = daemon(async (delegation) => {
      out.push(await delegate(delegation, 'before-restart'))
    })
    await start(first.d, first.project.id, 'read')
    await finished(first.d, out[0])
    await first.d.crash()
    stops.pop()

    const second = daemon(async () => undefined, { dir: first.dir, pid: 2 })
    setProfile(second.d, 'manage')
    expect(second.d.engine.delegations.listForChildThread(out[0].childThreadId).map((task) => task.accessLevel)).toEqual(['read'])
    expect(grant(second.d, out[0].childThreadId)).toBe('read')
    setProfile(second.d, 'lineage')
    expect(grant(second.d, out[0].childThreadId)).toBe('lineage')
  }, 30_000)

  it('a thread records the thread that launched it, apart from the subagent lineage, and keeps it across a restart', async () => {
    const { d, project } = daemon(async () => undefined)
    const creator = d.store.createThread('Creator', project.id)
    const launched = d.store.createThread('Launched', project.id, undefined, { createdByThreadId: creator.id })
    const plain = d.store.createThread('Plain', project.id)
    const late = d.store.createThread('Late', project.id)
    d.store.updateThreadMeta(late.id, { createdByThreadId: creator.id })
    // A fresh store over the same home is what the next daemon sees.
    const reopened = new ThreadDataStore(d.projects)
    expect(reopened.getThread(launched.id)).toMatchObject({ createdByThreadId: creator.id })
    expect(reopened.getThread(late.id)).toMatchObject({ createdByThreadId: creator.id })
    expect(reopened.getThread(plain.id)?.createdByThreadId).toBeUndefined()
    // Not a subagent relation: the launched thread has no lineage and is listed on its own.
    expect(reopened.getThread(launched.id)?.lineage).toBeUndefined()
    expect(reopened.listAllVisibleThreads().map((thread) => thread.id)).toEqual(expect.arrayContaining([launched.id, creator.id]))
  })

  describe('recordAgentAction', () => {
    it('writes an agent.action event without content and a transcript row naming the acting thread', async () => {
      const { d, project } = daemon(async () => undefined)
      const caller = d.store.createThread('Planner', project.id)
      const target = d.store.createThread('Target', project.id)
      const sent = await d.engine.dispatch({ kind: 'send', threadId: target.id, clientRequestId: 'target-run', source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      const orch = d.orch as unknown as {
        recordAgentAction(target: { threadId: string; runId?: string }, actor: { kind: 'agent'; threadId: string; runId: string; toolCallId: string }, action: string, details?: Record<string, string | number | boolean | null>): void
      }
      orch.recordAgentAction({ threadId: target.id, runId: sent.runId }, { kind: 'agent', threadId: caller.id, runId: 'run-of-caller', toolCallId: 'mcp:call-1' }, 'sent_message', { summary: 'sent a message', length: 12 })
      const event = d.engine.listEvents(target.id).find((entry) => entry.type === 'agent.action')!
      expect(event).toMatchObject({ runId: sent.runId, payload: { action: 'sent_message', actorThreadId: caller.id, actorRunId: 'run-of-caller', toolCallId: 'mcp:call-1', summary: 'sent a message', length: 12 } })
      const row = d.orch.getMessages(target.id).find((message) => message.role === 'system')!
      expect(row.content).toBe(`Changed by an agent in thread «Planner» (${caller.id}): sent a message`)
      // The event is durable and visible to a lineage reader; it holds ids and counts only.
      expect(JSON.stringify(event.payload)).not.toMatch(/hello|secret/)
    })

    it('names the acting thread by id when its title is unknown, and uses the action when there is no summary', async () => {
      const { d, project } = daemon(async () => undefined)
      const target = d.store.createThread('Target', project.id)
      const orch = d.orch as unknown as { recordAgentAction(target: { threadId: string }, actor: unknown, action: string): void }
      orch.recordAgentAction({ threadId: target.id }, { kind: 'agent', threadId: 'gone-thread', runId: 'r', toolCallId: 't' }, 'stopped_run')
      expect(d.orch.getMessages(target.id).find((message) => message.role === 'system')!.content).toBe('Changed by an agent in thread «gone-thread» (gone-thread): stopped_run')
      expect(d.engine.listEvents(target.id).some((entry) => entry.type === 'agent.action')).toBe(true)
    })
  })
})

/** The server and bearer a turn's bridge attaches, with the turn token Claude's hook stamps on each call. */
type Mcp = { url: string; token: string; turnToken?: string }

async function rpc(mcp: Mcp, method: string, params: Record<string, unknown>, id = 1) {
  const response = await fetch(mcp.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mcp.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  })
  return await response.json() as { result?: { content?: Array<{ text: string }>; tools?: Array<{ name: string }>; isError?: boolean }; error?: { code: number; message: string; data?: { reason: string } } }
}

describe('agent access over the Mousse MCP server', () => {
  let home: string | undefined
  let previousHome: string | undefined
  const stops: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  /** A daemon whose Claude-shaped parent talks to the real MCP server; `script` is its model. */
  const world = (script: (input: TurnInput, mcp: Mcp, d: Phase6Daemon) => Promise<string>) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-agent-access-mcp-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    mkdirSync(join(home, 'project'))
    let created: Phase6Daemon | undefined
    const vendor = new ScriptedAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, async (input, host) => {
      const bridge = host.bridge
      if (!bridge?.mcp) throw new Error('expected the Mousse MCP server')
      return script(input, { ...bridge.mcp, turnToken: bridge.turnToken }, created!)
    })
    const d = phase6Daemon(home, [vendor])
    created = d
    const credentials = new McpCredentials(d.engine.store)
    const server = new MousseMcpServer({ credentials, registry: d.orch.mcpToolRegistry() })
    stops.push(async () => {
      d.orch.setMcpAttachment(null)
      await server.stop()
      await d.stop()
    })
    const project = d.projects.openProject(join(home, 'project'))
    const parent = d.store.createThread('Parent', project.id)
    const other = d.store.createThread('Other work', project.id)
    d.orch.setThreadModelOverride(parent.id, { llmProvider: 'claude-subscription', model: 'vendor-model' })
    return { d, server, credentials, parent, other, vendor, attach: async () => { await server.start(); d.orch.setMcpAttachment(server) } }
  }
  const setProfile = (d: Phase6Daemon, level: AgentAccessLevel): void => {
    ;(d.orch as unknown as { settingsStore: { get(): { agentAccess: unknown } } }).settingsStore.get().agentAccess = { level, projectIds: [], answerApprovals: false }
  }
  const names = async (mcp: Mcp): Promise<string[]> => (await rpc(mcp, 'tools/list', {})).result!.tools!.map((tool) => tool.name)
  const call = (mcp: Mcp, name: string, args: Record<string, unknown> = {}, id = 2) =>
    rpc(mcp, 'tools/call', { name, arguments: mcp.turnToken ? { ...args, [TURN_TOKEN_KEY]: mcp.turnToken } : args }, id)

  it('stamps the turn\'s grant on the credential, enforces it live, and gives a child the level it held', async () => {
    const seen: Record<string, unknown> = {}
    let child: { childThreadId: string; childRunId: string } | undefined
    const { d, credentials, parent, other, attach } = world(async (input, mcp, d) => {
      if (input.prompt !== 'Go') return 'Done.'
      seen.listedAtManage = await names(mcp)
      seen.listAtManage = (await call(mcp, 'thread_list')).result?.isError
      seen.readOther = JSON.parse((await call(mcp, 'thread_read', { threadId: other.id })).result!.content![0].text).scope
      seen.messagesAtManage = (await call(mcp, 'thread_read', { threadId: other.id, view: 'messages' })).error
      const started = await call(mcp, 'delegate_task', { prompt: 'Work', title: 'Worker', workspace: 'isolated', role: 'implement', instanceId: 'claude' })
      child = JSON.parse(started.result!.content![0].text)
      await waitFor(() => d.engine.getRun(child!.childRunId)?.status === 'completed', 'the child run')
      // The profile is lowered while this turn runs.
      setProfile(d, 'read')
      seen.listedAtRead = await names(mcp)
      seen.messagesAtRead = (await call(mcp, 'thread_read', { threadId: other.id, view: 'messages' })).error
      seen.listAtRead = (await call(mcp, 'thread_list')).result?.isError
      setProfile(d, 'lineage')
      seen.listedAtLineage = await names(mcp)
      seen.listAtLineage = (await call(mcp, 'thread_list')).error
      seen.readAtLineage = (await call(mcp, 'thread_read', { threadId: other.id })).error
      seen.ownAtLineage = (await call(mcp, 'thread_read', {})).error
      return 'Delegated.'
    })
    await attach()
    setProfile(d, 'manage')
    await d.orch.send('Go', false, { threadId: parent.id, clientRequestId: 'go' })

    expect(seen.listedAtManage).toEqual(expect.arrayContaining(['thread_list', 'thread_search', 'thread_read']))
    expect(seen.listAtManage).toBeUndefined()
    expect(seen.readOther).toBe('manage')
    expect(seen.messagesAtManage).toBeUndefined()
    // Lowered mid-turn: the same credential narrows at once.
    expect(seen.listedAtRead).toContain('thread_list')
    expect(seen.messagesAtRead).toMatchObject({ code: MCP_ERROR_CODES.mousse_scope_denied })
    expect(seen.listAtRead).toBeUndefined()
    expect(seen.listedAtLineage).not.toContain('thread_list')
    expect(seen.listAtLineage).toMatchObject({ code: MCP_ERROR_CODES.mousse_scope_denied })
    expect(seen.readAtLineage).toMatchObject({ code: MCP_ERROR_CODES.mousse_scope_denied })
    expect(seen.ownAtLineage).toBeUndefined()

    // The grant of the turn is on the credential row, for audit; the child got the level held when it was started.
    expect(credentials.listForThread(parent.id).map((row) => row.accessLevel)).toEqual(['manage'])
    expect(d.engine.delegations.listForParentThread(parent.id).map((task) => task.accessLevel)).toEqual(['manage'])
    expect(credentials.listForThread(child!.childThreadId).map((row) => row.accessLevel)).toEqual(['manage'])
  }, 60_000)

  it('a plan turn is granted at most read, whatever the profile says', async () => {
    const seen: Record<string, unknown> = {}
    const { d, credentials, parent, other, attach } = world(async (_input, mcp) => {
      seen.listed = await names(mcp)
      seen.readOther = JSON.parse((await call(mcp, 'thread_read', { threadId: other.id })).result!.content![0].text).scope
      seen.messages = (await call(mcp, 'thread_read', { threadId: other.id, view: 'messages' })).error
      return 'Planned.'
    })
    await attach()
    setProfile(d, 'manage')
    await d.orch.send({ content: 'Plan it', mode: 'plan' }, false, { threadId: parent.id, clientRequestId: 'plan' })
    expect(credentials.listForThread(parent.id).map((row) => row.accessLevel)).toEqual(['read'])
    expect(seen.listed).toContain('thread_list')
    expect(seen.readOther).toBe('read')
    expect(seen.messages).toMatchObject({ code: MCP_ERROR_CODES.mousse_scope_denied })
  }, 60_000)

  it('the default profile grants lineage: no read-others tools are listed and another thread is refused', async () => {
    const seen: Record<string, unknown> = {}
    const { d, credentials, parent, other, attach } = world(async (_input, mcp) => {
      seen.listed = await names(mcp)
      seen.readOther = (await call(mcp, 'thread_read', { threadId: other.id })).error
      seen.own = (await call(mcp, 'thread_read', {})).error
      return 'Done.'
    })
    await attach()
    expect((d.orch as unknown as { settingsStore: { get(): { agentAccess: unknown } } }).settingsStore.get().agentAccess).toEqual({ level: 'lineage', projectIds: [], answerApprovals: false, remoteSubagents: false, computers: [] })
    await d.orch.send('Hello', false, { threadId: parent.id, clientRequestId: 'hello' })
    expect(credentials.listForThread(parent.id).map((row) => row.accessLevel)).toEqual(['lineage'])
    expect(seen.listed).not.toContain('thread_list')
    expect(seen.listed).toContain('thread_read')
    expect(seen.readOther).toMatchObject({ code: MCP_ERROR_CODES.mousse_scope_denied })
    expect(seen.own).toBeUndefined()
  }, 60_000)
})
