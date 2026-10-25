import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * A stand-in for the Claude Code process at the Agent SDK's `query()` seam (issue #142). It is a
 * live peer, not a script: it reads the prompt stream the way the real process reads its stdin,
 * records every message, and writes whatever frames a test emits. One `FakeClaudeProcess` per
 * `query()` call; `processes` shows how many Claude processes a scenario started.
 */

export type Frame = Record<string, unknown>
type Handler = (message: SDKUserMessage, process: FakeClaudeProcess) => void

export const SESSION = 'vendor-session'

export const textDelta = (text: string, uuid?: string, extra: Frame = {}): Frame => ({
  type: 'stream_event',
  session_id: SESSION,
  parent_tool_use_id: null,
  ...(uuid ? { user_message_uuid: uuid, user_message_uuids: [uuid] } : {}),
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  ...extra
})

export const toolStart = (id: string, name: string, uuid?: string): Frame => ({
  type: 'stream_event',
  session_id: SESSION,
  parent_tool_use_id: null,
  ...(uuid ? { user_message_uuid: uuid, user_message_uuids: [uuid] } : {}),
  event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name } }
})

export const toolResult = (id: string): Frame => ({
  type: 'user',
  session_id: SESSION,
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }
})

export function resultFrame(options: { uuids?: string[]; text?: string; origin?: 'task-notification'; numTurns?: number; terminalReason?: string; queued?: number; error?: string } = {}): Frame {
  const uuids = options.uuids ?? []
  return {
    type: 'result',
    subtype: options.error ? 'error_during_execution' : 'success',
    is_error: Boolean(options.error),
    ...(options.error ? { errors: [options.error] } : { result: options.text ?? 'done' }),
    session_id: SESSION,
    num_turns: options.numTurns ?? 1,
    ...(uuids.length ? { user_message_uuid: uuids[uuids.length - 1], user_message_uuids: uuids } : {}),
    ...(options.origin ? { origin: { kind: options.origin } } : {}),
    ...(options.terminalReason ? { terminal_reason: options.terminalReason } : {}),
    ...(options.queued !== undefined ? { queued_turn_count: options.queued } : {})
  }
}

export const roster = (...tasks: Array<{ id: string; type?: string; ambient?: boolean }>): Frame => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  session_id: SESSION,
  tasks: tasks.map((task) => ({ task_id: task.id, task_type: task.type ?? 'local_bash', description: `task ${task.id}`, ...(task.ambient ? { ambient: true } : {}) }))
})

export const notification = (id: string, status = 'completed'): Frame => ({
  type: 'system',
  subtype: 'task_notification',
  session_id: SESSION,
  task_id: id,
  status,
  summary: `task ${id} ${status}`,
  output_file: ''
})

export class FakeClaudeProcess {
  /** Every message read from the prompt stream, in order. */
  readonly inputs: SDKUserMessage[] = []
  readonly permissionModes: string[] = []
  interrupts = 0
  backgrounded = 0
  closed = false
  /** The prompt stream ended (the real process would exit and take its background work with it). */
  inputEnded = false
  /**
   * Reaction to each message read: a function, null for silence, or undefined to follow the CLI's
   * `reply` (read on every message, so a test can change it between turns).
   */
  onInput: Handler | null | undefined
  /** Reaction to `interrupt()`. */
  onInterrupt: ((process: FakeClaudeProcess) => void) | undefined
  private readonly frames: Frame[] = []
  private waiting: ((result: IteratorResult<SDKMessage>) => void) | undefined
  private ended = false

  constructor(
    readonly prompt: string | AsyncIterable<SDKUserMessage>,
    readonly options: Options,
    private readonly reply: () => Handler | undefined
  ) {
    if (typeof prompt !== 'string') void this.readPrompt(prompt)
  }

  private async readPrompt(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const message of prompt) {
      this.inputs.push(message)
      const handler = this.onInput === undefined ? this.reply() : this.onInput
      handler?.(message, this)
    }
    this.inputEnded = true
    // Like the real process: with its input closed it finishes what it was asked and exits.
    this.end()
  }

  /** The text of the n-th message the process read. */
  text(index: number): string {
    const content = this.inputs[index]?.message.content
    return typeof content === 'string' ? content : JSON.stringify(content)
  }

  uuid(index: number): string {
    return String(this.inputs[index]?.uuid)
  }

  emit(...frames: Frame[]): void {
    for (const frame of frames) {
      if (this.ended) return
      if (this.waiting) {
        const resolve = this.waiting
        this.waiting = undefined
        resolve({ value: frame as unknown as SDKMessage, done: false })
      } else this.frames.push(frame)
    }
  }

  /** The process exits: the iterator ends. */
  end(): void {
    this.ended = true
    const resolve = this.waiting
    this.waiting = undefined
    resolve?.({ value: undefined, done: true })
  }

  /** A model turn that answers `uuid`: its text, then its result. */
  answer(uuid: string, text: string): void {
    this.emit(textDelta(text, uuid), resultFrame({ uuids: [uuid], text }))
  }

  asQuery(): Query {
    const iterator: AsyncGenerator<SDKMessage> = {
      next: () => {
        const frame = this.frames.shift()
        if (frame) return Promise.resolve({ value: frame as unknown as SDKMessage, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
      return: async () => {
        this.end()
        return { value: undefined, done: true }
      },
      throw: async (error) => {
        this.end()
        throw error
      },
      [Symbol.asyncIterator]() {
        return this
      },
      [Symbol.asyncDispose]: async () => undefined
    } as AsyncGenerator<SDKMessage>
    return Object.assign(iterator, {
      interrupt: async () => {
        this.interrupts++
        this.onInterrupt?.(this)
      },
      close: () => {
        this.closed = true
        this.end()
      },
      setPermissionMode: async (mode: string) => {
        this.permissionModes.push(mode)
      },
      backgroundTasks: async () => {
        this.backgrounded++
        return true
      },
      supportedModels: async () => []
    }) as unknown as Query
  }
}

/** Starts a `FakeClaudeProcess` per `query()` call. */
export class FakeClaudeCli {
  readonly processes: FakeClaudeProcess[] = []
  /** What every new process does with each message it reads, unless a test replaces it on that process. */
  reply: Handler | undefined = (message, process) => {
    if (message.priority === 'now') return
    process.answer(String(message.uuid), `reply to ${process.inputs.length}`)
  }

  readonly query = ({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }): Query => {
    const process = new FakeClaudeProcess(prompt, options, () => this.reply)
    this.processes.push(process)
    return process.asQuery()
  }

  get last(): FakeClaudeProcess {
    return this.processes[this.processes.length - 1]
  }
}
