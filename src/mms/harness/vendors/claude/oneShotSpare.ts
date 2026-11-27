import { createHash } from 'node:crypto'
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { OneShotTask } from '../../driver'

/**
 * A Claude Code process started ahead for a naming one-shot (a thread's title and branch name), so the request does not
 * wait for a process to start: about a second on Windows, more on a cold disk. The process is started with its input
 * open (the Agent SDK's streaming input) and waits; the request pushes its one message, reads the answer, and the
 * process is closed. A Send or New Thread request can leave a spare, and one left waiting is closed after
 * `ONE_SHOT_SPARE_IDLE_MS`. A process answers one request only, so no request sees another's text.
 */

/** How long a process started ahead waits for a request before it is closed. */
export const ONE_SHOT_SPARE_IDLE_MS = 10 * 60_000

/**
 * The system prompt of a naming one-shot's process. The request's own instructions come with its message, so a process
 * started before anyone knew the request can answer any naming request on its model.
 */
export const ONE_SHOT_SPARE_SYSTEM = 'You answer exactly one request. Follow the instructions that come with it. You have no tools.'

/**
 * Set on every single request's Claude Code process, over the user's own variables: no retry of a 429 or a 5xx, and no
 * second, non-streaming request after a failed stream. Counted at a stub (`claudeOneShotCount.test.ts`): 11 requests
 * on a 429 or a 503 without them, 1 with them.
 */
export const ONE_SHOT_SINGLE_REQUEST_ENV = Object.freeze({ CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1' })

/** The one-shots a process is started ahead for: titles and branch names, asked for at every new thread. */
export function oneShotUsesSpare(task: OneShotTask | undefined): boolean {
  return task === 'title' || task === 'branch_name'
}

/** A naming request's message: its instructions, then the request. */
export function oneShotSpareMessage(system: string, prompt: string): string {
  return `${system}\n\n${prompt}`
}

/**
 * What a one-shot's process is started with, as one digest: model, effort, environment, account (`account`) and every
 * other option a process cannot change once started. Its folder is not part of it: each process has a place of its own. A process started ahead answers only a request whose
 * launch and account have the same digest; anything else changed (the title model, the account, the launch settings)
 * starts anew.
 */
export function oneShotLaunchKey(options: Options, account: string | null = null): string {
  const { abortController: _abort, canUseTool: _tools, stderr: _stderr, cwd: _cwd, spawnClaudeCodeProcess: _spawn, ...rest } = options
  return createHash('sha256').update(JSON.stringify({ ...rest, account })).digest('hex')
}

/** The input of a process started ahead: it waits for the request's one message, then stays open until `end`. */
export class OneShotInput implements AsyncIterable<SDKUserMessage> {
  private message: SDKUserMessage | undefined
  private ended = false
  /** The process read the request's message: it may have sent it, so nothing sends it again (the handoff fence). */
  taken = false
  private wake: (() => void) | undefined

  push(text: string): void {
    this.message = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' }
    this.wake?.()
  }

  end(): void {
    this.ended = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.message && !this.ended) await new Promise<void>((resolve) => { this.wake = resolve })
    if (this.ended) return
    this.taken = true
    yield this.message!
    // Open until the answer is read: Claude Code ends its session when its input ends.
    while (!this.ended) await new Promise<void>((resolve) => { this.wake = resolve })
  }
}

export interface OneShotSpare {
  key: string
  /** The account and launch it was started under (`ClaudeSubscriptionProviderService.oneShotGeneration`). */
  generation: number
  input: OneShotInput
  controller: AbortController
  /** The query, once the SDK started it; rejects when it could not be. */
  query: Promise<Query>
  close: (reason?: unknown) => void
  timer: ReturnType<typeof setTimeout>
}
