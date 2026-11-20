/**
 * A bot's turn runs under its grant, never a thread permission mode, and nobody is asked before its commands and edits.
 * Work that goes on past its runtime's step cap continues in a fresh turn of the same thread; that turn must not be told
 * the thread's mode changed ("Commands and file edits now ask the user before they run"), which led a model to give up
 * on its work. The turns run through the real orchestrator on Claude Code; the runtime's replies are hand-authored.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { BotTurnDispatcher } from '../../src/mms/bots/activation/dispatcher'
import { setSharedShellPath } from '../../src/mms/harness/shellPath'
import type { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'
import type { RunEngine } from '../../src/mms/run/RunEngine'
import type { BotTurnPayload } from '../../src/mms/run/types'
import { AppError } from '../../src/shared/errors'
import { PROVIDER_TURN_CAP } from '../../src/shared/harness/types'

let home: string
let main: MousseMainService

beforeAll(async () => {
  home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-bot-continuation-mode-'))
  setSharedShellPath({ entries: [], source: 'login_shell' })
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await main.start()
  main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'opus' } })
})

afterAll(async () => {
  try {
    try { await main?.threads.flushSearchIndex() }
    finally { await main?.stop() }
  }
  finally {
    setSharedShellPath(undefined)
    vi.restoreAllMocks()
    // On a busy Windows machine the stopped profile's folder can stay held past this (`botReplyFinalMessage` fails the
    // same way on master); a temporary folder left behind is no failure of what this file checks.
    try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error }
  }
})

type Chat = ClaudeSubscriptionProviderService['chat']

it('a continuation of bot work is not told the thread\'s permission mode changed', async () => {
  const thread = main.threads.createThread('Bot work')
  const scratch = mkdtempSync(join(home, 'scratch-'))
  const time = new AbortController()
  const settled: Array<{ text?: string }> = []
  const settleRun = vi.spyOn(main.personalBots!, 'settleRun')
  const dispatcher: BotTurnDispatcher = {
    prepare: (payload) => ({
      activationId: payload.activationId,
      dispatchN: payload.dispatchN,
      prompt: payload.dispatchN === 1 ? 'Create 30 note files, one at a time.' : '[Mousse] You reached the most steps one turn may take; what you did so far is kept. Continue.',
      selection: { instanceId: 'claude', model: 'opus' },
      policy: { approvals: 'grants', approve: 'host', tools: { allow: ['read', 'edit'] }, authority: { kind: 'bot', digest: 'd' } },
      authority: { time: { signal: time.signal }, appTools: new Set<string>(), check: () => ({ ok: true }) } as never,
      scratch,
      skills: [],
      history: payload.dispatchN === 1 ? 'none' : 'thread'
    }),
    settle: (_payload, outcome) => { settled.push(outcome) },
    ownerOf: () => undefined
  }
  main.orchestrator.setBotDispatcher(dispatcher)
  // What Claude Code is given: the prompt, and the thread's history when a turn starts a fresh process (as each turn
  // after the turn cap does: a capped turn saves no session to resume).
  const seen: string[] = []
  const chat = vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input: Parameters<Chat>[0]) => {
    seen.push(`${input.turnPreamble ?? ''}\n${input.prompt}\n${input.history ?? ''}`)
    input.onText('Made 3 files so far.')
    // The first two turns end at Claude Code's step cap, as `resultFailure` reports it.
    if (seen.length < 3) throw new AppError({ code: PROVIDER_TURN_CAP, message: 'Claude Code reached the most steps one turn may take.', errorInfo: { category: 'internal', retryable: false } })
    return 'Made all 30 files.'
  })
  const runs = (main.orchestrator as unknown as { runEngine: RunEngine }).runEngine
  try {
    // The work's first turn, then two that go on from it in fresh turns of the same thread, as after the turn cap.
    let previous: string | undefined
    for (let n = 1; n <= 3; n += 1) {
      const sent = await runs.sendWithStart({ kind: 'send', threadId: thread.id, clientRequestId: `${thread.id}:d${n}`, source: 'bot', ...(previous ? { continuationOfRunId: previous } : {}) },
        (runId): BotTurnPayload => ({ kind: 'bot', runId, threadId: thread.id, activationId: 'act-1', dispatchN: n }))
      if (sent.status !== 'accepted') throw new Error('rejected')
      await vi.waitFor(() => {
        expect(settled).toHaveLength(n)
        // The profile also handles the terminal run event on setImmediate, using its bot database.
        expect(settleRun).toHaveBeenCalledWith(sent.runId)
      }, { timeout: 20_000 })
      previous = sent.runId
    }
  } finally {
    chat.mockRestore()
  }
  expect(seen).toHaveLength(3)
  expect(seen[2]).toContain('You reached the most steps one turn may take')
  expect(seen.join('\n')).not.toContain('Permission mode changed')
  const messages = main.threads.loadThreadData(thread.id).messages ?? []
  expect(messages.filter((message) => message.role === 'user' && String(message.content).includes('Permission mode changed'))).toEqual([])
  // The thread says why the work went on: no restart happened.
  expect(messages.filter((message) => message.role === 'system' && String(message.content).startsWith('Continuing run')).map((message) => message.content))
    .toEqual(['Continuing run 1, which took the most steps one turn may take.', 'Continuing run 2, which took the most steps one turn may take.'])
})
