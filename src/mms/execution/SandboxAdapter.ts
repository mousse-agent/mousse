import type { SandboxAdapter, ScriptSpawnRequest, ScriptSpawnResult } from '../../shared/workflows'

export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'

/**
 * Seam for a real OS/container isolation backend. A Node child + env whitelist is
 * not a sandbox. When no supported platform backend is registered, sandboxed
 * execution fails closed and must not downgrade to trusted-local.
 */
export class UnconfiguredSandboxAdapter implements SandboxAdapter {
  readonly kind = 'sandbox' as const
  readonly platform = 'none'

  async execute(_request: ScriptSpawnRequest): Promise<ScriptSpawnResult> {
    throw Object.assign(new Error('Sandboxed execution is unavailable: no supported isolation backend is configured'), {
      code: SANDBOX_UNAVAILABLE
    })
  }
}

export function isSandboxUnavailable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === SANDBOX_UNAVAILABLE)
}

/** True only when a backend publishes a real isolation platform and sandbox filesystem root. */
export function isConfiguredSandbox(adapter: SandboxAdapter | undefined): adapter is SandboxAdapter {
  return Boolean(
    adapter &&
    adapter.platform &&
    adapter.platform !== 'none' &&
    typeof adapter.workspaceRoot === 'string' &&
    adapter.workspaceRoot.trim().length > 0
  )
}
