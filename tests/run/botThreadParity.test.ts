/**
 * A bot can use every tool a thread's agent can (bot/thread parity), each through the registry as a bot's turn reaches
 * it: the grant compiled for the turn, the bot's authority, the registry's listing and per-call check, and the tool's own
 * handler. A turn nobody answers (`approvals: never`, every bot turn) asks nobody: the owner's Allow of the permission is
 * the answer. Rows: the thread controls (steer, queues, forks, approvals), Git, other computers, scheduled jobs, secrets,
 * quick actions, the task list, and what a subagent of the work holds.
 */
import { remoteThreadFingerprint } from '../../src/mms/orchestrator/remoteThreadRequest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { botManifestDigest, compileBotThread, type CompileInput } from '../../src/mms/bots/grants/compile'
import { QuickActionTools } from '../../src/mms/orchestrator/QuickActionTools'
import type { AgentScheduleHost, AppToolHost, BotAppToolDeps, RemoteThreadsHost } from '../../src/mms/run/mcp/appTools'
import {
  BOT_SCHEDULE_ACT_TOOLS, BOT_TASK_TOOLS, BOT_THREAD_ACT_TOOLS,
  BOT_THREAD_READ_TOOLS, BOT_THREADS_PERMISSION, botStarterManifest
} from '../../src/shared/bots/personal/manifest'
import { BOT_SCHEDULES_NOT_OWNER_TEXT } from '../../src/shared/bots/personal/walls'
import { botVariantSays, canonicalToolName } from '../../src/shared/toolAliases'
import type { ScheduledJob, Thread } from '../../src/shared/types'
import { appToolRegistry, appTurn, fakeAppToolHost, refusalOf } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const NOW = '2026-11-16T10:00:00.000Z'
const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({ id, name: `Thread ${id}`, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1', ...patch }) as Thread

/** The one permission this PR's tools fall under: scheduled jobs, secrets and quick actions need none. */
const ALL = [BOT_THREADS_PERMISSION]

describe('a bot uses what a thread\'s agent can', () => {
  let fx: DelegationFixture | undefined
  let base: string | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
    if (base) rmSync(base, { recursive: true, force: true })
    base = undefined
  })

  /**
   * A bot whose chat thread is `home` and whose work runs on `work`, holding a live run there that nobody answers. `grant`
   * adds permissions to the starter grant (default: use your threads); `tools` adds built-ins; `botTools` is what the turn
   * is compiled with (default: work, which may act); `role` is the calling thread's.
   */
  const world = async (options: { grant?: string[]; tools?: Array<'shell'>; botTools?: CompileInput['botTools']; role?: 'activation' | 'subagent' | 'context'; host?: Partial<AppToolHost> } = {}) => {
    fx = delegationFixture()
    base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-parity-')))
    const profile = join(base, 'profile')
    const scratch = join(profile, 'bots', 'scratch', 'act-1')
    const files = join(profile, 'bots', 'files', 'alpha')
    mkdirSync(scratch, { recursive: true })
    mkdirSync(files, { recursive: true })
    const starter = botStarterManifest()
    const grant = { ...starter, tools: [...starter.tools, ...(options.tools ?? [])], appTools: [...starter.appTools, ...(options.grant ?? ALL)] }
    const compiled = compileBotThread({
      grant, digest: botManifestDigest(grant), thread: {}, scratch, profileHome: profile, filesFolder: files,
      nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 600_000 },
      botTools: options.botTools ?? { escalate: true, consult: false, memory: true, threads: 'all', profiler: true, owner: true, tasks: true }
    })
    if (!compiled.ok) throw new Error(compiled.error.message)
    const role = options.role ?? 'activation'
    const authority = createBotAuthority({
      activationId: 'act-1', role, permissions: compiled.permissions, waiting: () => false,
      counters: { charge: () => ({ ok: true, count: 1 }) }, time: { deadline: () => 0, signal: new AbortController().signal }, spend: null
    })
    const threads = new Map<string, Thread>([
      ['home', thread('home', { botOwned: true, projectId: undefined } as Partial<Thread>)],
      ['work', thread('work', { botOwned: true, projectId: undefined } as Partial<Thread>)],
      ['mine', thread('mine', { name: 'Fix the login page' })],
      ['private', thread('private', { localOnly: true })],
      ['subagent', thread('subagent', { lineage: { parentThreadId: 'mine', rootThreadId: 'mine', relationship: 'subagent' } } as Partial<Thread>)]
    ])
    const asked: string[] = []
    const onAppResult = vi.fn()
    const deps = { host: { activationOf: () => ({ botId: 'b1', activationId: 'act-1', lane: 'run' }) }, activity: { onAppResult, onAllowed: vi.fn(), drain: () => [] } } as unknown as BotAppToolDeps
    const fake = fakeAppToolHost({
      threadMeta: (id) => threads.get(id),
      listThreads: () => [...threads.values()],
      listProjects: () => [{ id: 'p1', name: 'Web app' }],
      botRole: (id) => (id === 'work' ? role : id === 'home' ? 'activation' : undefined),
      botHomeOf: (id) => (id === 'work' || id === 'home' ? 'home' : undefined),
      // A bot's binding is Ask; were it consulted, every change would ask, and nobody answers.
      permissionModeFor: () => 'ask',
      askApproval: async (_threadId, questions) => {
        asked.push(questions[0]!.prompt)
        return { permission: 'reject' }
      },
      steerRun: vi.fn(async (_threadId, runId) => ({ status: 'accepted' as const, runId, sequence: 2, replayed: false })),
      approvalRequest: vi.fn((requestId: string) => ({ requestId, threadId: 'mine', questions: [{ id: 'permission', options: [{ id: 'allow', scope: 'once' }, { id: 'reject' }] }], approval: { action: 'edit', options: [{ id: 'allow', decision: 'allow', scope: 'once' }, { id: 'reject', decision: 'reject' }] } }) as never),
      answerApproval: vi.fn(() => ({ ok: true as const, decision: 'allow' as const, replayed: false })),
      showAgentAction: vi.fn(),
      ...options.host
    })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host, { bots: () => deps })
    const workRun = await fx.runningRun('work')
    turns.register(appTurn({ threadId: 'work', runId: workRun.runId, bot: authority, approvals: 'never', ...(role === 'subagent' ? { subagent: true } : {}) }))
    const call = async (name: string, args: Record<string, unknown> = {}, toolCallId?: string) => {
      try {
        const outcome = await registry.call(name, args, request({ threadId: 'work', runId: workRun.runId, ...(toolCallId ? { toolCallId } : {}) }))
        // A refusal reads as its words; its shape is checked in toolRefusalShape.test.ts.
        return { error: outcome.isError === true, text: refusalOf(outcome)?.message ?? outcome.text }
      } catch (error) {
        return { error: true, text: error instanceof Error ? error.message : String(error) }
      }
    }
    const listed = () => registry.listForThread('work', workRun.runId)
    return { compiled, call, listed, asked, host: fake.host, queueCommands: fake.queueCommands, onAppResult, files, base: base!, registry }
  }

  /**
   * The bot's own work tools a main turn lists under a thread tool's name (S7d4a), whether or not its turn holds them:
   * a call is held to the bot's grant. The listing then says only what each does ("With <its arguments>: …").
   */
  const WORK_UNDER_THREAD_NAMES = ['work_start', 'work_list', 'work_note', 'work_stop']
  // What each kind of turn holds of the tools this PR adds. `asWork`: the lacked thread tools it may list only as those.
  const lanes: Array<[string, Parameters<typeof world>[0], { has: readonly string[]; lacks: readonly string[]; asWork?: readonly string[] }]> = [
    ['work holds every thread control, scheduled jobs, secrets with "run commands", quick actions and its task list', { tools: ['shell'] },
      { has: [...BOT_THREAD_READ_TOOLS, ...BOT_THREAD_ACT_TOOLS, 'schedule_list', ...BOT_SCHEDULE_ACT_TOOLS, 'secret_request', 'secret_run', 'create_quick_action', ...BOT_TASK_TOOLS], lacks: [] }],
    ['without "run commands", secrets are asked for and never run', {}, { has: ['secret_request'], lacks: ['secret_run'] }],
    ['a turn that may only read lists its jobs and reads threads, and changes nothing', { botTools: { escalate: true, consult: false, threads: 'read', owner: true, tasks: true } },
      { has: [...BOT_THREAD_READ_TOOLS, 'schedule_list'], lacks: [...BOT_THREAD_ACT_TOOLS, ...BOT_SCHEDULE_ACT_TOOLS], asWork: ['thread_create', 'thread_send', 'thread_stop'] }],
    ['a bot without "use your threads" keeps its jobs, secrets, quick actions and task list', { grant: [] }, { has: [...BOT_TASK_TOOLS, 'schedule_list', ...BOT_SCHEDULE_ACT_TOOLS, 'secret_request', 'create_quick_action'], lacks: BOT_THREAD_READ_TOOLS, asWork: ['thread_list'] }],
    ['a consult has none', { role: 'context', botTools: { escalate: false, consult: false } }, { has: [], lacks: [...BOT_THREAD_READ_TOOLS, 'schedule_list', 'secret_request', 'create_quick_action', ...BOT_TASK_TOOLS] }],
    ['a subagent of the work: what a thread\'s subagent may use', { tools: ['shell'], role: 'subagent', botTools: { escalate: false, consult: false, subagent: true, threads: 'all', profiler: true, tasks: true } },
      { has: [...BOT_THREAD_READ_TOOLS, ...BOT_THREAD_ACT_TOOLS, ...BOT_TASK_TOOLS], lacks: ['schedule_list', ...BOT_SCHEDULE_ACT_TOOLS, 'secret_request', 'secret_run', 'create_quick_action', 'theme_set'] }]
  ]
  it.each(lanes)('%s', async (_name, options, { has, lacks, asWork = [] }) => {
    const { compiled, listed } = await world(options)
    for (const tool of has) expect(compiled.permissions.appTools, tool).toContain(tool)
    for (const tool of lacks) expect(compiled.permissions.appTools, tool).not.toContain(tool)
    // The thread lists what its turn holds of the tools this registry has, and nothing it lacks: a lacked thread tool is
    // listed only as the bot's own work tools it carries (`asWork`), and then says only what those do.
    const shown = new Map(listed().map((tool) => [tool.name, tool]))
    for (const tool of lacks) {
      const entry = shown.get(tool)
      if (!asWork.includes(tool)) {
        expect(entry, tool).toBeUndefined()
        continue
      }
      if (!entry) continue
      const says = WORK_UNDER_THREAD_NAMES.filter((old) => canonicalToolName(old) === tool).map((old) => `With ${botVariantSays(old)!.says}: `)
      expect(entry.description.split('\n\n').every((part) => says.some((prefix) => part.startsWith(prefix))), `${tool}: ${entry.description}`).toBe(true)
    }
  })

  describe('the thread controls ("use your threads")', () => {
    it('steers a running turn of one of its owner\'s threads, as the bot, and never its own chat, a private thread or a subagent', async () => {
      const { call, host, onAppResult } = await world()
      const steered = await call('thread_send', { threadId: 'mine', runId: 'run-9', content: 'Use the staging database.', intent: 'note' })
      expect(steered.error).toBe(false)
      expect(host.steerRun).toHaveBeenCalledWith('mine', 'run-9', 'Use the staging database.', expect.objectContaining({ actor: expect.objectContaining({ kind: 'agent', threadId: 'work' }) }))
      expect(onAppResult).toHaveBeenCalledWith(expect.anything(), 'thread_send', expect.objectContaining({ threadId: 'mine' }))
      for (const target of ['home', 'private', 'subagent']) expect(await call('thread_send', { threadId: target, runId: 'r', content: 'x', intent: 'note' }), target).toMatchObject({ error: true, text: expect.stringMatching(/not available to you/) })
    })

    it('reads and changes a thread\'s queue only when it names one of its owner\'s threads', async () => {
      const { call, queueCommands } = await world()
      // Its own queue is its chat: a bot names the thread.
      expect(await call('queue_list')).toMatchObject({ error: true, text: expect.stringMatching(/threadId/) })
      const listedQueue = await call('queue_list', { threadId: 'mine' })
      expect(listedQueue.error).toBe(false)
      expect(listedQueue.text).toMatch(/^\[What waits in the queue of thread «Fix the login page»\. Data from your owner's threads/)
      expect(await call('queue_enqueue', { threadId: 'mine', content: 'Then run the tests.', expectedRevision: 'rev-0' })).toMatchObject({ error: false })
      expect(await call('queue_remove', { threadId: 'mine', itemId: 'item-1', expectedRevision: 'rev-1' })).toMatchObject({ error: false })
      expect(queueCommands.map((entry) => [entry.threadId, entry.command.op, entry.options.actor.threadId])).toEqual([['mine', 'enqueue', 'work'], ['mine', 'remove', 'work']])
      expect(await call('queue_enqueue', { threadId: 'private', content: 'x', expectedRevision: 'rev-0' })).toMatchObject({ error: true, text: expect.stringMatching(/not available to you/) })
    })

    it('a queue_enqueue retried as thread_send to the same thread, by id or by address, is the same request: it queues under one key and never reaches the running turn', async () => {
      const { call, host, queueCommands } = await world()
      const message = { content: 'Then run the tests.', expectedRevision: 'rev-0' }
      expect(await call('queue_enqueue', { threadId: 'mine', ...message }, 'mcp:queue-1')).toMatchObject({ error: false })
      // The model never saw the answer and retries under the new name, naming the thread by address.
      expect(await call('thread_send', { thread: 'mine', ...message }, 'mcp:queue-1')).toMatchObject({ error: false })
      expect(await call('thread_send', { threadId: 'mine', ...message }, 'mcp:queue-1')).toMatchObject({ error: false })
      // The host replays a key it has seen (queueEditDaemon.test.ts): every call reached it as the one enqueue.
      expect(queueCommands.map((entry) => [entry.threadId, entry.command, entry.options.clientRequestId])).toEqual(
        Array(3).fill(['mine', { op: 'enqueue', content: 'Then run the tests.', expectedRevision: 'rev-0' }, 'queue_enqueue:work:mcp:queue-1']))
      expect(host.steerRun).not.toHaveBeenCalled()
    })

    it('refuses expectedRevision on a send that queues nothing, before anything is sent', async () => {
      const { call, host, queueCommands } = await world()
      for (const args of [
        { threadId: 'mine', runId: 'run-9', intent: 'note', expectedRevision: 'stale', content: 'Use the staging database.' },
        { thread: 'mine', runId: 'run-9', intent: 'note', expectedRevision: 'stale', content: 'Use the staging database.' }
      ])
        expect(await call('thread_send', args), JSON.stringify(args)).toMatchObject({ error: true, text: expect.stringMatching(/^expectedRevision applies only when you queue work/) })
      expect(host.steerRun).not.toHaveBeenCalled()
      expect(queueCommands).toEqual([])
    })

    it('answers an approval in one of its owner\'s threads through the agents\' rule', async () => {
      const { call, host } = await world()
      expect(await call('approval_respond', { threadId: 'mine', requestId: 'req-1', answers: { permission: 'allow' } })).toMatchObject({ error: false })
      expect(host.answerApproval).toHaveBeenCalledWith('mine', 'req-1', { permission: 'allow' }, expect.objectContaining({ actor: expect.objectContaining({ threadId: 'work' }) }))
      expect(await call('approval_respond', { threadId: 'private', requestId: 'req-1', answers: { permission: 'allow' } })).toMatchObject({ error: true, text: expect.stringMatching(/not available to you/) })
    })

    it('forks and hands back only threads it may reach, asking nobody', async () => {
      const { call, asked } = await world()
      // Past the bot's gates, the engine decides: `mine` has no finished run to fork after, and is no fork to hand back.
      expect(await call('thread_fork', { sourceThreadId: 'mine' })).toMatchObject({ error: true, text: expect.not.stringMatching(/not available to you|lineage/) })
      expect(await call('thread_return', { forkThreadId: 'mine' })).toMatchObject({ error: true, text: expect.stringMatching(/not a fork/) })
      expect(asked).toEqual([])
      // Its own chat is never the source, and a thread out of its reach is refused before anything runs.
      expect(await call('thread_fork', {})).toMatchObject({ error: true, text: expect.stringMatching(/sourceThreadId/) })
      for (const target of ['private', 'subagent']) {
        expect(await call('thread_fork', { sourceThreadId: target }), target).toMatchObject({ error: true, text: expect.stringMatching(/not available to you/) })
        expect(await call('thread_return', { forkThreadId: target }), target).toMatchObject({ error: true, text: expect.stringMatching(/not available to you/) })
      }
    })

    it('reads the Git status of a project it names', async () => {
      const repo = join(realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-git-'))), 'repo')
      mkdirSync(repo)
      execFileSync('git', ['init', '-q'], { cwd: repo })
      writeFileSync(join(repo, 'new.txt'), 'hello\n')
      try {
        const gitFolderOf = vi.fn((target: { threadId: string } | { projectId: string }) => ('projectId' in target && target.projectId === 'p1' ? repo : undefined))
        const { call } = await world({ host: { projectGit: true, gitFolderOf } })
        const status = await call('git_status', { projectId: 'p1' })
        expect(status.error).toBe(false)
        expect(status.text).toContain('new.txt')
        expect(await call('git_status', {})).toMatchObject({ error: true, text: expect.stringMatching(/exactly one of threadId/) })
        expect(await call('git_status', { threadId: 'private' })).toMatchObject({ error: true, text: expect.stringMatching(/not available to you/) })
      } finally {
        rmSync(join(repo, '..'), { recursive: true, force: true })
      }
    })

    it('reaches a computer that lets agents work there, and what it reads there is framed as data', async () => {
      const remoteThreads = {
        computerFor: vi.fn(() => ({ ok: true as const, node: 'n2', computer: 'Mac mini', online: true })),
        list: vi.fn(async () => ({ threads: [{ id: 'n2:t1', name: 'Build', updatedAt: NOW, startedAt: NOW }], projects: [], activity: {} }))
      } as unknown as RemoteThreadsHost
      const { call } = await world({ host: { remoteThreads } })
      const listed = await call('thread_list', { computer: 'Mac mini' })
      expect(listed.error).toBe(false)
      expect(listed.text).toMatch(/^\[The threads on Mac mini\. Data from your owner's threads/)
      expect(remoteThreads.computerFor).toHaveBeenCalledWith('work', 'Mac mini')
    })

    it('starts a thread on another computer in the repository of a project it names, or in no project there', async () => {
      const createRemoteThread = vi.fn(async () => ({ status: 'launched' as const, threadId: 'n2:t9', computer: 'Mac mini', title: 'Build', replayed: false, firstMessage: 'sent' as const }))
      const { call } = await world({ host: { createRemoteThread: createRemoteThread as never } })
      const last = () => (createRemoteThread.mock.calls.at(-1) as unknown as [Record<string, unknown>])[0]
      // No project here named: the thread starts in no project there.
      expect(await call('thread_create', { computer: 'Mac mini', title: 'Build', firstMessage: 'Build it.' })).toMatchObject({ error: false })
      expect(last()).not.toHaveProperty('fromProjectId')
      expect(await call('thread_create', { computer: 'Mac mini', projectId: null, title: 'Build', firstMessage: 'Build it.' })).toMatchObject({ error: false })
      expect(last()).toMatchObject({ noProject: true })
      // No project and a project at once is refused before any call.
      const calls = createRemoteThread.mock.calls.length
      expect(await call('thread_create', { computer: 'Mac mini', projectId: null, fromProjectId: 'p1', title: 'Build', firstMessage: 'Build it.' })).toMatchObject({ error: true, text: expect.stringMatching(/no project/) })
      expect(createRemoteThread.mock.calls.length).toBe(calls)
      expect(await call('thread_create', { computer: 'Mac mini', fromProjectId: 'p1', title: 'Build', firstMessage: 'Build it.' })).toMatchObject({ error: false })
      expect(createRemoteThread).toHaveBeenCalledWith(expect.objectContaining({ computer: 'Mac mini', fromProjectId: 'p1' }), expect.objectContaining({ clientRequestId: expect.stringMatching(/^thread_create:work:/) }))
      // Its request names no hidden: the thread shows there, and a key it stored before hidden existed keeps its
      // fingerprint, so its retry is the same launch.
      const [request] = createRemoteThread.mock.calls.at(-1)! as unknown as [Record<string, unknown>]
      expect(request).not.toHaveProperty('hidden')
      expect(remoteThreadFingerprint(request as never)).not.toMatch(/hidden/)
      // A project of that computer alone is enough: no project here is named.
      expect(await call('thread_create', { computer: 'Mac mini', projectId: 'n2:p7', title: 'Build', firstMessage: 'Build it.', clientRequestId: 'direct' })).toMatchObject({ error: false })
      const [direct] = createRemoteThread.mock.calls.at(-1)! as unknown as [Record<string, unknown>]
      expect(direct).toMatchObject({ computer: 'Mac mini', projectId: 'n2:p7' })
      expect(direct).not.toHaveProperty('fromProjectId')
    })
  })

  describe('scheduled jobs', () => {
    const scheduleHost = () => {
      const jobs: ScheduledJob[] = []
      const schedules = {
        threadAllowed: vi.fn(() => false),
        askFirst: vi.fn(() => ({ id: 'ask-1' })),
        jobLimits: () => ({ maxActive: 10, minIntervalMinutes: 15, lifetimeDays: 7 }),
        list: () => jobs,
        get: (id: string) => jobs.find((job) => job.id === id),
        validate: () => ({}),
        create: vi.fn((input: Partial<ScheduledJob>) => {
          const job = { id: `job-${jobs.length + 1}`, enabled: true, state: 'idle', nextRunAt: NOW, ...input } as ScheduledJob
          jobs.push(job)
          return job
        }),
        update: vi.fn(),
        pause: vi.fn(),
        trigger: vi.fn(),
        wake: vi.fn(),
        limits: () => ({ permissionCeiling: 'full' as const })
      } as unknown as AgentScheduleHost
      return { schedules, jobs }
    }

    it('makes a job in a project for its owner without the thread\'s first ask, filed as the bot\'s', async () => {
      const { schedules, jobs } = scheduleHost()
      const { call } = await world({ host: { schedules } })
      const job = { name: 'Nightly tests', prompt: 'Run the test suite and report failures.', schedule: { kind: 'cron', expr: '0 2 * * *' } }
      expect(await call('schedule_create', job)).toMatchObject({ error: true, text: expect.stringMatching(/threadId .* or projectId/) })
      expect(await call('schedule_create', { ...job, projectId: 'p1' })).toMatchObject({ error: false })
      expect(schedules.askFirst).not.toHaveBeenCalled()
      // Its jobs are the bot's, whichever turn made them: its chat's thread.
      expect(jobs[0]).toMatchObject({ projectId: 'p1', createdBy: { threadId: 'home' } })
      expect(JSON.parse((await call('schedule_list')).text).jobs.map((entry: { id: string }) => entry.id)).toEqual(['job-1'])
      // Bound to a thread out of its reach, refused.
      expect(await call('schedule_create', { ...job, threadId: 'private' })).toMatchObject({ error: true, text: expect.stringMatching(/not available to you/) })
    })

    it('a turn that may only read is told why, and nothing is asked or made', async () => {
      const { schedules } = scheduleHost()
      const { call } = await world({ host: { schedules }, botTools: { escalate: true, consult: false, threads: 'read', owner: true } })
      expect(await call('schedule_create', { name: 'x', prompt: 'y', schedule: { kind: 'cron', expr: '0 2 * * *' }, projectId: 'p1' })).toEqual({ error: true, text: BOT_SCHEDULES_NOT_OWNER_TEXT })
      expect(schedules.create).not.toHaveBeenCalled()
    })
  })

  describe('secrets', () => {
    it('asks with the card in its chat, though nobody answers the turn, and runs a command from its files folder without asking', async () => {
      const request = vi.fn(async () => ({ kind: 'stored' as const, name: 'API_TOKEN', keep: 'thread' as const }))
      const run = vi.fn(async () => ({ exitCode: 0, output: 'ok', timedOut: false, stopped: false }))
      const secrets = { request, run, usableIn: vi.fn(() => true), masker: () => undefined, endThread: vi.fn() }
      const { call, asked, files } = await world({ tools: ['shell'], host: { secrets: () => secrets as never } })
      expect(await call('secret_request', { label: 'API token', reason: 'To call the API you asked about.' })).toMatchObject({ error: false })
      // Filed under its chat thread, where its owner sees the card.
      expect(request).toHaveBeenCalledWith('home', expect.objectContaining({ label: 'API token' }), expect.anything())
      expect(await call('secret_run', { command: 'curl -H "Authorization: $API_TOKEN" https://example.com', secrets: [{ name: 'API_TOKEN' }] })).toMatchObject({ error: false })
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'home', cwd: files }))
      expect(asked).toEqual([])
    })
  })

  describe('quick actions and its task list', () => {
    it('adds a quick action without asking', async () => {
      const approve = vi.fn(async () => false)
      const created = vi.fn()
      const { call } = await world({ host: { quickActions: new QuickActionTools(approve, created) } })
      expect(await call('create_quick_action', { label: 'Run tests', kind: 'send-current', payload: 'Run the tests.' })).toMatchObject({ error: false, text: expect.stringMatching(/Quick action created/) })
      expect(approve).not.toHaveBeenCalled()
      expect(created).toHaveBeenCalledWith(expect.objectContaining({ label: 'Run tests' }))
    })

    it('keeps a task list with no permission', async () => {
      const { call } = await world({ grant: [] })
      expect(await call('task_create', { description: 'Read the logs' })).toMatchObject({ error: false })
      expect((await call('task_list')).text).toContain('Read the logs')
    })
  })

  describe('a subagent of its work', () => {
    it('acts on its owner\'s threads as its work would, and is refused what a thread\'s subagent is', async () => {
      const { call, host } = await world({ role: 'subagent', tools: ['shell'], botTools: { escalate: false, consult: false, subagent: true, threads: 'all', profiler: true, tasks: true } })
      expect(await call('thread_send', { threadId: 'mine', runId: 'run-9', content: 'Stop after the build.', intent: 'note' })).toMatchObject({ error: false })
      expect(host.steerRun).toHaveBeenCalled()
      expect(await call('task_create', { description: 'Part one' })).toMatchObject({ error: false })
      for (const tool of ['schedule_list', 'secret_request', 'create_quick_action']) expect(await call(tool, {}), tool).toMatchObject({ error: true })
    })
  })
})
