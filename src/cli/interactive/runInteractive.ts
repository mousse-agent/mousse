/**
 * Interactive mousse-cli session.
 * Prefers a pi-tui Editor/TUI when available (via @earendil-works/pi-coding-agent's
 * pi-tui 0.80.7); falls back to a readline REPL with the same command semantics.
 */

import { createInterface } from 'readline'
import type { MousseMainService } from '../contract'
import type { OutputMode } from '../parseArgs'
import { writeOutput } from '../output'
import { loadOrchestratorThread } from '../mmsContext'
import { detectThreadRuntime } from '../../mms/channels/threadRuntime'
import {
  handleInteractiveSlash,
  type InteractiveCommandContext,
  type InteractiveSessionState,
  type SessionModel
} from './sessionCommands'
import { loadPiTui } from './piTui'
import {
  classifySigint,
  createSigintState,
  DEFAULT_SIGINT_EXIT_WINDOW_MS
} from './sigintSemantics'

export interface InteractiveChatOptions {
  mms: MousseMainService
  mode: OutputMode
  initialThreadId: string | null
  initialMessage?: string
}

interface QueuedMessage {
  content: string
  enqueuedAt: number
}

export async function runInteractiveChat(opts: InteractiveChatOptions): Promise<void> {
  const { mms, mode, initialThreadId } = opts

  if (initialThreadId) {
    await loadOrchestratorThread(mms, initialThreadId)
  } else {
    const active = mms.threads.getActiveThreadId()
    if (!active) {
      const thread = mms.threads.createThread('CLI session')
      mms.threads.setActiveThreadId(thread.id)
      mms.orchestrator.bindThread(thread.id, [], undefined, [])
    } else {
      await loadOrchestratorThread(mms, active)
    }
  }

  const state: InteractiveSessionState = {
    threadId: mms.threads.getActiveThreadId(),
    modelOverride: undefined
  }

  const runtime = detectThreadRuntime(mms.orchestrator)
  let turnActive = false
  let shuttingDown = false
  const fifo: QueuedMessage[] = []
  let drainChain: Promise<void> = Promise.resolve()

  let appendLine = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }

  const resolveControls = (): {
    isTurnActive: () => boolean
    abortTurn: () => boolean
    steerTurn: (text: string) => boolean
  } => {
    const threadId = state.threadId
    return {
      isTurnActive: () => {
        if (turnActive) return true
        if (threadId && runtime.isActive(threadId)) return true
        return mms.orchestrator.isTurnActive()
      },
      abortTurn: () => {
        let aborted = false
        if (mms.orchestrator.abortActiveTurn()) aborted = true
        if (threadId && runtime.abort(threadId)) aborted = true
        return aborted
      },
      steerTurn: (text: string) => {
        if (mms.orchestrator.steerActiveTurn(text, threadId ?? undefined)) return true
        if (threadId && runtime.steer(threadId, text)) return true
        // Cross-process: persist steer-intent for the lease owner instead of failing.
        if (threadId && typeof mms.orchestrator.steerThreadOrEnqueueExternal === 'function') {
          const result = mms.orchestrator.steerThreadOrEnqueueExternal(threadId, text, {
            source: 'cli'
          })
          if (result.steered || result.queued) return true
        }
        return false
      }
    }
  }

  const buildCtx = (): InteractiveCommandContext => {
    const controls = resolveControls()
    return {
      state,
      listThreads: () =>
        mms.threads.listAllThreads().map((t) => ({ id: t.id, name: t.name })),
      listModels: () => mms.providerAuth.getConfiguredLlmProviders(),
      getGlobalModel: () => {
        const p = mms.settings.get().provider
        return { llmProvider: p.llmProvider, model: p.model }
      },
      setGlobalModel: (model: SessionModel) => {
        mms.settings.set({
          provider: { llmProvider: model.llmProvider, model: model.model }
        })
      },
      isTurnActive: controls.isTurnActive,
      abortTurn: controls.abortTurn,
      steerTurn: controls.steerTurn,
      bindThread: (threadId: string) => {
        const data = mms.threads.loadThreadData(threadId)
        mms.orchestrator.bindThread(
          threadId,
          data.messages,
          data.llmContext,
          data.messageQueue
        )
        mms.threads.setActiveThreadId(threadId)
        state.threadId = threadId
      },
      setModelOverride: (override) => {
        state.modelOverride = override
        if (override) {
          mms.settings.set({
            provider: { llmProvider: override.llmProvider, model: override.model }
          })
        }
      }
    }
  }

  const applyModelOverrideIfNeeded = (): void => {
    if (!state.modelOverride) return
    mms.settings.set({
      provider: {
        llmProvider: state.modelOverride.llmProvider,
        model: state.modelOverride.model
      }
    })
  }

  const runOneTurn = async (content: string): Promise<void> => {
    applyModelOverrideIfNeeded()
    turnActive = true
    try {
      if (
        runtime.hasMmsQueue &&
        runtime.enqueue &&
        state.threadId &&
        runtime.isActive(state.threadId)
      ) {
        await runtime.enqueue(state.threadId, content)
        appendLine('(queued in MMS thread queue)')
        return
      }

      const response = await mms.orchestrator.send(content, false, {
        threadId: state.threadId ?? undefined,
        source: 'cli'
      })
      if (mode === 'json') {
        writeOutput(mode, { message: response.message, actions: response.actions }, (d) =>
          String(d)
        )
      } else {
        appendLine('')
        appendLine(response.message || '(empty response)')
        appendLine('')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      appendLine(`Error: ${message}`)
    } finally {
      turnActive = false
    }
  }

  const enqueueOrRun = (content: string): void => {
    const trimmed = content.trim()
    if (!trimmed) return

    if (resolveControls().isTurnActive() || fifo.length > 0) {
      if (runtime.hasMmsQueue && runtime.enqueue && state.threadId) {
        void Promise.resolve(runtime.enqueue(state.threadId, trimmed)).then(() => {
          appendLine('(stacked — MMS queue)')
        })
        return
      }
      fifo.push({ content: trimmed, enqueuedAt: Date.now() })
      appendLine(`(stacked — position ${fifo.length})`)
      return
    }

    drainChain = drainChain
      .then(async () => {
        await runOneTurn(trimmed)
        while (fifo.length > 0 && !shuttingDown) {
          const next = fifo.shift()!
          await runOneTurn(next.content)
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        appendLine(`Error: ${message}`)
      })
  }

  const handleLine = (line: string): boolean => {
    const trimmed = line.trim()
    if (!trimmed) return false

    if (trimmed.startsWith('/')) {
      const result = handleInteractiveSlash(trimmed, buildCtx())
      if (result.reply) appendLine(result.reply)
      return Boolean(result.exit)
    }

    appendLine(`you> ${trimmed}`)
    enqueueOrRun(trimmed)
    return false
  }

  const banner = buildBanner(state, mms)
  /** Exit / full teardown only — never call on first Ctrl+C stop. */
  const onExit = (): void => {
    shuttingDown = true
    resolveControls().abortTurn()
  }
  /** First Ctrl+C: stop active turn only; session remains usable. */
  const onStopTurn = (): void => {
    resolveControls().abortTurn()
  }

  const piTui = process.stdin.isTTY && process.stdout.isTTY ? await loadPiTui() : null

  if (piTui) {
    await runWithPiTui(piTui, {
      handleLine,
      setAppendLine: (fn) => {
        appendLine = fn
      },
      initialMessage: opts.initialMessage,
      banner,
      waitDrain: () => drainChain,
      onStopTurn,
      onExit
    })
  } else {
    await runWithReadline({
      handleLine,
      appendLine: (line) => appendLine(line),
      initialMessage: opts.initialMessage,
      banner,
      waitDrain: () => drainChain,
      onStopTurn,
      onExit
    })
  }

  await drainChain
  await mms.stop()
}

function buildBanner(state: InteractiveSessionState, mms: MousseMainService): string {
  const threadId = state.threadId
  const short = threadId ? threadId.slice(0, 8) : '(none)'
  const provider = mms.settings.get().provider
  return [
    'mousse-cli interactive (pi-style)',
    `thread: ${short}  model: ${provider.llmProvider}/${provider.model}`,
    'Type a message, or /help. Ctrl+C once to stop a turn; twice or /exit to quit.'
  ].join('\n')
}

interface LoopHooks {
  handleLine: (line: string) => boolean
  initialMessage?: string
  banner: string
  waitDrain: () => Promise<void>
  /** First Ctrl+C — stop turn only. */
  onStopTurn: () => void
  /** Second Ctrl+C within window / /exit — leave the session. */
  onExit: () => void
}

async function runWithPiTui(
  pi: NonNullable<Awaited<ReturnType<typeof loadPiTui>>>,
  hooks: LoopHooks & { setAppendLine: (fn: (line: string) => void) => void }
): Promise<void> {
  const identity = (s: string): string => s
  const theme = {
    borderColor: identity,
    selectList: {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity
    }
  }

  const terminal = new pi.ProcessTerminal()
  const tui = new pi.TUI(terminal)

  const transcriptLines: string[] = []
  const transcript = new pi.Text('')
  tui.addChild(transcript)

  const pushTranscript = (line: string): void => {
    for (const part of line.split('\n')) {
      transcriptLines.push(part)
    }
    while (transcriptLines.length > 400) transcriptLines.shift()
    transcript.setText(transcriptLines.join('\n'))
    tui.requestRender()
  }

  hooks.setAppendLine(pushTranscript)

  const editor = new pi.Editor(tui, theme)
  tui.addChild(editor)
  tui.setFocus(editor)

  let exitResolve: (() => void) | undefined
  const done = new Promise<void>((resolve) => {
    exitResolve = resolve
  })

  const sigintState = createSigintState()

  const shutdown = async (): Promise<void> => {
    hooks.onExit()
    try {
      tui.stop()
    } catch {
      // ignore
    }
    exitResolve?.()
  }

  editor.onSubmit = (text: string) => {
    const shouldExit = hooks.handleLine(text)
    if (shouldExit) void shutdown()
  }

  tui.addInputListener((data) => {
    if (pi.matchesKey(data, 'ctrl+c')) {
      const action = classifySigint(sigintState, Date.now(), DEFAULT_SIGINT_EXIT_WINDOW_MS)
      if (action === 'exit') {
        void shutdown()
        return { consume: true }
      }
      pushTranscript('^C — stop requested (Ctrl+C again to exit)')
      // Stop the active turn only — do not permanently set shutdown on first press.
      hooks.onStopTurn()
      return { consume: true }
    }
    return undefined
  })

  tui.start()
  pushTranscript(hooks.banner)

  if (hooks.initialMessage?.trim()) {
    const shouldExit = hooks.handleLine(hooks.initialMessage)
    if (shouldExit) await shutdown()
  }

  await done
  await hooks.waitDrain()
}

async function runWithReadline(
  hooks: LoopHooks & { appendLine: (line: string) => void }
): Promise<void> {
  hooks.appendLine(hooks.banner)

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY)
  })

  const sigintState = createSigintState()
  const onSigInt = (): void => {
    const action = classifySigint(sigintState, Date.now(), DEFAULT_SIGINT_EXIT_WINDOW_MS)
    if (action === 'exit') {
      hooks.onExit()
      rl.close()
      return
    }
    hooks.appendLine('^C — stop requested (Ctrl+C again to exit)')
    // First Ctrl+C: abort turn only; session remains usable.
    hooks.onStopTurn()
    rl.prompt()
  }
  process.on('SIGINT', onSigInt)

  if (hooks.initialMessage?.trim()) {
    const shouldExit = hooks.handleLine(hooks.initialMessage)
    if (shouldExit) {
      process.off('SIGINT', onSigInt)
      rl.close()
      await hooks.waitDrain()
      return
    }
  }

  await new Promise<void>((resolve) => {
    rl.setPrompt('mousse> ')
    rl.prompt()
    rl.on('line', (line) => {
      const shouldExit = hooks.handleLine(line)
      if (shouldExit) {
        rl.close()
        return
      }
      rl.prompt()
    })
    rl.on('close', () => {
      process.off('SIGINT', onSigInt)
      hooks.onExit()
      resolve()
    })
  })

  await hooks.waitDrain()
}
