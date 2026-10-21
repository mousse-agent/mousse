import type { RpcId, NodeId, UserId } from '../../../shared/net'
import { NetError } from '../../../shared/net'
import type { Clock, RpcContext, RpcDispatcher, RpcMethod } from '../../net/contracts'
import {
  BRIDGE_REMOTE_METHODS,
  type BridgeOrdinaryMethod,
  type BridgeRemoteMethod
} from './capabilities'
import { REMOTE_ATTACHMENT_MAX_CHARS, validateRemoteParams } from './dto'

/** A chat mode a remote node may pick: built-in, or one skill. */
export type RemoteChatMode = string | { type: 'skill'; skillId: string }
export interface RemoteImage {
  name: string
  mimeType: string
  /** Base64 without a `data:` prefix. */
  data: string
}
/** What a remote send or queued message carries besides its text. */
export interface RemoteChatExtras {
  mode?: RemoteChatMode
  images?: RemoteImage[]
}

export interface RemoteBackendPort {
  /** `queue.enqueue` params carry resolved `images` instead of staged `attachments`. */
  execute(method: BridgeOrdinaryMethod, params: Record<string, unknown>): Promise<unknown>
  snapshot(threadId: string): unknown
  /** Must bind signal to this exact admitted run and return only after its lease/turn settles. */
  run(
    threadId: string,
    content: string,
    control: { signal: AbortSignal; drainSteer(): string | undefined },
    extras?: RemoteChatExtras
  ): Promise<unknown>
}

/** How long a staged image waits for the send that uses it. */
export const STAGED_UPLOAD_TTL_MS = 10 * 60 * 1000
/**
 * An expected refusal, answered as `{ ok: false, error }` (or a run's `error`) instead of a thrown
 * error: a mutating handler that throws reports an uncertain outcome, which hides the reason.
 */
