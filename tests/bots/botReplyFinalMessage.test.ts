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
import type { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'
import type { RunEngine } from '../../src/mms/run/RunEngine'
import type { BotTurnPayload } from '../../src/mms/run/types'

let home: string
let main: MousseMainService

beforeAll(async () => {
  home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-bot-final-message-'))
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await main.start()
  main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'opus' } })
})

afterAll(async () => {
  try { await main?.stop() }
  finally {
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
})

type Chat = ClaudeSubscriptionProviderService['chat']

/**
 * Runs one bot dispatch whose runtime does `script`, through the profile's effect worker as any bot dispatch runs.
 * Returns what the dispatch settled with (the bot's reply) and the thread's reply rows.
 */
async function botTurn(script: (input: Parameters<Chat>[0], time: AbortController) => Promise<string>): Promise<{ settled: { text?: string }; rows: string[] }> {
  const thread = main.threads.createThread('Bot run')
  const scratch = mkdtempSync(join(home, 'scratch-'))
  const time = new AbortController()
  const settled: Array<{ text?: string }> = []
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
  try {
    const runs = (main.orchestrator as unknown as { runEngine: RunEngine }).runEngine
    const sent = await runs.sendWithStart({ kind: 'send', threadId: thread.id, clientRequestId: `${thread.id}:d1`, source: 'bot' },
      (runId): BotTurnPayload => ({ kind: 'bot', runId, threadId: thread.id, activationId: 'act-1', dispatchN: 1 }))
    if (sent.status !== 'accepted') throw new Error('rejected')
    await vi.waitFor(() => expect(settled).toHaveLength(1), { timeout: 20_000 })
  } finally {
    chat.mockRestore()
  }
  const rows = (main.threads.loadThreadData(thread.id).messages ?? []).filter((message) => message.role === 'assistant' && !message.kind).map((message) => message.content)
  return { settled: settled[0]!, rows }
}

const NOTE = 'Bash ate the $ signs; using a heredoc.'
const REPORT = '**Computer name:** studio\n\nNothing was changed.'

/** Two notes, each before a call. */
function notesThenCalls(input: Parameters<Chat>[0]): string {
  input.onText('Checking the system.')
  input.onTool?.({ phase: 'start', callId: 'sh-1', title: 'Bash', toolName: 'Bash' })
  input.onTool?.({ phase: 'complete', callId: 'sh-1', title: 'Bash', toolName: 'Bash' })
  input.onText(`Checking the system.\n\n${NOTE}`)
  input.onTool?.({ phase: 'start', callId: 'sh-2', title: 'Bash', toolName: 'Bash' })
  input.onTool?.({ phase: 'complete', callId: 'sh-2', title: 'Bash', toolName: 'Bash' })
  return `Checking the system.\n\n${NOTE}`
}

it('a bot turn with notes between its tool calls replies with its final message only', async () => {
  const { settled, rows } = await botTurn(async (input) => {
    const whole = `${notesThenCalls(input)}\n\n${REPORT}`
    input.onText(whole)
    return whole
  })
  expect(settled).toEqual({ text: REPORT })
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
