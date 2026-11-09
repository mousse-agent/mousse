import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { withFileLock } from '../scheduled/fileLock'
import type { CreateScheduledJobInput } from '../../shared/types'

/**
 * The first-creation ask (Path step 2): the first time a thread's agent adds an automation, the automation is not made;
 * a durable ask is, and the person answers it with Allow or Not now. Allow makes the automation and lets that thread add
 * more within the limits; Not now closes the ask. It replaces the old "Agents may add automations" switch.
 */
export interface AgentJobAsk {
  id: string
  /** The thread whose agent asked. */
  threadId: string
  /** The creating call's key, so a retried call finds its ask instead of asking again. */
  requestKey: string
  /** The automation as it will be made, without its end (set from the moment the person allows it). */
  input: Omit<CreateScheduledJobInput, 'expiresAt'>
  createdAt: string
  state: 'open' | 'allowed' | 'declined'
  answeredAt?: string
  /** The automation Allow made. */
  jobId?: string
}

interface AskFile {
  version: 1
  asks: AgentJobAsk[]
  /** Threads whose agents the person allowed to add automations. */
  allowedThreads: string[]
}

const EMPTY: AskFile = { version: 1, asks: [], allowedThreads: [] }
/** Answered asks kept for the record, newest last. */
const ANSWERED_KEPT = 50

export class AgentJobAskStore {
  private readonly dir: string
  private readonly path: string

  constructor(homeDir: string) {
    this.dir = join(homeDir, 'scheduled')
    this.path = join(this.dir, 'agent-asks.json')
  }

  private read(): AskFile {
    if (!existsSync(this.path)) return structuredClone(EMPTY)
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<AskFile>
      return {
        version: 1,
        asks: Array.isArray(parsed.asks) ? parsed.asks : [],
        allowedThreads: Array.isArray(parsed.allowedThreads) ? parsed.allowedThreads.filter((id): id is string => typeof id === 'string') : []
      }
    } catch {
      return structuredClone(EMPTY)
    }
  }

  private change<T>(edit: (file: AskFile) => T): T {
    mkdirSync(this.dir, { recursive: true })
    return withFileLock(join(this.dir, '.agent-asks.lock'), () => {
      const file = this.read()
      const result = edit(file)
      const open = file.asks.filter((ask) => ask.state === 'open')
      const answered = file.asks.filter((ask) => ask.state !== 'open').slice(-ANSWERED_KEPT)
      atomicWriteJsonSync(this.path, { ...file, asks: [...answered, ...open] })
      return result
    })
  }

  list(): AgentJobAsk[] {
    return this.read().asks
  }

  open(): AgentJobAsk[] {
    return this.list().filter((ask) => ask.state === 'open')
  }

  get(id: string): AgentJobAsk | undefined {
    return this.list().find((ask) => ask.id === id)
  }

  threadAllowed(threadId: string): boolean {
    return this.read().allowedThreads.includes(threadId)
  }

  /** Records the ask, or returns the one the same call already made. */
  ask(input: { threadId: string; requestKey: string; job: AgentJobAsk['input'] }, now = new Date()): AgentJobAsk {
    return this.change((file) => {
      const earlier = file.asks.find((ask) => ask.requestKey === input.requestKey)
      if (earlier) return earlier
      const ask: AgentJobAsk = { id: randomUUID(), threadId: input.threadId, requestKey: input.requestKey, input: input.job, createdAt: now.toISOString(), state: 'open' }
      file.asks.push(ask)
      return ask
    })
  }

  /**
   * Answers an open ask. Allow runs `create` under the store's lock (so two answers cannot make two automations) and
   * lets the thread add more; Not now only closes the ask. An ask already answered is refused.
   */
  answer(id: string, answer: 'allow' | 'not_now', create: (ask: AgentJobAsk) => { id: string }, now = new Date()): AgentJobAsk {
    return this.change((file) => {
      const ask = file.asks.find((entry) => entry.id === id)
      if (!ask) throw new Error('This request is gone.')
      if (ask.state !== 'open') throw new Error('This request was already answered.')
      if (answer === 'allow') {
        const job = create(ask)
        ask.jobId = job.id
        if (!file.allowedThreads.includes(ask.threadId)) file.allowedThreads.push(ask.threadId)
      }
      ask.state = answer === 'allow' ? 'allowed' : 'declined'
      ask.answeredAt = now.toISOString()
      return ask
    })
  }
}
