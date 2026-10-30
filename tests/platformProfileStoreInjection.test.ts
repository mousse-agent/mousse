import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { settleThreadMutationOwnership } from '../src/mms/queue/ThreadExecutionLease'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { ThreadStorageLayout } from '../src/mms/data/ThreadStorageLayout'
import { ScheduledJobStore, readTickerHeartbeat, recordTickerHeartbeat } from '../src/mms/scheduled/ScheduledJobStore'
import { LineEditStatsStore } from '../src/mms/stats/LineEditStatsStore'
import { MmsProfileServices } from '../src/mms/MmsProfileServices'
import { ProfileDatabase } from '../src/mms/run/db/ProfileDatabase'
import { RunEngine } from '../src/mms/run/RunEngine'
import { RunStore } from '../src/mms/run/RunStore'

const fixture = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-profile-injection-'))
let sequence = 0
function home(label: string) { const path = join(fixture, label + '-' + sequence++); mkdirSync(path); return path }
afterEach(() => vi.unstubAllEnvs())
afterAll(() => {
  const rel = relative(realpathSync(tmpdir()), realpathSync(fixture))
  if (!rel.startsWith('mousse-profile-injection-') || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Unsafe fixture cleanup')
  rmSync(fixture, { recursive: true, force: true })
})

describe('explicit profile store roots', () => {
  it('splits config writes, shares only infrastructure reads and rejects prototype paths', () => {
    const installationHome = home('installation'), a = home('a'), b = home('b')
    const installation = MousseConfigStore.loadInstallation(installationHome)
    const configA = MousseConfigStore.loadProfile(a, installation), configB = MousseConfigStore.loadProfile(b, installation)
    configA.set('settings.profile.username', 'Alice')
    configA.save()
    configB.set('settings.profile.username', 'Bob')
    configB.save()
    configA.updateMmsSection({ logLevel: 'debug' })
    configA.set('features.subagentLifecycleV2', true)
    expect(configA.get('settings.profile.username')).toBe('Alice')
    expect(configB.get('settings.profile.username')).toBe('Bob')
    expect(configB.get('mms.logLevel')).toBe('debug')
    expect(configB.get('features.subagentLifecycleV2')).toBe(true)
    expect(configA.get('settings.toString')).toBeUndefined()
    const disk = JSON.parse(readFileSync(join(installationHome, 'mousse.conf'), 'utf8'))
    expect(disk.settings).toBeUndefined()
    expect(disk.providers).toBeUndefined()
    expect(disk.mms.logLevel).toBe('debug')
    expect(disk.features.subagentLifecycleV2).toBe(true)
    expect(JSON.parse(readFileSync(join(a, 'mousse.conf'), 'utf8')).mms).toBeUndefined()
    expect(() => installation.set('settings.profile.username', 'Wrong')).toThrow('bound profile')
    expect(() => configA.set('settings.__proto__.polluted', true)).toThrow('Unsafe')
    expect(() => MousseConfigStore.loadProfile(installationHome, installation)).toThrow('must be distinct')
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('keeps trash inside the profile even after switching ambient home', async () => {
    const a = home('a'), b = home('b')
    const threadsA = new ThreadDataStore(new ProjectManager(a), a, { allowLegacyProjectData: false })
    const threadsB = new ThreadDataStore(new ProjectManager(b), b, { allowLegacyProjectData: false })
    const thread = threadsA.createThread('Private A')
    vi.stubEnv('MOUSSE_HOME', b)
    const coordinator = (threads: ThreadDataStore) => new ResourceLifecycleCoordinator(threads.lifecycleStore, {
      drain: async () => undefined,
      settleMutationOwnership: async (record) => settleThreadMutationOwnership(record.location),
      projectIndex: (record) => threads.projectLifecycleIndex(record)
    })
    await coordinator(threadsA).trash({ taskId: thread.id, operationId: 'trash-a' })
    await expect(coordinator(threadsB).restore({ taskId: thread.id, operationId: 'restore-b' })).rejects.toThrow('no lifecycle owner')
    await coordinator(threadsA).restore({ taskId: thread.id, operationId: 'restore-a' })
    expect(threadsA.getThread(thread.id)?.id).toBe(thread.id)
  })

  it('loads/migrates config from its explicit root without mutating ambient home', () => {
    const a = home('a'), b = home('b')
    vi.stubEnv('MOUSSE_HOME', a)
    const config = MousseConfigStore.load(b)
    expect(config.getHomeDir()).toBe(b)
    expect(process.env.MOUSSE_HOME).toBe(a)
    expect(existsSync(join(b, 'mousse.conf'))).toBe(true)
    expect(existsSync(join(a, 'mousse.conf'))).toBe(false)
  })

  it('loads a config an older build wrote with a channels section and writes that section back unchanged', () => {
    const a = home('a')
    const channels = { platforms: { telegram: { enabled: true, token: 'fixture-token' } }, filterSilenceNarration: true }
    writeFileSync(join(a, 'mousse.conf'), JSON.stringify({ version: 1, scheduled: { enabled: false, jobs: [] }, channels }))
    const config = MousseConfigStore.load(a)
    expect(config.getScheduledSection().enabled).toBe(false)
    config.set('settings.profile.username', 'Changed')
    config.save()
    const disk = JSON.parse(readFileSync(join(a, 'mousse.conf'), 'utf8'))
    expect(disk.settings.profile.username).toBe('Changed')
    expect(disk.channels).toEqual(channels)
  })

  it('keeps projects, standalone threads and active selection in their captured home', () => {
    const a = home('a'), b = home('b'), repo = home('repository')
    vi.stubEnv('MOUSSE_HOME', a)
    const projectsA = new ProjectManager(a), projectsB = new ProjectManager(b)
    const threadsA = new ThreadDataStore(projectsA, a, { allowLegacyProjectData: false })
    const threadsB = new ThreadDataStore(projectsB, b, { allowLegacyProjectData: false })
    vi.stubEnv('MOUSSE_HOME', b)
    const project = projectsA.openProject(repo)
    const threadA = threadsA.createThread('Private A')
    const threadB = threadsB.createThread('Private B')
    threadsA.setActiveThreadId(threadA.id)
    threadsB.setActiveThreadId(threadB.id)
    expect(projectsB.listProjects()).toEqual([])
    expect(new ProjectManager(a).getProject(project.id)?.path).toBe(repo)
    expect(threadsA.getThread(threadB.id)).toBeUndefined()
    expect(threadsB.getThread(threadA.id)).toBeUndefined()
    expect(JSON.parse(readFileSync(join(a, 'active-thread.json'), 'utf8')).id).toBe(threadA.id)
    expect(JSON.parse(readFileSync(join(b, 'active-thread.json'), 'utf8')).id).toBe(threadB.id)
    expect(new ThreadDataStore(projectsA, a).listThreads().map((thread) => thread.name)).toEqual(['Private A'])
  })

  it('does not discover another profile legacy project transcript when a repository is shared', () => {
    const b = home('b'), repo = home('repository')
    const projects = new ProjectManager(b)
    const project = projects.openProject(repo)
    const legacy = join(repo, '.mousse', '.data', 'legacy-thread')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'meta.json'), JSON.stringify({ id: 'legacy-thread', name: 'Private legacy', createdAt: '2026-01-01', order: 0 }))
    const threads = new ThreadDataStore(projects, b, { allowLegacyProjectData: false })
    expect(threads.listThreads(project.id)).toEqual([])
    expect(threads.getThread('legacy-thread')).toBeUndefined()
    expect(existsSync(join(legacy, 'meta.json'))).toBe(true)
    expect(() => new ThreadStorageLayout(b).standaloneThreadDir('../a')).toThrow('Invalid storage identity')
  })

  it('keeps job runtime, ticker state and usage history isolated after an ambient switch', () => {
    const a = home('a'), b = home('b')
    const configA = MousseConfigStore.load(a), configB = MousseConfigStore.load(b)
    const jobsA = new ScheduledJobStore(configA), jobsB = new ScheduledJobStore(configB)
    const statsA = new LineEditStatsStore(a), statsB = new LineEditStatsStore(b)
    vi.stubEnv('MOUSSE_HOME', b)
    const job = jobsA.createJob({ name: 'Only A', prompt: 'Fixture', schedule: { kind: 'interval', minutes: 1 } })
    recordTickerHeartbeat(true, a)
    statsA.record('manual', 7)
    expect(jobsB.listJobs()).toEqual([])
    expect(jobsA.getJob(job.id)?.name).toBe('Only A')
    expect(readTickerHeartbeat(a).successAt).not.toBeNull()
    expect(readTickerHeartbeat(b)).toEqual({ heartbeatAt: null, successAt: null })
    expect(existsSync(join(a, 'line-edits.json'))).toBe(true)
    expect(existsSync(join(b, 'line-edits.json'))).toBe(false)
    expect(statsB.getSnapshot()).not.toEqual(statsA.getSnapshot())
  })

  it.each(['undoRetention', 'scheduled'])('attempts every personal-service cleanup when %s stop fails', async (failed) => {
    const calls: string[] = []
    const service = Object.assign(Object.create(MmsProfileServices.prototype) as object, {
      stopped: false,
      started: true,
      stopOperation: undefined as Promise<void> | undefined,
      profileId: 'profile-fixture',
      beginShutdown: () => { calls.push('begin') },
      undoRetention: { stop: async () => { calls.push('undoRetention'); if (failed === 'undoRetention') throw new Error('undoRetention failed') } },
      pullRequestWatch: { stop: () => { calls.push('pullRequestWatch') } },
      storageCleanup: { stop: async () => { calls.push('storageCleanup') } },
      storageUsage: { stop: () => { calls.push('storageUsage') } },
      lifecycle: { cleanup: { stop: async () => { calls.push('lifecycle') } } },
      platform: { dispose: async () => { calls.push('platform') } },
      scheduledWebhookServer: { stop: async () => { calls.push('webhooks') } },
      scheduled: { shutdown: () => { calls.push('scheduled'); if (failed === 'scheduled') throw new Error('scheduled failed') } },
      orchestrator: { holdApprovals: () => undefined, shutdown: async () => { calls.push('orchestrator') } },
      net: { shutdown: async () => { calls.push('net') } },
      requests: { waitForIdle: async () => { calls.push('requests') } },
      antigravity: { stop: () => { calls.push('antigravity') } },
      claudeSubscription: { stop: () => { calls.push('claudeSubscription') } },
      codex: { stop: () => { calls.push('codex') } },
      ptyManager: { shutdown: async () => { calls.push('pty') } },
      mcpManager: { shutdown: async () => { calls.push('mcp') } },
      config: { stopWatching: () => { calls.push('config') } },
      getOwnedActivity: () => ({ platform: 0, scheduled: 0, orchestrator: 0, net: 0, requests: 0, ptys: 0, headless: 0, mcp: 0 })
    })
    const stop = MmsProfileServices.prototype.stop as (this: typeof service) => Promise<void>
    await expect(stop.call(service)).rejects.toMatchObject({
      message: 'Failed to drain profile services',
      errors: [expect.objectContaining({ message: `${failed} failed` })]
    })
    expect(calls).toEqual(['begin', 'undoRetention', 'pullRequestWatch', 'storageCleanup', 'storageUsage', 'lifecycle', 'platform', 'webhooks', 'scheduled', 'orchestrator', 'net', 'requests', 'antigravity', 'claudeSubscription', 'codex', 'pty', 'mcp'])
    expect(service.started).toBe(true)
  })

  /** A profile mock for `finishStop`; `failing` makes one cleanup throw. */
  const stoppingProfile = (calls: string[], failing?: string) =>
    Object.assign(Object.create(MmsProfileServices.prototype) as object, {
      stopped: false,
      started: true,
      stopOperation: undefined as Promise<void> | undefined,
      profileId: 'profile-fixture',
      beginShutdown: () => { calls.push('begin') },
      undoRetention: { stop: async () => { calls.push('undoRetention') } },
      pullRequestWatch: { stop: () => undefined },
      storageCleanup: { stop: async () => undefined },
      storageUsage: { stop: () => undefined },
      lifecycle: { cleanup: { stop: async () => { calls.push('lifecycle') } } },
      platform: { dispose: async () => { calls.push('platform') } },
      scheduledWebhookServer: { stop: async () => undefined },
      // The scheduler and requests settle late: the clean epoch end must still come after them.
      scheduled: { shutdown: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); calls.push('scheduled done'); if (failing === 'scheduled') throw new Error('scheduled failed') } },
      orchestrator: { holdApprovals: () => undefined, shutdown: async () => { calls.push('orchestrator') }, setRunEngine: () => { calls.push('detach') }, setBotDispatcher: () => undefined, setBotThreads: () => undefined },
      net: { shutdown: async () => { calls.push('net') } },
      requests: { waitForIdle: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); calls.push('requests idle') } },
      antigravity: { stop: () => { calls.push('antigravity') } },
      claudeSubscription: { stop: () => { calls.push('claudeSubscription') } },
      codex: { stop: () => { calls.push('codex') } },
      ptyManager: { shutdown: async () => { calls.push('pty') } },
      mcpManager: { shutdown: async () => { calls.push('mcp') } },
      config: { stopWatching: () => { calls.push('config') } },
      runEngine: { shutdown: () => { calls.push('epoch ended') }, store: { db: { close: () => { calls.push('db closed') } } } },
      getOwnedActivity: () => ({ platform: 0, scheduled: 0, orchestrator: 0, net: 0, requests: 0, ptys: 0, headless: 0, mcp: 0 })
    })

  it('writes the clean daemon end only after the scheduler shut down and requests went idle (H5)', async () => {
    const calls: string[] = []
    const service = stoppingProfile(calls)
    const stop = MmsProfileServices.prototype.stop as (this: typeof service) => Promise<void>
    await stop.call(service)
    expect(calls.indexOf('epoch ended')).toBeGreaterThan(calls.indexOf('scheduled done'))
    expect(calls.indexOf('epoch ended')).toBeGreaterThan(calls.indexOf('requests idle'))
    expect(calls.indexOf('epoch ended')).toBeGreaterThan(calls.indexOf('orchestrator'))
    expect(calls.slice(-4)).toEqual(['epoch ended', 'config', 'detach', 'db closed'])
  })

  it('leaves the daemon epoch open when a cleanup fails (the next boot reads it as a crash) (H5)', async () => {
    const calls: string[] = []
    const service = stoppingProfile(calls, 'scheduled')
    const stop = MmsProfileServices.prototype.stop as (this: typeof service) => Promise<void>
    await expect(stop.call(service)).rejects.toMatchObject({ message: 'Failed to drain profile services' })
    expect(calls).not.toContain('epoch ended')
  })
})

