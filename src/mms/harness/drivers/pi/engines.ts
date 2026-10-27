import type { InstanceConfig } from '../../driver'

/**
 * Providers that never run on Pi's agent whatever their config says (PR 2 §5): `openai-codex` and
 * `cursor` ran only on the legacy loop, and a Mousse update retired them (`retired.ts`: they run
 * nowhere until moved). Every other provider can run on Pi's agent (`rpc`) when the user opts in (Advanced → Engine:
 * New engine); the default stays the loop until the parity gate passed on real accounts, and a later
 * PR flips it.
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

/** The engine new instances run on until the parity gate passes (PR 2 §5). */
export const PI_DEFAULT_ENGINE: PiEngine = 'legacy'

/**
 * The engine in effect for a provider: `rpc` only when the user opted in (or the default is
 * `rpc`), the provider can run on it and the packaged Pi runtime is there; else `legacy`.
 */
export function piEngineFor(providerId: string, stored: PiEngine | undefined, rpcAvailable: boolean): PiEngine {
  if (!piEngineSwitchable(providerId, rpcAvailable)) return 'legacy'
  return stored ?? PI_DEFAULT_ENGINE
}

/** The engine a decoded config runs on (its `engine` is the one in effect once decoded with the instance id). */
export function piEngineOf(config: InstanceConfig, rpcAvailable: boolean): PiEngine {
  return config.engine === 'rpc' && rpcAvailable ? 'rpc' : 'legacy'
}
