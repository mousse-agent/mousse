import { createInterface } from 'readline'
import type { ParsedArgs } from '../parseArgs'
import { readStdinIfPiped } from '../parseArgs'
import { exitWithError, writeOutput } from '../output'
import { openMms, loadOrchestratorThread, resolveThreadId } from '../mmsContext'

export async function runChat(args: ParsedArgs): Promise<void> {
  const { globals, positional } = args
  const stdinText = await readStdinIfPiped()
  const messageParts = [...positional]
  if (stdinText) {
    messageParts.unshift(stdinText)
  }
  const message = messageParts.join(' ').trim()

  if (!message && !globals.print) {
    exitWithError('Provide a message or use -p/--print for non-interactive mode.', globals.mode)
  }
  if (!message) {
    exitWithError('No message provided.', globals.mode)
  }

  const { mms } = await openMms(globals)
  const threadId = await resolveThreadId(mms, globals)
  await loadOrchestratorThread(mms, threadId)

  const trimmed = message.trim()

  // Control commands (same names as Telegram/Discord/GUI)
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
    const steered = mms.orchestrator.steerActiveTurn(steerText)
    if (!steered) {
      // One-shot CLI has no concurrent turn; send as a normal follow-up message.
      writeOutput(
        globals.mode,
        globals.mode === 'json'
          ? {
              steered: false,
              message:
                'No active turn to steer. Sending as a normal message. Mid-run steer works in GUI and on Telegram/Discord.'
            }
          : 'No active turn to steer in this process — sending as a normal message.\n(Mid-run /steer works in the GUI and on Telegram/Discord.)',
        (data: unknown) => String(data)
      )
      const response = await runSendWithSigint(mms, steerText)
      writeOutput(
        globals.mode,
        globals.mode === 'json'
          ? { message: response.message, actions: response.actions }
          : response.message,
        (data: unknown) => String(data)
      )
      await mms.stop()
      return
    }
    writeOutput(
      globals.mode,
      globals.mode === 'json' ? { steered: true, text: steerText } : `Steered: ${steerText}`,
      (data: unknown) => String(data)
    )
    await mms.stop()
    return
  }

  const response = await runSendWithSigint(mms, message)

  writeOutput(
    globals.mode,
    globals.mode === 'json'
      ? { message: response.message, actions: response.actions }
      : response.message,
    (data: unknown) => String(data)
  )

  await mms.stop()
}

async function runSendWithSigint(
  mms: Awaited<ReturnType<typeof openMms>>['mms'],
  message: string
): Promise<{ message: string; actions: unknown[] }> {
  const onSigInt = (): void => {
    const stopped = mms.orchestrator.abortActiveTurn()
    if (stopped) {
      process.stderr.write('\nStop requested (Ctrl+C). Waiting for turn to abort…\n')
    }
  }
  process.on('SIGINT', onSigInt)
  try {
    return await mms.orchestrator.send(message)
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
