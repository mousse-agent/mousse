import type { ParsedArgs } from '../parseArgs'
import { isInteractiveStdin, readStdinIfPiped } from '../parseArgs'
import { exitWithError, writeOutput } from '../output'
import {
  closeMmsContext,
  loadOrchestratorThread,
  openMms,
  resolveThreadId
} from '../mmsContext'
import { runInteractiveChat } from '../interactive/runInteractive'
import { createInterface } from 'readline'

export async function runChat(args: ParsedArgs): Promise<void> {
  const { globals, positional } = args
  const stdinText = await readStdinIfPiped()
  const messageParts = [...positional]
  if (stdinText) {
    messageParts.unshift(stdinText)
  }
  const message = messageParts.join(' ').trim()

  const wantInteractive =
    !globals.print && isInteractiveStdin() && !stdinText

  if (wantInteractive) {
    const ctx = await openMms(globals)
    const threadId = await resolveThreadId(ctx, globals)
    try {
      await runInteractiveChat({
        client: ctx.client,
        mode: globals.mode,
        initialThreadId: threadId,
        initialMessage: message || undefined
      })
    } finally {
      await closeMmsContext(ctx)
    }
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

  const ctx = await openMms(globals)
  const client = ctx.client
  const threadId = await resolveThreadId(ctx, globals)
  await loadOrchestratorThread(ctx, threadId)

  const trimmed = message.trim()

  if (trimmed === '/stop' || trimmed.startsWith('/stop ')) {
    const tid = threadId
    if (!tid) {
      writeOutput(globals.mode, { stopped: false, message: 'No thread specified.' })
      await closeMmsContext(ctx)
      return
    }
    const res = await client.request<{ ok: boolean }>('orchestrator.abort', {
      threadId: tid
    })
    writeOutput(
      globals.mode,
      globals.mode === 'json'
        ? { stopped: res.ok, message: res.ok ? 'Stop requested.' : 'Nothing to stop.' }
        : res.ok
          ? 'Stop requested.'
          : 'Nothing to stop — no in-flight turn.',
      (data: unknown) => String(data)
    )
    await closeMmsContext(ctx)
    return
  }

  if (trimmed.startsWith('/steer ') || trimmed === '/steer') {
    const steerText = trimmed.replace(/^\/steer\s*/, '').trim()
    if (!steerText) {
      exitWithError('Usage: mousse-cli /steer <prompt>', globals.mode)
    }
    let tid = threadId
    if (!tid) {
      const threads = await client.request<{ threads: { id: string; settledAt?: string }[] }>(
        'threads.list'
      )
      tid = threads.threads.find((t) => !t.settledAt)?.id ?? null
    }
    if (!tid) {
      exitWithError('No thread to steer.', globals.mode)
    }
    const res = await client.request<{ ok: boolean; steered?: boolean; queued?: boolean }>(
      'orchestrator.steer',
      { threadId: tid, text: steerText, source: 'cli' }
    )
    writeOutput(
      globals.mode,
      globals.mode === 'json'
        ? { steered: res.steered, queued: res.queued, text: steerText, threadId: tid }
        : res.ok
          ? `Steer accepted: ${steerText}`
          : 'No active turn to steer.',
      (data: unknown) => String(data)
    )
    await closeMmsContext(ctx)
    return
  }

  let tid = threadId
  if (!tid) {
    const created = await client.request<{ thread: { id: string } }>('threads.create', {
      name: 'CLI Chat'
    })
    tid = created.thread.id
  }

  const onSigInt = (): void => {
    void client.request('orchestrator.abort', { threadId: tid }).then((r) => {
      if ((r as { ok?: boolean }).ok) {
        process.stderr.write('\nStop requested (Ctrl+C). Waiting for turn to abort…\n')
      }
    })
  }
  process.on('SIGINT', onSigInt)
  let response: { message?: string; actions?: unknown[]; queued?: boolean }
  try {
    response = await client.request('orchestrator.send', {
      threadId: tid,
      content: message,
      source: 'cli'
    })
  } finally {
    process.off('SIGINT', onSigInt)
  }

  writeOutput(
    globals.mode,
    globals.mode === 'json'
      ? {
          message: response.message,
          actions: response.actions,
          queued: response.queued,
          threadId: tid,
          source: 'cli'
        }
      : response.queued
        ? `(queued for thread ${tid.slice(0, 8)}) ${message}`
        : response.message ?? '',
    (data: unknown) => String(data)
  )

  await closeMmsContext(ctx)
}

export async function promptLine(question: string, secret = false): Promise<string> {
  if (!isInteractiveStdin()) {
    return ''
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(secret ? answer : answer)
    })
  })
}

export async function promptSelect(
  question: string,
  options: Array<{ id: string; label: string }>
): Promise<string | null> {
  if (!isInteractiveStdin() || options.length === 0) return options[0]?.id ?? null
  process.stderr.write(`${question}\n`)
  options.forEach((o, i) => process.stderr.write(`  ${i + 1}. ${o.label}\n`))
  const answer = await promptLine('Choice: ')
  const n = Number(answer)
  if (Number.isFinite(n) && n >= 1 && n <= options.length) {
    return options[n - 1].id
  }
  return options.find((o) => o.id === answer || o.label === answer)?.id ?? null
}
