import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readStartTime } from '../../harness/processTree.mjs'
import type { BotProcessSupervision } from '../seams'
import type { BotStore } from '../store/BotStore'
import { botSupervisorArgv, readBotSupervisorJournal, removeBotSupervisorJournal, type BotSupervisorArgs } from './botSupervisor'
import { endGroup, groupAlive, waitGone, type EndGroupOptions } from './processScope'

/**
 * The daemon's side of bot process control (Bot Phase 1 §5.9): which process serves which bot
 * dispatch, and the evidence that it is gone.
 *
 * - `arm` records a dispatch and its deadline before its runtime starts.
 * - `attach` (or `attachThread`, for the runtimes' `onProcess` hooks, which know the thread) records
 *   the process in `bot_dispatches.child_pid`/`child_group`/`child_token` and starts its detached
 *   supervisor (`botSupervisorMain.ts`), which ends the group at the deadline even while the
 *   daemon's loop is blocked. Without a supervisor nothing runs: `attach` throws, and the runtime
 *   ends the process it just started.
 * - `settled` waits for the group to end (its runtime ends it as the turn settles), ends what is
 *   still there, stops the supervisor and writes `exit_at`.
 * - `reconcile` at startup ends the recorded groups of dispatches with no `exit_at` (only groups
 *   verified as the ones recorded: the leader's start time, `child_token`) and folds supervisor
 *   journals in.
 *
 * A dispatch is `bot_dispatches.client_request_id` (`<activationId>:d<n>`, `<activationId>:c<n>`).
 * A dispatch may serve several processes in turn (a retried attempt): each gets a supervisor of its
 * own, and the row records the latest.
 */

/** The `bot_dispatches` columns the registry reads and writes. */
export interface BotProcessRecords {
  /** The dispatch's thread, so a runtime's process report (by thread) finds its dispatch. */
  threadOf(dispatchId: string): string | undefined
  setChild(dispatchId: string, proc: { pid: number; pgid: number; token?: string }): void
  /** Epoch milliseconds; a later exit of the same dispatch (another process) moves it on. */
  setExit(dispatchId: string, exitAt: number): void
  /** Dispatches with a recorded process and no `exit_at`. */
  unfinished(): Array<{ dispatchId: string; pid: number; pgid: number; token?: string }>
}

/** The records over `bots.db` (columns that exist since v1; `BotStore` itself is unchanged). */
export function botStoreProcessRecords(store: Pick<BotStore, 'get' | 'all' | 'run'>): BotProcessRecords {
  return {
    threadOf: (dispatchId) => {
      const thread = store.get('SELECT thread_id FROM bot_dispatches WHERE client_request_id = ?', dispatchId)?.thread_id
      return typeof thread === 'string' ? thread : undefined
    },
    setChild: (dispatchId, proc) => {
      store.run('UPDATE bot_dispatches SET child_pid = ?, child_group = ?, child_token = ?, exit_at = NULL WHERE client_request_id = ?', proc.pid, proc.pgid, proc.token ?? null, dispatchId)
    },
    setExit: (dispatchId, exitAt) => {
      store.run('UPDATE bot_dispatches SET exit_at = MAX(COALESCE(exit_at, 0), ?) WHERE client_request_id = ?', Math.round(exitAt), dispatchId)
    },
    unfinished: () =>
      store.all('SELECT client_request_id, child_pid, child_group, child_token FROM bot_dispatches WHERE child_group IS NOT NULL AND exit_at IS NULL').map((row) => ({
        dispatchId: row.client_request_id as string,
        pid: Number(row.child_pid),
        pgid: Number(row.child_group),
        ...(typeof row.child_token === 'string' ? { token: row.child_token } : {})
      }))
  }
}

/** A running supervisor: `stop` ends it (the dispatch settled). */
export interface BotSupervisorHandle {
  stop(): void
}

export type StartBotSupervisor = (args: BotSupervisorArgs) => BotSupervisorHandle

/**
 * The built supervisor beside the bundle that runs this code (`out/cli/bot-supervisor.js`): the CLI
 * bundle's own folder, or `out/cli` from the app's `out/main` (or a chunk folder below it).
 */
export function defaultBotSupervisorScript(): string | undefined {
  const here = dirname(typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url))
  for (const dir of [here, join(here, '..', 'cli'), join(here, '..', '..', 'cli')]) {
    const script = join(dir, 'bot-supervisor.js')
    if (existsSync(script)) return script
  }
  return undefined
}

/** Variables the supervisor never takes from the daemon: they would change how its runtime starts. */
const DROPPED_ENV = /^(ELECTRON_|NODE_OPTIONS$)/i

/**
 * Starts `script` detached with this process's runtime as plain Node, its output ignored, so it
 * outlives a daemon that stops or hangs. Throws when it does not start.
 */
