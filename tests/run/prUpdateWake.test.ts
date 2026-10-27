/**
 * A `pr_update` row (a watched pull request that changed, for a thread whose watch lets the agent act) is
 * woken like any notice, through a real orchestrator, Run Engine and effect worker with a scripted
 * provider: the wake is an ordinary turn of the thread, in the mode of its last message and under its
 * own agent access level, never the profile's alone and never above the thread's ceiling.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { ToolInvocations } from '../../src/mms/run/ToolInvocations'
import type { AgentAccessLevel } from '../../src/shared/settings'
import { formatPullRequestNotice } from '../../src/mms/git/pullRequestWatch'
import { phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

describe('a woken pull request update runs as the thread\'s own turn', () => {
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

  const setProfile = (d: Phase6Daemon, level: AgentAccessLevel): void => {
    ;(d.orch as unknown as { settingsStore: { get(): { agentAccess: unknown } } }).settingsStore.get().agentAccess = { level, projectIds: [], answerApprovals: false }
  }

  const world = () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-pr-wake-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    mkdirSync(join(home, 'project'))
    const adapter = piAdapter(() => 'Looked at it.')
    const d = phase6Daemon(home, [adapter])
    stops.push(d.stop)
    const project = d.projects.openProject(join(home, 'project'))
    const reconciler = new Reconciler({
      store: d.engine.store,
      outbox: d.engine.outbox,
      tools: new ToolInvocations(d.engine.store),
      now: () => new Date().toISOString(),
      capabilitiesFor: () => PI_LOOP_CAPABILITIES
    })
    return { d, adapter, project, reconciler }
  }

  const noticeFor = () =>
    formatPullRequestNotice([{ kind: 'checks_failed', checks: [{ name: 'build', state: 'failing', url: null }] }], { number: 7, title: 'Add thing', url: 'https://github.com/acme/app/pull/7', headSha: 'abcdef0123', authorAssociation: 'OWNER' }, 'act')

  /** Appends the row the watch writes and lets rule 4 wake the thread; resolves with the wake run once it ended. */
  const wake = async (w: ReturnType<typeof world>, threadId: string) => {
    const text = noticeFor()
    w.d.engine.inbox.append({ inboxId: `inbox:pr-update:${threadId}:1:0`, threadId, kind: 'pr_update', payload: { text, number: 7, headSha: 'abcdef0123', changes: ['checks_failed'] } })
    const [wakeRunId] = w.reconciler.runOnce().wakes.wakes
    expect(wakeRunId).toBeTruthy()
    await waitFor(() => w.d.engine.getRun(wakeRunId)?.status === 'completed', 'the wake turn')
    return { wakeRunId, text }
  }

  it.each([
    ['a plan turn stays a plan turn: read access', 'plan' as const, 'manage' as const, undefined, 'read' as const],
    ['an agent turn gets what the profile gives', 'agent' as const, 'manage' as const, undefined, 'manage' as const],
    ['a thread\'s own ceiling holds over the profile', 'agent' as const, 'manage' as const, 'read' as const, 'read' as const],
    ['a thread with the lowest ceiling stays there', 'agent' as const, 'manage' as const, 'lineage' as const, 'lineage' as const]
  ])('%s', async (_name, mode, profile, ceiling, expected) => {
    const w = world()
    setProfile(w.d, profile)
    const thread = w.d.store.createThread('Watched', w.project.id)
    if (ceiling) w.d.store.capAccessCeiling(thread.id, ceiling)
    await w.d.orch.send({ content: 'Fix the build', mode }, false, { threadId: thread.id, clientRequestId: `first:${thread.id}` })
    const turnsBefore = w.adapter.turns.length
    const { wakeRunId, text } = await wake(w, thread.id)
    const run = w.d.engine.getRun(wakeRunId)!
    expect(run).toMatchObject({ threadId: thread.id, source: 'wake', accessGrant: expected })
    // The turn's prompt is the notice as written, and it is the only turn the row caused.
    expect(w.adapter.turns).toHaveLength(turnsBefore + 1)
    expect(w.adapter.turns.at(-1)!.prompt).toBe(text)
    expect(w.d.engine.inbox.listForThread(thread.id).find((row) => row.kind === 'pr_update')).toMatchObject({ status: expect.stringMatching(/delivered|acknowledged/) })
    // Nothing wakes it again: the row was delivered once.
    expect(w.reconciler.runOnce().wakes.wakes).toEqual([])
  }, 30_000)
  it('does not wake a thread while a saved approval waits on it, and does once nothing waits', async () => {
    const w = world()
    setProfile(w.d, 'manage')
    const thread = w.d.store.createThread('Watched', w.project.id)
    await w.d.orch.send({ content: 'Fix the build', mode: 'agent' }, false, { threadId: thread.id, clientRequestId: `first:${thread.id}` })
    // What a restart leaves: a request nobody has answered yet.
    w.d.engine.approvals.create({
      requestId: 'approval-1',
      threadId: thread.id,
      runId: null,
      instanceId: 'claude',
      provider: 'claude',
      action: 'command',
      permissionKey: 'claude:command',
      fingerprint: 'fp-1',
      questions: [{ id: 'permission', prompt: 'Run it?', options: [{ id: 'allow', label: 'Allow once', decision: 'allow', scope: 'once' }, { id: 'reject', label: 'Reject', decision: 'reject' }] }]
    })
    const turns = w.adapter.turns.length
    const text = noticeFor()
    w.d.engine.inbox.append({ inboxId: `inbox:pr-update:${thread.id}:1:0`, threadId: thread.id, kind: 'pr_update', payload: { text, number: 7, headSha: 'abcdef0123', changes: ['checks_failed'] } })
    const [wakeRunId] = w.reconciler.runOnce().wakes.wakes
    expect(wakeRunId).toBeTruthy()
    // The wake is queued and deferred, not run; the approval is still waiting and the row is not lost.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(w.d.engine.getRun(wakeRunId)!.status).toBe('queued')
    expect(w.adapter.turns).toHaveLength(turns)
    expect(w.d.engine.approvals.listPending(thread.id)).toHaveLength(1)
    // Answered by the user's reject: nothing waits, and the wake runs.
    w.d.engine.approvals.cancel('approval-1', 'stopped')
    await waitFor(() => w.d.engine.getRun(wakeRunId)?.status === 'completed', 'the wake once nothing waits', 20_000)
    expect(w.adapter.turns.at(-1)!.prompt).toBe(text)
  }, 40_000)
})
