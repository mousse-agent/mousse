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

/** A new top-level assistant message starts (what Claude Code sends when it begins reading a steer). */
export const messageStart = (uuid?: string): Frame => ({
  type: 'stream_event',
  session_id: SESSION,
  parent_tool_use_id: null,
  ...(uuid ? { user_message_uuid: uuid, user_message_uuids: [uuid] } : {}),
  event: { type: 'message_start', message: { id: `msg-${uuid ?? 'next'}`, type: 'message', role: 'assistant', content: [] } }
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

/** Claude Code's word on a pushed message: `started` when a turn takes it (the model reads it). */
export const lifecycle = (uuid: string, state: 'queued' | 'started' | 'completed' | 'cancelled'): Frame => ({
  type: 'command_lifecycle',
  command_uuid: uuid,
  state,
  uuid: `lifecycle-${uuid}-${state}`,
  session_id: SESSION
})

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
  /** The options of each `interrupt()` call. */
  readonly interruptOptions: Array<{ cancelQueued?: boolean } | undefined> = []
  stoppedTasks: string[] = []
  /** The ids `cancelAsyncMessage` was asked to drop, in order. */
  readonly cancelAsyncCalls: string[] = []
  /** Whether the process has `cancelAsyncMessage` (an older Claude Code has no per-message cancel). */
  cancelAsync = true
  /** The roster's tasks that have not ended: `local_agent` or `local_bash` by id. */
  private readonly liveTasks = new Map<string, string>()
  /**
   * Whether `interrupt()` returns a receipt (a current Claude Code). With `false` it resolves to
   * undefined, like an older one that cannot say what it cancelled.
   */
  receipts = true
  /**
   * A Claude Code that sends interrupt receipts but predates `interrupt_cancel_queued_v1`: it ignores `cancelQueued`,
   * answers like a plain interrupt (`still_queued`, no `cancelled`), and then (spike S1) starts what is still queued at
   * once as a new turn, unless its process was closed first. What it started that way is in `ranAfterInterrupt`.
   */
  ignoresCancelQueued = false
  /** The ids an interrupt left queued that the process then ran as turns of their own (`ignoresCancelQueued`). */
  readonly ranAfterInterrupt: string[] = []
  /**
   * Like the real Claude Code, the process keeps running for a while after its input closes (the SDK's close only ends
   * its stdin and signals it seconds later): the turn it runs goes on, and when that turn's result is written it starts
   * what is still queued as turns of their own (`ranAfterClose`). Only a signal (`signals`) ends it.
   */
  lingersAfterClose = false
  /** The ids the process ran after its input closed (`lingersAfterClose`). */
  readonly ranAfterClose: string[] = []
  /** The pid its process transport shows, as the Agent SDK's does; without one the query has no transport. */
  pid: number | undefined
  /** The signals sent through the process transport's handle, in order. */
  readonly signals: string[] = []
  /** While set, `setPermissionMode` and `backgroundTasks` wait for it. */
  permissionGate: Promise<unknown> | undefined
  /** While set, `interrupt()` waits for it before it answers (a slow receipt). */
  interruptGate: Promise<unknown> | undefined
  /** While set, `cancelAsyncMessage` waits for it before it answers (a slow answer). */
  cancelAsyncGate: Promise<unknown> | undefined
  /**
   * Like the real Claude Code when its queue gave a message up a moment before the cancel came: `cancelAsyncMessage`
   * answers false for a message still queued, yet the message never runs (the turn that took it drops it as it starts).
   * `'lifecycle'` then says so with a `cancelled` lifecycle; `'silent'` says nothing at all, ever (the worst case).
   */
  cancelAsyncTakenThenDropped: 'silent' | 'lifecycle' | undefined
  backgroundGate: Promise<unknown> | undefined
  private readonly started = new Set<string>()
  private readonly cancelled = new Set<string>()
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
    if (!this.lingersAfterClose) this.end()
  }

  /** The text of the n-th message the process read. */
  text(index: number): string {
    const content = this.inputs[index]?.message.content
    return typeof content === 'string' ? content : JSON.stringify(content)
  }

  uuid(index: number): string {
    return String(this.inputs[index]?.uuid)
  }

  emit(...emitted: Frame[]): void {
    // Like the real process: a session resumed into a fork writes its frames under the fork's id.
    const branch = this.options.forkSession && this.options.sessionId
    const frames = branch ? emitted.map((frame) => (frame.session_id === SESSION ? { ...frame, session_id: branch } : frame)) : emitted
    for (const frame of frames) {
      if (this.ended) return
      this.trackTasks(frame)
      const stamped = frame.user_message_uuids
      if (Array.isArray(stamped)) for (const id of stamped) this.started.add(String(id))
      if (frame.type === 'command_lifecycle' && frame.state === 'started') this.started.add(String(frame.command_uuid))
      if (this.waiting) {
        const resolve = this.waiting
        this.waiting = undefined
        resolve({ value: frame as unknown as SDKMessage, done: false })
      } else this.frames.push(frame)
      // A turn ended while the process lingers with its input closed: it starts what is still queued.
      if (frame.type === 'result' && this.lingersAfterClose && (this.closed || this.inputEnded))
        setTimeout(() => this.runQueued(this.ranAfterClose), 0)
    }
  }

  /** The tasks the roster lists that have not ended, by id, with their type. */
  private trackTasks(frame: Frame): void {
    if (frame.subtype === 'background_tasks_changed' && Array.isArray(frame.tasks)) {
      for (const task of frame.tasks as Array<{ task_id: string; task_type?: string; ambient?: boolean }>)
        if (!task.ambient) this.liveTasks.set(task.task_id, task.task_type ?? 'local_bash')
    } else if (frame.subtype === 'task_notification') this.liveTasks.delete(String(frame.task_id))
  }

  /**
   * A finished task: the process reports it and, as the real one does, starts a turn of its own for it
   * only when the test emits that turn's frames. Only shells and agents still running can finish.
   */
  finishTask(id: string, status = 'completed'): void {
    if (this.liveTasks.has(id)) this.emit(notification(id, status))
  }

  /** The process exits: the iterator ends. */
  end(): void {
    this.ended = true
    const resolve = this.waiting
    this.waiting = undefined
    resolve?.({ value: undefined, done: true })
  }

  /** A model turn that answers `uuid`: its text, then its result. */
  /**
   * A model turn that answers `uuid`. Like the real process, only the first stream frame of the turn
   * carries the id of the message it answers (and the result); later frames of the turn carry none.
   */
  answer(uuid: string, text: string, chunks: string[] = [text]): void {
    this.emit(
      ...chunks.map((chunk, index) => textDelta(chunk, index === 0 ? uuid : undefined)),
      resultFrame({ uuids: [uuid], text: chunks.join('') })
    )
  }

  /**
   * Messages Claude read together and answered in one turn: the first stream frame and the result both
   * name every one of them, in the order they were pushed.
   */
  answerBatch(uuids: string[], text: string): void {
    this.emit(textDelta(text, uuids[uuids.length - 1], { user_message_uuids: uuids }), resultFrame({ uuids, text }))
  }

  /** Each message still queued starts as a turn of its own and runs to its result, as after an interrupt (spike S1). */
  private runQueued(ran: string[] = this.ranAfterInterrupt): void {
    for (const id of this.queued) {
      if (this.ended) return
      ran.push(id)
      this.emit(lifecycle(id, 'started'))
      this.answer(id, 'ran after the interrupt')
    }
  }

  /** The process took this message into the turn it is running (folded in) without a frame naming it. */
  markStarted(uuid: string): void {
    this.started.add(uuid)
  }

  /** The uuids of messages the process read that no frame has named yet: still in its input queue. */
  get queued(): string[] {
    return this.inputs.map((message) => String(message.uuid)).filter((id) => !this.started.has(id) && !this.cancelled.has(id))
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
    // The SDK's process handle: a signal ends the process at once.
    const handle = {
      pid: this.pid,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: (signal: string = 'SIGTERM') => {
        this.signals.push(signal)
        handle.signalCode = signal
        this.end()
        return true
      }
    }
    return Object.assign(iterator, this.pid === undefined ? {} : { transport: { process: handle } }, {
      interrupt: async (options?: { cancelQueued?: boolean }) => {
        this.interrupts++
        this.interruptOptions.push(options)
        this.onInterrupt?.(this)
        await this.interruptGate
        // Like the real process: an interrupt stops the background agents (each reports `stopped`, and
        // no turn follows) and leaves shells running.
        for (const [id, type] of [...this.liveTasks]) if (type === 'local_agent') this.emit(notification(id, 'stopped'))
        if (!this.receipts) return undefined
        const queued = this.queued
        if (this.ignoresCancelQueued) {
          setTimeout(() => this.runQueued(), 0)
          return { still_queued: queued }
        }
        if (!options?.cancelQueued) return { still_queued: queued }
        for (const id of queued) this.cancelled.add(id)
        return { still_queued: [], cancelled: queued }
      },
      stopTask: async (taskId: string) => {
        this.stoppedTasks.push(taskId)
      },
      // Like the real process: a message still in the queue is dropped (true); one a turn already took is not (false).
      cancelAsyncMessage: async (uuid: string) => {
        if (!this.cancelAsync) throw new Error('cancel_async_message is not supported')
        this.cancelAsyncCalls.push(uuid)
        await this.cancelAsyncGate
        if (this.cancelAsyncTakenThenDropped && this.queued.includes(uuid)) {
          this.cancelled.add(uuid)
          if (this.cancelAsyncTakenThenDropped === 'lifecycle') setTimeout(() => this.emit(lifecycle(uuid, 'cancelled')), 0)
          return false
        }
        if (!this.queued.includes(uuid)) return false
        this.cancelled.add(uuid)
        return true
      },
      close: () => {
        this.closed = true
        if (!this.lingersAfterClose) this.end()
      },
      setPermissionMode: async (mode: string) => {
        await this.permissionGate
        this.permissionModes.push(mode)
      },
      backgroundTasks: async () => {
        this.backgrounded++
        await this.backgroundGate
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

  /** Each new process lingers after its input closes (`FakeClaudeProcess.lingersAfterClose`). */
  lingersAfterClose = false
  /** The pid each new process's transport shows (`FakeClaudeProcess.pid`); none by default. */
  pid: number | undefined

  readonly query = ({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }): Query => {
    const process = new FakeClaudeProcess(prompt, options, () => this.reply)
    process.lingersAfterClose = this.lingersAfterClose
    process.pid = this.pid
    this.processes.push(process)
    return process.asQuery()
  }

  get last(): FakeClaudeProcess {
    return this.processes[this.processes.length - 1]
  }
}
