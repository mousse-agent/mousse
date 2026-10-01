import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type {
  InterpreterResolver,
  ScriptSpawnRequest,
  ScriptSpawnResult
} from '../../shared/workflows'
import { killProcessTree } from './processTree'

const DEFAULT_INTERPRETERS: InterpreterResolver = {
  resolve(runtime) {
    switch (runtime) {
      case 'node':
        return { command: process.execPath, prefixArgs: [] }
      case 'python':
        return { command: process.platform === 'win32' ? 'python' : 'python3', prefixArgs: [] }
      case 'powershell':
        return {
          command: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
          prefixArgs: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']
        }
      case 'bash':
        return { command: 'bash', prefixArgs: [] }
      default:
        throw new Error(`Unsupported script runtime ${runtime as string}`)
    }
  }
}

export class ScriptRunner {
  constructor(private readonly interpreters: InterpreterResolver = DEFAULT_INTERPRETERS) {}

  hashFile(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  }

  async run(request: ScriptSpawnRequest): Promise<ScriptSpawnResult> {
    if (request.signal.aborted) throw new Error('cancelled')
    const resolved = this.interpreters.resolve(request.runtime)
    const args = [...resolved.prefixArgs, request.scriptPath, ...request.argv]
    const env: NodeJS.ProcessEnv = { ...request.env }
    // Scrub ambient secrets; only the allowlisted env is passed in request.env.
    delete env.NODE_OPTIONS
    if (request.runtime === 'node' && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    else delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(resolved.command, args, {
      cwd: request.cwd,
      env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const pid = child.pid
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let truncated = false
    let timedOut = false
    const onAbort = () => {
      if (pid) killProcessTree(pid)
    }
    request.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      if (pid) killProcessTree(pid)
    }, request.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk])
      if (stdout.byteLength > request.maxStdoutBytes) {
        truncated = true
        stdout = stdout.subarray(0, request.maxStdoutBytes)
        if (pid) killProcessTree(pid)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk])
      if (stderr.byteLength > request.maxStderrBytes) {
        truncated = true
        stderr = stderr.subarray(0, request.maxStderrBytes)
        if (pid) killProcessTree(pid)
      }
    })
    if (request.stdin) {
      child.stdin?.write(request.stdin)
    }
    child.stdin?.end()

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(null))
      child.on('close', (code) => resolve(code))
    })
    clearTimeout(timer)
    request.signal.removeEventListener('abort', onAbort)
    return {
      exitCode,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      pid,
      timedOut,
      truncated
    }
  }
}

export const defaultInterpreterResolver = DEFAULT_INTERPRETERS
