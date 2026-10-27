import { spawn } from 'node:child_process'
import { WorkerHandle } from '../../../../src/mms/terminals/WorkerHandle'
import type { ProcessLifecycleController } from '../../../../src/mms/terminals/processLifecycle'

/**
 * Runs a shell command as a plain (non-PTY) child owned by `controller`, keeping its stdout and
 * stderr pipes open so inherited pipes hold the worker until every descendant exits. Real-process
 * evidence for the lifecycle controller outside a PTY.
 */
export function spawnOwnedShell(
  controller: ProcessLifecycleController,
  id: string,
  cwd: string,
  command: string,
  env: Record<string, string> = {}
): void {
  controller.assertAdmits('create')
  const [shell, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command]]
    : [process.env.SHELL || 'bash', ['-lc', command]]
  const child = spawn(shell, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const handle = new WorkerHandle(id, id, controller.runner)
  const pid = typeof child.pid === 'number' && child.pid > 0 ? child.pid : undefined
  controller.track({
    id,
    agentId: id,
    kind: controller.runner,
    pid,
    handle,
    signaled: false,
    signalLocal: (force) => {
      // On Windows the tree signal (taskkill /T) owns termination; killing the parent first would orphan descendants.
      if (process.platform === 'win32' && pid) return
      try { child.kill(force ? 'SIGKILL' : 'SIGTERM') } catch { /* already exited */ }
    }
  })
  child.stdout.resume()
  child.stderr.resume()
  child.on('error', (error) => { if (handle.alive) handle.recordExit(null, null, error) })
  child.on('exit', (code, signal) => { if (handle.alive) handle.recordExit(code, signal) })
  child.on('close', () => {
    handle.recordClose()
    controller.untrackIfSettled(id)
  })
}
