import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import {
  COMPUTER_USE_REASON_MAX,
  computerUseOutcomeText,
  outcomeHostName,
  type ComputerUseSetupRequestView,
  type ComputerUseStatus
} from '../../shared/computerUse'

/**
 * The setup cards `computer_use_request` opens (`src/shared/computerUse.ts`): at most one per thread, the latest
 * replacing the one before, kept in memory for this run of the service. Nothing waits on a card: the tool returns at once
 * with an outcome line, and what the person does on the card (install, enable, Not now) applies from the next turn.
 *
 * A bot's turns file their card under the bot's chat (`targetOf`), whichever of its threads asked. Not now on a thread's
 * card stops its agents asking again until computer use's settings change. A request that a Stop, a Not now or a newer
 * request overtook while the driver was being looked at publishes nothing (`seq`).
 */

export interface ComputerUseSetupHost {
  /** The driver now; `refresh` looks again (an install made outside Mousse is found). */
  status(refresh: boolean): Promise<ComputerUseStatus>
  /** Settings → Computer use is on. */
  enabled(): boolean
  /** This computer's name, as the card and the outcome line say it. */
  hostName(): string
  /** The thread a request of `threadId` shows in: a bot's chat for any of its threads, else the thread itself. */
  targetOf(threadId: string): string
  now?(): Date
}

export interface ComputerUseRequestResult {
  text: string
  isError?: true
}

/** What the agent is told the card is for, from the driver's state. */
function needed(status: ComputerUseStatus | undefined, enabled: boolean): string {
  const on = enabled ? '' : ' and turn computer use on'
  if (!status) return `Cua Driver could not be checked${on}`
  if (status.state === 'installing') return `Cua Driver is being installed${on}`
  if (status.source === 'chosen' && (status.state === 'missing' || status.state === 'broken')) return 'the driver chosen in Settings → Computer use needs fixing'
  if (status.state === 'found') return 'computer use is off; it needs turning on'
  if (status.state === 'broken') return `Cua Driver didn't start; it needs reinstalling${on}`
  if (!status.installable) return 'Cua Driver needs installing by hand'
  return `Cua Driver needs installing${on}`
}

export class ComputerUseSetupRequests extends EventEmitter {
  private readonly open = new Map<string, ComputerUseSetupRequestView>()
  private readonly seqs = new Map<string, number>()
  private readonly declined = new Set<string>()

  constructor(private readonly host: ComputerUseSetupHost) {
    super()
  }

  /** A thread's sequence number now: every request and Not now moves it on. */
  currentSeq(threadId: string): number {
    return this.seqs.get(threadId) ?? 0
  }

  private nextSeq(threadId: string): number {
    const next = this.currentSeq(threadId) + 1
    this.seqs.set(threadId, next)
    return next
  }

  private changed(threadId: string): void {
    this.emit('changed', { threadId })
  }

  /** The thread's open card, without looking at the driver. */
  peek(threadId: string): ComputerUseSetupRequestView | undefined {
    return this.open.get(threadId)
  }

  /** The thread's open card; one whose setup is done (on, and the driver found) is closed instead. */
  async get(threadId: string): Promise<ComputerUseSetupRequestView | undefined> {
    const request = this.open.get(threadId)
    if (!request) return undefined
    let status: ComputerUseStatus | undefined
    try {
      status = await this.host.status(false)
    } catch {
      status = undefined
    }
    if (this.host.enabled() && status?.state === 'found' && !status.error && this.open.get(threadId) === request) {
      this.open.delete(threadId)
      this.changed(threadId)
      return undefined
    }
    return this.open.get(threadId)
  }

  /** Not now: closes the thread's card and stops its agents asking again until computer use's settings change. */
  dismiss(threadId: string, requestId?: string): boolean {
    const request = this.open.get(threadId)
    if (requestId !== undefined && request && request.requestId !== requestId) return false
    this.declined.add(threadId)
    this.nextSeq(threadId)
    if (request) this.open.delete(threadId)
    this.changed(threadId)
    return true
  }

  /** Whether the person said Not now on the thread's card since computer use's settings last changed. */
  isDeclined(threadId: string): boolean {
    return this.declined.has(threadId)
  }

  /**
   * Computer use's settings changed (the switch, the chosen driver): a Not now no longer stands, and each open card
   * reads the driver again.
   */
  settingsChanged(): void {
    const declined = [...this.declined]
    this.declined.clear()
    for (const threadId of new Set([...declined, ...this.open.keys()])) this.changed(threadId)
  }

  /** The installer started or ended: each open card reads the driver again. */
  installChanged(): void {
    for (const threadId of this.open.keys()) this.changed(threadId)
  }

  /**
   * `computer_use_request` from `threadId`'s agent: says at once whether computer use is ready here, declined, or needs
   * setting up, and in that case shows the card. Never waits for the person.
   */
  async request(input: { threadId: string; reason: string; signal?: AbortSignal }): Promise<ComputerUseRequestResult> {
    const target = this.host.targetOf(input.threadId)
    const host = outcomeHostName(this.host.hostName())
    const startSeq = this.nextSeq(target)
    if (this.declined.has(target)) return { text: this.declinedText() }
    let status: ComputerUseStatus | undefined
    try {
      status = await this.host.status(true)
    } catch {
      status = undefined
    }
    // What happened while the driver was looked at wins: a Stop, a Not now, or a newer request.
    if (input.signal?.aborted) return { text: 'Stopped before the setup card was shown.', isError: true }
    if (this.declined.has(target)) return { text: this.declinedText() }
    if (this.currentSeq(target) !== startSeq) return { text: 'A newer request replaced this one; its card is the one shown.' }
    const enabled = this.host.enabled()
    if (enabled && status?.state === 'found') {
      if (this.open.delete(target)) this.changed(target)
      return { text: computerUseOutcomeText('ready', `Computer use is set up on ${host}. If computer_tools and computer_use aren't listed yet, they are from your next turn.`) }
    }
    const reason = input.reason.replace(/\s+/g, ' ').trim().slice(0, COMPUTER_USE_REASON_MAX)
    this.open.set(target, {
      requestId: `cur_${randomUUID()}`,
      threadId: target,
      originThreadId: input.threadId,
      hostName: this.host.hostName().slice(0, 128),
      reason,
      createdAt: (this.host.now?.() ?? new Date()).toISOString()
    })
    this.changed(target)
    return {
      text: computerUseOutcomeText('setup_needed', `Computer use is not set up on ${host}: ${needed(status, enabled)}. The user sees a setup card above the composer; don't wait for it. Once set up, it works from your next turn.`)
    }
  }

  private declinedText(): string {
    return computerUseOutcomeText('declined', "The user said Not now to setting up computer use. Don't ask again in this thread; carry on without it.")
  }
}
