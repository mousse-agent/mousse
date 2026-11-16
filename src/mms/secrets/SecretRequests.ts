import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import {
  safeSecretLink,
  SECRET_KEEPS,
  SECRET_REQUEST_TIMEOUT_MS,
  secretGivenSentence,
  secretNameFor,
  secretValueProblem,
  type SecretKeep,
  type SecretRequestView
} from '../../shared/secretRequests'
import type { SecretVault } from './SecretVault'

/** What the agent asked for. */
export interface SecretRequestInput {
  label: string
  reason: string
  link?: string
  format?: string
  /** The name the agent would like it kept under (a key name such as HF_TOKEN). */
  name?: string
}

/** How a request ended, as the agent is told. Never holds a value; `file` is the private file the agent may read. */
export type SecretRequestOutcome =
  | { kind: 'stored'; name: string; keep: SecretKeep; file?: string }
  | { kind: 'saved_reused'; name: string; file?: string }
  | { kind: 'declined' }
  | { kind: 'ended'; why: 'stopped' | 'timed_out' | 'shutdown' }

/** A refusal a window is shown; its message never repeats what was typed. */
export class SecretRequestError extends Error {
  constructor(readonly code: 'not_found' | 'invalid' | 'not_saved', message: string) {
    super(message)
    this.name = 'SecretRequestError'
  }
}

interface Pending {
  view: SecretRequestView
  settle(outcome: SecretRequestOutcome): void
}

/**
 * The secret requests waiting in threads. A request lives in memory only, until the person answers it, declines it,
 * the agent's turn ends (Stop, the turn finishing, a restart) or an hour passes; only an answer stores anything. The
 * service sees a value only inside `answer`, which hands it straight to the vault.
 */
export class SecretRequests extends EventEmitter {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly vault: SecretVault, private readonly now: () => number = Date.now) {
    super()
  }

  /** Puts a card in the thread and waits for the person. */
  request(threadId: string, input: SecretRequestInput, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SecretRequestOutcome> {
    const label = input.label.trim().slice(0, 120)
    const reason = input.reason.trim().slice(0, 600)
    const link = safeSecretLink(input.link)
    const format = typeof input.format === 'string' && input.format.trim() ? input.format.trim().slice(0, 120) : undefined
    const name = secretNameFor({ name: input.name, label })
    const requestId = randomUUID()
    const view: SecretRequestView = {
      requestId,
      threadId,
      label,
      reason,
      ...(link ? { link } : {}),
      ...(format ? { format } : {}),
      name,
      savedExists: this.vault.isSaved(name),
      createdAt: new Date(this.now()).toISOString()
    }
    return new Promise<SecretRequestOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => finish({ kind: 'ended', why: 'stopped' })
      const finish = (outcome: SecretRequestOutcome): void => {
        if (!this.pending.delete(requestId)) return
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        this.emit('changed', { threadId })
        resolve(outcome)
      }
      this.pending.set(requestId, { view, settle: finish })
      if (options.signal?.aborted) {
        finish({ kind: 'ended', why: 'stopped' })
        return
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => finish({ kind: 'ended', why: 'timed_out' }), options.timeoutMs ?? SECRET_REQUEST_TIMEOUT_MS)
      timer.unref?.()
      this.emit('changed', { threadId })
    })
  }

  /** The thread's waiting requests, oldest first. */
  list(threadId: string): SecretRequestView[] {
    return [...this.pending.values()].map((entry) => entry.view).filter((view) => view.threadId === threadId)
  }

  /** Whether the thread has a request waiting. */
  waiting(threadId: string): boolean {
    return this.list(threadId).length > 0
  }

  /**
   * Save securely: the value goes to the store under the request's name (or the next free one) and the agent is told
   * the name. A request that already ended stores nothing.
   */
  answer(threadId: string, requestId: string, value: unknown, keep: unknown): { name: string } {
    const entry = this.find(threadId, requestId)
    const problem = secretValueProblem(value)
    if (problem) throw new SecretRequestError('invalid', problem)
    if (typeof keep !== 'string' || !(SECRET_KEEPS as readonly string[]).includes(keep)) throw new SecretRequestError('invalid', 'Choose how long to keep it.')
    const name = this.vault.freeName(entry.view.name)
    this.vault.store(name, value as string, { keep: keep as SecretKeep, threadId, label: entry.view.label })
    const file = this.vault.fileFor(name, threadId)
    entry.settle({ kind: 'stored', name, keep: keep as SecretKeep, ...(file ? { file } : {}) })
    return { name }
  }

  /** Use saved: the thread may use the saved secret of the request's name; nothing new is stored. */
  useSaved(threadId: string, requestId: string): { name: string } {
    const entry = this.find(threadId, requestId)
    const name = entry.view.name
    if (!this.vault.isSaved(name)) throw new SecretRequestError('not_saved', `No saved secret is named ${name}.`)
    this.vault.grant(name, threadId)
    const file = this.vault.fileFor(name, threadId)
    entry.settle({ kind: 'saved_reused', name, ...(file ? { file } : {}) })
    return { name }
  }

  decline(threadId: string, requestId: string): void {
    this.find(threadId, requestId).settle({ kind: 'declined' })
  }

  /** Ends every request of a thread (its turn stopped or ended); nothing is stored. */
  endThread(threadId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.view.threadId === threadId) entry.settle({ kind: 'ended', why: 'stopped' })
    }
  }

  /** The daemon is stopping: every request ends. */
  dispose(): void {
    for (const entry of [...this.pending.values()]) entry.settle({ kind: 'ended', why: 'shutdown' })
  }

  private find(threadId: string, requestId: string): Pending {
    const entry = this.pending.get(requestId)
    if (!entry || entry.view.threadId !== threadId) throw new SecretRequestError('not_found', 'This request has ended.')
    return entry
  }
}

