import { spawn } from 'node:child_process'

export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
    return
  }
  try {
    process.kill(pid, signal)
  } catch {
    // already exited
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // not a process group leader
  }
}
