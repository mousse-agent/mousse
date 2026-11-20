/**
 * The idle Compact suggestion on every provider: after a turn, the context snapshot carries the thread's prompt
 * cache record (and, where the runtime reports no context, Mousse's estimate of the history), and Compact now
 * compacts through the runtime's own compaction where it has one, else through Mousse's copy. Claude Code's path
 * is in `claudeSubscriptionOrchestrator.test.ts`.
 *
 * The runtimes are scripted (hand-authored): they prove Mousse's side only. The real runtimes' session reuse by
 * history fingerprint (ACP, Cursor, Pi) and Codex's `thread/compact/start` are covered by their own tests.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANTIGRAVITY_CAPABILITIES } from '../src/mms/harness/acp/presets/antigravity'
import type { ProviderCapabilities } from '../src/mms/harness/adapter'
import type { NativeCompactRequest } from '../src/mms/harness/driver'
import { CODEX_CAPABILITIES } from '../src/mms/harness/drivers/codex/adapter'
import { CURSOR_CAPABILITIES } from '../src/mms/harness/drivers/cursor/adapter'
import type { ProviderDriverKind } from '../src/shared/providerInstances'
import { ProviderInstanceService } from '../src/mms/harness/instanceMap'
import { adapterDriver } from '../src/mms/run/testkit/harness'
import { PI_TEST_CAPABILITIES } from './support/piStub'
import { phase6Daemon, ScriptedAdapter, type Phase6Daemon } from './run/phase6Fixture'

/** About 15K tokens a reply: four turns make a history past both the chip's 40K and the 20K a compaction keeps. */
const LONG_REPLY = 'word '.repeat(12_000)

interface Row {
  name: string
  driver: ProviderDriverKind
  capabilities: ProviderCapabilities
  /** The runtime reports its context (the composer has a gauge). */
  reportsContext: boolean
  /** The runtime has a compaction of its own (Codex's `thread/compact/start`). */
  nativeCompaction: boolean
  /** The thread's selection; the pi row keeps the profile default. */
  selection?: { instanceId: string; llmProvider: string; model: string }
}

const ROWS: Row[] = [
  { name: 'Codex', driver: 'codex', capabilities: CODEX_CAPABILITIES, reportsContext: true, nativeCompaction: true, selection: { instanceId: 'codex', llmProvider: 'codex', model: 'gpt-replay' } },
  { name: 'Pi', driver: 'pi', capabilities: PI_TEST_CAPABILITIES, reportsContext: true, nativeCompaction: false },
  { name: 'Antigravity (ACP)', driver: 'antigravity', capabilities: ANTIGRAVITY_CAPABILITIES, reportsContext: false, nativeCompaction: false, selection: { instanceId: 'antigravity', llmProvider: 'antigravity', model: 'agent' } },
  { name: 'Cursor', driver: 'cursor', capabilities: CURSOR_CAPABILITIES, reportsContext: false, nativeCompaction: false, selection: { instanceId: 'cursor', llmProvider: 'cursor', model: 'auto' } }
]

let home: string | undefined
let daemon: Phase6Daemon | undefined
const previousHome = process.env.MOUSSE_HOME

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  vi.restoreAllMocks()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  home = undefined
})

describe.each(ROWS)('idle compaction on $name', (row) => {
  const start = () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-idle-compaction-'))
    process.env.MOUSSE_HOME = home
    const adapter = Object.assign(new ScriptedAdapter(row.driver, row.capabilities, () => LONG_REPLY), {
      describe: () => ({ contextUsage: row.reportsContext ? 'reported' as const : 'none' as const })
    })
    const compactConversation = vi.fn(async (_request: NativeCompactRequest) => true)
    // Cursor is seeded only where its agent is installed.
    const instances = new ProviderInstanceService()
    if (row.driver === 'cursor') instances.setEntry('cursor', { driver: 'cursor', enabled: true, config: {} })
    daemon = phase6Daemon(home, [], { instances, drivers: [adapterDriver(adapter, row.nativeCompaction ? { runtime: { compactConversation } } : {})] })
    const thread = daemon.store.createThread('Idle')
    if (row.selection) daemon.orch.setThreadModelOverride(thread.id, row.selection)
    const usage = () => daemon!.orch.getContextUsage({ draftInput: 'a draft', mode: 'agent' }, thread.id)
    return { orch: daemon.orch, thread, usage, compactConversation }
  }

  it('records the prompt cache after a turn, and Compact now compacts the history and leaves it cold', async () => {
    const { orch, thread, usage, compactConversation } = start()
    const before = await usage()
    expect(before.promptCache).toBeUndefined()
    expect(before.historyEstimate).toBeUndefined()

    for (const content of ['one', 'two', 'three', 'four']) await orch.send({ content, mode: 'agent' }, false, { threadId: thread.id })
    const after = await usage()
    // Codex, Cursor and ACP agents report no cache lifetime: the composer shows idle time and goes cold after an hour.
    expect(after.promptCache).toMatchObject({ lastRequestAt: expect.any(Number) })
    expect(after.promptCache?.ttlMs).toBeUndefined()
    if (row.reportsContext) {
      expect(after.historyEstimate).toBeUndefined()
    } else {
      // No gauge is made up for a runtime that reports none; the history size is an estimate for the chip only,
      // without the draft.
      expect(after).toMatchObject({ limit: 0, used: 0, categories: [] })
      expect(after.historyEstimate).toBeGreaterThan(40_000)
      expect(after.historyEstimate).toBe((await orch.getContextUsage({ draftInput: '', mode: 'agent' }, thread.id)).historyEstimate)
    }

    const outcome = await orch.compactConversationContext(thread.id)
    if (row.nativeCompaction) {
      expect(outcome).toBe('native')
      expect(compactConversation).toHaveBeenCalledOnce()
      expect(compactConversation.mock.calls[0]![0]).toMatchObject({ threadId: thread.id, instanceId: row.selection?.instanceId })
    } else {
      // Mousse summarizes its own copy; the history's revision moves, so the runtime's next session starts from it.
      expect(outcome).toBe('compacted')
      expect(compactConversation).not.toHaveBeenCalled()
    }
    const compacted = await usage()
    expect(compacted.promptCache).toBeUndefined()
    expect(compacted.historyEstimate).toBeUndefined()
  }, 60_000)

  if (!row.reportsContext) {
    it('sends no cache record or estimate for another model than the one the cache was made on', async () => {
      const { orch, thread, usage } = start()
      await orch.send({ content: 'one', mode: 'agent' }, false, { threadId: thread.id })
      expect((await usage()).promptCache).toBeDefined()
      orch.setThreadModelOverride(thread.id, { ...row.selection!, model: 'another-model' })
      const elsewhere = await usage()
      expect(elsewhere.promptCache).toBeUndefined()
      expect(elsewhere.historyEstimate).toBeUndefined()
    }, 60_000)
  }
})
