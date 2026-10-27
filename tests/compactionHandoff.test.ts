/**
 * PR 4 keeps Mousse's compaction for prompt runtimes (F2): the canonical transcript, and so the
 * history preamble a runtime is handed, stays inside the runtime's window. A long thread handed to a
 * prompt runtime is compacted before the turn (`prepareNativeContext`), and an overflow the runtime
 * reports before any tool ran is recovered once (`recoverOverflow`).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RecoveredContext } from '../src/mms/harness/gateway'
import type { AdapterHost, TurnControl, TurnInput, TurnResult, TurnSink } from '../src/mms/run/adapters/ProviderAdapter'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { CLAUDE, ScriptedAdapter, phase6Daemon, type Phase6Daemon } from './run/phase6Fixture'

/** About 40k tokens of reply per turn (Mousse estimates four characters a token). */
const LONG = 'x'.repeat(160_000)

/** A prompt runtime that asks Mousse to fit its history first, or to recover an overflow. */
class FittingAdapter extends ScriptedAdapter {
  readonly prepared: Array<RecoveredContext | null> = []
  readonly recovered: Array<RecoveredContext | null> = []
  mode: 'reply' | 'prepare' | 'overflow' = 'reply'

  constructor() {
    super('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, () => LONG)
  }

  override async startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    if (this.mode === 'prepare') this.prepared.push(await host.context.prepareNativeContext(input.llmProvider, input.model))
    if (this.mode === 'overflow') this.recovered.push(await host.context.recoverOverflow())
    return super.startTurn(input, sink, ctl, host)
  }
}

describe('compaction before a handoff to a prompt runtime', () => {
  let home: string
  let daemon: Phase6Daemon
  let adapter: FittingAdapter

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-compaction-handoff-'))
    process.env.MOUSSE_HOME = home
    adapter = new FittingAdapter()
    daemon = phase6Daemon(home, [adapter])
  })

  afterEach(async () => {
    await daemon.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  /** A thread on the prompt runtime whose transcript is past the 128k compaction setting. */
  async function longThread(): Promise<string> {
    const thread = daemon.store.createThread('Long thread')
    daemon.orch.setThreadModelOverride(thread.id, CLAUDE)
    for (let turn = 0; turn < 4; turn += 1) await daemon.orch.send(`turn ${turn}`, false, { threadId: thread.id, clientRequestId: `long-${turn}` })
    return thread.id
  }

  const notes = (threadId: string) => daemon.orch.getMessages(threadId).filter((message) => message.kind === 'context_compaction').map((message) => message.content)

  it('a long thread handed to a prompt runtime is compacted first', async () => {
    const threadId = await longThread()
    adapter.mode = 'prepare'
    const response = await daemon.orch.send('next', false, { threadId, clientRequestId: 'prepare' })
    expect(response.message).toBe(LONG)
    expect(adapter.prepared).toHaveLength(1)
    const recovered = adapter.prepared[0]
    expect(recovered).not.toBeNull()
    expect(recovered!.contextSummary).toBeTruthy()
    // The preamble handed over is the compacted history, much shorter than the transcript was.
    expect(recovered!.nativeHistory.length).toBeLessThan(4 * LONG.length)
    expect(notes(threadId)).toContain('Context compacted')
  })

  it('an overflow before any tool ran is recovered by compacting the transcript', async () => {
    const threadId = await longThread()
    adapter.mode = 'overflow'
    await daemon.orch.send('next', false, { threadId, clientRequestId: 'overflow' })
    expect(adapter.recovered).toHaveLength(1)
    expect(adapter.recovered[0]?.messages.length).toBeGreaterThan(0)
    expect(adapter.recovered[0]?.contextSummary).toBeTruthy()
    expect(notes(threadId)).toContain('Context compacted')
  })

  it('a short thread is handed over as it is', async () => {
    const thread = daemon.store.createThread('Short thread')
    daemon.orch.setThreadModelOverride(thread.id, CLAUDE)
    adapter.mode = 'prepare'
    await daemon.orch.send('hello', false, { threadId: thread.id, clientRequestId: 'short' })
    expect(adapter.prepared).toEqual([null])
    expect(notes(thread.id)).toEqual([])
  })
})
