/**
 * Bounded framed local MMS client for Linux qualification.
 * Speaks the production hello/request protocol over the Unix socket.
 * Not a production CLI path and not a test backdoor in src/.
 */
import { randomBytes } from 'node:crypto'
import { createConnection } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MMS_PROTOCOL_VERSION = 1
export const MMS_PROTOCOL_MAX_FRAME_BYTES = 4 * 1024 * 1024
export const QUAL_CAPABILITIES = [
  'profiles-v1',
  'workflows.definitions.v1',
  'workflowRuns.v1',
  'browser.setup.v1'
]

export function encodeFrame(value, maxBytes = MMS_PROTOCOL_MAX_FRAME_BYTES) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.length > maxBytes) throw new Error(`Frame size ${body.length} exceeds max ${maxBytes}`)
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

export class FrameDecoder {
  constructor(maxBytes = MMS_PROTOCOL_MAX_FRAME_BYTES) {
    this.maxBytes = maxBytes
    this.buffer = Buffer.alloc(0)
  }

  push(chunk) {
    if (!chunk.length) return
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    if (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0)
      if (len > this.maxBytes) {
        this.buffer = Buffer.alloc(0)
        throw new Error(`Frame size ${len} exceeds max ${this.maxBytes}`)
      }
    }
  }

  shift() {
    if (this.buffer.length < 4) return null
    const len = this.buffer.readUInt32BE(0)
    if (this.buffer.length < 4 + len) return null
    const body = this.buffer.subarray(4, 4 + len)
    this.buffer = this.buffer.subarray(4 + len)
    return JSON.parse(body.toString('utf8'))
  }

  shiftAll() {
    const frames = []
    for (;;) {
      const next = this.shift()
      if (next == null) return frames
      frames.push(next)
    }
  }
}

export function readOwnerRecord(homeDir) {
  const raw = readFileSync(join(homeDir, 'mms.owner.json'), 'utf8')
  return JSON.parse(raw)
}

export function unixSocketPath(homeDir) {
  return join(homeDir, 'mms.sock')
}

export class QualMmsClient {
  constructor({ homeDir, ownerToken, endpoint, clientType = 'cli', requestTimeoutMs = 20_000, capabilities = QUAL_CAPABILITIES }) {
    this.homeDir = homeDir
    this.ownerToken = ownerToken
    this.endpoint = endpoint ?? unixSocketPath(homeDir)
    this.requestTimeoutMs = requestTimeoutMs
    this.capabilities = capabilities
    this.clientType = clientType
    this.socket = null
    this.decoder = new FrameDecoder()
    this.pending = new Map()
    this.hello = null
  }

  connect() {
    if (this.hello && this.socket && !this.socket.destroyed) return Promise.resolve(this.hello)
    this.decoder = new FrameDecoder()
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.endpoint)
      this.socket = socket
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.removeAllListeners()
        socket.destroy()
        this.socket = null
        reject(err instanceof Error ? err : new Error(String(err)))
      }
      const timer = setTimeout(() => fail(new Error('Hello timeout')), 10_000)
      socket.on('connect', () => {
        socket.write(
          encodeFrame({
            kind: 'hello',
            protocolVersion: MMS_PROTOCOL_VERSION,
            ownerToken: this.ownerToken,
            clientType: this.clientType,
            clientBuild: 'linux-qualification',
            requestedCapabilities: this.capabilities
          })
        )
      })
      socket.on('data', (chunk) => {
        if (settled) {
          this.onData(chunk)
          return
        }
        try {
          this.decoder.push(chunk)
          const frames = this.decoder.shiftAll()
          const rest = []
          for (const frame of frames) {
            if (!settled && frame?.kind === 'hello_ok') {
              settled = true
              clearTimeout(timer)
              this.hello = frame
              socket.on('error', (err) => this.onDisconnect(err))
              socket.on('close', () => this.onDisconnect(new Error('Connection closed')))
              resolve(frame)
              continue
            }
            if (!settled && frame?.kind === 'hello_err') {
              fail(new Error(`Hello rejected: ${frame.code}: ${frame.message}`))
              return
            }
            if (settled) rest.push(frame)
          }
          for (const frame of rest) this.handle(frame)
        } catch (err) {
          fail(err)
        }
      })
      socket.on('error', fail)
      socket.on('close', () => {
        if (!settled) fail(new Error('Connection closed before hello'))
      })
    })
  }

  onData(chunk) {
    this.decoder.push(chunk)
    for (const frame of this.decoder.shiftAll()) this.handle(frame)
  }

  handle(frame) {
    if (frame?.kind === 'res' && frame.id && this.pending.has(frame.id)) {
      const pending = this.pending.get(frame.id)
      this.pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.ok) pending.resolve(frame.result)
      else {
        const err = new Error(frame.error?.message ?? 'Request failed')
        err.code = frame.error?.code
        err.details = frame.error?.details
        pending.reject(err)
      }
      return
    }
    if (frame?.kind === 'error' && frame.id && this.pending.has(frame.id)) {
      const pending = this.pending.get(frame.id)
      this.pending.delete(frame.id)
      clearTimeout(pending.timer)
      pending.reject(new Error(frame.message ?? 'Transport error'))
    }
  }

  onDisconnect(err) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(err instanceof Error ? err : new Error(String(err)))
      this.pending.delete(id)
    }
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('Not connected'))
    const id = randomBytes(8).toString('hex')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      this.socket.write(encodeFrame({ kind: 'req', id, method, params }))
    })
  }

  async close() {
    this.onDisconnect(new Error('Client closed'))
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.destroy()
      this.socket = null
    }
    this.hello = null
  }
}

export async function withQualClient(homeDir, fn) {
  const owner = readOwnerRecord(homeDir)
  if (!owner?.token) throw new Error('Missing owner token')
  const client = new QualMmsClient({
    homeDir,
    ownerToken: owner.token,
    endpoint: owner.endpoint ?? unixSocketPath(homeDir)
  })
  try {
    const hello = await client.connect()
    return await fn(client, hello, owner)
  } finally {
    await client.close().catch(() => undefined)
  }
}
