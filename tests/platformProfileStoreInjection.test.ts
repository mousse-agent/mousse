import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { settleThreadMutationOwnership } from '../src/mms/queue/ThreadExecutionLease'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { ThreadStorageLayout } from '../src/mms/data/ThreadStorageLayout'
import { ThreadTrashService } from '../src/mms/data/ThreadTrashService'
import { ChannelStore } from '../src/mms/channels/ChannelStore'
import { ChannelAuth } from '../src/mms/channels/ChannelAuth'
import { ScheduledJobStore, readTickerHeartbeat, recordTickerHeartbeat } from '../src/mms/scheduled/ScheduledJobStore'
import { LineEditStatsStore } from '../src/mms/stats/LineEditStatsStore'
import { MmsProfileServices } from '../src/mms/MmsProfileServices'

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

  it('keeps trash and pairing authorization inside the profile even after switching ambient home', async () => {
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
    const authA = new ChannelAuth(join(a, 'channels', 'pairing')), authB = new ChannelAuth(join(b, 'channels', 'pairing'))
    const message = { platform: 'telegram' as const, userId: 'fixture-user', chatId: 'fixture-chat', text: 'hello', messageId: 'fixture-id', isDm: true }
    const request = authA.createPairingRequest(message)
    expect(request).not.toBeNull()
    expect(authB.approvePairing(request!.code)).toBe(false)
    expect(authA.approvePairing(request!.code)).toBe(true)
    const config = MousseConfigStore.load(a).getChannelsSection()
    expect(authA.isAuthorized(config, message)).toBe(true)
    expect(authB.isAuthorized(config, message)).toBe(false)

    const inheritedId = { ...message, userId: 'toString', messageId: 'prototype-id' }
    expect(authA.isAuthorized(config, inheritedId)).toBe(false)
    const protoId = { ...message, userId: '__proto__', messageId: 'proto-id' }
    const protoRequest = authA.createPairingRequest(protoId)
    expect(protoRequest).not.toBeNull()
    expect(authA.approvePairing(protoRequest!.code)).toBe(true)
    expect(authA.isAuthorized(config, protoId)).toBe(true)
  })

  it('captures legacy channel credentials once and leaves new profiles unconfigured', () => {
    const a = home('a'), b = home('b')
    vi.stubEnv('MOUSSE_TELEGRAM_BOT_TOKEN', 'fixture-original')
    const legacy = new ChannelStore(MousseConfigStore.load(a))
    const personal = new ChannelStore(MousseConfigStore.load(b), { inheritEnvironment: false })
    vi.stubEnv('MOUSSE_TELEGRAM_BOT_TOKEN', 'fixture-later')
    expect(legacy.getConfig().platforms.telegram.token).toBe('fixture-original')
    expect(personal.getConfig().platforms.telegram.token).toBeUndefined()
    expect(personal.getConfig().platforms.telegram.enabled).toBe(false)
    legacy.updateConfig({ filterSilenceNarration: false })
    const persisted = JSON.parse(readFileSync(join(a, 'mousse.conf'), 'utf8'))
    expect(persisted.channels.platforms.telegram.token).toBeUndefined()
    expect(legacy.getConfig().platforms.telegram.token).toBe('fixture-original')
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

  it('keeps channels, job runtime, ticker state and usage history isolated after an ambient switch', () => {
    const a = home('a'), b = home('b')
    const configA = MousseConfigStore.load(a), configB = MousseConfigStore.load(b)
    const channelsA = new ChannelStore(configA), channelsB = new ChannelStore(configB)
    const jobsA = new ScheduledJobStore(configA), jobsB = new ScheduledJobStore(configB)
    const statsA = new LineEditStatsStore(a), statsB = new LineEditStatsStore(b)
    vi.stubEnv('MOUSSE_HOME', b)
    channelsA.saveDirectory({ telegram: [{ id: 'only-a', name: 'Only A', type: 'private' }], discord: [], webhook: [] })
    const job = jobsA.createJob({ name: 'Only A', prompt: 'Fixture', schedule: { kind: 'interval', minutes: 1 } })
    recordTickerHeartbeat(true, a)
    statsA.record('manual', 7)
    expect(channelsB.getDirectory().telegram).toEqual([])
    expect(channelsA.getDirectory().telegram[0].id).toBe('only-a')
    expect(jobsB.listJobs()).toEqual([])
    expect(jobsA.getJob(job.id)?.name).toBe('Only A')
    expect(readTickerHeartbeat(a).successAt).not.toBeNull()
    expect(readTickerHeartbeat(b)).toEqual({ heartbeatAt: null, successAt: null })
    expect(existsSync(join(a, 'line-edits.json'))).toBe(true)
    expect(existsSync(join(b, 'line-edits.json'))).toBe(false)
    expect(statsB.getSnapshot()).not.toEqual(statsA.getSnapshot())
  })

  it('refuses direct trash and purge entry points, preserving linked external data', () => {
    const a = home('trash-a'), outside = home('trash-outside')
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    const threadRoot = join(a, 'thread-data')
    mkdirSync(threadRoot, { recursive: true })
    const escapedOriginal = join(threadRoot, 'escaped')
    symlinkSync(outside, escapedOriginal, process.platform === 'win32' ? 'junction' : 'dir')
    const trash = new ThreadTrashService(a, { strictOwnedRoot: true })
    expect(() => trash.trash('escaped', escapedOriginal)).toThrow('lifecycle coordinator')
    expect(() => trash.purge('escaped')).toThrow('unavailable')
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
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
      lifecycle: { cleanup: { stop: async () => { calls.push('lifecycle') } } },
      platform: { dispose: async () => { calls.push('platform') } },
      scheduled: { shutdown: () => { calls.push('scheduled'); if (failed === 'scheduled') throw new Error('scheduled failed') } },
      channels: { shutdown: async () => { calls.push('channels') } },
      orchestrator: { shutdown: async () => { calls.push('orchestrator') } },
      net: { shutdown: async () => { calls.push('net') } },
      requests: { waitForIdle: async () => { calls.push('requests') } },
      antigravity: { stop: () => { calls.push('antigravity') } },
      ptyManager: { shutdown: async () => { calls.push('pty') } },
      headlessRunner: { shutdown: async () => { calls.push('headless') } },
      mcpManager: { shutdown: async () => { calls.push('mcp') } },
      config: { stopWatching: () => { calls.push('config') } },
      getOwnedActivity: () => ({ platform: 0, scheduled: 0, channels: 0, orchestrator: 0, net: 0, requests: 0, ptys: 0, headless: 0, mcp: 0 })
    })
    const stop = MmsProfileServices.prototype.stop as (this: typeof service) => Promise<void>
    await expect(stop.call(service)).rejects.toMatchObject({
      message: 'Failed to drain profile services',
      errors: [expect.objectContaining({ message: `${failed} failed` })]
    })
    expect(calls).toEqual(['begin', 'undoRetention', 'lifecycle', 'platform', 'scheduled', 'channels', 'orchestrator', 'net', 'requests', 'antigravity', 'pty', 'headless', 'mcp'])
    expect(service.started).toBe(true)
  })
})
