/** Hand-authored provider events prove the orchestrator forwards model output, not merely a started request. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { createOrchestrator, piAdapter } from '../run/phase6Fixture'

it.each(['empty', 'text', 'thinking', 'tool', 'throw'] as const)('N2 confirms delivery on %s model output through the real turn sink', async kind => {
  const home = mkdtempSync(join(tmpdir(), 'mousse-bot-delivery-output-'))
  const previousHome = process.env.MOUSSE_HOME
  process.env.MOUSSE_HOME = home
  let stop: (() => void) | undefined
  const db = new ProfileDatabase({ profileHome: home })
  try {
    const threads = new ThreadDataStore(new ProjectManager())
    const orch = createOrchestrator(home, threads)
    const thread = threads.createThread('Bot output')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stop = () => warning.mockRestore()
    const modelOutput = vi.fn(() => { if (kind === 'throw') throw new Error('database closed') })
    let calls = 0
    const adapter = piAdapter(() => 'Completed normally.')
    const original = adapter.startTurn.bind(adapter)
    adapter.startTurn = async (_input, sink, ctl, host) => {
      calls++
      sink.text({ phase: 'start', content: '', contentIndex: 0 })
      expect(modelOutput).not.toHaveBeenCalled()
      if (kind === 'text') sink.text({ phase: 'delta', content: 'Received.', contentIndex: 0 })
      if (kind === 'thinking') sink.thinking({ phase: 'delta', content: 'Checking the request.' })
      if (kind === 'tool') sink.tool({ phase: 'start', callId: 'model-call', kind: 'mcp_tool_call', title: 'Read', summary: '', details: [] })
      if (kind === 'throw') {
        sink.text({ phase: 'delta', content: 'First.', contentIndex: 0 })
        sink.text({ phase: 'delta', content: 'Second.', contentIndex: 0 })
        return original(_input, sink, ctl, host)
      }
      expect(modelOutput).toHaveBeenCalledTimes(kind === 'empty' ? 0 : 1)
      throw new Error('network_error')
    }
    orch.setHarness(testHarness({ drivers: [{ ...adapterDriver(adapter), botAuthority: () => true }], profileHome: home }))
    const bot = {
      activationId: 'work', dispatchN: 2, prompt: 'Continue the work', modelOutput,
      selection: { instanceId: 'openai', model: 'gpt-replay' },
      policy: { approvals: 'grants', approve: 'host', tools: { allow: [] }, authority: { kind: 'bot', digest: 'd' } },
      authority: { time: { signal: new AbortController().signal }, appTools: new Set<string>(), check: () => ({ ok: true }) },
      scratch: home, skills: [], history: 'none'
    }
    const engine = new RunEngine({ store: new RunStore(db) })
    orch.setRunEngine(engine)
    stop = () => { orch.setRunEngine(null); warning.mockRestore() }
    const sent = await engine.sendWithStart({ kind: 'send', threadId: thread.id, clientRequestId: 'model-output', source: 'bot' }, runId => ({ kind: 'bot', runId, threadId: thread.id, activationId: 'work', dispatchN: 2 }))
    if (sent.status !== 'accepted') throw new Error('run refused')
    const result = await (orch as any).runTurnOnSession(orch.getOrCreateSession(thread.id), { content: 'Continue', mode: 'agent' }, false, true, { bot, runId: sent.runId, source: 'bot' })
    await new Promise(resolve => setImmediate(resolve))
    orch.setRunEngine(null)
    expect(calls, JSON.stringify(result)).toBe(1)
    expect(modelOutput).toHaveBeenCalledTimes(kind === 'empty' ? 0 : 1)
    if (kind === 'throw') {
      expect(result.error).toBeUndefined()
      expect(result.message).toContain('Completed normally.')
      expect(warning).toHaveBeenCalledTimes(1)
    }
  } finally {
    await new Promise(resolve => setImmediate(resolve))
    stop?.()
    db.close()
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
