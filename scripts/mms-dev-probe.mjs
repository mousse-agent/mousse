import { readFile } from 'fs/promises'
import { createConnection } from 'net'
import { join } from 'path'

const MAX_FRAME_BYTES = 16 * 1024 * 1024

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf-8')
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

async function readOwner(homeDir) {
  const raw = await readFile(join(homeDir, 'mms.owner.json'), 'utf-8')
  const owner = JSON.parse(raw)
  if (
    !owner ||
    typeof owner.token !== 'string' ||
    typeof owner.endpoint !== 'string' ||
    typeof owner.protocolVersion !== 'number'
  ) {
    throw new Error('MMS owner record is not ready')
  }
  return owner
}

/**
 * Small dependency-free protocol client used only by the dev process. Keeping this
 * outside the watched CLI bundle lets the runner inspect the old daemon after a
 * rebuild, before deciding whether it is safe to replace it.
 */
class DevProbeClient {
  constructor(owner) {
    this.owner = owner
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.pending = new Map()
    this.nextId = 0
    this.hello = null
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = createConnection(this.owner.endpoint)
      this.socket = socket
      let settled = false

      const fail = (error) => {
        if (!settled) {
          settled = true
          reject(error)
        }
        this.rejectPending(error)
      }

      socket.on('connect', () => {
        socket.write(
          encodeFrame({
            kind: 'hello',
            protocolVersion: this.owner.protocolVersion,
            ownerToken: this.owner.token,
            clientType: 'cli',
            clientBuild: 'dev-restart-probe'
          })
        )
      })
      socket.on('data', (chunk) => {
        try {
          this.onData(chunk)
          if (!settled && this.hello) {
            settled = true
            resolve()
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
        }
      })
      socket.on('error', fail)
      socket.on('close', () => fail(new Error('MMS probe connection closed')))
    })
  }

  request(method, params) {
    if (!this.socket || this.socket.destroyed || !this.hello) {
      return Promise.reject(new Error('MMS probe is not connected'))
    }
    const id = `dev-probe-${++this.nextId}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.socket.write(encodeFrame({ kind: 'req', id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  close() {
    const socket = this.socket
    this.socket = null
    this.rejectPending(new Error('MMS probe closed'))
    if (!socket) return
    socket.removeAllListeners()
    socket.destroy()
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk)
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE(0)
      if (size > MAX_FRAME_BYTES) throw new Error(`MMS probe frame is too large: ${size}`)
      if (this.buffer.length < size + 4) return
      const body = this.buffer.subarray(4, size + 4)
      this.buffer = this.buffer.subarray(size + 4)
      this.handleEnvelope(JSON.parse(body.toString('utf-8')))
    }
  }

  handleEnvelope(envelope) {
    if (envelope?.kind === 'hello_ok') {
      this.hello = envelope
      return
    }
    if (envelope?.kind === 'hello_err') {
      throw new Error(`MMS probe hello rejected: ${envelope.message ?? envelope.code}`)
    }
    if (envelope?.kind !== 'res' || typeof envelope.id !== 'string') return
    const pending = this.pending.get(envelope.id)
    if (!pending) return
    this.pending.delete(envelope.id)
    if (envelope.ok) pending.resolve(envelope.result)
    else pending.reject(new Error(envelope.error?.message ?? 'MMS probe request failed'))
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

/** Return whether replacing the daemon would interrupt a main orchestrator turn. */
export async function probeMmsActiveTurn(homeDir, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 3_000
  let client
  const operation = async () => {
    const owner = await readOwner(homeDir)
    client = new DevProbeClient(owner)
    try {
      await client.connect()
      const listed = await client.request('threads.list')
      const threads = Array.isArray(listed?.threads) ? listed.threads : []

      // Keep below the protocol pending-request cap even for very large histories.
      for (let offset = 0; offset < threads.length; offset += 32) {
        const batch = threads.slice(offset, offset + 32)
        const activity = await Promise.all(
          batch.map(async (thread) => {
            if (!thread || typeof thread.id !== 'string') return null
            const result = await client.request('orchestrator.isTurnActive', {
              threadId: thread.id
            })
            return result?.active || result?.running ? thread.id : null
          })
        )
        const threadId = activity.find((id) => typeof id === 'string')
        if (threadId) return { active: true, threadId }
      }
      return { active: false }
    } finally {
      client.close()
    }
  }

  let timer
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => {
            client?.close()
            reject(new Error(`MMS activity probe timed out after ${timeoutMs}ms`))
          },
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