describe('profile start order (H4)', () => {
  it('recovers the run engine before scheduled jobs or the network can send a turn', async () => {
    const profileHome = home('start-order')
    const engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome })) })
    const calls: string[] = []
    let netRunId = ''
    const service = Object.assign(Object.create(MmsProfileServices.prototype) as object, {
      started: false,
      requests: { assertAccepting: () => undefined },
      config: { getScheduledSection: () => ({ enabled: true }) },
      pullRequestWatch: { start: () => undefined },
      storagePolicy: { initialize: () => undefined },
      storageCleanup: { start: () => undefined },
      storageUsage: { start: () => undefined },
      scheduled: { start: () => { calls.push('scheduled') }, listJobs: () => [], getStatus: () => ({}) },
      net: {
        // A remote send arrives as soon as the network starts: its turn is a run that starts at once.
        start: async () => {
          const sent = await engine.dispatch({ kind: 'send', threadId: 'remote-thread', clientRequestId: 'remote-msg', source: 'remote' })
          if (sent.status !== 'accepted') throw new Error('send rejected')
          netRunId = sent.runId
          engine.markStarting(sent.runId)
          engine.markRunning(sent.runId)
          calls.push('net')
        }
      },
      orchestrator: {
        recoverRunEngineOnBoot: () => { engine.reconcileOnBoot(); calls.push('recover') },
        scheduleStartupQueueRecovery: () => undefined
      },
      startRunEngineWorkers: () => { calls.push('workers') },
      startMcpServer: async () => undefined,
      threadRuntimes: { restoreOnStartup: () => undefined },
      questions: { markInterruptedByDaemonRestart: () => undefined },
      platform: { workflowRuns: { startRecovery: async () => undefined } },
      undoRetention: { start: () => undefined },
      lifecycle: { cleanup: { start: () => undefined } },
      events: { emit: () => undefined },
      projects: { listProjects: () => [] },
      threads: { listAllThreads: () => [] }
    })
    try {
      const startOwned = (MmsProfileServices.prototype as unknown as { startOwned: (this: typeof service) => Promise<void> }).startOwned
      await startOwned.call(service)
      expect(calls).toEqual(['recover', 'workers', 'scheduled', 'net'])
      // Boot recovery ran first, so the remote send's live run was not interrupted as a leftover.
      expect(engine.getRun(netRunId)!.status).toBe('running')
    } finally {
      engine.store.db.close()
    }
  })
})