class RemoteInputError extends Error {}
const STAGED_UPLOADS_PER_CALLER = 32
const STAGED_UPLOADS_TOTAL = 128
interface StagedUpload {
  user: UserId
  name: string
  mimeType: string
  chunks: Array<string | undefined>
  received: number
  chars: number
  updatedAt: number
}
interface OwnedRun {
  threadId: string
  caller: NodeId
  user: UserId
  abort: AbortController
  pending: string[]
  bytes: number
}
export class RemoteApi {
  private runs = new Map<RpcId, OwnedRun>()
  /** Images staged chunk by chunk, keyed by caller node and upload id; memory only. */
  private uploads = new Map<string, StagedUpload>()
  constructor(
    private readonly backend: RemoteBackendPort,
    private readonly clock: Clock
  ) {}
  register(dispatcher: RpcDispatcher): void {
    for (const method of this.methods()) dispatcher.register(method)
  }
  methods(): Array<RpcMethod & { validate(params: unknown): unknown }> {
    return (Object.keys(BRIDGE_REMOTE_METHODS) as BridgeRemoteMethod[]).map((method) => ({
      method,
      ...BRIDGE_REMOTE_METHODS[method],
      validate: (params) => {
        validateRemoteParams(method, params)
        return params
      },
      handle: (params, context) => this.handle(method, params, context)
    }))
  }
  private async handle(
    method: BridgeRemoteMethod,
    params: unknown,
    context: RpcContext
  ): Promise<unknown> {
    validateRemoteParams(method, params)
    if (context.signal.aborted) throw new NetError('cancelled')
    if (context.deadlineAt <= this.clock.now()) throw new NetError('deadline_exceeded')
    if (method === 'thread.snapshot') return this.backend.snapshot(params.threadId as string)
    if (method === 'attachments.stage') {
      try {
        return this.stage(params, context)
      } catch (error) {
        if (error instanceof RemoteInputError) return { ok: false, error: error.message }
        throw error
      }
    }
    if (method === 'queue.enqueue') {
      const { attachments: _staged, ...rest } = params
      let extras: RemoteChatExtras
      try {
        extras = this.extras(params, context)
      } catch (error) {
        if (error instanceof RemoteInputError) return { ok: false, error: error.message }
        throw error
      }
      return this.backend.execute(method, {
        ...rest,
        ...(extras.images ? { images: extras.images } : {})
      })
    }
    if (method === 'orchestrator.send') {
      const threadId = params.threadId as string
      if (this.runs.size >= 64) throw new NetError('rate_limited', 'Remote run capacity is full.')
      if ([...this.runs.values()].some((run) => run.threadId === threadId))
        throw new NetError('rate_limited', 'This thread already has a remote-owned run.')
      const abort = new AbortController(),
        run: OwnedRun = {
          threadId,
          caller: context.caller.node,
          user: context.caller.user,
          abort,
          pending: [],
          bytes: 0
        }
      let extras: RemoteChatExtras
      try {
        extras = this.extras(params, context)
      } catch (error) {
        if (error instanceof RemoteInputError)
          return { text: '', silent: false, error: error.message }
        throw error
      }
      this.runs.set(context.id, run)
      const stop = (): void => abort.abort()
      context.signal.addEventListener('abort', stop, { once: true })
      const timer = this.clock.setTimeout(stop, Math.max(0, context.deadlineAt - this.clock.now()))
      try {
        const result = await this.backend.run(
          threadId,
          params.content as string,
          {
            signal: abort.signal,
            drainSteer: () => {
              const text = run.pending.shift()
              if (text !== undefined) run.bytes -= Buffer.byteLength(text)
              return text
            }
          },
          extras
        )
        if (abort.signal.aborted) throw new NetError('cancelled')
        return result
      } finally {
        timer.cancel()
        context.signal.removeEventListener('abort', stop)
        this.runs.delete(context.id)
      }
    }
    if (method === 'orchestrator.abort' || method === 'orchestrator.steer') {
      const run = this.runs.get(params.run as RpcId)
      if (!run) return { ok: false }
      if (
        run.threadId !== params.threadId ||
        run.caller !== context.caller.node ||
        run.user !== context.caller.user
      )
        throw new NetError('forbidden')
      if (method === 'orchestrator.abort') {
        run.abort.abort()
        return { ok: true }
      }
      if (run.abort.signal.aborted) return { ok: false }
      const text = params.text as string,
        bytes = Buffer.byteLength(text)
      if (run.pending.length >= 32 || run.bytes + bytes > 128 * 1024)
        throw new NetError('rate_limited')
      run.pending.push(text)
      run.bytes += bytes
      return { ok: true }
    }
    return this.backend.execute(method, params)
  }
  close(): void {
    for (const run of this.runs.values()) run.abort.abort()
    this.uploads.clear()
  }
  /** Stores one chunk of an image; a repeated chunk (a retried request) is accepted once. */
  private stage(params: Record<string, unknown>, context: RpcContext): unknown {
    this.sweep()
    const key = context.caller.node + ':' + (params.upload as string),
      total = params.total as number,
      index = params.index as number,
      data = params.data as string
    let upload = this.uploads.get(key)
    if (upload && upload.user !== context.caller.user) throw new NetError('forbidden')
    if (
      upload &&
      (upload.chunks.length !== total ||
        upload.name !== params.name ||
        upload.mimeType !== params.mimeType)
    )
      throw new RemoteInputError('The image changed while it was uploading.')
    if (!upload) {
      const mine = [...this.uploads.keys()].filter((entry) =>
        entry.startsWith(context.caller.node + ':')
      ).length
      if (mine >= STAGED_UPLOADS_PER_CALLER || this.uploads.size >= STAGED_UPLOADS_TOTAL)
        throw new RemoteInputError('Too many images are waiting to be sent.')
      upload = {
        user: context.caller.user,
        name: params.name as string,
        mimeType: params.mimeType as string,
        chunks: new Array<string | undefined>(total).fill(undefined),
        received: 0,
        chars: 0,
        updatedAt: this.clock.now()
      }
      this.uploads.set(key, upload)
    }
    const existing = upload.chunks[index]
    if (existing === undefined) {
      if (upload.chars + data.length > REMOTE_ATTACHMENT_MAX_CHARS) {
        this.uploads.delete(key)
        throw new RemoteInputError('The image is too large.')
      }
      upload.chunks[index] = data
      upload.received++
      upload.chars += data.length
    } else if (existing !== data)
      throw new RemoteInputError('The image changed while it was uploading.')
    upload.updatedAt = this.clock.now()
    return { ok: true, received: upload.received, total }
  }
  /** Resolves a request's mode and staged images; the images are consumed. */
  private extras(params: Record<string, unknown>, context: RpcContext): RemoteChatExtras {
    const extras: RemoteChatExtras = {}
    if (params.mode !== undefined) extras.mode = params.mode as RemoteChatMode
    const ids = params.attachments as string[] | undefined
    if (!ids) return extras
    this.sweep()
    const images: RemoteImage[] = []
    for (const id of ids) {
      const upload = this.uploads.get(context.caller.node + ':' + id)
      if (
        !upload ||
        upload.user !== context.caller.user ||
        upload.received !== upload.chunks.length
      )
        throw new RemoteInputError('An attached image did not finish uploading. Attach it again.')
      const data = upload.chunks.join('')
      if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
        throw new RemoteInputError('An attached image could not be read. Attach it again.')
      images.push({ name: upload.name, mimeType: upload.mimeType, data })
    }
    for (const id of ids) this.uploads.delete(context.caller.node + ':' + id)
    extras.images = images
    return extras
  }
  private sweep(): void {
    const now = this.clock.now()
    for (const [key, upload] of this.uploads)
      if (now - upload.updatedAt > STAGED_UPLOAD_TTL_MS) this.uploads.delete(key)
  }
}
