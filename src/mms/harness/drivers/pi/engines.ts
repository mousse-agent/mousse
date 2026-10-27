import type { InstanceConfig } from '../../driver'

/**
 * Providers that stay on the legacy pi loop whatever their config says (PR 2 §5):
 * - `openai-codex` until PR 4 (PR 3 offers the move to Codex and keeps it chatting meanwhile);
 * - `cursor` until PR D (Mousse registers it in its own process; Pi's agent has no such provider).
 * Every other provider runs on Pi's agent (`rpc`) by default. The bare `pi` route (no instance)
 * stays on the loop until PR 4.
 */
export const PI_LEGACY_ONLY: Readonly<Record<string, 'legacy'>> = Object.freeze({ 'openai-codex': 'legacy', cursor: 'legacy' })

export type PiEngine = 'rpc' | 'legacy'

/** The user's stored choice (Providers → Advanced → Engine), if any. */
export function storedPiEngine(raw: Record<string, unknown> | undefined): PiEngine | undefined {
  return raw?.engine === 'rpc' || raw?.engine === 'legacy' ? raw.engine : undefined
}

/** Whether the user may switch the provider's engine: only where the RPC engine can run it at all. */
export function piEngineSwitchable(providerId: string, rpcAvailable: boolean): boolean {
  return rpcAvailable && Boolean(providerId) && !(providerId in PI_LEGACY_ONLY)
}

/**
 * The engine in effect for a provider: `legacy` when the provider is legacy-only, the packaged Pi
 * runtime is missing, or the user chose `legacy` (the rollback switch, removed in PR 4); else `rpc`.
 */
export function piEngineFor(providerId: string, stored: PiEngine | undefined, rpcAvailable: boolean): PiEngine {
  if (!piEngineSwitchable(providerId, rpcAvailable)) return 'legacy'
  return stored === 'legacy' ? 'legacy' : 'rpc'
}

/** The engine a decoded config runs on (its `engine` is the one in effect once decoded with the instance id). */
export function piEngineOf(config: InstanceConfig, rpcAvailable: boolean): PiEngine {
  return config.engine === 'rpc' && rpcAvailable ? 'rpc' : 'legacy'
}