export function spawnBotSupervisor(script: string, execPath = process.execPath): StartBotSupervisor {
  return (args) => {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) if (!DROPPED_ENV.test(key)) env[key] = value
    env.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn(execPath, [script, ...botSupervisorArgv(args)], { detached: true, stdio: 'ignore', windowsHide: true, env })
    child.on('error', (error) => console.warn('[bots] the bot supervisor failed', { dispatchId: args.dispatchId, error: error.message }))
    child.unref()
    if (!child.pid) throw new Error('The bot supervisor could not start, so the bot does not run.')
    return {
      stop: () => {
        try {
          child.kill('SIGTERM')
        } catch {
          // Already gone.
        }
      }
    }
  }
}

/** Why a bot process is refused when this build has no supervisor to start. */
export const BOT_SUPERVISOR_MISSING = 'This build has no bot supervisor, so a bot cannot run here.'

export interface BotProcessRegistryOptions {
  records: BotProcessRecords
  /** `<profileHome>/bots/supervisor`: the supervisors' journal files. */
  journalDir: string
  /** Default: `spawnBotSupervisor(defaultBotSupervisorScript())`; without a script every `attach` throws. */
  startSupervisor?: StartBotSupervisor
  /** The opaque start time of a pid (default `readStartTime`), recorded as `child_token`. */
  token?: (pid: number) => string | undefined
  /** How a group is read and ended (test seams). */
  scope?: EndGroupOptions
  /** How long a settled dispatch's group has to end on its own before it is ended (default 2 s). */
  settleGraceMs?: number
  now?: () => number
  platform?: NodeJS.Platform
}

interface SupervisedProcess {
  pid: number
  pgid: number
  token?: string
  journal: string
  supervisor?: BotSupervisorHandle
}

interface ArmedDispatch {
  dispatchId: string
  activationId: string
  deadlineAt: number
  threadId?: string
  procs: SupervisedProcess[]
}

type Settled = { exitAt: string } | { stillAlive: true }

export class BotProcessRegistry implements BotProcessSupervision {
  private readonly armed = new Map<string, ArmedDispatch>()
  private readonly settling = new Map<string, Promise<Settled>>()
  private readonly startSupervisor: StartBotSupervisor
  private readonly now: () => number

  constructor(private readonly options: BotProcessRegistryOptions) {
    this.now = options.now ?? Date.now
    this.startSupervisor = options.startSupervisor ?? (() => {
      const script = defaultBotSupervisorScript()
      if (!script) return () => { throw new Error(BOT_SUPERVISOR_MISSING) }
      return spawnBotSupervisor(script)
    })()
  }

  private journalOf(dispatchId: string, pid: number): string {
    // A dispatch id holds `:`, which Windows file names cannot.
    return join(this.options.journalDir, `${encodeURIComponent(dispatchId)}.${pid}.json`)
  }

  private journalsOf(dispatchId: string): string[] {
    const prefix = `${encodeURIComponent(dispatchId)}.`
    try {
      return readdirSync(this.options.journalDir).filter((name) => name.startsWith(prefix) && name.endsWith('.json')).map((name) => join(this.options.journalDir, name))
    } catch {
      return []
    }
  }

  arm(d: { dispatchId: string; activationId: string; deadlineAt: number }): void {
    const known = this.armed.get(d.dispatchId)
    if (known) {
      known.deadlineAt = d.deadlineAt
      return
    }
    this.armed.set(d.dispatchId, { ...d, procs: [] })
  }

  attach(dispatchId: string, proc: { pid: number; pgid: number }): void {
    const armed = this.armed.get(dispatchId)
    if (!armed || this.settling.has(dispatchId)) throw new Error(`Bot dispatch ${dispatchId} is not armed, so its process is not supervised.`)
    if (!Number.isInteger(proc.pid) || proc.pid <= 1 || !Number.isInteger(proc.pgid) || proc.pgid <= 1) throw new Error('A bot process needs its pid and process group.')
    const token = (this.options.token ?? readStartTime)(proc.pid)
    const journal = this.journalOf(dispatchId, proc.pid)
    mkdirSync(this.options.journalDir, { recursive: true, mode: 0o700 })
    removeBotSupervisorJournal(journal)
    const supervisor = this.startSupervisor({ dispatchId, pgid: proc.pgid, deadlineAt: armed.deadlineAt, journal })
    try {
      this.options.records.setChild(dispatchId, { ...proc, ...(token ? { token } : {}) })
    } catch (error) {
      supervisor.stop()
      throw error
    }
    armed.procs.push({ ...proc, ...(token ? { token } : {}), journal, supervisor })
  }

  /**
   * A runtime's process report (`onLockedProcess`, Pi's `onBotProcess`): the armed dispatch on
   * `threadId`, the latest one armed. The process leads its own group (`detached`). Throws when no
   * dispatch is armed on that thread: the runtime then ends the process.
   */
  attachThread(threadId: string, pid: number): void {
    const candidates = [...this.armed.values()].filter((armed) => !this.settling.has(armed.dispatchId) && this.threadOf(armed) === threadId)
    const armed = candidates.at(-1)
    if (!armed) throw new Error('This bot process has no armed dispatch, so it is not supervised.')
    this.attach(armed.dispatchId, { pid, pgid: pid })
  }

