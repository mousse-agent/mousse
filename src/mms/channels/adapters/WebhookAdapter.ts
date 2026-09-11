import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { ChannelPlatformConfig, ChannelStatus } from '../../../shared/types'
import type {
  ChannelAdapter,
  InboundChannelMessage,
  OutboundChannelMessage,
  SendResult
} from '../types'

interface WebhookPayload {
  text?: string
  userId?: string
  userName?: string
  chatId?: string
  chatName?: string
}

export class WebhookAdapter implements ChannelAdapter {
  readonly platform = 'webhook' as const
  private server: Server | null = null
  private inboundHandler: ((message: InboundChannelMessage) => void) | null = null
  private status: ChannelStatus = { platform: 'webhook', state: 'disconnected' }
  private pendingReplies = new Map<string, string[]>()
  private listenPort: number | null = null
  private closing = false
  private readonly inFlight = new Set<Promise<void>>()
  private closeWaiters: Array<() => void> = []

  constructor(private config: ChannelPlatformConfig) {}

  getListenPort(): number | null {
    return this.listenPort
  }

  setInboundHandler(handler: (message: InboundChannelMessage) => void): void {
    this.inboundHandler = handler
  }

  getStatus(): ChannelStatus {
    return { ...this.status }
  }

  async connect(signal?: AbortSignal): Promise<void> {
    const port = this.config.webhookPort ?? 18789
    this.closing = false
    this.status = { platform: 'webhook', state: 'connecting' }

    this.server = createServer((req, res) => {
      const work = this.handleRequest(req, res)
      this.inFlight.add(work)
      void work.finally(() => {
        this.inFlight.delete(work)
        if (this.closing && this.inFlight.size === 0) {
          for (const waiter of this.closeWaiters.splice(0)) waiter()
        }
      })
    })

    const onAbort = () => {
      this.server?.close()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject)
        this.server!.listen(port, '127.0.0.1', () => resolve())
      })
      if (signal?.aborted) {
        await this.disconnect()
        throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      }
      const address = this.server.address()
      this.listenPort = typeof address === 'object' && address ? address.port : port
      this.status = {
        platform: 'webhook',
        state: 'connected',
        connectedAt: new Date().toISOString()
      }
    } catch (error) {
      await this.disconnect().catch(() => undefined)
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async disconnect(): Promise<void> {
    this.closing = true
    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
    if (this.inFlight.size > 0) {
      await new Promise<void>((resolve) => {
        if (this.inFlight.size === 0) {
          resolve()
          return
        }
        this.closeWaiters.push(resolve)
      })
    }
    this.listenPort = null
    this.status = { platform: 'webhook', state: 'disconnected' }
  }

  async send(message: OutboundChannelMessage): Promise<SendResult> {
    const queue = this.pendingReplies.get(message.chatId) ?? []
    queue.push(message.text)
    this.pendingReplies.set(message.chatId, queue)
    return { success: true }
  }

  consumeReplies(chatId: string): string[] {
    const replies = this.pendingReplies.get(chatId) ?? []
    this.pendingReplies.delete(chatId)
    return replies
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closing) {
      res.writeHead(503)
      res.end('Shutting down')
      return
    }
    if (req.method !== 'POST' || req.url !== '/channels/webhook') {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const secret = this.config.webhookSecret?.trim()
    if (secret) {
      const header = req.headers['x-mousse-secret']
      if (header !== secret) {
        res.writeHead(401)
        res.end('Unauthorized')
        return
      }
    }

    try {
      const body = await readBody(req)
      if (this.closing) {
        res.writeHead(503)
        res.end('Shutting down')
        return
      }
      const payload = JSON.parse(body) as WebhookPayload
      const text = String(payload.text ?? '').trim()
      if (!text) {
        res.writeHead(400)
        res.end('Missing text')
        return
      }

      const chatId = String(payload.chatId ?? 'local')
      const userId = String(payload.userId ?? 'local-user')

      this.inboundHandler?.({
        platform: 'webhook',
        chatId,
        chatName: payload.chatName ?? 'Webhook',
        chatType: 'dm',
        userId,
        userName: payload.userName ?? userId,
        text
      })

      const replies: string[] = []
      const deadline = Date.now() + 120_000
      while (!this.closing && Date.now() < deadline) {
        const pending = this.consumeReplies(chatId)
        if (pending.length > 0) {
          replies.push(...pending)
          break
        }
        await sleep(250)
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ replies }))
    } catch (err) {
      res.writeHead(500)
      res.end(err instanceof Error ? err.message : 'Internal error')
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
