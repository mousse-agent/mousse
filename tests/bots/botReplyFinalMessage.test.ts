/**
 * A bot's reply or run report is the turn's final message only. The model's notes between tool calls ("Bash ate the $
 * signs; using a heredoc.") stay in the bot's thread and never reach its owner's chat. The turn runs through the real
 * orchestrator on Claude Code; the runtime's events are hand-authored (they prove Mousse's side only), shaped like the
 * Claude driver's: text, a tool call, more text, and the turn's whole text as its result.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { BotRoomAbort, type BotTurnDispatcher } from '../../src/mms/bots/activation/dispatcher'
import { setSharedShellPath } from '../../src/mms/harness/shellPath'
import type { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'
import type { RunEngine } from '../../src/mms/run/RunEngine'
import type { BotTurnPayload } from '../../src/mms/run/types'

let home: string
let main: MousseMainService

beforeAll(async () => {
  home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-bot-final-message-'))
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
    rmSync(home, { recursive: true, force: true })
  }
})

type Chat = ClaudeSubscriptionProviderService['chat']

/**
 * Runs one bot dispatch whose runtime does `script`, through the profile's effect worker as any bot dispatch runs.
 * Returns what the dispatch settled with (the bot's reply) and the thread's reply rows.
 */
async function botTurn(script: (input: Parameters<Chat>[0], time: AbortController) => Promise<string>): Promise<{ settled: { text?: string; messageId?: string }; rows: string[]; ids: string[] }> {
  const thread = main.threads.createThread('Bot run')
  const scratch = mkdtempSync(join(home, 'scratch-'))
  const time = new AbortController()
  const settled: Array<{ text?: string; messageId?: string }> = []
  const dispatcher: BotTurnDispatcher = {
    prepare: (payload) => ({
      activationId: payload.activationId,
      dispatchN: payload.dispatchN,
      prompt: 'Report on this computer',
      selection: { instanceId: 'claude', model: 'opus' },
      policy: { approvals: 'grants', approve: 'host', tools: { allow: ['read', 'shell'] }, authority: { kind: 'bot', digest: 'd' } },
      authority: { time: { signal: time.signal }, appTools: new Set<string>(), check: () => ({ ok: true }) } as never,
      scratch,
      skills: [],
      history: 'none'
    }),
    settle: (_payload, outcome) => { settled.push(outcome) },
    ownerOf: () => undefined
  }
  main.orchestrator.setBotDispatcher(dispatcher)
  const chat = vi.spyOn(main.claudeSubscription, 'chat').mockImplementation((input) => script(input, time))
  const settleRun = vi.spyOn(main.personalBots!, 'settleRun')
  try {
    const runs = (main.orchestrator as unknown as { runEngine: RunEngine }).runEngine
    const sent = await runs.sendWithStart({ kind: 'send', threadId: thread.id, clientRequestId: `${thread.id}:d1`, source: 'bot' },
      (runId): BotTurnPayload => ({ kind: 'bot', runId, threadId: thread.id, activationId: 'act-1', dispatchN: 1 }))
    if (sent.status !== 'accepted') throw new Error('rejected')
    await vi.waitFor(() => {
      expect(settled).toHaveLength(1)
      expect(settleRun).toHaveBeenCalledWith(sent.runId)
    }, { timeout: 20_000 })
  } finally {
    settleRun.mockRestore()
    chat.mockRestore()
  }
  const replies = (main.threads.loadThreadData(thread.id).messages ?? []).filter((message) => message.role === 'assistant' && !message.kind)
  return { settled: settled[0]!, rows: replies.map((message) => message.content), ids: replies.map((message) => message.id) }
}

const NOTE = 'Bash ate the $ signs; using a heredoc.'
const REPORT = '**Computer name:** studio\n\nNothing was changed.'

/** Two notes, each before a call. */
function notesThenCalls(input: Parameters<Chat>[0]): string {
  input.onText('Checking the system.')
  input.onTool?.({ phase: 'start', callId: 'sh-1', title: 'Bash', toolName: 'Bash' })
  input.onTool?.({ phase: 'complete', callId: 'sh-1', title: 'Bash', toolName: 'Bash' })
  // Claude's frames put a blank line before each new text block, and say it is their own (`TurnFrames`).
  input.onTextSeparator?.('Checking the system.'.length, '\n\n')
  input.onText(`Checking the system.\n\n${NOTE}`)
  input.onTool?.({ phase: 'start', callId: 'sh-2', title: 'Bash', toolName: 'Bash' })
  input.onTool?.({ phase: 'complete', callId: 'sh-2', title: 'Bash', toolName: 'Bash' })
  input.onTextSeparator?.(`Checking the system.\n\n${NOTE}`.length, '\n\n')
  return `Checking the system.\n\n${NOTE}`
}

it('a bot turn with notes between its tool calls replies with its final message only', async () => {
  const { settled, rows, ids } = await botTurn(async (input) => {
    const whole = `${notesThenCalls(input)}\n\n${REPORT}`
    input.onText(whole)
    return whole
  })
  // It names the thread's row that holds it, so the bot's journal keeps the reply once.
  expect(settled).toEqual({ text: REPORT, messageId: ids[2] })
  // The notes stay in the bot's thread, each in a row of its own above its call.
  expect(rows).toEqual(['Checking the system.', NOTE, REPORT])
}, 60_000)

it('work cut because it ran out of room hands back the reply it was writing, not its earlier notes', async () => {
  const { settled } = await botTurn(async (input, time) => {
    const whole = `${notesThenCalls(input)}\n\nSo far: the computer is called studio.`
    input.onText(whole)
    time.abort(new BotRoomAbort())
    return whole
  })
  expect(settled).toEqual({ text: 'So far: the computer is called studio.' })
}, 60_000)
