import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { ThreadStorageLayout } from '../src/mms/data/ThreadStorageLayout'
import { ChannelStore } from '../src/mms/channels/ChannelStore'
import { ScheduledJobStore, readTickerHeartbeat, recordTickerHeartbeat } from '../src/mms/scheduled/ScheduledJobStore'
import { LineEditStatsStore } from '../src/mms/stats/LineEditStatsStore'

const fixture = mkdtempSync(join(tmpdir(), 'mousse-profile-injection-'))
let sequence = 0
function home(label: string) { const path = join(fixture, label + '-' + sequence++); mkdirSync(path); return path }
afterEach(() => vi.unstubAllEnvs())
afterAll(() => {
  const rel = relative(realpathSync(tmpdir()), realpathSync(fixture))
  if (!rel.startsWith('mousse-profile-injection-') || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Unsafe fixture cleanup')
  rmSync(fixture, { recursive: true, force: true })
})

describe('explicit profile store roots', () => {
  it('captures legacy channel credentials once and leaves new profiles unconfigured', () => {
    const a = home('a'), b = home('b')
    vi.stubEnv('MOUSSE_TELEGRAM_BOT_TOKEN', 'fixture-original')
    const legacy = new ChannelStore(MousseConfigStore.load(a))
    const personal = new ChannelStore(MousseConfigStore.load(b), { inheritEnvironment: false })
    vi.stubEnv('MOUSSE_TELEGRAM_BOT_TOKEN', 'fixture-later')
    expect(legacy.getConfig().platforms.telegram.token).toBe('fixture-original')
    expect(personal.getConfig().platforms.telegram.token).toBeUndefined()
    expect(personal.getConfig().platforms.telegram.enabled).toBe(false)
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
})
