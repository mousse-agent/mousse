import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { endGroup, signalGroup, type EndGroupOptions } from './processScope'

/**
 * The active-time supervisor of one bot dispatch (Bot Phase 1 §5.9, gap 1): a plain Node process
 * outside the daemon, started detached for each process a bot's runtime reports. It sleeps until
 * the dispatch's deadline, then ends the process group (SIGTERM, SIGKILL after 2 seconds, the exit
 * confirmed for up to 10 seconds; `taskkill /T /F` on Windows) and writes what it saw to its
 * journal file, which the daemon folds into `bot_dispatches.exit_at`. A group that ends before the
 * deadline is recorded as such, and the supervisor leaves. The daemon stops it (SIGTERM) when the
 * dispatch settles. Node's built-ins only: `out/cli/bot-supervisor.js` bundles this file alone.
 */

export const BOT_SUPERVISOR_USAGE = 'Usage: bot-supervisor --dispatch <id> --pgid <n> --deadline <epochMs> --journal <path>'

export interface BotSupervisorArgs {
  dispatchId: string
  /** The process group (POSIX) or tree leader (Windows) the runtime reported. */
  pgid: number
  /** Epoch milliseconds. */
  deadlineAt: number
  /** Where the journal line goes (`<profile>/bots/supervisor/…json`). */
  journal: string
}

/** What a supervisor saw: the group was gone (`exitAt`), or still there after the kill (`stillAlive`). */
export interface BotSupervisorJournal {
  dispatchId: string
  pgid: number
  /** When it ended the group at the deadline; absent when the group was gone before it. */
  killedAt?: number
  exitAt?: number
  stillAlive?: true
}

export function botSupervisorArgv(args: BotSupervisorArgs): string[] {
  return ['--dispatch', args.dispatchId, '--pgid', String(args.pgid), '--deadline', String(args.deadlineAt), '--journal', args.journal]
}

export function parseBotSupervisorArgs(argv: readonly string[]): BotSupervisorArgs | undefined {
  const value = (flag: string) => {
    const at = argv.indexOf(flag)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const dispatchId = value('--dispatch')
  const journal = value('--journal')
  const pgid = Number(value('--pgid'))
  const deadlineAt = Number(value('--deadline'))
  if (!dispatchId || !journal || !Number.isInteger(pgid) || pgid <= 1 || !Number.isFinite(deadlineAt)) return undefined
  return { dispatchId, pgid, deadlineAt, journal }
}

/** Written whole or not at all: a reader never sees half a line. */
export function writeBotSupervisorJournal(path: string, record: BotSupervisorJournal): void {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

export function readBotSupervisorJournal(path: string): BotSupervisorJournal | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BotSupervisorJournal>
    if (typeof parsed.dispatchId !== 'string' || typeof parsed.pgid !== 'number') return undefined
    return {
      dispatchId: parsed.dispatchId,
      pgid: parsed.pgid,
      ...(typeof parsed.killedAt === 'number' ? { killedAt: parsed.killedAt } : {}),
      ...(typeof parsed.exitAt === 'number' ? { exitAt: parsed.exitAt } : {}),
      ...(parsed.stillAlive === true ? { stillAlive: true as const } : {})
    }
  } catch {
    return undefined
  }
}

export function removeBotSupervisorJournal(path: string): void {
  rmSync(path, { force: true })
}

export interface BotSupervisorDeps extends EndGroupOptions {
  /** How often the group is looked at before the deadline (default 1 s). */
  watchMs?: number
}

/** Runs one supervisor to its end; the exit code (0: the group is gone, 1: it was still there). */
export async function runBotSupervisor(args: BotSupervisorArgs, deps: BotSupervisorDeps = {}): Promise<number> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const watch = deps.watchMs ?? 1_000
  const base = { dispatchId: args.dispatchId, pgid: args.pgid }
  while (now() < args.deadlineAt) {
    // Gone before the deadline (the turn ended, the daemon could not stop this supervisor).
    if (!signalGroup(args.pgid, 0, deps)) {
      writeBotSupervisorJournal(args.journal, { ...base, exitAt: now() })
      return 0
    }
    await sleep(Math.max(1, Math.min(watch, args.deadlineAt - now())))
  }
  const killedAt = now()
  const ended = await endGroup(args.pgid, deps)
  writeBotSupervisorJournal(args.journal, { ...base, killedAt, ...ended })
  return 'stillAlive' in ended ? 1 : 0
}
