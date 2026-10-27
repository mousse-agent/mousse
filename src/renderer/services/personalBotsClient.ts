import type { BotActivationSummary, BotApprovalView, BotDefinition, BotSummary } from '../../shared/bots/personal/definition'
import type { BotEscalationAnswer, BotEscalationSummary } from '../../shared/bots/personal/escalation'
import type { PlatformRequestApi } from '../../shared/platform'

/** A bot's draft and published revision, as `bots.definitions.save` returns them. */
export interface BotDefinitionEntryView {
  id: string
  draft: BotDefinition
  draftHash: string
  published?: BotDefinition
}

export interface PersonalBotsClient {
  list(): Promise<BotSummary[]>
  get(botId: string): Promise<BotDefinitionEntryView & { summary: BotSummary; approval: BotApprovalView | null }>
  save(definition: BotDefinition, expectedDraftHash?: string): Promise<BotDefinitionEntryView>
  publish(botId: string, expectedDraftHash: string): Promise<BotDefinition>
  remove(botId: string): Promise<void>
  approve(botId: string, manifestDigest: string): Promise<{ digest: string; approvedAt: string }>
  revoke(botId: string): Promise<boolean>
  activate(botId: string, input: string, clientRequestId: string): Promise<BotActivationSummary>
  activations(botId?: string): Promise<BotActivationSummary[]>
  stop(activationId: string): Promise<BotActivationSummary>
  continue(activationId: string, acknowledgeUncertain?: boolean): Promise<BotActivationSummary>
  markDone(activationId: string, acknowledgeUncertain?: boolean): Promise<BotActivationSummary>
  escalations(activationId?: string): Promise<BotEscalationSummary[]>
  respond(escalationId: string, answer: BotEscalationAnswer, amount?: number): Promise<{ escalation: BotEscalationSummary; activation: BotActivationSummary }>
  resetContext(botId: string, key: string): Promise<{ gen: number }>
}

/** The personal-bot methods over the host's profile-bound bridge (`bots.*`, PR 6). */
export function createPersonalBotsClient(transport: PlatformRequestApi): PersonalBotsClient {
  const ack = (acknowledgeUncertain?: boolean) => (acknowledgeUncertain ? { acknowledgeUncertain: true } : {})
  return {
    list: async () => (await transport.request<{ bots: BotSummary[] }>('bots.definitions.list', {})).bots,
    get: (botId) => transport.request('bots.definitions.get', { botId }),
    save: (definition, expectedDraftHash) => transport.request('bots.definitions.save', { definition, ...(expectedDraftHash ? { expectedDraftHash } : {}) }),
    publish: async (botId, expectedDraftHash) => (await transport.request<{ definition: BotDefinition }>('bots.definitions.publish', { botId, expectedDraftHash })).definition,
    remove: async (botId) => { await transport.request('bots.definitions.delete', { botId }) },
    approve: (botId, manifestDigest) => transport.request('bots.approve', { botId, manifestDigest }),
    revoke: async (botId) => (await transport.request<{ revoked: boolean }>('bots.revoke', { botId })).revoked,
    activate: (botId, input, clientRequestId) => transport.request('bots.activate', { botId, input, clientRequestId }),
    activations: async (botId) => (await transport.request<{ activations: BotActivationSummary[] }>('bots.activations.list', botId ? { botId } : {})).activations,
    stop: (activationId) => transport.request('bots.activations.stop', { activationId }),
    continue: (activationId, acknowledgeUncertain) => transport.request('bots.activations.continue', { activationId, ...ack(acknowledgeUncertain) }),
    markDone: (activationId, acknowledgeUncertain) => transport.request('bots.activations.markDone', { activationId, ...ack(acknowledgeUncertain) }),
    escalations: async (activationId) => (await transport.request<{ escalations: BotEscalationSummary[] }>('bots.escalations.list', activationId ? { activationId } : {})).escalations,
    respond: (escalationId, answer, amount) => transport.request('bots.escalations.respond', { escalationId, answer, ...(amount !== undefined ? { amount } : {}) }),
    resetContext: (botId, key) => transport.request('bots.context.reset', { botId, key })
  }
}

/** The plain message of a failed request (RPC errors carry a code and a message). */
export function errorText(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'message' in cause) return String((cause as { message: unknown }).message)
  return String(cause)
}
