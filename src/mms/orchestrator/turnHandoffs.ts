import type { Message } from '../../shared/transcript'
import type { HandoffPlan } from '../run/handoff/HandoffService'
import { handoffMessages, renderHandoffBlock } from '../run/handoff/delivery'
import type { RunEngine } from '../run/RunEngine'
import type { TransferRecord } from '../run/types'

/** One handoff a turn delivers (docs/run-engine/SPEC.md §16.1-§16.2). */
export interface PlannedHandoff {
  /** `switch`: the provider changed; `fork`: a fork's first message; `merge_back`: a fork's delta. */
  kind: 'switch' | 'fork' | 'merge_back'
  plan: HandoffPlan
  /** The transfer the turn consumes (`fork`, `merge_back`). */
  transfer?: TransferRecord
  /** Fork only: how the source session was carried over. */
  forkStrategy?: 'native' | 'portable'
}

function sameMessage(left: Message, right: Message): boolean {
  return left.role === right.role && JSON.stringify(left.content) === JSON.stringify(right.content)
}

/**
 * The marker a transfer's injected history carries in the canonical transcript: a property on each
 * message (never part of its content, so providers do not see it). A later turn that finds a
 * transfer's marker in the transcript knows the history is already there.
 */
export interface TransferMarker {
  handoffId: string
  transferId: string
}

type MarkedMessage = Message & { contextHandoff?: TransferMarker }

/** The markers of the transfers whose injected history `messages` already holds, by transfer id. */
export function committedTransfers(messages: readonly Message[]): Map<string, TransferMarker> {
  const markers = new Map<string, TransferMarker>()
  for (const message of messages as readonly MarkedMessage[]) {
    const marker = message.contextHandoff
    if (marker && typeof marker.transferId === 'string') markers.set(marker.transferId, marker)
  }
  return markers
}

/**
 * What a turn sends instead of (switch) or in addition to (fork, merge-back) its raw history, and
 * the bookkeeping once the adapter returns. A provider switch replaces the history for this turn
 * only: the canonical transcript keeps every message, so the handoff prefix is stripped from what
 * the adapter hands back. Fork and merge-back items stay in the transcript: they are the fork's
 * starting context and what the parent learnt from its fork, marked with their transfer.
 *
 * A transfer is consumed once: as soon as a commit of the turn's transcript holds its items
 * (`committed`), or when a turn that delivered it some other way completes (`settle`). A turn that
 * aborts before its first commit leaves the transfer pending for the next turn.
 */
export class TurnHandoffs {
  /** A provider switch replaces this turn's raw history (`TurnInput.messages`/`nativeHistory`). */
  readonly replaceHistory: boolean
  /** A switch or fork hands history over in the prompt or messages (not a native session) this turn. */
  readonly historyHandedOver: boolean
  private readonly prefix: Message[] = []
  private readonly kept: Message[] = []
  private readonly blocks: string[] = []
  /** Transfers whose items ride in `kept` (transcript-native delivery). */
  private readonly keptTransfers = new Set<PlannedHandoff>()
  private readonly consumed = new Set<PlannedHandoff>()
  private prior: Message[] = []
  private handedOver = false
  private settled = false

  constructor(
    private readonly engine: RunEngine,
    readonly planned: PlannedHandoff[],
    /** The adapter takes structured history (`historyInjection: 'native'`). */
    private readonly native: boolean
  ) {
    for (const entry of planned) {
      if (entry.plan.strategy === 'native_resume') continue
      if (!native) this.blocks.push(renderHandoffBlock(entry.plan))
      else if (entry.kind === 'switch') this.prefix.push(...handoffMessages(entry.plan))
      else {
        const messages = handoffMessages(entry.plan)
        if (entry.transfer) {
          const marker: TransferMarker = { handoffId: entry.plan.handoffId, transferId: entry.transfer.transferId }
          for (const message of messages) (message as MarkedMessage).contextHandoff = marker
          if (messages.length) this.keptTransfers.add(entry)
        }
        this.kept.push(...messages)
      }
    }
    this.replaceHistory = planned.some((entry) => entry.kind === 'switch' && entry.plan.strategy !== 'native_resume')
    this.historyHandedOver = planned.some((entry) => (entry.kind === 'switch' || entry.kind === 'fork') && entry.plan.strategy !== 'native_resume')
  }

  /** `TurnInput.messages` for a transcript-native adapter; `active` ends with the admitted message. */
  messages(active: Message[]): Message[] {
    this.prior = active.slice(0, -1)
    this.handedOver = true
    const last = active.slice(-1)
    if (this.replaceHistory) return [...this.prefix, ...this.kept, ...last]
    return this.kept.length ? [...this.prior, ...this.kept, ...last] : active
  }

  /** `TurnInput.prompt` for a prompt-injected adapter: the `<handoff>` blocks, then the prompt. */
  prompt(text: string): string {
    return this.blocks.length ? `${this.blocks.join('\n\n')}\n\n${text}` : text
  }

  /**
   * The canonical active transcript for what the adapter handed back: the switch prefix is replaced
   * by the history it stood in for. A transcript that no longer starts with the prefix (the turn
   * recovered from an overflow with the compacted transcript) is already canonical.
   */
  canonical(returned: Message[]): Message[] {
    if (!this.replaceHistory || !this.prefix.length || returned.length < this.prefix.length) return returned
    if (!this.prefix.every((message, index) => sameMessage(message, returned[index]))) return returned
    return [...this.prior, ...returned.slice(this.prefix.length)]
  }

  /**
   * The turn's transcript was committed (the adapter's `nativeMessages` or its final messages): the
   * fork and merge-back items it was handed are now canonical, so their transfers are consumed
   * (`consumedBy` this run) and a later turn never injects them again, even if this one aborts.
   */
  committed(): void {
    if (!this.handedOver) return
    for (const entry of this.keptTransfers) this.consume(entry)
  }

  /**
   * Marks every handoff `delivered` when the adapter returned (`failed` when it threw), and consumes
   * the remaining transfers of a turn that completed. A failed or stopped turn leaves uncommitted
   * transfers pending so the next turn delivers them again. Runs once.
   */
  settle(outcome: 'completed' | 'aborted' | 'failed', error?: string): void {
    if (this.settled) return
    this.settled = true
    for (const entry of this.planned) {
      try {
        if (outcome === 'failed') this.engine.handoffs.markFailed(entry.plan.handoffId, error)
        else this.engine.handoffs.markDelivered(entry.plan.handoffId)
      } catch (failure) {
        console.warn('run engine handoff settle failed', {
          handoffId: entry.plan.handoffId,
          error: failure instanceof Error ? failure.message : String(failure)
        })
      }
      if (outcome === 'completed') this.consume(entry)
    }
  }

  private consume(entry: PlannedHandoff): void {
    if (!entry.transfer || this.consumed.has(entry)) return
    this.consumed.add(entry)
    try {
      this.engine.transfers.setStatus({
        transferId: entry.transfer.transferId,
        from: 'pending',
        to: 'consumed',
        payloadPatch: {
          handoffId: entry.plan.handoffId,
          strategy: entry.plan.strategy,
          consumedBy: entry.plan.record.targetRunId,
          ...(entry.forkStrategy ? { forkStrategy: entry.forkStrategy } : {})
        }
      })
    } catch (failure) {
      console.warn('run engine transfer consume failed', {
        transferId: entry.transfer.transferId,
        error: failure instanceof Error ? failure.message : String(failure)
      })
    }
  }
}
