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

  const response = await mms.orchestrator.send(message)

  writeOutput(
    globals.mode,
    globals.mode === 'json'
      ? { message: response.message, actions: response.actions }
      : response.message,
    (data: unknown) => String(data)
  )

  await mms.stop()
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
