import { spawn, type ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { abortFrom } from './mcpOwnedWork'
import { terminateOwnedStdioTree } from './ownedProcessTree'

export interface OwnedStdioServerParameters {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  signal?: AbortSignal
  closeTimeoutMs?: number
}

const DEFAULT_CLOSE_TIMEOUT_MS = 15_000

/**
 * MCP stdio transport that keeps the exact ChildProcess handle through close.
 * SDK 1.29 StdioClientTransport.clear `_process` before the child exits and
 * returns after SIGKILL without waiting, so it cannot own descendants.
 */
export class OwnedStdioClientTransport implements Transport {
  private child?: ChildProcess
  private readonly readBuffer = new ReadBuffer()
  private readonly stderrStream = new PassThrough()
  private started = false
  private closed = false
  private closePromise?: Promise<void>
  private readonly abort: AbortSignal | undefined
  private readonly closeTimeoutMs: number

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  constructor(private readonly server: OwnedStdioServerParameters) {
    this.abort = server.signal
    this.closeTimeoutMs = server.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
  }

  get stderr(): PassThrough {
    return this.stderrStream
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  get spawned(): ChildProcess | undefined {
    return this.child
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('Owned stdio MCP transport is closed')
    if (this.started || this.child) {
      throw new Error(
        'OwnedStdioClientTransport already started! If using Client class, note that connect() calls start() automatically.'
      )
    }
    if (this.abort?.aborted) throw abortFrom(this.abort.reason)
    this.started = true

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        this.abort?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      const child = spawn(this.server.command, this.server.args ?? [], {
        env: {
          ...getDefaultEnvironment(),
          ...this.server.env
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: process.platform === 'win32',
        cwd: this.server.cwd
      })
      this.child = child

      const onAbort = (): void => {
        void this.close().finally(() => finish(abortFrom(this.abort?.reason)))
      }
      if (this.abort?.aborted) {
        onAbort()
        return
      }
      this.abort?.addEventListener('abort', onAbort, { once: true })

      child.once('error', (error) => {
        const err = error instanceof Error ? error : new Error(String(error))
        this.onerror?.(err)
        void this.close().finally(() => finish(err))
      })
      child.once('spawn', () => {
        if (this.abort?.aborted) {
          onAbort()
          return
        }
        finish()
      })
      child.once('close', () => {
        this.onclose?.()
      })
      child.stdin?.on('error', (error) => {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
      })
      child.stdout?.on('data', (chunk) => {
        this.readBuffer.append(Buffer.from(chunk))
        this.processReadBuffer()
      })
      child.stdout?.on('error', (error) => {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
      })
      if (child.stderr) child.stderr.pipe(this.stderrStream)
    })
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    const work = this.closeOwned().catch((error) => {
      if (this.closePromise === work) this.closePromise = undefined
      throw error
    })
    this.closePromise = work
    return work
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin
    if (!stdin || this.closed) throw new Error('Not connected')
    const json = serializeMessage(message)
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error | null): void => {
        if (settled) return
        settled = true
        stdin.off('error', onError)
        stdin.off('close', onClose)
        if (error) reject(error)
        else resolve()
      }
      const onError = (error: Error): void => finish(error)
      const onClose = (): void => finish(new Error('MCP stdio closed before the message was written'))
      stdin.once('error', onError)
      stdin.once('close', onClose)
      try {
        stdin.write(json, (error) => finish(error))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this.readBuffer.readMessage()
        if (message === null) break
        this.onmessage?.(message)
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private async closeOwned(): Promise<void> {
    const child = this.child
    this.readBuffer.clear()
    try {
      this.stderrStream.end()
    } catch {
      /* ignore */
    }
    if (!child) {
      this.onclose?.()
      return
    }
    try {
      child.stdin?.end()
    } catch {
      /* ignore */
    }
    await terminateOwnedStdioTree(child, this.closeTimeoutMs)
  }
}
