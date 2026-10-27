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
  execute(method: BridgeOrdinaryMethod, params: Record<string, unknown>, caller?: { node: NodeId }): Promise<unknown>
  snapshot(threadId: string): unknown
  /**
   * Must bind signal to this exact admitted run and return only after its lease/turn settles.
   * `onAccepted` is called once the message is stored on the thread, never for a turn that was
   * refused or cancelled before that.
   */
  run(
    threadId: string,
    content: string,
    control: { signal: AbortSignal; drainSteer(): string | undefined; onAccepted(): void },
    extras?: RemoteChatExtras
  ): Promise<unknown>
  /** A remote Stop also stops the thread and every subagent below it (the run's own signal ends only the turn it carries). */
  stop?(threadId: string): Promise<unknown>
  /** Whether the thread has a turn running that is not a remote run (the desktop's, the CLI's, a channel's, a schedule's). */
  isActive?(threadId: string): boolean
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
/** Base64 characters held for one caller, and for everyone, before more images are refused. */
const STAGED_CHARS_PER_CALLER = 24 * 1024 * 1024
const STAGED_CHARS_TOTAL = 48 * 1024 * 1024
/**
 * Base64 characters in one message's images. The message is shown to every remote reader, whose
 * events and snapshots are bounded (25 and 32 MiB), so a larger batch would make the thread
 * unreadable from a phone.
 */
