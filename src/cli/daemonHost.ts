/**
 * Lowest-cost supported host for the packaged MMS daemon (node-pty ABI).
 * Prefer ELECTRON_RUN_AS_NODE only when the packaged entry can load Electron-ABI node-pty;
 * otherwise retain headless Electron dual-mode (`Mousse.exe --cli`).
 * koffi remains Electron-local and is not required for daemon host selection.
 */

import { existsSync } from 'fs'
import { createRequire } from 'module'
import { basename, dirname, join } from 'path'
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
 * ELECTRON_RUN_AS_NODE is only selected when explicitly available and caller marks probe OK.
 */
export function resolveDaemonHostInvocation(
  scriptPath?: string,
  opts?: {
    /** When true, allow ELECTRON_RUN_AS_NODE path (after external probe). */
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
    if (opts?.preferRunAsNode && opts.nodePtyOk) {
      // Only when explicitly probed OK under ELECTRON_RUN_AS_NODE.
      const electronBin = process.execPath
      const cliEntry =
        scriptPath && existsSync(scriptPath)
          ? scriptPath
          : join(dirname(process.execPath), 'resources', 'app.asar', 'out', 'cli', 'index.js')
      return {
        mode: 'electron-run-as-node',
        command: electronBin,
        argsPrefix: [cliEntry],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          MOUSSE_CLI: '1'
        },
        reason:
          'ELECTRON_RUN_AS_NODE with probed node-pty load (Electron ABI); koffi not required for daemon',
        nodePtyOk: true
      }
    }

    return {
      mode: 'electron-dual-mode',
      command: base.command,
      argsPrefix: base.argsPrefix,
      env: { ...base.env, MOUSSE_CLI: '1' },
      reason:
        'Headless Electron dual-mode (--cli) for Electron-ABI native modules (node-pty). ' +
        'ELECTRON_RUN_AS_NODE not selected without a successful node-pty probe.',
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
