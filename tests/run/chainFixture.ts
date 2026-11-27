import { CHAIN_BUDGET } from '../../src/mms/run/AgentChains'
import type { RunEngine } from '../../src/mms/run/RunEngine'

/** Spends `chainId`'s budget until `leave` messages are left, as that many earlier messages of the chain would. */
export function spendChain(engine: Pick<RunEngine, 'chains'>, chainId: string, senderThreadId: string, targetThreadId: string, leave = 0): void {
  for (let i = 0; (engine.chains.get(chainId)?.used ?? 0) < CHAIN_BUDGET - leave; i += 1)
    engine.chains.admit({ chainId, senderThreadId, senderRunId: null, targetThreadId, kind: 'work', requestKey: `spend:${chainId}:${i}`, payload: null })
}
