import type { HarnessCaps, RunPolicy } from '../../shared/harness/types'
import type { LlmProviderOption } from '../../shared/settings'
import { checkPolicy, toolControlLevel } from '../harness/policy'

/**
 * The policy every channel turn binds with. Nobody in a channel can answer a tool approval, so the
 * turn's bridge refuses every request that needs one instead of waiting for an answer.
 */
export const CHANNEL_POLICY: RunPolicy = Object.freeze({ mode: 'default', approvals: 'never', origin: 'interactive' })

/** Shown once per channel thread whose runtime asks before some tools (`asksBeforeTools`). */
export const CHANNEL_APPROVALS_NOTICE = 'Tools that need approval are refused in channels.'

/** The reply to a channel turn on a model that cannot hold `CHANNEL_POLICY` (it approves tools itself). */
export const CHANNEL_MODEL_REFUSED = "This model can't run in channels. Choose another with /model."

/**
 * `/model` choices: the instances that resolve for a channel turn (`channel_model`) and can hold
 * `CHANNEL_POLICY`. `capsOf` resolves an instance for that purpose and throws when it cannot run
 * one; such an instance is left out. Nothing is decided by the instance's name.
 */
export function channelModelOptions(providers: readonly LlmProviderOption[], capsOf: (instanceId: string) => HarnessCaps): LlmProviderOption[] {
  return providers.filter((provider) => {
    if (!provider.instanceId) return false
    try {
      return checkPolicy(capsOf(provider.instanceId), CHANNEL_POLICY, provider.instanceId).ok
    } catch {
      return false
    }
  })
}

/**
 * What a channel turn on these caps needs before it runs: a refusal when the runtime cannot hold
 * `CHANNEL_POLICY` (it approves tools itself), else the approvals notice when it asks before tools.
 * Unknown caps (no model, an unreadable instance) pass: the turn reports its own error.
 */
export function channelGate(caps: HarnessCaps | null, instanceId?: string): { refusal?: string; approvalOnly?: true } {
  if (!caps) return {}
  if (!checkPolicy(caps, CHANNEL_POLICY, instanceId).ok) return { refusal: CHANNEL_MODEL_REFUSED }
  return asksBeforeTools(caps) ? { approvalOnly: true } : {}
}

/**
 * Whether a runtime admitted to channels asks before some of its tools, so a channel turn refuses
 * them: one that asks Mousse before each tool (`approval_only`), and one that runs its own tools
 * under the thread's permission mode with Mousse deciding each (`exact`: Pi's agent on any platform).
 */
export function asksBeforeTools(caps: HarnessCaps): boolean {
  const control = toolControlLevel(caps)
  return control === 'approval_only' || control === 'exact'
}

/**
 * The one-time approvals notice: given until it has been delivered once on the thread (for as long
 * as the profile runs), when the thread's runtime approves tools by asking.
 */
export class ChannelApprovalNotices {
  private readonly shown = new Set<string>()

  pending(threadId: string, caps: HarnessCaps | null): string | undefined {
    if (!caps || !asksBeforeTools(caps) || this.shown.has(threadId)) return undefined
    return CHANNEL_APPROVALS_NOTICE
  }

  delivered(threadId: string): void {
    this.shown.add(threadId)
  }
}
