/** Hand-authored provider events prove the orchestrator forwards model output, not merely a started request. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { testHarness } from '../../src/mms/run/testkit/harness'
import { createOrchestrator, piAdapter } from '../run/phase6Fixture'

it.each(['empty', 'text', 'thinking', 'tool'] as const)('N2 confirms delivery on %s model output through the real turn sink', async kind => {
  const home = mkdtempSync(join(tmpdir(), 'mousse-bot-delivery-output-'))
  const previousHome = process.env.MOUSSE_HOME
  process.env.MOUSSE_HOME = home
  try {
    const threads = new ThreadDataStore(new ProjectManager())
    const orch = createOrchestrator(home, threads)
    const thread = threads.createThread('Bot output')
    const modelOutput = vi.fn()
    let calls = 0
    const adapter = piAdapter(() => 'unused')
    adapter.startTurn = async (_input, sink) => {
      calls++
      sink.text({ phase: 'start', content: '', contentIndex: 0 })
      expect(modelOutput).not.toHaveBeenCalled()
      if (kind === 'text') sink.text({ phase: 'delta', content: 'Received.', contentIndex: 0 })
      if (kind === 'thinking') sink.thinking({ phase: 'delta', content: 'Checking the request.' })
      if (kind === 'tool') sink.tool({ phase: 'start', callId: 'model-call', kind: 'mcp_tool_call', title: 'Read', summary: '', details: [] })
      expect(modelOutput).toHaveBeenCalledTimes(kind === 'empty' ? 0 : 1)
      throw new Error('network_error')
    }
    orch.setHarness(testHarness({ adapters: [adapter], profileHome: home }))
    await orch.send('Continue the work', false, { threadId: thread.id, bot: {
      activationId: 'work', dispatchN: 2, prompt: 'Continue the work', modelOutput,
      selection: { instanceId: 'openai', model: 'gpt-replay' },
      policy: { approvals: 'grants', approve: 'host', tools: { allow: [] }, authority: { kind: 'bot', digest: 'd' } },
      authority: { time: { signal: new AbortController().signal }, appTools: new Set<string>(), check: () => ({ ok: true }) },
      scratch: home, skills: [], history: 'none'
    } } as never)
    expect(calls).toBe(1)
    expect(modelOutput).toHaveBeenCalledTimes(kind === 'empty' ? 0 : 1)
  } finally {
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
