/**
 * Interactive CLI chat over the daemon protocol only (no embedded MMS).
 * readline loop: send, stream events, /usage, /stop, /steer, /threads, /exit.
 */

import { createInterface } from 'readline'
import type { OutputMode } from '../parseArgs'
import type { DaemonClient } from '../daemonClient'
import type { ContextUsageSnapshot } from '../../shared/types'
import {
  handleInteractiveSlash,
  type InteractiveCommandContext,
  type InteractiveSessionState,
  type SessionModel
} from './sessionCommands'
import {
  classifySigint,
  createSigintState,
  DEFAULT_SIGINT_EXIT_WINDOW_MS
} from './sigintSemantics'
import { canUsePiTui, loadPiTui } from './piTui'

export interface InteractiveChatOptions {
  client: DaemonClient
  mode: OutputMode
  initialThreadId: string | null
  initialMessage?: string
}

export async function runInteractiveChat(opts: InteractiveChatOptions): Promise<void> {
  const { client, initialThreadId, initialMessage } = opts
  let threadId = initialThreadId

  if (!threadId) {
    const list = await client.request<{ threads: { id: string; settledAt?: string }[] }>(
      'threads.list'
    )
    threadId = list.threads.find((t) => !t.settledAt)?.id ?? null
  }
  if (!threadId) {
    const created = await client.request<{ thread: { id: string } }>('threads.create', {
      name: 'CLI session'
    })
    threadId = created.thread.id
  }

  await client.request('thread.snapshot', { threadId })
  await client.client.subscribe(0).catch(() => undefined)

  const state: InteractiveSessionState = {
    threadId,
    modelOverride: undefined
  }

  let turnActive = false
  let shuttingDown = false
  const fifo: string[] = []
  let drainChain: Promise<void> = Promise.resolve()

  let tuiWriteLine: ((line: string) => void) | null = null
  const writeLine = (line: string): void => {
    if (tuiWriteLine) tuiWriteLine(line)
    else process.stdout.write(`${line}\n`)
  }

  // Stream protocol events for this thread.
  const unsub = client.client.onEvent((ev) => {
    if (ev.threadId && ev.threadId !== state.threadId) return
    if (ev.type === 'thread.message') {
      const msg = (ev.data as { message?: { role?: string; content?: string } })?.message
      if (msg?.content) {
        const role = msg.role ?? 'assistant'
        writeLine(role === 'user' ? `you> ${msg.content}` : msg.content)
      }
    }
    if (ev.type === 'turn.started') turnActive = true
    if (
      ev.type === 'turn.completed' ||
      ev.type === 'turn.interrupted' ||
      ev.type === 'turn.aborted'
    ) {
      turnActive = false
    }
  })

  const refreshTurn = async (): Promise<boolean> => {
    if (!state.threadId) return false
    try {
      const snap = await client.request<{
        activeTurn?: { active?: boolean; running?: boolean }
      }>('thread.snapshot', { threadId: state.threadId })
      const active = Boolean(snap.activeTurn?.active || snap.activeTurn?.running)
      turnActive = active
      return active
    } catch {
      return turnActive
    }
  }

  const listThreads = async (): Promise<Array<{ id: string; name?: string }>> => {
    const res = await client.request<{ threads: { id: string; name?: string }[] }>(
      'threads.list'
    )
    return res.threads
  }

  const listModels = async (): Promise<
    Array<{ id: string; label: string; models: Array<{ id: string; label: string }> }>
  > => {
    const res = await client.request<{
      options: {
        llmProviders: Array<{
          id: string
          label: string
          models: Array<{ id: string; label: string }>
        }>
      }
    }>('settings.getOptions')
    return res.options.llmProviders
  }

  // sessionCommands is sync; keep a small cache refreshed before slash handling.
  let threadCache: Array<{ id: string; name?: string }> = []
  let modelCache: Awaited<ReturnType<typeof listModels>> = []
  let contextUsage: ContextUsageSnapshot | null = null
  let globalModel: SessionModel = { llmProvider: 'mock', model: 'mock' }

  const refreshCaches = async (): Promise<void> => {
    threadCache = await listThreads()
    modelCache = await listModels()
    try {
      const s = await client.request<{
        settings: { provider: { llmProvider: string; model: string } }
      }>('settings.get')
      globalModel = {
        llmProvider: s.settings.provider.llmProvider,
        model: s.settings.provider.model
      }
    } catch {
      /* keep prior */
    }
    try {
      contextUsage = state.threadId
        ? await client.request<ContextUsageSnapshot>('orchestrator.contextUsage', {
            threadId: state.threadId
          })
        : null
    } catch {
      contextUsage = null
    }
    await refreshTurn()
  }

  const buildCtx = (): InteractiveCommandContext => ({
    state,
    listThreads: () => threadCache,
    listModels: () => modelCache,
    getGlobalModel: () => globalModel,
    getContextUsage: () => contextUsage,
    setGlobalModel: (model: SessionModel) => {
      globalModel = model
      void client.request('settings.set', {
        partial: { provider: { llmProvider: model.llmProvider, model: model.model } }
      })
    },
    isTurnActive: () => turnActive,
    abortTurn: () => {
      if (!state.threadId) return false
      void client.request('orchestrator.abort', { threadId: state.threadId })
      turnActive = false
      return true
    },
    steerTurn: (text: string) => {
      if (!state.threadId) return false
      void client.request('orchestrator.steer', {
        threadId: state.threadId,
        text,
        source: 'cli'
      })
      return true
    },
    bindThread: (id: string) => {
      state.threadId = id
      void client.request('thread.snapshot', { threadId: id })
    },
    setModelOverride: (override) => {
      state.modelOverride = override
      if (override) {
        void client.request('settings.set', {
          partial: {
            provider: { llmProvider: override.llmProvider, model: override.model }
          }
        })
      }
    }
  })

  const sendMessage = async (content: string): Promise<void> => {
    if (!state.threadId) return
    if (await refreshTurn()) {
      fifo.push(content)
      writeLine(`(queued) ${content}`)
      return
    }
    turnActive = true
    try {
      const res = await client.request<{ message?: string; queued?: boolean }>(
        'orchestrator.send',
        {
          threadId: state.threadId,
          content,
          source: 'cli'
        }
      )
      if (res.queued) {
        writeLine(`(queued for ${state.threadId.slice(0, 8)}) ${content}`)
      } else if (res.message) {
        writeLine(res.message)
      }
    } catch (err) {
      writeLine(`Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      turnActive = false
      if (fifo.length > 0) {
        const next = fifo.shift()!
        drainChain = drainChain.then(() => sendMessage(next))
      }
    }
  }

  await refreshCaches()

  let closeUi = (): void => undefined
  let resolveDone: (() => void) | null = null
  const done = new Promise<void>((resolve) => { resolveDone = resolve })

  const handleLine = async (line: string): Promise<void> => {
    const text = line.trim()
    if (!text) return
    if (text.startsWith('/')) {
      await refreshCaches()
      const result = handleInteractiveSlash(text, buildCtx())
      if (result.reply) writeLine(result.reply)
      if (result.exit) {
        shuttingDown = true
        closeUi()
        resolveDone?.()
        return
      }
      if (text.startsWith('/stop') && state.threadId) {
        await client.request('orchestrator.abort', { threadId: state.threadId })
      } else if (text.startsWith('/steer ')) {
        const steerText = text.replace(/^\/steer\s*/, '').trim()
        if (state.threadId && steerText) {
          await client.request('orchestrator.steer', { threadId: state.threadId, text: steerText, source: 'cli' })
        }
      } else if ((text.startsWith('/thread') || text.startsWith('/threads')) && text.split(/\s+/).length > 1 && state.threadId) {
        await client.request('thread.snapshot', { threadId: state.threadId })
      }
      return
    }
    await sendMessage(text)
  }

  const pi = canUsePiTui() ? await loadPiTui() : null
  if (pi) {
    const tui = new pi.TUI(new pi.ProcessTerminal())
    const transcript = new pi.Container()
    const editor = new pi.Editor(tui, {
      borderColor: (s) => `\x1b[38;5;39m${s}\x1b[0m`,
      selectList: {
        selectedPrefix: (s) => `\x1b[36m${s}\x1b[0m`, selectedText: (s) => `\x1b[1m${s}\x1b[0m`,
        description: (s) => `\x1b[2m${s}\x1b[0m`, scrollInfo: (s) => `\x1b[2m${s}\x1b[0m`, noMatch: (s) => s
      }
    })
    tui.addChild(transcript)
    tui.addChild(new pi.Spacer(1))
    tui.addChild(editor)
    tuiWriteLine = (line) => {
      transcript.addChild(new pi.Text(line, 1, 0))
      tui.requestRender()
    }
    editor.onSubmit = (text) => { editor.setText(''); void handleLine(text) }
    tui.addInputListener((data) => {
      if (pi.matchesKey(data, 'ctrl+c')) {
        onSigInt()
        return { consume: true }
      }
      return undefined
    })
    tui.setFocus(editor)
    closeUi = () => tui.stop()
    tui.start()
  } else {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY)
    })
    closeUi = () => rl.close()
    const prompt = (): void => {
      if (shuttingDown) return
      rl.question('> ', (line) => { void handleLine(line).finally(prompt) })
    }
    rl.on('close', () => resolveDone?.())
    prompt()
  }

  if (initialMessage?.trim()) await handleLine(initialMessage.trim())
  writeLine(`Mousse — thread ${state.threadId?.slice(0, 8)}  /help for commands  Ctrl+C stops; twice exits`)

  const sigint = createSigintState()
  function onSigInt(): void {
    if (classifySigint(sigint) === 'exit') {
      shuttingDown = true
      closeUi()
      resolveDone?.()
    } else if (state.threadId) {
      void client.request('orchestrator.abort', { threadId: state.threadId }).then(() => writeLine('Stop requested.'))
    }
  }
  process.on('SIGINT', onSigInt)
  await done
  process.off('SIGINT', onSigInt)
  unsub()
  closeUi()
}
