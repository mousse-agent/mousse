import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../../data/AtomicFs'

/**
 * What Grok's held launch was proven to hold, per Grok version and platform (`heldCheck.ts`). Without a record for the
 * version that runs, Mousse claims nothing: Grok runs only chats a person drives, in Full access, and names no thread.
 */

/** Bumped whenever the check proves more or differently: an older local record is checked again. */
export const GROK_HELD_CHECK_VERSION = 2

export interface GrokHeldRecord {
  cliVersion: string
  platform: NodeJS.Platform
  /**
   * Turns: a read, a folder listing, a search, a read-only and a writing shell command, a file write and edit, an MCP
   * tool and a subagent each asked Mousse before any effect, and a refusal left none, with a Claude Code allow rule
   * and a saved "always allow" answer for the MCP tool both present.
   */
  turns: boolean
  /** One-shots: one model request, no tools, only Mousse's system text, and a forced tool call ran nothing. */
  titles: boolean
  /** The built-in tools this version offers (from the stub's first request): every one-shot disallows them. */
  tools: readonly string[]
  /** Why not, in words for the user, when either is false. */
  reason?: string
  checkVersion: number
  recordedAt: string
}

/** The tools Grok 1.0.89 and 1.0.92 offer (their check's record). */
const GROK_1_0_9X_TOOLS: readonly string[] = Object.freeze([
  'run_terminal_command', 'read_file', 'search_replace', 'list_dir', 'grep', 'kill_command_or_subagent', 'todo_write',
  'get_command_or_subagent_output', 'spawn_subagent', 'scheduler_create', 'scheduler_delete', 'scheduler_list', 'monitor',
  'search_tool', 'use_tool', 'workflow', 'enter_plan_mode', 'exit_plan_mode', 'ask_user_question', 'send_feedback',
  'image_gen', 'image_edit', 'image_to_video', 'reference_to_video', 'write', 'web_search', 'x_search'
])

/**
 * Records shipped with Mousse: `heldCheck.ts` run against the real Grok on that platform (`tests/live/grokHeldCheck.test.ts`,
 * whose controls show the same check failing without the held config, with the ask rule alone, when a worktree may take
 * its main checkout's answers, and without the startup switches).
 * - 1.0.92 and 1.0.89, Windows 11 x64: every turn item in all three phases, no startup marker, and every one-shot item.
 * Any other version or platform, or a record of an older check, is checked on the computer that runs it, after a check
 * of the entry finds it.
 */
export const GROK_HELD_SHIPPED: readonly GrokHeldRecord[] = Object.freeze([
  Object.freeze({ cliVersion: '1.0.92', platform: 'win32', turns: true, titles: true, tools: GROK_1_0_9X_TOOLS, checkVersion: 2, recordedAt: '2026-11-27T07:17:08Z' }),
  Object.freeze({ cliVersion: '1.0.89', platform: 'win32', turns: true, titles: true, tools: GROK_1_0_9X_TOOLS, checkVersion: 2, recordedAt: '2026-11-27T07:17:20Z' })
] satisfies GrokHeldRecord[])

/** The record for `cliVersion` on `platform`: a local one of this check version, else a shipped one. */
export function grokHeldRecord(cliVersion: string | undefined, platform: NodeJS.Platform, local: readonly GrokHeldRecord[], shipped: readonly GrokHeldRecord[] = GROK_HELD_SHIPPED): GrokHeldRecord | undefined {
  if (!cliVersion) return undefined
  const matches = (record: GrokHeldRecord) => record.cliVersion === cliVersion && record.platform === platform
  return local.find((record) => matches(record) && record.checkVersion === GROK_HELD_CHECK_VERSION) ?? shipped.find((record) => matches(record) && record.checkVersion === GROK_HELD_CHECK_VERSION)
}

interface EvidenceFile {
  version: 1
  records: GrokHeldRecord[]
}

/** An entry's local records, in `<stateDir>/grok-held.json`: read once, written when a check concludes. */
export class GrokHeldStore {
  private records: GrokHeldRecord[] | undefined

  constructor(private readonly stateDir: string) {}

  private path(): string {
    return join(this.stateDir, 'grok-held.json')
  }

  list(): readonly GrokHeldRecord[] {
    if (this.records) return this.records
    let records: GrokHeldRecord[] = []
    try {
      const raw = JSON.parse(readFileSync(this.path(), 'utf8')) as Partial<EvidenceFile>
      if (Array.isArray(raw.records)) records = raw.records.filter(isRecord)
    } catch {
      // None yet.
    }
    this.records = records
    return records
  }

  /** Keeps `record` in place of any other for its version and platform. */
  put(record: GrokHeldRecord): void {
    const records = [...this.list().filter((entry) => entry.cliVersion !== record.cliVersion || entry.platform !== record.platform), record]
    this.records = records
    atomicWriteJsonSync(this.path(), { version: 1, records } satisfies EvidenceFile, { mode: 0o600 })
  }
}

function isRecord(value: unknown): value is GrokHeldRecord {
  const record = value as Partial<GrokHeldRecord> | null
  return Boolean(record) && typeof record!.cliVersion === 'string' && typeof record!.platform === 'string' &&
    typeof record!.turns === 'boolean' && typeof record!.titles === 'boolean' && Array.isArray(record!.tools) &&
    typeof record!.checkVersion === 'number' && typeof record!.recordedAt === 'string'
}
