export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
    return code === 'EPERM'
  }
}

/** Kill only this PID (and on Windows its PID tree). Never matches by process name. */
export async function stopOwnedPid(pid: number, timeoutMs = 5_000): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return
  try { process.kill(pid) } catch { /* already gone or no permission */ }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!isProcessAlive(pid)) return
  if (process.platform === 'win32') {
    const { spawn } = await import('node:child_process')
    await new Promise<void>((resolve) => {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      child.on('exit', () => resolve())
      child.on('error', () => resolve())
      setTimeout(resolve, 3_000)
    })
    const verifyDeadline = Date.now() + 3_000
    while (Date.now() < verifyDeadline && isProcessAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 50))
    return
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
}
