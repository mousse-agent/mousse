/**
 * Scheduled jobs run as turns: a real `OrchestratorService`, Run Engine, effect worker and scheduler
 * over a temporary profile and a real Git repository, with scripted adapters in place of providers.
 * A plain-prompt job is admitted like any send (`schedule:<job>:<occurrence>`), runs on its target or
 * per-run thread with the job's model, mode and workspace, and is held until its run is terminal.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { resolveProjectWorkingDirectory } from '../src/mms/data/projectWorkingDirectory'
import { readDurableQueue } from '../src/mms/queue/durableQueue'
import { releaseExecutionLeaseHandle, tryAcquireExecutionLease } from '../src/mms/queue/ThreadExecutionLease'
import type { HarnessDriver } from '../src/mms/harness/driver'
import { adapterDriver } from '../src/mms/run/testkit/harness'
import { Reconciler } from '../src/mms/run/Reconciler'
import { jobPermissionRequest } from '../src/mms/scheduled/jobPermission'
import { ScheduledJobService } from '../src/mms/scheduled/ScheduledJobService'
import { ScheduledJobStore } from '../src/mms/scheduled/ScheduledJobStore'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import type { ScheduledJob, ScheduledJobRunRecord } from '../src/shared/types'
import { gitFoundationFixture } from './fixtures/gitFoundation'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { CLAUDE, PI, ScriptedAdapter, claudeAdapter, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './run/phase6Fixture'

vi.setConfig({ testTimeout: 30_000 })

const CLAUDE_SELECTION = { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' }
const PAST = '2026-01-01T00:00:00.000Z'
/** A claim owner that is gone: another pid and a process instance nobody runs. */
const DEAD_OWNER = { pid: 2_147_000_090, processInstanceId: 'dead-daemon' }

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('scheduled jobs run as turns', () => {
  let fx: ReturnType<typeof gitFoundationFixture>
  const worlds: World[] = []
  const gates: Array<{ resolve: () => void }> = []

  type World = Phase6Daemon & {
    jobs: ScheduledJobStore
    service: ScheduledJobService
    /** One scheduler tick; the runs it starts are not awaited. */
    tick: () => Promise<void>
  }

  beforeEach(() => {
    fx = gitFoundationFixture()
  })

  afterEach(async () => {
    for (const gate of gates.splice(0)) gate.resolve()
    for (const world of worlds.splice(0).reverse()) {
      world.service.stop()
      await world.stop().catch(() => undefined)
    }
    fx.dispose()
  })

  /** A scheduler over a real daemon, wired the way a profile wires it. */
  const boot = (adapters: ScriptedAdapter[], options: { pid?: number; start?: boolean; recover?: boolean; drivers?: HarnessDriver[] } = {}): World => {
    const daemon = phase6Daemon(fx.home, adapters, { pid: options.pid, ...(options.drivers ? { drivers: options.drivers } : {}) })
    const jobs = new ScheduledJobStore(MousseConfigStore.load(fx.home))
    jobs.setRunProbe(daemon.orch.scheduledRunProbe())
    const service = new ScheduledJobService({ runIsolated: (prompt, ingress) => daemon.orch.runIsolatedScheduledJob(prompt, ingress) }, jobs, daemon.store, daemon.projects)
    daemon.orch.setScheduledHooks({
      onOccurrenceSettled: (event) => service.occurrenceSettled(event),
      // As a profile wires it: a run takes the mode its job holds when it starts.
      currentPermissionRequest: (jobId) => {
        const job = jobs.getJob(jobId)
        return job ? jobPermissionRequest(job) : undefined
      }
    })
    // The rest of boot recovery that a profile runs after the engine's own (the fixture runs the engine's).
    if (options.recover) {
      ;(daemon.orch as any).recoverQueuedRows()
      ;(daemon.orch as any).recoverOrphanedFollowUps()
    }
    if (options.start !== false) service.start()
    const world: World = { ...daemon, jobs, service, tick: () => (service as any).tick() as Promise<void> }
    worlds.push(world)
    return world
  }

  const gate = () => {
    const held = deferred()
    gates.push(held)
    return held
  }

  const projectOf = (w: World) => w.projects.openProject(fx.repo)

  const addJob = (w: World, extra: Partial<Parameters<ScheduledJobStore['createJob']>[0]> = {}): ScheduledJob =>
    w.jobs.createJob({ name: 'Report', prompt: 'write the report', schedule: { kind: 'manual' }, ...extra })

  /** Makes an interval job due now, as if its time had passed. */
  const makeDue = (w: World, job: ScheduledJob, at = PAST) => w.jobs.updateJob(job.id, { nextRunAt: at, state: 'scheduled' })

  /** Starts a manual job on the next tick. */
  const runNow = (w: World, job: ScheduledJob) => {
    w.jobs.triggerJob(job.id)
    return w.tick()
  }

  /** The job's latest run record once nothing holds it any more. */
  const finished = async (w: World, jobId: string): Promise<ScheduledJobRunRecord> => {
    await waitFor(() => {
      const job = w.jobs.getJob(jobId)
      return Boolean(job && job.state !== 'running' && !job.runClaim && !job.pendingOccurrence && job.runHistory?.length && job.runHistory.at(-1)!.status !== 'queued')
    }, 'the occurrence to finish')
    return w.jobs.getJob(jobId)!.runHistory!.at(-1)!
  }

  const perRunThreads = (w: World, jobId: string) => w.store.listAllThreads().filter((thread) => thread.scheduledJobId === jobId)

  /** The claim of a job whose daemon died: a different pid and process instance. */
  const killOwner = (w: World, jobId: string) => {
    const claim = w.jobs.getJob(jobId)!.runClaim!
    w.jobs.updateJob(jobId, { runClaim: { ...claim, ...DEAD_OWNER } })
  }

  /** What `executeJob` does for a claimed job up to the runner's return, without finalizing the claim. */
  const startByHand = (w: World, job: ScheduledJob) => {
    const claim = job.runClaim!
    return w.orch.runIsolatedScheduledJob(job.prompt, {
      jobId: job.id,
      occurrenceAt: claim.occurrenceKey,
      occurrenceKey: claim.occurrenceKey,
      threadId: job.threadId,
      projectId: job.projectId,
      createThread: job.createThread,
      jobName: job.name,
      selection: job.selection,
      mode: job.mode,
      permissionMode: job.permissionMode,
      permissionCeiling: job.permissionCeiling,
      workspace: job.workspace,
      claim: {},
      onThreadChosen: (threadId) => { w.jobs.markClaimThread(job.id, claim.token, threadId) },
      onAdmitted: (runId) => { w.jobs.markOccurrenceAdmitted(job.id, claim.token, runId) }
    })
  }

  describe('the job\'s model, mode and workspace are the turn\'s', () => {
    it('binds the job\'s model and the schedule origin on a bound thread whose own model differs, and leaves that thread\'s model alone', async () => {
      const pi = piAdapter((input) => `pi: ${input.prompt}`)
      const claude = claudeAdapter((input) => `claude: ${input.prompt}`)
      const w = boot([pi, claude])
      const project = projectOf(w)
      const thread = w.store.createThread('Target', project.id, project.path)
      w.orch.setThreadModelOverride(thread.id, PI)
      const job = addJob(w, { threadId: thread.id, projectId: project.id, selection: CLAUDE_SELECTION, mode: 'agent' })

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(record).toMatchObject({ status: 'ok', threadId: thread.id, mode: 'agent', occurrenceKey: expect.any(String) })
      expect(record.output).toContain('claude: ')
      expect(record.selection).toMatchObject({ instanceId: 'claude', model: 'sonnet' })
      expect(w.engine.getRun(record.runId!)).toMatchObject({ source: 'schedule', threadId: thread.id, status: 'completed', clientRequestId: `schedule:${job.id}:${record.occurrenceKey}` })
      expect(w.engine.bindingForRun(record.runId!)).toMatchObject({ instanceId: 'claude', model: 'sonnet', policy: { origin: 'schedule' } })
      expect(claude.turns).toHaveLength(1)
      expect(pi.turns).toHaveLength(0)
      expect(w.store.getThread(thread.id)?.modelOverride).toMatchObject(PI)
      // The prompt and the reply are the thread's own messages, written once.
      const messages = w.orch.getMessages(thread.id)
      expect(messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(['write the report'])
      expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
      // The stored prompt is marked as the job's, so it does not pass for something the person typed.
      const prompt = w.orch.getOrCreateSession(thread.id).messages.find((message) => message.role === 'user')
      expect(prompt?.scheduled).toEqual({ jobId: job.id, jobName: 'Report' })
    })

    it('does the same through the direct path when no effect worker is attached', async () => {
      const pi = piAdapter((input) => `pi: ${input.prompt}`)
      const claude = claudeAdapter((input) => `claude: ${input.prompt}`)
      const w = boot([pi, claude])
      w.orch.attachEffectWorker(null)
      const project = projectOf(w)
      const thread = w.store.createThread('Target', project.id, project.path)
      w.orch.setThreadModelOverride(thread.id, PI)
      const job = addJob(w, { threadId: thread.id, projectId: project.id, selection: CLAUDE_SELECTION })

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(record.status).toBe('ok')
      expect(w.engine.bindingForRun(record.runId!)).toMatchObject({ instanceId: 'claude', model: 'sonnet', policy: { origin: 'schedule' } })
      expect(claude.turns).toHaveLength(1)
      expect(pi.turns).toHaveLength(0)
      expect(w.store.getThread(thread.id)?.modelOverride).toMatchObject(PI)
    })

    it('keeps the thread\'s own model for a bound job without one, and the profile default for a per-run job without one', async () => {
      const pi = piAdapter((input) => `pi: ${input.prompt}`)
      const claude = claudeAdapter((input) => `claude: ${input.prompt}`)
      const w = boot([pi, claude])
      const project = projectOf(w)
      // The thread's model is Claude; the profile default is pi.
      const thread = w.store.createThread('Target', project.id, project.path)
      w.orch.setThreadModelOverride(thread.id, CLAUDE)
      const bound = addJob(w, { name: 'Bound', threadId: thread.id, projectId: project.id })
      const perRun = addJob(w, { name: 'Per run', projectId: project.id })

      await runNow(w, bound)
      const boundRecord = await finished(w, bound.id)
      await runNow(w, perRun)
      const perRunRecord = await finished(w, perRun.id)

      expect(w.engine.bindingForRun(boundRecord.runId!)).toMatchObject({ instanceId: 'claude', model: 'sonnet' })
      expect(w.engine.bindingForRun(perRunRecord.runId!)).toMatchObject({ instanceId: 'pi:openai', model: PI.model })
      expect(claude.turns.map((turn) => turn.threadId)).toEqual([thread.id])
      expect(pi.turns.map((turn) => turn.threadId)).toEqual([perRunRecord.threadId])
      expect(perRunRecord.threadId).not.toBe(thread.id)
    })

    it('runs a plan-mode job in plan mode', async () => {
      const pi = piAdapter(() => 'a plan')
      const w = boot([pi])
      const project = projectOf(w)
      const job = addJob(w, { projectId: project.id, mode: 'plan' })

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(record).toMatchObject({ status: 'ok', mode: 'plan' })
      expect(w.engine.bindingForRun(record.runId!)?.policy).toMatchObject({ mode: 'plan', origin: 'schedule' })
    })

    it('runs a per-run job on the project\'s own checkout, with no provisioned workspace for tools that need an owned one', async () => {
      let context: unknown
      let world: World | undefined
      // The workspace the turn runs with, as the tools see it: `withTaskWriter` refuses isolated delegation
      // ("Isolated agents require an owned Git workspace") whenever it is not checkpointable.
      const pi = piAdapter((input) => {
        context = (world!.orch as any).sessions.get(input.threadId)?.workspace
        return 'looked'
      })
      const w = boot([pi])
      world = w
      const project = projectOf(w)
      const job = addJob(w, { projectId: project.id, workspace: { kind: 'project' } })

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(record).toMatchObject({ status: 'ok', workspace: { kind: 'project' } })
      expect(pi.turns[0].cwd).toBe(resolveProjectWorkingDirectory(project.path))
      expect(w.store.getThread(record.threadId!)).toMatchObject({ scheduledJobId: job.id, workspaceBinding: { policy: 'primary' } })
      expect(new ThreadWorkspaceManager(w.store.getThreadDir(record.threadId!)).load()).toBeUndefined()
      expect(context).toMatchObject({
        lifecycle: 'unprovisioned',
        workspacePath: project.path,
        capability: { gitBacked: true, checkpointable: false, publishable: false, undoable: false, unavailableReason: 'Scheduled run on the primary checkout' }
      })
    })

    it('provisions a worktree for a new-worktree job, and an existing-worktree job runs on the thread that owns it', async () => {
      const pi = piAdapter((input) => `pi: ${input.prompt}`)
      const w = boot([pi])
      const project = projectOf(w)
      const fresh = addJob(w, { name: 'Fresh', projectId: project.id, workspace: { kind: 'newWorktree' } })

      await runNow(w, fresh)
      const freshRecord = await finished(w, fresh.id)
      expect(freshRecord.status).toBe('ok')
      const metadata = new ThreadWorkspaceManager(w.store.getThreadDir(freshRecord.threadId!)).load()!
      expect(metadata).toMatchObject({ lifecycle: 'ready', threadId: freshRecord.threadId })
      expect(pi.turns[0].cwd).toBe(metadata.worktreePath)
      expect(metadata.worktreePath.replace(/\\/g, '/')).toContain(`/worktrees/threads/${freshRecord.threadId}`)
      expect(w.store.getThread(freshRecord.threadId!)?.workspaceBinding).toBeUndefined()

      const again = addJob(w, { name: 'Again', projectId: project.id, workspace: { kind: 'worktree', path: metadata.worktreePath } })
      await runNow(w, again)
      const againRecord = await finished(w, again.id)

      expect(againRecord).toMatchObject({ status: 'ok', threadId: freshRecord.threadId })
      expect(pi.turns[1]).toMatchObject({ threadId: freshRecord.threadId, cwd: metadata.worktreePath })
      expect(perRunThreads(w, again.id)).toHaveLength(0)
    })

    it('runs a job bound to a thread that has a workspace in that workspace', async () => {
      const pi = piAdapter((input) => `pi: ${input.prompt}`)
      const w = boot([pi])
      const project = projectOf(w)
      const thread = w.store.createThread('Worktree thread', project.id, project.path)
      w.orch.setThreadModelOverride(thread.id, PI)
      await w.orch.send('first', false, { threadId: thread.id, clientRequestId: 'person-1' })
      const metadata = new ThreadWorkspaceManager(w.store.getThreadDir(thread.id)).load()!
      expect(metadata.lifecycle).toBe('ready')
      const job = addJob(w, { threadId: thread.id, projectId: project.id })

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(record).toMatchObject({ status: 'ok', threadId: thread.id })
      expect(pi.turns.at(-1)).toMatchObject({ threadId: thread.id, cwd: metadata.worktreePath })
    })
  })

  describe('a model or workspace that is gone fails the occurrence with a clear error and starts nothing', () => {
    it('refuses a model hidden after the job was made, before any run exists', async () => {
      const pi = piAdapter(() => 'pi')
      const claude = claudeAdapter(() => 'claude')
      const w = boot([pi, claude])
      const project = projectOf(w)
      const thread = w.store.createThread('Target', project.id, project.path)
      const bound = addJob(w, { name: 'Bound', threadId: thread.id, projectId: project.id, selection: CLAUDE_SELECTION })
      const perRun = addJob(w, { name: 'Per run', projectId: project.id, selection: CLAUDE_SELECTION })
      await (w.orch as any).harness.instances.setModelPrefs('claude', { hidden: ['sonnet'] })

      await runNow(w, bound)
      const boundRecord = await finished(w, bound.id)
      await runNow(w, perRun)
      const perRunRecord = await finished(w, perRun.id)

      for (const record of [boundRecord, perRunRecord]) expect(record).toMatchObject({ status: 'error', error: expect.stringMatching(/hidden/i) })
      expect(w.engine.listRuns(thread.id)).toHaveLength(0)
      expect(perRunThreads(w, perRun.id)).toHaveLength(0)
      expect(claude.turns).toHaveLength(0)
      expect(pi.turns).toHaveLength(0)
    })

    it('refuses a provider instance that no longer exists', async () => {
      const pi = piAdapter(() => 'pi')
      const w = boot([pi])
      const project = projectOf(w)
      const job = addJob(w, { projectId: project.id, selection: { instanceId: 'removed-instance', llmProvider: 'removed-instance', model: 'm' } })

      await runNow(w, job)
      const record = await finished(w, job.id)

      // The turn fails after admission (an older selection is not re-checked before it), so the run is on record as failed.
      expect(record).toMatchObject({ status: 'error', error: expect.stringContaining('removed-instance') })
      expect(w.engine.getRun(record.runId!)?.status).toBe('failed')
      expect(pi.turns).toHaveLength(0)
    })

    it('fails a job whose project was removed, instead of running it without one', async () => {
      const pi = piAdapter(() => 'pi')
      const w = boot([pi])
      const project = projectOf(w)
      const job = addJob(w, { projectId: project.id })
      w.projects.removeProject(project.id)

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(record).toMatchObject({ status: 'error', error: expect.stringMatching(/project no longer exists/i) })
      expect(w.store.listAllThreads().filter((thread) => thread.scheduledJobId === job.id)).toHaveLength(0)
      expect(pi.turns).toHaveLength(0)
    })

    it('fails a job whose existing worktree has no owner any more', async () => {
      const pi = piAdapter(() => 'pi')
      const w = boot([pi])
      const project = projectOf(w)
      const job = addJob(w, { projectId: project.id, workspace: { kind: 'worktree', path: join(fx.root, 'gone-worktree') } })

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(record).toMatchObject({ status: 'error', error: expect.stringMatching(/No thread owns a ready worktree/) })
      expect(pi.turns).toHaveLength(0)
    })

    it('fails a new-worktree job whose project stopped being a Git repository, instead of running on its checkout', async () => {
      const pi = piAdapter(() => 'pi')
      const w = boot([pi])
      const project = projectOf(w)
      const job = addJob(w, { projectId: project.id, workspace: { kind: 'newWorktree' } })
      rmSync(join(fx.repo, '.git'), { recursive: true, force: true })

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(record).toMatchObject({ status: 'error', error: expect.stringMatching(/new worktree.*Git repository/) })
      expect(perRunThreads(w, job.id)).toHaveLength(0)
      expect(pi.turns).toHaveLength(0)
    })

    it('stops a new-worktree job at ten open per-run threads and says how to continue', async () => {
      const pi = piAdapter(() => 'pi')
      const w = boot([pi])
      const project = projectOf(w)
      const job = addJob(w, { projectId: project.id, workspace: { kind: 'newWorktree' } })
      for (let index = 0; index < 10; index += 1) w.store.createThread(`Scheduled: Report ${index}`, project.id, project.path, { scheduledJobId: job.id })

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(record).toMatchObject({ status: 'error', error: expect.stringMatching(/10 open per-run worktree threads; settle or delete some, or bind the job to a thread/) })
      expect(perRunThreads(w, job.id)).toHaveLength(10)
      expect(pi.turns).toHaveLength(0)
    })

    it('keeps running a job on the project\'s checkout past ten runs, settling each finished run\'s thread', async () => {
      const pi = piAdapter((input) => `pi: ${input.prompt}`)
      const w = boot([pi])
      const project = projectOf(w)
      const job = addJob(w, { projectId: project.id })

      for (let run = 1; run <= 12; run += 1) {
        await runNow(w, job)
        await waitFor(() => w.jobs.getJob(job.id)?.runHistory?.length === Math.min(run, 20) && !w.jobs.getJob(job.id)?.runClaim, `run ${run}`)
      }

      const records = w.jobs.getJob(job.id)!.runHistory!
      expect(records.map((record) => record.status)).toEqual(Array(12).fill('ok'))
      expect(pi.turns).toHaveLength(12)
      expect(perRunThreads(w, job.id)).toHaveLength(12)
      expect(perRunThreads(w, job.id).every((thread) => thread.settledAt)).toBe(true)
      // A settled thread is still reachable from the run record.
      expect(w.store.getThread(records[0].threadId!)).toBeDefined()
    })

    it('leaves the thread of a new-worktree run open, because it holds that run worktree', async () => {
      const pi = piAdapter(() => 'pi')
      const w = boot([pi])
      const project = projectOf(w)
      const job = addJob(w, { projectId: project.id, workspace: { kind: 'newWorktree' } })

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(record.status).toBe('ok')
      expect(w.store.getThread(record.threadId!)?.settledAt).toBeFalsy()
    })

    it('settles a [SILENT] per-run thread, so it leaves the sidebar and stops counting toward the cap', async () => {
      const pi = piAdapter(() => '[SILENT]')
      const w = boot([pi])
      const project = projectOf(w)
      const job = addJob(w, { projectId: project.id })

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(record).toMatchObject({ status: 'ok', silent: true })
      expect(w.store.getThread(record.threadId!)?.settledAt).toBeTruthy()
    })

    it('records a run the engine ended failed as an error, even though the turn returned', async () => {
      const pi = piAdapter(() => 'unused')
      pi.failNext = new Error('provider exploded')
      const w = boot([pi])
      const project = projectOf(w)
      const job = addJob(w, { projectId: project.id })

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(record.status).toBe('error')
      expect(w.engine.getRun(record.runId!)?.status).toBe('failed')
      expect(w.jobs.getJob(job.id)).toMatchObject({ lastStatus: 'error', state: 'scheduled' })
    })
  })

  describe('overlapping runs', () => {
    /** A bound thread running a turn that waits for `release`, with an interval job due on it. */
    const busyThread = async (w: World, pi: ScriptedAdapter, extra: Partial<Parameters<ScheduledJobStore['createJob']>[0]> = {}) => {
      const project = projectOf(w)
      const thread = w.store.createThread('Busy', project.id, project.path)
      w.orch.setThreadModelOverride(thread.id, PI)
      await w.orch.send('hold', false, { threadId: thread.id, clientRequestId: 'person-1', awaitMode: 'ack' })
      await waitFor(() => pi.turns.length === 1, 'the busy turn')
      const job = addJob(w, { threadId: thread.id, projectId: project.id, schedule: { kind: 'interval', minutes: 10 }, ...extra })
      makeDue(w, job)
      return { thread, job }
    }

    it('queues one item behind a busy thread, adds no second across further ticks, and runs it with the job\'s model once the thread is free', async () => {
      const release = gate()
      const pi = piAdapter(async (input) => {
        if (input.prompt.includes('hold')) await release.promise
        return `pi: ${input.prompt}`
      })
      const claude = claudeAdapter((input) => `claude: ${input.prompt}`)
      const w = boot([pi, claude])
      const { thread, job } = await busyThread(w, pi, { selection: CLAUDE_SELECTION })

      await w.tick()
      await waitFor(() => w.jobs.getJob(job.id)?.pendingOccurrence?.state === 'queued', 'the queued occurrence')
      const queue = readDurableQueue(w.store, thread.id)
      expect(queue).toHaveLength(1)
      expect(queue[0]).toMatchObject({
        source: 'schedule',
        runId: expect.any(String),
        origin: { kind: 'schedule', jobId: job.id, occurrenceKey: PAST, jobName: 'Report', selection: CLAUDE_SELECTION }
      })
      const held = w.jobs.getJob(job.id)!
      expect(held.runHistory).toEqual([expect.objectContaining({ status: 'queued', threadId: thread.id, runId: queue[0].runId, queueItemId: queue[0].id })])
      expect(held).toMatchObject({ state: 'scheduled', nextRunAt: PAST })

      for (let index = 0; index < 3; index += 1) await w.tick()
      expect(readDurableQueue(w.store, thread.id)).toHaveLength(1)
      expect(w.engine.listRuns(thread.id)).toHaveLength(2)

      release.resolve()
      const record = await finished(w, job.id)

      expect(record).toMatchObject({ status: 'ok', threadId: thread.id, runId: queue[0].runId })
      expect(record.output).toContain('claude: ')
      expect(w.engine.bindingForRun(queue[0].runId!)).toMatchObject({ instanceId: 'claude', model: 'sonnet', policy: { origin: 'schedule' } })
      expect(claude.turns).toHaveLength(1)
      expect(w.store.getThread(thread.id)?.modelOverride).toMatchObject(PI)
      // The person's own message is not marked; the job's prompt is, after waiting in the queue too.
      const users = w.orch.getOrCreateSession(thread.id).messages.filter((message) => message.role === 'user')
      expect(users.map((message) => message.scheduled?.jobName)).toEqual([undefined, 'Report'])
      // The repeat is spent and the next run is a full interval away.
      expect(new Date(w.jobs.getJob(job.id)!.nextRunAt!).getTime()).toBeGreaterThan(Date.now())
      expect(readDurableQueue(w.store, thread.id)).toHaveLength(0)
    })

    it('treats a thread waiting on a question as busy: the occurrence queues and the question survives', async () => {
      const pi = piAdapter(() => 'pi')
      const w = boot([pi])
      const project = projectOf(w)
      const thread = w.store.createThread('Asking', project.id, project.path)
      w.orch.setThreadModelOverride(thread.id, PI)
      const questions = (w.orch as any).questions
      const answer = questions.requestAnswers([], thread.id).catch(() => undefined)
      expect(questions.listPendingForThread(thread.id)).toHaveLength(1)
      const job = addJob(w, { threadId: thread.id, projectId: project.id, schedule: { kind: 'interval', minutes: 10 } })
      makeDue(w, job)

      await w.tick()
      await waitFor(() => w.jobs.getJob(job.id)?.pendingOccurrence?.state === 'queued', 'the queued occurrence')

      expect(questions.listPendingForThread(thread.id)).toHaveLength(1)
      expect(readDurableQueue(w.store, thread.id)).toHaveLength(1)
      expect(pi.turns).toHaveLength(0)
      // Settle it the way a person's message does, without stopping the question service.
      questions.autoRejectPendingForThread(thread.id)
      await answer
    })

    it('ends an occurrence whose queue item was removed before it started as interrupted, with no copy of it', async () => {
      const release = gate()
      const pi = piAdapter(async (input) => {
        if (input.prompt.includes('hold')) await release.promise
        return `pi: ${input.prompt}`
      })
      const w = boot([pi])
      const { thread, job } = await busyThread(w, pi)
      await w.tick()
      await waitFor(() => w.jobs.getJob(job.id)?.pendingOccurrence?.state === 'queued', 'the queued occurrence')
      const [item] = readDurableQueue(w.store, thread.id)

      w.orch.removeQueuedItem(thread.id, item.id)
      await w.tick()
      const record = await finished(w, job.id)

      expect(record).toMatchObject({ status: 'interrupted', error: 'Interrupted: removed before start' })
      expect(readDurableQueue(w.store, thread.id)).toHaveLength(0)
      expect(w.engine.getRun(item.runId!)?.status).toBe('cancelled')
      release.resolve()
      await waitFor(() => w.engine.listRuns(thread.id).every((run) => run.status !== 'running'), 'the busy turn')
      expect(pi.turns).toHaveLength(1)
    })

    it('adds nothing while a queued turn that already started waits on its provider', async () => {
      const releaseBusy = gate()
      const releaseScheduled = gate()
      const pi = piAdapter(async (input) => {
        if (input.prompt.includes('hold')) await releaseBusy.promise
        if (input.prompt.includes('write the report')) await releaseScheduled.promise
        return `pi: ${input.prompt}`
      })
      const w = boot([pi])
      const { thread, job } = await busyThread(w, pi)
      await w.tick()
      await waitFor(() => w.jobs.getJob(job.id)?.pendingOccurrence?.state === 'queued', 'the queued occurrence')

      releaseBusy.resolve()
      await waitFor(() => pi.turns.length === 2, 'the queued turn to start')
      // Its item is consumed once the turn accepted its input, yet the occurrence is still open.
      await waitFor(() => readDurableQueue(w.store, thread.id).length === 0, 'the item to be consumed')
      for (let index = 0; index < 3; index += 1) await w.tick()
      w.jobs.triggerJob(job.id)
      await w.tick()

      expect(w.jobs.getJob(job.id)?.pendingOccurrence).toBeDefined()
      expect(w.engine.listRuns(thread.id)).toHaveLength(2)
      expect(pi.turns).toHaveLength(2)
      expect(readDurableQueue(w.store, thread.id)).toHaveLength(0)

      releaseScheduled.resolve()
      const record = await finished(w, job.id)
      expect(record.status).toBe('ok')
      expect(w.engine.listRuns(thread.id)).toHaveLength(2)
    })

    it('keeps an occurrence queued when a peer wins the thread\'s execution lease, and completes it once when it is finally run', async () => {
      const pi = piAdapter((input) => `pi: ${input.prompt}`)
      const claude = claudeAdapter((input) => `claude: ${input.prompt}`)
      const w = boot([pi, claude])
      const project = projectOf(w)
      const thread = w.store.createThread('Shared', project.id, project.path)
      w.orch.setThreadModelOverride(thread.id, PI)
      const job = addJob(w, { threadId: thread.id, projectId: project.id, selection: CLAUDE_SELECTION, schedule: { kind: 'interval', minutes: 10 } })
      makeDue(w, job)
      // The peer takes the lease after this daemon decided the thread was idle.
      const peer = tryAcquireExecutionLease(w.store.getThreadDir(thread.id), { source: 'peer-daemon' })
      expect(peer).not.toBeNull()
      const idle = vi.spyOn(w.orch, 'isThreadLeaseHeldExternally').mockReturnValue(false)

      await w.tick()
      await waitFor(() => w.jobs.getJob(job.id)?.pendingOccurrence?.state === 'queued', 'the occurrence to wait in the queue')
      const [item] = readDurableQueue(w.store, thread.id)
      const runId = w.jobs.getJob(job.id)!.pendingOccurrence!.runId

      expect(item).toMatchObject({ source: 'schedule', runId, origin: { kind: 'schedule', jobId: job.id, occurrenceKey: PAST, jobName: 'Report', selection: CLAUDE_SELECTION } })
      expect(w.engine.getRun(runId)?.status).toBe('queued')
      expect(w.jobs.getJob(job.id)).toMatchObject({ state: 'scheduled', nextRunAt: PAST })
      for (let index = 0; index < 2; index += 1) await w.tick()
      w.jobs.triggerJob(job.id)
      await w.tick()
      expect(readDurableQueue(w.store, thread.id)).toHaveLength(1)
      expect(w.engine.listRuns(thread.id)).toHaveLength(1)
      expect(claude.turns).toHaveLength(0)

      // The peer's execution ends; the item is drained and its run is the occurrence's single run.
      releaseExecutionLeaseHandle(peer!)
      idle.mockRestore()
      ;(w.orch as any).scheduleQueueDrain(w.orch.getOrCreateSession(thread.id))
      const record = await finished(w, job.id)

      expect(record).toMatchObject({ status: 'ok', runId, threadId: thread.id })
      expect(w.engine.getRun(runId)).toMatchObject({ status: 'completed', source: 'schedule' })
      expect(w.engine.bindingForRun(runId)).toMatchObject({ instanceId: 'claude', model: 'sonnet', policy: { origin: 'schedule' } })
      expect(claude.turns).toHaveLength(1)
      expect(w.engine.listRuns(thread.id)).toHaveLength(1)
      expect(w.jobs.getJob(job.id)?.runHistory).toHaveLength(1)
    })

    it('observes the existing run when the same occurrence is admitted again, and starts nothing', async () => {
      const pi = piAdapter((input) => `pi: ${input.prompt}`)
      const w = boot([pi], { start: false })
      const project = projectOf(w)
      const thread = w.store.createThread('Target', project.id, project.path)
      w.orch.setThreadModelOverride(thread.id, PI)
      const ingress = { jobId: 'job-replay', occurrenceAt: PAST, occurrenceKey: PAST, threadId: thread.id, projectId: project.id, jobName: 'Replay' }

      const first = await w.orch.runIsolatedScheduledJob('write the report', ingress)
      const second = await w.orch.runIsolatedScheduledJob('write the report', ingress)

      expect(first).toMatchObject({ threadId: thread.id, text: 'pi: write the report' })
      expect(second).toMatchObject({ status: 'replayed', runId: first.runId, threadId: thread.id })
      expect(pi.turns).toHaveLength(1)
      expect(w.engine.listRuns(thread.id)).toHaveLength(1)
    })

    it.each([
      ['rejected', () => ({ status: 'rejected', reason: 'stale_write', sequence: 0 })],
      ['ignored', () => ({ status: 'ignored', sequence: 0 })]
    ])('fails closed when admission is %s, on an idle and on a busy thread', async (_label, outcome) => {
      const release = gate()
      const pi = piAdapter(async (input) => {
        if (input.prompt.includes('hold')) await release.promise
        return `pi: ${input.prompt}`
      })
      const w = boot([pi], { start: false })
      const project = projectOf(w)
      const idle = w.store.createThread('Idle', project.id, project.path)
      const busy = w.store.createThread('Busy', project.id, project.path)
      w.orch.setThreadModelOverride(idle.id, PI)
      w.orch.setThreadModelOverride(busy.id, PI)
      await w.orch.send('hold', false, { threadId: busy.id, clientRequestId: 'person-1', awaitMode: 'ack' })
      await waitFor(() => pi.turns.length === 1, 'the busy turn')
      const turnsBefore = pi.turns.length
      const dispatch = vi.spyOn(w.engine, 'dispatch')

      for (const [index, target] of [idle, busy].entries()) {
        dispatch.mockResolvedValueOnce(outcome() as never)
        const result = await w.orch.runIsolatedScheduledJob('write the report', { jobId: 'job-closed', occurrenceAt: PAST, occurrenceKey: `${PAST}#${index}`, threadId: target.id, projectId: project.id })
        expect(result.error).toBeTruthy()
        expect(result.runId).toBeUndefined()
      }
      dispatch.mockRejectedValueOnce(new Error('dispatch failed'))
      const thrown = await w.orch.runIsolatedScheduledJob('write the report', { jobId: 'job-closed', occurrenceAt: PAST, occurrenceKey: `${PAST}#thrown`, threadId: busy.id, projectId: project.id })
      expect(thrown.error).toBe('dispatch failed')

      expect(pi.turns).toHaveLength(turnsBefore)
      expect(readDurableQueue(w.store, busy.id)).toHaveLength(0)
      expect(w.engine.listRuns(idle.id)).toHaveLength(0)
    })

    it('reuses the thread its claim recorded when an occurrence is retried', async () => {
      const pi = piAdapter((input) => `pi: ${input.prompt}`)
      const w = boot([pi], { start: false })
      const project = projectOf(w)
      const job = addJob(w, { projectId: project.id })
      const chosen: string[] = []
      const ingress = { jobId: job.id, occurrenceAt: PAST, occurrenceKey: PAST, projectId: project.id, jobName: job.name, onThreadChosen: (id: string) => { chosen.push(id) } }

      const first = await w.orch.runIsolatedScheduledJob('write the report', ingress)
      const retry = await w.orch.runIsolatedScheduledJob('write the report', { ...ingress, claim: { threadId: chosen[0] } })

      expect(chosen).toHaveLength(2)
      expect(chosen[1]).toBe(chosen[0])
      expect(first.threadId).toBe(chosen[0])
      expect(retry.threadId).toBe(chosen[0])
      expect(perRunThreads(w, job.id)).toHaveLength(1)
    })

    it('runs due jobs at the same time, so a slow one does not hold the others', async () => {
      const release = gate()
      const pi = piAdapter(async (input) => {
        if (input.prompt.includes('slow')) await release.promise
        return `pi: ${input.prompt}`
      })
      const w = boot([pi])
      const project = projectOf(w)
      const slow = addJob(w, { name: 'Slow', prompt: 'slow work', projectId: project.id })
      const quick = addJob(w, { name: 'Quick', prompt: 'quick work', projectId: project.id })
      w.jobs.triggerJob(slow.id)
      w.jobs.triggerJob(quick.id)

      await w.tick()
      const quickRecord = await finished(w, quick.id)

      expect(quickRecord.status).toBe('ok')
      expect(w.jobs.getJob(slow.id)?.state).toBe('running')
      expect(w.service.getStatus().activeJobIds).toContain(slow.id)
      release.resolve()
      expect((await finished(w, slow.id)).status).toBe('ok')
    })
  })

  describe('missed runs', () => {
    it('runs an overdue job once after the daemon was off, then waits a full interval', async () => {
      const pi = piAdapter((input) => `pi: ${input.prompt}`)
      const w = boot([pi], { start: false })
      const project = projectOf(w)
      const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
      const job = addJob(w, { projectId: project.id, schedule: { kind: 'interval', minutes: 60 } })
      makeDue(w, job, longAgo)

      w.service.start()
      const record = await finished(w, job.id)
      for (let index = 0; index < 3; index += 1) await w.tick()

      expect(record).toMatchObject({ status: 'ok', occurrenceKey: longAgo })
      expect(pi.turns).toHaveLength(1)
      expect(w.engine.listRuns(record.threadId!)).toHaveLength(1)
      const next = new Date(w.jobs.getJob(job.id)!.nextRunAt!).getTime()
      expect(next).toBeGreaterThan(Date.now() + 50 * 60 * 1000)
    })
  })

  describe('a restart while a job runs', () => {
    const jobOn = (w: World, extra: Partial<Parameters<ScheduledJobStore['createJob']>[0]> = {}) => {
      const project = projectOf(w)
      const job = addJob(w, { projectId: project.id, schedule: { kind: 'interval', minutes: 10 }, ...extra })
      makeDue(w, job)
      const [claimed] = w.jobs.claimDueJobs()
      return { project, job, claimed }
    }

    /** The state a crash leaves between an admission and the write that would start the run. */
    const admitWithoutStart = async (w: World, jobId: string, threadId: string, claimed: ScheduledJob, options: { recordRun: boolean }) => {
      const key = claimed.runClaim!.occurrenceKey
      w.jobs.markClaimThread(jobId, claimed.runClaim!.token, threadId)
      const sent = await w.engine.dispatch({ kind: 'send', threadId, clientRequestId: `schedule:${jobId}:${key}`, source: 'schedule' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      if (options.recordRun) w.jobs.markOccurrenceAdmitted(jobId, claimed.runClaim!.token, sent.runId)
      return sent.runId
    }

    it('runs an admitted occurrence exactly once after the restart when its turn.start was already written', async () => {
      const first = boot([piAdapter(() => 'unused')], { start: false })
      const { job, claimed } = jobOn(first)
      // The worker is gone before it claims the turn.start; the daemon then dies.
      await first.worker.stop()
      void startByHand(first, claimed).catch(() => undefined)
      await waitFor(() => first.engine.store.listNonTerminalRuns().some((run) => first.engine.outbox.listForRun(run.runId).some((effect) => effect.kind === 'turn.start')), 'the turn.start effect')
      const runId = first.jobs.getJob(job.id)!.runClaim!.runId!
      killOwner(first, job.id)
      await first.crash()

      const pi = piAdapter((input) => `after restart: ${input.prompt}`)
      const second = boot([pi], { pid: 2, recover: true })
      expect(second.jobs.getJob(job.id)).toMatchObject({ state: 'scheduled', runClaim: undefined, pendingOccurrence: { runId, state: 'admitted' } })
      new Reconciler({ store: second.engine.store, outbox: second.engine.outbox, tools: second.engine.tools }).runOnce()
      const record = await finished(second, job.id)

      expect(record).toMatchObject({ status: 'ok', runId })
      expect(record.output).toContain('after restart: ')
      expect(pi.turns).toHaveLength(1)
      expect(second.engine.listRuns(record.threadId!)).toHaveLength(1)
      expect(second.engine.getRun(runId)).toMatchObject({ status: 'completed', source: 'schedule' })
      // The per-run thread is kept: it holds the run's messages.
      expect(second.store.getThread(record.threadId!)).toBeDefined()
      expect(second.orch.getMessages(record.threadId!).some((message) => message.role === 'assistant')).toBe(true)
      expect(second.jobs.getJob(job.id)?.pendingOccurrence).toBeUndefined()
    })

    it('keeps the mode of the job for an occurrence that was admitted but not started when the daemon died', async () => {
      const first = boot([piAdapter(() => 'unused')], { start: false })
      const { job, claimed } = jobOn(first, { permissionMode: 'ask', permissionCeiling: 'full' })
      await first.worker.stop()
      void startByHand(first, claimed).catch(() => undefined)
      await waitFor(() => first.engine.store.listNonTerminalRuns().some((run) => first.engine.outbox.listForRun(run.runId).some((effect) => effect.kind === 'turn.start')), 'the turn.start effect')
      const runId = first.jobs.getJob(job.id)!.runClaim!.runId!
      killOwner(first, job.id)
      await first.crash()

      const pi = piAdapter((input) => `after restart: ${input.prompt}`)
      const second = boot([pi], { pid: 2, recover: true })
      new Reconciler({ store: second.engine.store, outbox: second.engine.outbox, tools: second.engine.tools }).runOnce()
      const record = await finished(second, job.id)

      expect(record).toMatchObject({ status: 'ok', runId })
      // The thread follows the profile default (Auto-accept edits); the job's own mode is the stricter one.
      expect(second.orch.requestedPermissionMode(record.threadId!)).toBe('accept_edits')
      expect(second.engine.bindingForRun(runId)?.policy.permissionMode).toBe('ask')
      expect(record.permissionMode).toBe('ask')
    })

    it.each([
      ['crash right after the run was recorded', true],
      ['crash between the dispatch and the claim write', false]
    ])('cancels an admission nothing can start and ends the occurrence as never started (%s)', async (_label, recordRun) => {
      const first = boot([piAdapter(() => 'unused')], { start: false })
      const { project, job, claimed } = jobOn(first)
      const thread = first.store.createThread('Scheduled: Report', project.id, project.path, { scheduledJobId: job.id, workspaceBinding: { policy: 'primary' } })
      const runId = await admitWithoutStart(first, job.id, thread.id, claimed, { recordRun })
      killOwner(first, job.id)
      await first.crash()

      const pi = piAdapter((input) => `after restart: ${input.prompt}`)
      const second = boot([pi], { pid: 2, recover: true })
      const record = await finished(second, job.id)

      expect(record).toMatchObject({ status: 'interrupted', error: 'Interrupted: never started', runId, threadId: thread.id })
      expect(second.engine.getRun(runId)).toMatchObject({ status: 'cancelled' })
      expect(second.engine.listRuns(thread.id)).toHaveLength(1)
      expect(pi.turns).toHaveLength(0)
      // The per-run thread the dead claim made is empty, so recovery does not keep it.
      expect(second.store.getThread(thread.id)).toBeUndefined()
      expect(second.jobs.getJob(job.id)).toMatchObject({ state: 'scheduled', runClaim: undefined, pendingOccurrence: undefined })
    })

    it('cancels the same window on a busy thread, whose running turn the restart interrupts', async () => {
      const first = boot([piAdapter(() => 'unused')], { start: false })
      const project = projectOf(first)
      const thread = first.store.createThread('Busy', project.id, project.path)
      first.orch.setThreadModelOverride(thread.id, PI)
      // A person's turn is running when the daemon dies (a crash does not wait for it).
      const person = await first.engine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: 'person-1', source: 'gui' })
      if (person.status !== 'accepted') throw new Error('send rejected')
      first.engine.markStarting(person.runId)
      first.engine.markRunning(person.runId)
      const job = addJob(first, { threadId: thread.id, projectId: project.id, schedule: { kind: 'interval', minutes: 10 } })
      makeDue(first, job)
      const [claimed] = first.jobs.claimDueJobs()
      const runId = await admitWithoutStart(first, job.id, thread.id, claimed, { recordRun: true })
      killOwner(first, job.id)
      await first.crash()

      const pi = piAdapter(() => 'after restart')
      const second = boot([pi], { pid: 2, recover: true })
      const record = await finished(second, job.id)

      expect(record).toMatchObject({ status: 'interrupted', error: 'Interrupted: never started', runId })
      expect(second.engine.getRun(runId)?.status).toBe('cancelled')
      expect(second.engine.getRun(person.runId)?.status).toBe('interrupted')
      expect(second.engine.listRuns(thread.id)).toHaveLength(2)
      expect(pi.turns).toHaveLength(0)
    })

    it('ends a started run the restart cut off as interrupted and does not run it again', async () => {
      const first = boot([piAdapter(() => 'unused')], { start: false })
      const { project, job, claimed } = jobOn(first)
      const thread = first.store.createThread('Scheduled: Report', project.id, project.path, { scheduledJobId: job.id, workspaceBinding: { policy: 'primary' } })
      const runId = await admitWithoutStart(first, job.id, thread.id, claimed, { recordRun: true })
      first.engine.markStarting(runId)
      first.engine.markRunning(runId)
      killOwner(first, job.id)
      await first.crash()

      const pi = piAdapter(() => 'after restart')
      const second = boot([pi], { pid: 2, recover: true })
      const record = await finished(second, job.id)

      expect(record).toMatchObject({ status: 'interrupted', error: expect.stringMatching(/daemon restarted/i), runId })
      expect(second.engine.getRun(runId)).toMatchObject({ status: 'interrupted', outcome: { interruptedBy: 'daemon_restart' } })
      expect(pi.turns).toHaveLength(0)
      expect(second.engine.listRuns(thread.id)).toHaveLength(1)
      expect(second.jobs.getJob(job.id)).toMatchObject({ state: 'scheduled', pendingOccurrence: undefined })
    })

    it('ends a run with a non-idempotent tool in flight as uncertain, keeps the engine\'s warning, and never replays it', async () => {
      const first = boot([piAdapter(() => 'unused')], { start: false })
      const { project, job, claimed } = jobOn(first)
      const thread = first.store.createThread('Scheduled: Report', project.id, project.path, { scheduledJobId: job.id, workspaceBinding: { policy: 'primary' } })
      const runId = await admitWithoutStart(first, job.id, thread.id, claimed, { recordRun: true })
      first.engine.markStarting(runId)
      const running = first.engine.markRunning(runId)
      first.engine.tools.start({ invocationId: 'call-1', runId, attemptId: running.activeAttemptId!, tool: 'bash', argsDigest: 'd', now: new Date().toISOString() })
      killOwner(first, job.id)
      await first.crash()

      const pi = piAdapter(() => 'after restart')
      const second = boot([pi], { pid: 2, recover: true })
      const record = await finished(second, job.id)

      expect(record).toMatchObject({ status: 'uncertain', error: expect.stringContaining('Non-idempotent tools were in flight'), runId })
      expect(second.jobs.getJob(job.id)).toMatchObject({ lastStatus: 'uncertain', state: 'scheduled', pendingOccurrence: undefined, runClaim: undefined })
      expect(second.engine.getRun(runId)?.status).toBe('uncertain')
      expect(pi.turns).toHaveLength(0)
      expect(second.engine.listRuns(thread.id)).toHaveLength(1)
    })

    it('interrupts a claim that never reached a run and discards its empty per-run thread', async () => {
      const first = boot([piAdapter(() => 'unused')], { start: false })
      const { project, job, claimed } = jobOn(first)
      const thread = first.store.createThread('Scheduled: Report', project.id, project.path, { scheduledJobId: job.id, workspaceBinding: { policy: 'primary' } })
      first.jobs.markClaimThread(job.id, claimed.runClaim!.token, thread.id)
      killOwner(first, job.id)
      await first.crash()

      const pi = piAdapter(() => 'after restart')
      const second = boot([pi], { pid: 2, recover: true })
      const record = await finished(second, job.id)

      expect(record).toMatchObject({ status: 'interrupted', error: expect.stringMatching(/no longer live/) })
      expect(second.store.getThread(thread.id)).toBeUndefined()
      expect(pi.turns).toHaveLength(0)
    })
  })

  describe('a saved target is checked as often as a new one', () => {
    it('fails a job bound to a thread of a project that was removed, even though the thread is still readable', async () => {
      const pi = piAdapter(() => 'pi')
      const w = boot([pi])
      const project = projectOf(w)
      const thread = w.store.createThread('Target', project.id, project.path)
      // The thread list is warm, as it is in a running app.
      w.store.listThreads(project.id)
      const job = addJob(w, { threadId: thread.id })
      w.projects.removeProject(project.id)

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(record).toMatchObject({ status: 'error', error: expect.stringMatching(/project no longer exists/i) })
      expect(w.engine.listRuns(thread.id)).toHaveLength(0)
      expect(w.orch.getMessages(thread.id)).toHaveLength(0)
      expect(pi.turns).toHaveLength(0)
    })

    it('fails a job whose saved owner thread no longer owns the existing worktree it asks for', async () => {
      const pi = piAdapter((input) => `pi: ${input.prompt}`)
      const w = boot([pi])
      const project = projectOf(w)
      const fresh = addJob(w, { name: 'Fresh', projectId: project.id, workspace: { kind: 'newWorktree' } })
      await runNow(w, fresh)
      const owner = (await finished(w, fresh.id)).threadId!
      const metadata = new ThreadWorkspaceManager(w.store.getThreadDir(owner)).load()!
      const other = w.store.createThread('Someone else', project.id, project.path)
      // The shape the protocol saves: the owner's id as `threadId`, next to the worktree path.
      const saved = addJob(w, { name: 'Saved', projectId: project.id, threadId: owner, workspace: { kind: 'worktree', path: metadata.worktreePath } })
      const wrong = addJob(w, { name: 'Wrong', projectId: project.id, threadId: other.id, workspace: { kind: 'worktree', path: metadata.worktreePath } })

      await runNow(w, saved)
      expect((await finished(w, saved.id)).status).toBe('ok')

      await runNow(w, wrong)
      const wrongRecord = await finished(w, wrong.id)
      expect(wrongRecord).toMatchObject({ status: 'error', error: expect.stringMatching(/no longer owns the worktree/) })
      expect(w.engine.listRuns(other.id)).toHaveLength(0)

      // The owner loses its workspace: the saved thread is not enough to run there.
      rmSync(join(w.store.getThreadDir(owner), 'workspace.json'), { force: true })
      w.jobs.updateJob(saved.id, { nextRunAt: null })
      await runNow(w, saved)
      await waitFor(() => w.jobs.getJob(saved.id)?.runHistory?.length === 2 && !w.jobs.getJob(saved.id)?.runClaim, 'the second run of the saved job')
      expect(w.jobs.getJob(saved.id)?.runHistory?.at(-1)).toMatchObject({ status: 'error', error: expect.stringMatching(/No thread owns a ready worktree/) })
    })

    it('refuses a thread whose own runtime approves tools itself before the prompt is written into it', async () => {
      const unattended = new ScriptedAdapter('codex', CLAUDE_SUBSCRIPTION_CAPABILITIES, () => 'unused')
      const pi = piAdapter(() => 'pi')
      const w = boot([pi], { drivers: [adapterDriver(unattended, { toolControl: 'uncontrolled' })] })
      const project = projectOf(w)
      const thread = w.store.createThread('Codex thread', project.id, project.path)
      w.orch.setThreadModelOverride(thread.id, { instanceId: 'codex', llmProvider: 'codex', model: 'gpt-x' })
      const job = addJob(w, { threadId: thread.id, projectId: project.id })

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(record).toMatchObject({ status: 'error', error: expect.stringMatching(/approves tools itself/) })
      expect(w.engine.listRuns(thread.id)).toHaveLength(0)
      expect(w.store.loadThreadData(thread.id).messages).toHaveLength(0)
      expect(unattended.turns).toHaveLength(0)
    })

    it('refuses the send and cancels the run it admitted when the claim cannot record that run', async () => {
      const pi = piAdapter((input) => `pi: ${input.prompt}`)
      const w = boot([pi], { start: false })
      const project = projectOf(w)
      const thread = w.store.createThread('Target', project.id, project.path)
      w.orch.setThreadModelOverride(thread.id, PI)

      const result = await w.orch.runIsolatedScheduledJob('write the report', {
        jobId: 'job-lost', occurrenceAt: PAST, occurrenceKey: PAST, threadId: thread.id, projectId: project.id,
        onAdmitted: () => { throw new Error('Scheduled claim was lost before its run was recorded') }
      })

      expect(result.error).toBe('Scheduled claim was lost before its run was recorded')
      const [run] = w.engine.listRuns(thread.id)
      expect(run.status).toBe('cancelled')
      expect(pi.turns).toHaveLength(0)
      expect(readDurableQueue(w.store, thread.id)).toHaveLength(0)
    })
  })

  describe('what a scheduled turn may reach', () => {
    const setProfileAccess = (w: World, level: 'lineage' | 'read' | 'manage') => {
      ;(w.orch as any).settingsStore.get().agentAccess = { level, projectIds: [], answerApprovals: false }
    }

    it('grants at most the job creator\'s level, and `lineage` when the creator is unknown', async () => {
      const pi = piAdapter(() => 'pi')
      const w = boot([pi])
      setProfileAccess(w, 'manage')
      const project = projectOf(w)
      const unknown = addJob(w, { name: 'Unknown', projectId: project.id })
      const reader = addJob(w, { name: 'Reader', projectId: project.id, accessCap: 'read' })
      const manager = addJob(w, { name: 'Manager', projectId: project.id, accessCap: 'manage' })

      const records: Record<string, ScheduledJobRunRecord> = {}
      for (const job of [unknown, reader, manager]) {
        await runNow(w, job)
        records[job.name] = await finished(w, job.id)
      }

      expect(w.engine.getRun(records.Unknown.runId!)?.accessGrant).toBe('lineage')
      expect(w.engine.getRun(records.Reader.runId!)?.accessGrant).toBe('read')
      expect(w.engine.getRun(records.Manager.runId!)?.accessGrant).toBe('manage')
      // The per-run thread keeps the limit, as a channel's thread does, so what it delegates inherits it.
      expect(w.store.getThread(records.Unknown.threadId!)?.accessCeiling).toBe('lineage')
      expect(w.store.getThread(records.Reader.threadId!)?.accessCeiling).toBe('read')
    })

    it('never grants more than the profile allows now, whatever the job\'s cap', async () => {
      const pi = piAdapter(() => 'pi')
      const w = boot([pi])
      setProfileAccess(w, 'read')
      const project = projectOf(w)
      const job = addJob(w, { projectId: project.id, accessCap: 'manage' })

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(w.engine.getRun(record.runId!)?.accessGrant).toBe('read')
    })

    it('caps a run on a person\'s thread without narrowing the thread for the person', async () => {
      const release = gate()
      const pi = piAdapter(async (input) => {
        if (input.prompt.includes('hold')) await release.promise
        return `pi: ${input.prompt}`
      })
      const w = boot([pi])
      setProfileAccess(w, 'manage')
      const project = projectOf(w)
      const thread = w.store.createThread('Mine', project.id, project.path)
      w.orch.setThreadModelOverride(thread.id, PI)
      const idle = addJob(w, { name: 'Idle', threadId: thread.id, projectId: project.id })
      await runNow(w, idle)
      const idleRecord = await finished(w, idle.id)

      // The same on a busy thread: the occurrence waits in the queue and keeps its cap when drained.
      const busy = await w.orch.send('hold', false, { threadId: thread.id, clientRequestId: 'person-1', awaitMode: 'ack' })
      await waitFor(() => pi.turns.some((turn) => turn.prompt.includes('hold')), 'the busy turn')
      const queued = addJob(w, { name: 'Queued', threadId: thread.id, projectId: project.id, accessCap: 'read' })
      await runNow(w, queued)
      await waitFor(() => w.jobs.getJob(queued.id)?.pendingOccurrence?.state === 'queued', 'the queued occurrence')
      release.resolve()
      const queuedRecord = await finished(w, queued.id)
      await waitFor(() => w.engine.getRun(busy.runId!)?.status === 'completed', 'the person\'s turn')

      expect(w.engine.getRun(idleRecord.runId!)?.accessGrant).toBe('lineage')
      expect(w.engine.getRun(queuedRecord.runId!)?.accessGrant).toBe('read')
      // The person's own turn on that thread is not capped, and the thread has no limit of its own.
      expect(w.engine.getRun(busy.runId!)?.accessGrant).toBe('manage')
      expect(w.store.getThread(thread.id)?.accessCeiling).toBeUndefined()
    })

    it('runs in the thread\'s permission mode and never widens it', async () => {
      const pi = piAdapter(() => 'pi')
      const w = boot([pi])
      const project = projectOf(w)
      const strict = w.store.createThread('Strict', project.id, project.path)
      w.orch.setThreadPermissionMode(strict.id, 'ask')
      const bound = addJob(w, { name: 'Bound', threadId: strict.id, projectId: project.id })
      const perRun = addJob(w, { name: 'Per run', projectId: project.id })

      await runNow(w, bound)
      const boundRecord = await finished(w, bound.id)
      await runNow(w, perRun)
      const perRunRecord = await finished(w, perRun.id)

      expect(w.engine.bindingForRun(boundRecord.runId!)?.policy.permissionMode).toBe('ask')
      // A per-run thread follows the profile default, as any new thread does; the job adds nothing to it.
      expect(w.engine.bindingForRun(perRunRecord.runId!)?.policy.permissionMode).toBe(
        w.orch.requestedPermissionMode(perRunRecord.threadId!)
      )
    })
  })

  describe('a job\'s permission mode and ceiling', () => {
    const modeOf = (w: World, record: ScheduledJobRunRecord) => w.engine.bindingForRun(record.runId!)?.policy.permissionMode
    const setProfileDefault = (w: World, mode: 'ask' | 'accept_edits' | 'full') => {
      ;(w.orch as any).settingsStore.get().permissions.defaultMode = mode
    }
    const threadIn = (w: World, mode: 'ask' | 'accept_edits' | 'full') => {
      const project = projectOf(w)
      const thread = w.store.createThread('Target', project.id, project.path)
      w.orch.setThreadPermissionMode(thread.id, mode)
      return { project, thread }
    }
    /** A thread whose person-started turn waits for the returned gate, so a scheduled occurrence queues behind it. */
    const holdThread = async (w: World, pi: ScriptedAdapter, mode: 'ask' | 'accept_edits' | 'full') => {
      const { project, thread } = threadIn(w, mode)
      w.orch.setThreadModelOverride(thread.id, PI)
      await w.orch.send('hold', false, { threadId: thread.id, clientRequestId: 'person-1', awaitMode: 'ack' })
      await waitFor(() => pi.turns.length === 1, 'the busy turn')
      return { project, thread }
    }
    const holdingAdapter = (release: { promise: Promise<void> }) => piAdapter(async (input) => {
      if (input.prompt.includes('hold')) await release.promise
      return `pi: ${input.prompt}`
    })

    it('runs a strict job on a wider thread strictly, and a wider job on a strict thread strictly', async () => {
      const pi = piAdapter(() => 'pi')
      const w = boot([pi])
      const wide = threadIn(w, 'full')
      const strict = threadIn(w, 'ask')
      const strictJob = addJob(w, { name: 'Strict job', threadId: wide.thread.id, projectId: wide.project.id, permissionMode: 'ask', permissionCeiling: 'full' })
      const wideJob = addJob(w, { name: 'Wide job', threadId: strict.thread.id, projectId: strict.project.id, permissionMode: 'full', permissionCeiling: 'full' })

      await runNow(w, strictJob)
      const strictRecord = await finished(w, strictJob.id)
      await runNow(w, wideJob)
      const wideRecord = await finished(w, wideJob.id)

      expect(modeOf(w, strictRecord)).toBe('ask')
      expect(modeOf(w, wideRecord)).toBe('ask')
      // The record shows the mode the run enforced.
      expect(strictRecord.permissionMode).toBe('ask')
      expect(wideRecord.permissionMode).toBe('ask')
      // The job never changes its thread's own mode.
      expect(w.store.getThread(wide.thread.id)?.permissionMode).toBe('full')
    })

    it('caps a job with no mode of its own at its ceiling, on a bound thread and on a per-run thread, and never grants more than the thread or profile', async () => {
      const pi = piAdapter(() => 'pi')
      const w = boot([pi])
      setProfileDefault(w, 'accept_edits')
      const wide = threadIn(w, 'full')
      const bound = addJob(w, { name: 'Bound', threadId: wide.thread.id, projectId: wide.project.id, permissionCeiling: 'ask' })
      const perRun = addJob(w, { name: 'Per run', projectId: wide.project.id, permissionCeiling: 'ask' })
      // A ceiling is a limit, not a grant: a wide ceiling still follows the thread (or the profile default).
      const wideBound = addJob(w, { name: 'Wide bound', threadId: threadIn(w, 'ask').thread.id, projectId: wide.project.id, permissionCeiling: 'full' })
      const widePerRun = addJob(w, { name: 'Wide per run', projectId: wide.project.id, permissionCeiling: 'full' })

      const records: Record<string, ScheduledJobRunRecord> = {}
      for (const job of [bound, perRun, wideBound, widePerRun]) {
        await runNow(w, job)
        records[job.name] = await finished(w, job.id)
      }

      expect(modeOf(w, records.Bound)).toBe('ask')
      expect(modeOf(w, records['Per run'])).toBe('ask')
      expect(modeOf(w, records['Wide bound'])).toBe('ask')
      expect(modeOf(w, records['Wide per run'])).toBe('accept_edits')
    })

    it('runs a job with neither a mode nor a ceiling in its thread\'s mode', async () => {
      const pi = piAdapter(() => 'pi')
      const w = boot([pi])
      const { project, thread } = threadIn(w, 'full')
      const job = addJob(w, { threadId: thread.id, projectId: project.id })

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(modeOf(w, record)).toBe('full')
    })

    it('holds a job started by a webhook to the same mode and ceiling', async () => {
      const pi = piAdapter(() => 'pi')
      const w = boot([pi])
      const { project, thread } = threadIn(w, 'full')
      const job = addJob(w, { threadId: thread.id, projectId: project.id, permissionMode: 'accept_edits', permissionCeiling: 'accept_edits' })
      w.jobs.setWebhookTrigger(job.id, { scheme: 'mousse', secretRef: 'scheduled-webhook-test', createdAt: new Date().toISOString() })
      const accepted = w.jobs.triggerFromWebhook(job.id, { ts: Math.floor(Date.now() / 1000), sig: 'sig-1', body: Buffer.from('{}') })
      expect(accepted.kind).toBe('accepted')

      await w.tick()
      const record = await finished(w, job.id)

      expect(record.occurrenceKey).toMatch(/^webhook:/)
      expect(modeOf(w, record)).toBe('accept_edits')
      expect(w.engine.getRun(record.runId!)).toMatchObject({ source: 'schedule' })
    })

    it('keeps the job\'s mode for an occurrence that waits in the queue, and records it', async () => {
      const release = gate()
      const pi = holdingAdapter(release)
      const w = boot([pi])
      const { project, thread } = await holdThread(w, pi, 'full')
      const job = addJob(w, { threadId: thread.id, projectId: project.id, schedule: { kind: 'interval', minutes: 10 }, permissionMode: 'ask', permissionCeiling: 'full' })
      makeDue(w, job)

      await w.tick()
      await waitFor(() => w.jobs.getJob(job.id)?.pendingOccurrence?.state === 'queued', 'the queued occurrence')
      expect(readDurableQueue(w.store, thread.id)[0]).toMatchObject({ source: 'schedule', permissionMode: 'ask' })
      release.resolve()
      const record = await finished(w, job.id)

      expect(modeOf(w, record)).toBe('ask')
      expect(record.permissionMode).toBe('ask')
      // The person's own turn on that thread ran in the thread's mode.
      const person = w.engine.listRuns(thread.id).find((run) => run.clientRequestId === 'person-1')!
      expect(w.engine.bindingForRun(person.runId)?.policy.permissionMode).toBe('full')
    })

    it.each([
      ['tightened', 'full', 'ask', 'ask'],
      ['widened', 'ask', 'full', 'ask']
    ] as const)('runs a queued occurrence in the stricter of the mode it was admitted with and the mode of the job now: job %s while it waited', async (_label, admittedWith, editedTo, expected) => {
      const release = gate()
      const pi = holdingAdapter(release)
      const w = boot([pi])
      const { project, thread } = await holdThread(w, pi, 'full')
      const job = addJob(w, { threadId: thread.id, projectId: project.id, schedule: { kind: 'interval', minutes: 10 }, permissionMode: admittedWith, permissionCeiling: 'full' })
      makeDue(w, job)
      await w.tick()
      await waitFor(() => w.jobs.getJob(job.id)?.pendingOccurrence?.state === 'queued', 'the queued occurrence')
      expect(readDurableQueue(w.store, thread.id)[0]).toMatchObject({ permissionMode: admittedWith })

      // The job is edited while its occurrence waits. The run has not started, so it takes the narrower of the two.
      w.jobs.updateJob(job.id, { permissionMode: editedTo })
      release.resolve()
      const record = await finished(w, job.id)

      expect(modeOf(w, record)).toBe(expected)
      expect(record.permissionMode).toBe(expected)
    })

    it('does the same through the direct path when no effect worker is attached', async () => {
      const pi = piAdapter(() => 'pi')
      const w = boot([pi])
      w.orch.attachEffectWorker(null)
      const { project, thread } = threadIn(w, 'full')
      const job = addJob(w, { threadId: thread.id, projectId: project.id, permissionMode: 'ask', permissionCeiling: 'full' })

      await runNow(w, job)
      const record = await finished(w, job.id)

      expect(modeOf(w, record)).toBe('ask')
    })

    it('keeps a queued strict occurrence strict across a restart', async () => {
      const first = boot([piAdapter(() => 'unused')], { start: false })
      const { project, thread } = threadIn(first, 'full')
      first.orch.setThreadModelOverride(thread.id, PI)
      const job = addJob(first, { threadId: thread.id, projectId: project.id, schedule: { kind: 'interval', minutes: 10 }, permissionMode: 'ask', permissionCeiling: 'full' })
      makeDue(first, job)
      const [claimed] = first.jobs.claimDueJobs()
      // The state a crash leaves for an occurrence that was admitted and waiting behind a busy thread: its run is
      // recorded on the claim and its item, carrying the job's mode, is in the durable queue.
      const { token, occurrenceKey } = claimed.runClaim!
      first.jobs.markClaimThread(job.id, token, thread.id)
      const sent = await first.engine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: `schedule:${job.id}:${occurrenceKey}`, source: 'schedule' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      first.jobs.markOccurrenceAdmitted(job.id, token, sent.runId)
      first.orch.enqueueForThread(thread.id, { content: job.prompt, mode: 'agent' }, {
        source: 'schedule',
        runId: sent.runId,
        permissionMode: 'ask',
        origin: { kind: 'schedule', jobId: job.id, occurrenceKey, jobName: job.name }
      })
      expect(readDurableQueue(first.store, thread.id)[0]).toMatchObject({ permissionMode: 'ask', runId: sent.runId })
      killOwner(first, job.id)
      await first.crash()

      const pi = piAdapter((input) => `after restart: ${input.prompt}`)
      const second = boot([pi], { pid: 2, recover: true })
      // The restarted daemon drains the thread's saved queue, as a profile does at start.
      second.orch.recoverAndDrainPendingQueues()
      const record = await finished(second, job.id)

      expect(record).toMatchObject({ status: 'ok', runId: sent.runId })
      expect(modeOf(second, record)).toBe('ask')
      expect(record.permissionMode).toBe('ask')
      expect(pi.turns).toHaveLength(1)
    })
  })

  describe('questions asked by a scheduled turn', () => {
    it('hold the occurrence until the question ends, and the occurrence ends with the turn', async () => {
      let world: World | undefined
      let pendingWhenAsked = 0
      const pi = piAdapter(async (input) => {
        const questions = (world!.orch as any).questions
        // Long enough that only the dismissal below ends it (the timeouts are UserQuestionService's own).
        const answer = questions.requestAnswers([], input.threadId, { timeoutMs: 60_000 })
        pendingWhenAsked = questions.listAllPending().length
        try {
          await answer
          return 'answered'
        } catch {
          return 'nobody answered'
        }
      })
      const w = boot([pi])
      world = w
      const project = projectOf(w)
      const job = addJob(w, { projectId: project.id, schedule: { kind: 'interval', minutes: 10 } })
      makeDue(w, job)

      await w.tick()
      await waitFor(() => pendingWhenAsked === 1, 'the question to be asked')
      // Waiting on the question, the job still has its one occurrence: nothing else starts.
      for (let index = 0; index < 2; index += 1) await w.tick()
      expect(pi.turns).toHaveLength(1)
      expect(w.jobs.getJob(job.id)?.state).toBe('running')
      expect((w.orch as any).questions.listAllPending()).toHaveLength(1)

      // A person's message on the thread settles the question with its defaults; the turn goes on and ends.
      const threadId = w.jobs.getJob(job.id)!.runClaim!.threadId!
      ;(w.orch as any).questions.autoRejectPendingForThread(threadId)
      const record = await finished(w, job.id)
      expect(record).toMatchObject({ status: 'ok', output: 'answered' })
      expect((w.orch as any).questions.listAllPending()).toHaveLength(0)
      expect(pi.turns).toHaveLength(1)
    })
  })

  describe('jobs made before these fields existed', () => {
    it('runs a job with only the old fields as a turn on its thread, on the thread\'s model, and writes the reply once', async () => {
      const pi = piAdapter((input) => `pi: ${input.prompt}`)
      const claude = claudeAdapter((input) => `claude: ${input.prompt}`)
      const w = boot([pi, claude])
      const project = projectOf(w)
      const thread = w.store.createThread('Existing target', project.id, project.path)
      w.orch.setThreadModelOverride(thread.id, CLAUDE)
      // The shape a job had before: name, prompt, schedule, target thread, repeat; no model, mode or workspace.
      const job = w.jobs.createJob({ name: 'Old job', prompt: 'summarise', schedule: { kind: 'interval', minutes: 30 }, threadId: thread.id, repeat: { times: 2 } })
      makeDue(w, job)
      expect(job.selection).toBeUndefined()
      expect(job.mode).toBeUndefined()
      expect(job.workspace).toBeUndefined()

      await w.tick()
      const record = await finished(w, job.id)

      expect(record).toMatchObject({ status: 'ok', threadId: thread.id, mode: 'agent' })
      expect(claude.turns).toHaveLength(1)
      expect(pi.turns).toHaveLength(0)
      expect(w.orch.getMessages(thread.id).filter((message) => message.role === 'assistant')).toHaveLength(1)
      expect(w.jobs.getJob(job.id)?.repeat).toMatchObject({ times: 2, completed: 1 })
    })

    it('interrupts a running claim written before occurrences existed, as before, and then runs the job normally', async () => {
      const first = boot([piAdapter(() => 'unused')], { start: false })
      const project = projectOf(first)
      const job = addJob(first, { projectId: project.id, schedule: { kind: 'interval', minutes: 10 } })
      makeDue(first, job)
      const [claimed] = first.jobs.claimDueJobs()
      // A claim from an older version: no occurrence key, thread or run.
      const { occurrenceKey: _key, ...legacyClaim } = claimed.runClaim!
      first.jobs.updateJob(job.id, { runClaim: { ...legacyClaim, ...DEAD_OWNER } as never })
      await first.crash()

      const pi = piAdapter((input) => `pi: ${input.prompt}`)
      const second = boot([pi], { pid: 2 })
      const interrupted = await finished(second, job.id)
      expect(interrupted).toMatchObject({ status: 'interrupted', error: expect.stringMatching(/no longer live/) })
      expect(second.jobs.getJob(job.id)).toMatchObject({ state: 'scheduled', pendingOccurrence: undefined, runClaim: undefined })

      second.jobs.triggerJob(job.id)
      await second.tick()
      await waitFor(() => second.jobs.getJob(job.id)?.lastStatus === 'ok', 'the next run')
      expect(pi.turns).toHaveLength(1)
    })
  })
})