export const REMOTE_MESSAGE_IMAGES_MAX_CHARS = 8 * 1024 * 1024
interface StagedUpload {
  user: UserId
  name: string
  mimeType: string
  chunks: Array<string | undefined>
  received: number
  chars: number
  updatedAt: number
  /** Set while a send or enqueue that uses this image is running; a refusal releases it. */
  claimed: boolean
}
interface ResolvedExtras {
  extras: RemoteChatExtras
  /** Upload keys to delete once the backend accepts the message. */
  keys: string[]
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
  private sweepTimer: { cancel(): void } | undefined
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
      let resolved: ResolvedExtras
      try {
        resolved = this.extras(params, context)
      } catch (error) {
        if (error instanceof RemoteInputError) return { ok: false, error: error.message }
        throw error
      }
      let result: unknown
      try {
        result = await this.backend.execute(method, {
          ...rest,
          ...(resolved.extras.images ? { images: resolved.extras.images } : {})
        })
      } catch (error) {
        this.release(resolved.keys)
        throw error
      }
      this.settle(resolved.keys, (result as { ok?: unknown } | undefined)?.ok !== false)
      return result
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
      let resolved: ResolvedExtras
      try {
        resolved = this.extras(params, context)
      } catch (error) {
        if (error instanceof RemoteInputError)
          return { text: '', silent: false, error: error.message }
        throw error
      }
      let accepted = false
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
            },
            onAccepted: () => {
              accepted = true
            }
          },
          resolved.extras
        )
        if (abort.signal.aborted) throw new NetError('cancelled')
        return result
      } finally {
        this.settle(resolved.keys, accepted)
        timer.cancel()
        context.signal.removeEventListener('abort', stop)
        this.runs.delete(context.id)
      }
    }
    if (method === 'orchestrator.abort' || method === 'orchestrator.steer') {
      const run = this.runs.get(params.run as RpcId)
      if (!run) {
        // No remote run to end: a Stop of the thread still ends its subagents and other work (an idle parent's).
        if (method !== 'orchestrator.abort' || typeof params.threadId !== 'string') return { ok: false }
        // Another caller's remote run on this thread is not this caller's to end, whatever run id it names.
        if ([...this.runs.values()].some((other) => other.threadId === params.threadId && (other.caller !== context.caller.node || other.user !== context.caller.user)))
          throw new NetError('forbidden')
        // A turn someone else is running (the desktop user's, a CLI, channel or schedule) is not a remote caller's to end.
        if (this.backend.isActive?.(params.threadId)) return { ok: false }
        const stopped = (await this.backend.stop?.(params.threadId)) as { ok?: boolean } | undefined
        return { ok: stopped?.ok === true }
      }
      if (
        run.threadId !== params.threadId ||
        run.caller !== context.caller.node ||
        run.user !== context.caller.user
      )
        throw new NetError('forbidden')
      if (method === 'orchestrator.abort') {
        run.abort.abort()
        // The remote turn ends with its signal; the subagents the thread started end with the Stop.
        await this.backend.stop?.(run.threadId)
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
    // A thread remembers the device that created it, so every device can list it.
    if (method === 'threads.create') return this.backend.execute(method, params, { node: context.caller.node })
    return this.backend.execute(method, params)
  }
  close(): void {
    for (const run of this.runs.values()) run.abort.abort()
    this.uploads.clear()
    this.sweepTimer?.cancel()
    this.sweepTimer = undefined
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
        updatedAt: this.clock.now(),
        claimed: false
      }
      this.uploads.set(key, upload)
      this.scheduleSweep()
    }
    const existing = upload.chunks[index]
    if (existing === undefined) {
      if (upload.chars + data.length > REMOTE_ATTACHMENT_MAX_CHARS) {
        this.uploads.delete(key)
        throw new RemoteInputError('The image is too large.')
      }
      if (
        this.stagedChars(context.caller.node + ':') + data.length > STAGED_CHARS_PER_CALLER ||
        this.stagedChars('') + data.length > STAGED_CHARS_TOTAL
      ) {
        this.uploads.delete(key)
        throw new RemoteInputError('Too many images are waiting to be sent.')
      }
      upload.chunks[index] = data
      upload.received++
      upload.chars += data.length
    } else if (existing !== data)
      throw new RemoteInputError('The image changed while it was uploading.')
    upload.updatedAt = this.clock.now()
    return { ok: true, received: upload.received, total }
  }
  /** Resolves a request's mode and staged images; the images stay claimed until settled. */
  private extras(params: Record<string, unknown>, context: RpcContext): ResolvedExtras {
    const extras: RemoteChatExtras = {}
    if (params.mode !== undefined) extras.mode = params.mode as RemoteChatMode
    const ids = params.attachments as string[] | undefined
    if (!ids) return { extras, keys: [] }
    this.sweep()
    const keys = ids.map((id) => context.caller.node + ':' + id),
      images: RemoteImage[] = []
    let total = 0
    for (const key of keys) {
      const upload = this.uploads.get(key)
      if (
        !upload ||
        upload.claimed ||
        upload.user !== context.caller.user ||
        upload.received !== upload.chunks.length
      )
        throw new RemoteInputError('An attached image did not finish uploading. Attach it again.')
      total += upload.chars
      if (total > REMOTE_MESSAGE_IMAGES_MAX_CHARS)
        throw new RemoteInputError('These images are too large to send together. Send fewer.')
      const data = upload.chunks.join('')
      if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
        throw new RemoteInputError('An attached image could not be read. Attach it again.')
      images.push({ name: upload.name, mimeType: upload.mimeType, data })
    }
    for (const key of keys) this.uploads.get(key)!.claimed = true
    if (images.length) extras.images = images
    return { extras, keys }
  }
  /** Single use on success; a refused message gives its images back so the phone can retry. */
  private settle(keys: string[], accepted: boolean): void {
    if (accepted) for (const key of keys) this.uploads.delete(key)
    else this.release(keys)
  }
  private release(keys: string[]): void {
    for (const key of keys) {
      const upload = this.uploads.get(key)
      if (upload) {
        upload.claimed = false
        upload.updatedAt = this.clock.now()
      }
    }
    this.scheduleSweep()
  }
  private stagedChars(prefix: string): number {
    let chars = 0
    for (const [key, upload] of this.uploads) if (key.startsWith(prefix)) chars += upload.chars
    return chars
  }
  private sweep(): void {
    const now = this.clock.now()
    for (const [key, upload] of this.uploads)
      if (!upload.claimed && now - upload.updatedAt > STAGED_UPLOAD_TTL_MS) this.uploads.delete(key)
  }
  /** One owned timer expires abandoned uploads without waiting for another request. */
  private scheduleSweep(): void {
    if (this.sweepTimer) return
    // A claimed upload belongs to a running send; release() arms the timer again when it ends.
    const idle = [...this.uploads.values()].filter((upload) => !upload.claimed)
    if (idle.length === 0) return
    const oldest = Math.min(...idle.map((upload) => upload.updatedAt))
    const delay = Math.max(0, oldest + STAGED_UPLOAD_TTL_MS + 1 - this.clock.now())
    this.sweepTimer = this.clock.setTimeout(() => {
      this.sweepTimer = undefined
      this.sweep()
      this.scheduleSweep()
    }, delay)
  }
}