/**
 * What the agent's tool returns for an outcome: the name and the private file, never the value. The secret is kept out
 * of the transcript, not out of the agent's hands: it may read the file and use the value wherever the work needs it.
 */
export function secretOutcomeText(outcome: SecretRequestOutcome): { text: string; isError?: boolean } {
  switch (outcome.kind) {
    case 'stored':
    case 'saved_reused': {
      const kept = outcome.kind === 'saved_reused' ? 'a saved secret' : outcome.keep === 'thread' ? 'for this thread only' : outcome.keep === 'day' ? 'for 24 hours' : 'saved in Settings'
      return {
        text: [
          secretGivenSentence(outcome.name, kept),
          outcome.file
            ? `It is in a private file you may use directly with your own tools: ${outcome.file}. Use it as you would any credential the user handed you, in commands, config files, API calls and logins, by passing the file inside the command so the value never comes back as output: gh auth login --with-token < "${outcome.file}", curl -H "Authorization: Bearer $(cat "${outcome.file}")", or a program option that reads a file. Open the file to look at its contents only when you need the value itself, since whatever a tool returns stays in your session's history.`
            : '',
          `secret_run with secrets [{ "name": "${outcome.name}" }] also gives it to one command as the environment variable ${outcome.name} (or as a file whose path is in ${outcome.name}_FILE), and \${secret:${outcome.name}} reads it in an MCP server's settings.`,
          'Keep the value out of the transcript: never print or echo it in a reply, a message or command output. Output that holds it is masked.'
        ].filter(Boolean).join(' ')
      }
    }
    case 'declined':
      return { text: 'The user declined to give the secret. Nothing was stored. Carry on without it, and do not ask for it again unless the user asks you to.', isError: true }
    case 'ended':
      return {
        text: outcome.why === 'timed_out'
          ? 'The user did not answer the secret request within an hour. Nothing was stored.'
          : 'The secret request ended before the user answered (the turn stopped or ended). Nothing was stored.',
        isError: true
      }
  }
}
