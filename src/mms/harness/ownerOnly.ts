import { basename } from 'node:path'
import type { HarnessDriverKind, TurnOrigin } from '../../shared/harness/types'
import type { OwnerProof } from '../run/ownerProof'
import { COVERED_AGENT_IDS } from './agents/registry'
import type { InstanceConfig } from './driver'

/**
 * Providers whose sign-in is the owner's personal Google account (Antigravity's Google sign-in) run
 * only turns the owner drives: a message they sent themselves from a Mousse window, here or on
 * another of their own computers. Everything else (schedules, bots, agents, delegated children,
 * workflows, goals, wakes, Mousse's own one-shot requests, the CLI) is refused before any prompt
 * reaches the provider.
 *
 * - `personal_oauth`: the built-in Antigravity entry, installed by Mousse or run from a manual
 *   executable; its only sign-in is Google's personal OAuth.
 * - `unknown_auth`: an ACP agent Mousse recognises as Antigravity (its registry entry, or the
 *   Antigravity agent's own executable as the command). Mousse cannot tell how it signs in, so it
 *   is held to the same rule. Any other command is opaque and outside this detection.
 */
export type OwnerOnlyAuth = 'personal_oauth' | 'unknown_auth'

/** The Antigravity ACP agent's executable, as Mousse installs it (`agy_acp_server.exe` / `.par`). */
const ANTIGRAVITY_EXECUTABLE = /^agy_acp_server(\.(exe|par|cmd|bat|sh))?$/i

/** A registry id that names Antigravity. */
function antigravityRegistryId(agentId: string): boolean {
  return COVERED_AGENT_IDS[agentId] === 'antigravity' || /antigravity/i.test(agentId)
}

/** Whether an instance may run only turns its owner drives, and why; undefined for every other instance. */
export function ownerOnlyAuth(driver: HarnessDriverKind, config: Pick<InstanceConfig, 'source' | 'binaryPath'>): OwnerOnlyAuth | undefined {
  if (driver === 'antigravity') return 'personal_oauth'
  if (driver !== 'acp') return undefined
  const source = config.source
  if (source?.kind === 'registry') return antigravityRegistryId(source.agentId) ? 'unknown_auth' : undefined
  const command = source?.kind === 'local' ? source.command : config.binaryPath
  return command && ANTIGRAVITY_EXECUTABLE.test(basename(command.replace(/\\/g, '/'))) ? 'unknown_auth' : undefined
}

/** What the gate reads of a run (`RunRecord`), straight from the run store. */
export interface RunProvenance {
  source: string
  ownerProof?: OwnerProof
  /** The run this one continues (`RunOutcome.continuationOf`). */
  continuationOf?: string
  /** The send's request id (`RunRecord.clientRequestId`): the message the run was made for. */
  clientRequestId: string | null
  /** An agent's message (`RunOutcome.sentByAgent`). */
  sentByAgent?: boolean
}

export type ProvenanceReader = (runId: string) => RunProvenance | undefined

/** Why a turn may not run on an owner-only instance. */
export type OwnerTurnRefusal =
  /** The binding has no origin, or one other than a person's chat. */
  | 'not_interactive'
  /** No run (or no run store) to read the turn's provenance from. */
  | 'unknown_run'
  /** The run was not sent by the owner from a window (the CLI, a schedule, a goal, a wake, a follow-up, …). */
  | 'not_owner'
  /** An agent wrote the message. */
  | 'agent'
  /** A continue turn whose earlier turns the owner cannot be shown to have written. */
  | 'continuation_unproven'

/** Continuations followed back at most this far; a longer chain is not proven. */
const CHAIN_MAX = 32

/**
 * Whether a run continues only turns the owner wrote: every run back to the first is the owner's
 * (a send from a window, or a Resume now they pressed), and the first is a message they sent, with
 * its request id stored.
 */
function ownerWrittenChain(runId: string, read: ProvenanceReader): boolean {
  let current: string | undefined = runId
  const seen = new Set<string>()
  for (let depth = 0; current !== undefined; depth += 1) {
    if (depth >= CHAIN_MAX || seen.has(current)) return false
    seen.add(current)
    const run = read(current)
    if (!run || !run.ownerProof || run.sentByAgent) return false
    if (run.source !== 'gui' && run.source !== 'resume_now') return false
    if (run.continuationOf === undefined) return run.source === 'gui' && typeof run.clientRequestId === 'string' && run.clientRequestId.length > 0
    current = run.continuationOf
  }
  return false
}

/**
 * Whether one attempt of `runId` may run on an owner-only instance, and if not, why. Read on every
 * attempt (first dispatch, retry, recovery after a restart, steer restart), from the binding the
 * attempt runs on and the run as stored now. Nothing is assumed: a binding without an origin, a run
 * the store does not have, or a run without the owner's proof is refused.
 */
export function ownerTurnRefusal(origin: TurnOrigin | undefined, runId: string, read: ProvenanceReader | undefined): OwnerTurnRefusal | undefined {
  if (origin !== 'interactive') return 'not_interactive'
  const run = read?.(runId)
  if (!run) return 'unknown_run'
  if (run.sentByAgent) return 'agent'
  if (!run.ownerProof || (run.source !== 'gui' && run.source !== 'resume_now')) return 'not_owner'
  // A Resume now continues a paused turn: never one the owner did not write.
  if (run.source === 'resume_now' && run.continuationOf === undefined) return 'continuation_unproven'
  if (run.continuationOf !== undefined && !ownerWrittenChain(run.continuationOf, read!)) return 'continuation_unproven'
  return undefined
}

/** The refusal a person reads. */
export function ownerOnlyMessage(label: string, auth: OwnerOnlyAuth, refusal: OwnerTurnRefusal | 'one_shot' | 'moved'): string {
  const signIn = auth === 'personal_oauth' ? `${label} uses your personal Google sign-in, so it` : `${label} may use a personal Google sign-in, so it`
  const elsewhere = 'For this, choose Gemini through Pi or Vertex AI instead.'
  switch (refusal) {
    case 'continuation_unproven':
      return `${signIn} continues only messages Mousse knows you wrote. Send the message again yourself.`
    case 'unknown_run':
      return `${signIn} runs only messages you send yourself, and Mousse could not confirm this one. Send it again.`
    case 'moved':
      return `${signIn} runs only chats you chose it for. Choose ${label} in this chat yourself, or another model.`
    case 'one_shot':
      return `${signIn} does not run Mousse's own background requests. ${elsewhere}`
    default:
      return `${signIn} runs only messages you send yourself from a Mousse window. ${elsewhere}`
  }
}