  private threadOf(armed: ArmedDispatch): string | undefined {
    armed.threadId ??= this.options.records.threadOf(armed.dispatchId)
    return armed.threadId
  }

  settled(dispatchId: string): Promise<Settled> {
    const known = this.settling.get(dispatchId)
    if (known) return known
    const settling = this.settle(dispatchId).finally(() => {
      this.settling.delete(dispatchId)
      this.armed.delete(dispatchId)
    })
    this.settling.set(dispatchId, settling)
    return settling
  }

  private async settle(dispatchId: string): Promise<Settled> {
    const armed = this.armed.get(dispatchId)
    // Armed in another daemon (before a restart): its recorded process.
    const procs: SupervisedProcess[] = armed?.procs.length
      ? armed.procs
      : this.options.records.unfinished().filter((row) => row.dispatchId === dispatchId).map((row) => ({ ...row, journal: this.journalOf(dispatchId, row.pid) }))
    const scope = this.scope()
    let exitAt = 0
    let stillAlive = false
    for (const proc of procs) {
      const journal = readBotSupervisorJournal(proc.journal)
      let ended: { exitAt: number } | { stillAlive: true }
      if (journal?.exitAt !== undefined) ended = { exitAt: journal.exitAt }
      // Its runtime ends the group as the turn settles; what is still there after the grace is ended here.
      else if (await waitGone(proc.pgid, this.now() + (this.options.settleGraceMs ?? 2_000), scope)) ended = { exitAt: this.now() }
      else ended = await endGroup(proc.pgid, scope)
      if ('stillAlive' in ended) {
        // Its supervisor keeps its deadline; `exit_at` stays empty, and the next start tries again.
        stillAlive = true
        continue
      }
      proc.supervisor?.stop()
      removeBotSupervisorJournal(proc.journal)
      exitAt = Math.max(exitAt, ended.exitAt)
    }
    if (stillAlive) return { stillAlive: true }
    const at = exitAt || this.now()
    this.options.records.setExit(dispatchId, at)
    return { exitAt: new Date(at).toISOString() }
  }

  async reconcile(): Promise<Array<{ dispatchId: string; exitAt?: string }>> {
    const scope = this.scope()
    const results: Array<{ dispatchId: string; exitAt?: string }> = []
    const pending = new Set<string>()
    for (const row of this.options.records.unfinished()) {
      // A dispatch of this daemon is settled by it, not here.
      if (this.armed.has(row.dispatchId)) {
        pending.add(row.dispatchId)
        continue
      }
      const journal = readBotSupervisorJournal(this.journalOf(row.dispatchId, row.pid))
      let exitAt: number | undefined = journal?.exitAt
      if (exitAt === undefined) {
        if (!(await groupAlive(row.pgid, scope))) exitAt = this.now()
        else {
          const current = (this.options.token ?? readStartTime)(row.pid)
          // The leader's pid now runs another program: a pid is not reused while its group has
          // members, so the recorded group is gone and this one is someone else's.
          if (row.token && current !== undefined && current !== row.token) exitAt = this.now()
          // Verified as the recorded group (its leader, or members left without it): ended here.
          else if (row.token) {
            const ended = await endGroup(row.pgid, scope)
            if ('exitAt' in ended) exitAt = ended.exitAt
          }
          // Not verifiable (no start time was recorded): never signalled by number alone. Its
          // supervisor still ends it at the deadline.
        }
      }
      if (exitAt !== undefined) {
        this.options.records.setExit(row.dispatchId, exitAt)
        for (const path of this.journalsOf(row.dispatchId)) removeBotSupervisorJournal(path)
      } else pending.add(row.dispatchId)
      results.push({ dispatchId: row.dispatchId, ...(exitAt !== undefined ? { exitAt: new Date(exitAt).toISOString() } : {}) })
    }
    // Journals of dispatches that are finished (or were never recorded) are left over: removed.
    let names: string[] = []
    try {
      names = readdirSync(this.options.journalDir)
    } catch {
      // No folder yet.
    }
    for (const name of names) {
      const match = name.match(/^(.+)\.\d+\.json$/)
      if (match && !pending.has(decodeURIComponent(match[1]))) removeBotSupervisorJournal(join(this.options.journalDir, name))
    }
    return results
  }

  private scope(): EndGroupOptions {
    return { ...(this.options.platform ? { platform: this.options.platform } : {}), ...(this.options.now ? { now: this.options.now } : {}), ...this.options.scope }
  }
}

/**
 * The profile's registry over its `bots.db` (`MmsProfileServices`): pass it to the bot engine as
 * its `BotProcessSupervision`, and route the runtimes' process reports to `attachThread`.
 */
export function createBotProcessRegistry(input: { store: BotStore } & Partial<Omit<BotProcessRegistryOptions, 'records' | 'journalDir'>>): BotProcessRegistry {
  const { store, ...rest } = input
  return new BotProcessRegistry({ records: botStoreProcessRecords(store), journalDir: join(store.directory, 'supervisor'), ...rest })
}
