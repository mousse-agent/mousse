/**
 * Issue #2004 T5: a fork an agent or a bot makes with `thread_fork` records who made it, as a `thread_create` thread does,
 * so it is listed where those are. A real `OrchestratorService` and Run Engine, with the tool called through the Mousse MCP
 * registry as a provider calls it; the lists are the functions the app and the bot use to build them. A person's fork,
 * made without the tool, names no starter.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import { BOT_THREAD_ACT_TOOLS, BOT_THREAD_READ_TOOLS } from '../../src/shared/bots/personal/manifest'
import { launchedThreadsOf as botLaunchedThreads } from '../../src/mms/bots/launchedThreads'
import { launchedThreadsOf as startedThreads } from '../../src/renderer/components/sideCard/lineageLogic'
import { threadInFilter, type ThreadFilter } from '../../src/renderer/lib/threadFilter'
import { appTurn } from './appToolsFixture'
import { phase6Daemon, piAdapter, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

describe('a fork records who made it (#2004 T5)', () => {
  let previousHome: string | undefined
  const homes: string[] = []
  const daemons: Phase6Daemon[] = []
  afterEach(async () => {
    for (const daemon of daemons.splice(0).reverse()) await daemon.stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  /** A daemon with a project, a source thread with a finished run, and a bot "alpha" whose chat is `chat`. */
  const world = () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-fork-starter-'))
    previousHome ??= process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    homes.push(home)
    const d = phase6Daemon(home, [piAdapter(() => 'unused')])
    daemons.push(d)
    mkdirSync(join(home, 'project'))
    const project = d.projects.openProject(join(home, 'project'))
    const chat = d.store.createThread('alpha', project.id)
    d.orch.setBotThreads({
      roleOf: (threadId) => (threadId === chat.id ? 'activation' : undefined),
      botOf: (threadId) => (threadId === chat.id ? { botId: 'b1', name: 'alpha' } : undefined),
      ownerTurn: () => ({})
    })
    /** A run of `threadId` left `completed` or `running`, without a provider turn. */
    const run = async (threadId: string, status: 'completed' | 'running') => {
      const sent = await d.engine.dispatch({ kind: 'send', threadId, clientRequestId: `seed:${Math.random()}`, source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      d.engine.markStarting(sent.runId)
      d.engine.markRunning(sent.runId)
      if (status === 'completed') d.engine.markTerminal(sent.runId, 'completed')
      return sent.runId
    }
    /** `thread_fork` from a running turn of `threadId` (a bot's turn when `bot`), as a provider calls it. */
    const fork = async (threadId: string, args: Record<string, unknown>, options: { bot?: boolean } = {}) => {
      const runId = await run(threadId, 'running')
      // A bot's chat turn its owner's message started, holding "use your threads"; its grant is checked elsewhere.
      const bot = options.bot ? { bot: { activationId: 'act-1', role: 'activation', appTools: new Set([...BOT_THREAD_READ_TOOLS, ...BOT_THREAD_ACT_TOOLS]), check: () => ({ ok: true }) } as unknown as BotAuthority } : {}
      d.orch.appToolTurns.register(appTurn({ threadId, runId, ...bot }))
      const answer = await d.orch.mcpToolRegistry().call('thread_fork', args, {
        credential: { threadId, runId, provider: 'pi', modeCeiling: 'default', accessLevel: 'lineage', binding: 'drained_turn', current: () => true },
        toolCallId: `call-${runId}`,
        signal: new AbortController().signal
      })
      d.engine.markTerminal(runId, 'completed')
      if (answer.isError) throw new Error(answer.text)
      const threadIdOf = (JSON.parse(answer.text) as { threadId: string }).threadId
      return d.store.getThread(threadIdOf)!
    }
    const threads = () => d.store.listAllThreads()
    return { d, project, chat, run, fork, threads }
  }

  const filter = (patch: Partial<ThreadFilter>): ThreadFilter => ({ query: '', show: 'mine', projectId: null, botId: null, computerIds: [], archived: false, ...patch })
  const context = { groupOf: (projectId: string) => projectId, projectName: () => undefined, botName: () => undefined }
  const botList = (threads: ReturnType<ReturnType<typeof world>['threads']>, creator: string) =>
    botLaunchedThreads({ creators: new Set([creator]), threads, activeRuns: [], lastRun: () => undefined, asks: () => false, standing: () => 'never' }).map((row) => row.threadId)

  it('an agent\'s fork is in its thread\'s Started threads, not nested, and still shown in the sidebar', async () => {
    const w = world()
    const source = w.d.store.createThread('Source', w.project.id)
    await w.run(source.id, 'completed')
    const forked = await w.fork(source.id, {})
    expect(forked).toMatchObject({ createdByThreadId: source.id })
    expect(forked.startedByBot).toBeUndefined()
    expect(forked.lineage).toBeUndefined()
    expect(startedThreads(w.threads(), source.id).map((thread) => thread.id)).toContain(forked.id)
    // Shown as a person's fork is, unless the call asks otherwise.
    expect(threadInFilter(forked, filter({ show: 'mine' }), context)).toBe(true)
    const hidden = await w.fork(source.id, { hidden: true })
    expect(hidden.hidden).toBe(true)
    expect(threadInFilter(hidden, filter({ show: 'mine' }), context)).toBe(false)
    expect(startedThreads(w.threads(), source.id).map((thread) => thread.id)).toContain(hidden.id)
  })

  it('a bot\'s fork is in the bot\'s list and the Bot threads filter', async () => {
    const w = world()
    const source = w.d.store.createThread('Owner\'s work', w.project.id)
    await w.run(source.id, 'completed')
    const forked = await w.fork(w.chat.id, { sourceThreadId: source.id }, { bot: true })
    expect(forked).toMatchObject({ createdByThreadId: w.chat.id, startedByBot: { botId: 'b1', name: 'alpha' } })
    expect(forked.hidden).toBeUndefined()
    expect(botList(w.threads(), w.chat.id)).toContain(forked.id)
    expect(threadInFilter(forked, filter({ show: 'bots' }), context)).toBe(true)
    expect(threadInFilter(forked, filter({ botId: 'b1' }), context)).toBe(true)
    // A bot's thread is in its chat, not in an agent's Started threads.
    expect(startedThreads(w.threads(), w.chat.id).map((thread) => thread.id)).not.toContain(forked.id)
    const hidden = await w.fork(w.chat.id, { sourceThreadId: source.id, hidden: true }, { bot: true })
    expect(hidden).toMatchObject({ hidden: true, startedByBot: { botId: 'b1' } })
    expect(botList(w.threads(), w.chat.id)).toContain(hidden.id)
  })

  it('a person\'s fork names no starter: it is in nobody\'s Started threads or bot list', async () => {
    const w = world()
    const source = w.d.store.createThread('Source', w.project.id)
    await w.run(source.id, 'completed')
    const { threadId } = await w.d.engine.forkThread({ sourceThreadId: source.id, clientRequestId: 'person-fork' })
    const forked = w.d.store.getThread(threadId)!
    expect(forked.createdByThreadId).toBeUndefined()
    expect(forked.startedByBot).toBeUndefined()
    expect(forked.hidden).toBeUndefined()
    expect(startedThreads(w.threads(), source.id)).toEqual([])
    expect(threadInFilter(forked, filter({ show: 'mine' }), context)).toBe(true)
  })
})
