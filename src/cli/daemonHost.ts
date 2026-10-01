/**
 * Credential-capable host for the packaged MMS daemon.
 * Headless Electron dual-mode preserves safeStorage and the node-pty ABI.
 * koffi remains Electron-local and is not required for daemon host selection.
 */

import { createRequire } from 'module'
import { basename } from 'path'
import {
  isElectronMainProcess,
  resolveCliInvocation,
  resolvePackagedCliLauncher
} from './cliLaunch'

export type DaemonHostMode =
  | 'electron-dual-mode'
  | 'electron-run-as-node'
  | 'system-node'
  | 'unknown'

export interface DaemonHostResolution {
  mode: DaemonHostMode
  command: string
  argsPrefix: string[]
  env: NodeJS.ProcessEnv
  /** Human-readable reason for the choice / fallback. */
  reason: string
  /** Whether node-pty probe passed for this host (when probed). */
  nodePtyOk?: boolean
}

/**
 * Probe whether node-pty can load in the *current* process (smoke / test helper).
 * Does not spawn children.
 */
export function probeNodePtyInCurrentProcess(): { ok: boolean; error?: string } {
  try {
    // The CLI bundle is ESM; createRequire keeps the native addon probe synchronous.
    const requireFromHere = createRequire(import.meta.url)
    const pty = requireFromHere('node-pty') as { spawn?: unknown }
    if (!pty || typeof pty.spawn !== 'function') {
      return { ok: false, error: 'node-pty loaded but spawn is missing' }
    }
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * Resolve how to spawn the packaged/local MMS daemon host.
 * Prefer dual-mode Electron when already in Electron or packaged launcher requires it.
 * A successful node-pty probe alone cannot make Node safeStorage-capable.
 */
export function resolveDaemonHostInvocation(
  scriptPath?: string,
  opts?: {
    /** @deprecated Retained for callers; safeStorage requires Electron main mode. */
    preferRunAsNode?: boolean
    /** Result of probing node-pty under the candidate host. */
    nodePtyOk?: boolean
  }
): DaemonHostResolution {
  const base = resolveCliInvocation(scriptPath)
  const packaged = resolvePackagedCliLauncher()
  const inElectron = isElectronMainProcess()
  const execBase = basename(process.execPath).toLowerCase()
  const isMousseExe =
    execBase === 'mousse.exe' || execBase === 'mousse' || execBase.includes('electron')

  // System Node CLI build (out/cli) — only if not inside Electron package.
  if (!inElectron && !packaged && process.execPath && !isMousseExe) {
    const probe = opts?.nodePtyOk ?? probeNodePtyInCurrentProcess().ok
    if (probe) {
      return {
        mode: 'system-node',
        command: base.command,
        argsPrefix: base.argsPrefix,
        env: base.env,
        reason: 'System Node with loadable node-pty',
        nodePtyOk: true
      }
    }
    return {
      mode: 'system-node',
      command: base.command,
      argsPrefix: base.argsPrefix,
      env: base.env,
      reason:
        'System Node selected but node-pty failed to load — PTY features may be unavailable',
      nodePtyOk: false
    }
  }

  // Prefer dual-mode Electron: Mousse.exe --cli (matches Electron ABI for node-pty).
  if (inElectron || packaged || isMousseExe) {
    return {
      mode: 'electron-dual-mode',
      command: base.command,
      argsPrefix: base.argsPrefix,
      env: { ...base.env, MOUSSE_CLI: '1' },
      reason:
        'Headless Electron dual-mode (--cli) for Electron-ABI native modules (node-pty). ' +
        'Electron safeStorage is required even when node-pty can load under Node.',
      nodePtyOk: opts?.nodePtyOk
    }
  }

  return {
    mode: 'unknown',
    command: base.command,
    argsPrefix: base.argsPrefix,
    env: base.env,
    reason: 'Fallback to default CLI invocation',
    nodePtyOk: opts?.nodePtyOk
  }
}
