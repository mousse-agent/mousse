import { createInterface } from 'readline'
import type { ParsedArgs } from '../parseArgs'
import { readStdinIfPiped } from '../parseArgs'
import { exitWithError, writeOutput } from '../output'
import { openMms, loadOrchestratorThread, resolveThreadId } from '../mmsContext'
import { runInteractiveChat } from '../interactive/runInteractive'

export async function runChat(args: ParsedArgs): Promise<void> {
  const { globals, positional } = args
  const stdinText = await readStdinIfPiped()
  const messageParts = [...positional]
  if (stdinText) {
    messageParts.unshift(stdinText)
  }
  const message = messageParts.join(' ').trim()

  // Interactive mode: no -p/--print, TTY, and no forced one-shot message requirement
  // when launched with no message (or with a first message that seeds the session).
  const wantInteractive =
    !globals.print &&
    Boolean(process.stdin.isTTY) &&
    // Piped stdin without -p still treated as one-shot for automation safety
    !stdinText

  if (wantInteractive) {
    const { mms } = await openMms(globals)
    const threadId = await resolveThreadId(mms, globals)
    await runInteractiveChat({
      mms,
      mode: globals.mode,
      initialThreadId: threadId,
      initialMessage: message || undefined
    })
    return
  }

  if (!message && globals.print) {
    exitWithError('No message provided.', globals.mode)
  }
  if (!message) {
    exitWithError(
      'Provide a message, use -p/--print for non-interactive mode, or run on a TTY for interactive chat.',
      globals.mode
    )
  }

  const { mms } = await openMms(globals)
  const threadId = await resolveThreadId(mms, globals)
  await loadOrchestratorThread(mms, threadId)

  const trimmed = message.trim()

  if (trimmed === '/stop' || trimmed.startsWith('/stop ')) {
    const stopped = mms.orchestrator.abortActiveTurn()
    writeOutput(
      globals.mode,
      globals.mode === 'json'
        ? { stopped, message: stopped ? 'Stop requested.' : 'Nothing to stop.' }
        : stopped
          ? 'Stop requested.'
          : 'Nothing to stop — no in-flight turn in this process. During a run, press Ctrl+C to stop.',
      (data: unknown) => String(data)
    )
    await mms.stop()
    return
  }

  if (trimmed.startsWith('/steer ') || trimmed === '/steer') {
    const steerText = trimmed.replace(/^\/steer\s*/, '').trim()
    if (!steerText) {
      exitWithError('Usage: mousse-cli /steer <prompt>', globals.mode)
    }
    const targetThread = threadId ?? mms.threads.getActiveThreadId()
    let steered = mms.orchestrator.steerActiveTurn(steerText, targetThread ?? undefined)
    let queued = false
    if (!steered && targetThread) {
      const result = mms.orchestrator.steerThreadOrEnqueueExternal(targetThread, steerText, {
        source: 'cli'
      })
      steered = result.steered
      queued = result.queued
    }
    if (!steered && !queued) {
      writeOutput(
        globals.mode,
        globals.mode === 'json'
          ? {
              steered: false,
              queued: false,
              threadId: targetThread,
              message:
                'No active turn to steer. Start a turn in GUI/CLI/channel, then /steer while it runs (cross-process steers are queued for the lease owner).'
            }
          : 'No active turn to steer.\nIf another MMS process owns the thread turn, /steer will queue a one-time steer-intent for that owner.',
        (data: unknown) => String(data)
      )
      await mms.stop()
      return
    }
    writeOutput(
      globals.mode,
      globals.mode === 'json'
        ? { steered, queued, text: steerText, threadId: targetThread }
        : queued
          ? `Steer queued for active owner (thread ${targetThread?.slice(0, 8) ?? '?'}): ${steerText}`
          : `Steered: ${steerText}`,
      (data: unknown) => String(data)
    )
    await mms.stop()
    return
  }

  const response = await runSendWithSigint(mms, message, threadId)

  writeOutput(
    globals.mode,
    globals.mode === 'json'
      ? {
          message: response.message,
          actions: response.actions,
          queued: response.queued,
          threadId: threadId ?? mms.threads.getActiveThreadId(),
          source: 'cli'
        }
      : response.queued
        ? `(queued for thread ${threadId?.slice(0, 8) ?? 'active'}) ${response.queueItem?.content ?? message}`
        : response.message,
    (data: unknown) => String(data)
  )

  await mms.stop()
}

async function runSendWithSigint(
  mms: Awaited<ReturnType<typeof openMms>>['mms'],
  message: string,
  threadId: string | null
): Promise<{
  message: string
  actions: unknown[]
  queued?: boolean
  queueItem?: { content: string }
}> {
  const onSigInt = (): void => {
    const stopped = mms.orchestrator.abortActiveTurn(threadId ?? undefined)
    if (stopped) {
      process.stderr.write('\nStop requested (Ctrl+C). Waiting for turn to abort…\n')
    }
  }
  process.on('SIGINT', onSigInt)
  try {
    return await mms.orchestrator.send(message, false, {
      threadId: threadId ?? undefined,
      source: 'cli'
    })
  } finally {
    process.off('SIGINT', onSigInt)
  }
}

export async function promptLine(question: string, secret = false): Promise<string> {
  if (!process.stdin.isTTY) {
    return ''
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(secret ? answer : answer.trim())
    })
  })
}

export async function promptSelect(
  message: string,
  options: Array<{ id: string; label: string }>
): Promise<string | null> {
  if (!process.stdin.isTTY) return null
  process.stderr.write(`${message}\n`)
  options.forEach((opt, index) => {
    process.stderr.write(`  ${index + 1}. ${opt.label} (${opt.id})\n`)
  })
  const answer = await promptLine('Choice: ')
  const index = Number(answer) - 1
  if (Number.isInteger(index) && index >= 0 && index < options.length) {
    return options[index].id
  }
  return options.find((opt) => opt.id === answer)?.id ?? null
}
