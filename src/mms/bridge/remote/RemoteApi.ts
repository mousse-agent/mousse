import type { RpcId, NodeId, UserId } from '../../../shared/net'
import { NetError } from '../../../shared/net'
import type { Clock, RpcContext, RpcDispatcher, RpcMethod } from '../../net/contracts'
import {
  BRIDGE_REMOTE_METHODS,
  type BridgeOrdinaryMethod,
  type BridgeRemoteMethod
} from './capabilities'
import { validateRemoteParams } from './dto'

export interface RemoteBackendPort {
  execute(method: BridgeOrdinaryMethod, params: Record<string, unknown>): Promise<unknown>
  snapshot(threadId: string): unknown
  /** Must bind signal to this exact admitted run and return only after its lease/turn settles. */
  run(
    threadId: string,
    content: string,
    control: { signal: AbortSignal; drainSteer(): string | undefined }
  ): Promise<unknown>
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
      this.runs.set(context.id, run)
      const stop = (): void => abort.abort()
      context.signal.addEventListener('abort', stop, { once: true })
      const timer = this.clock.setTimeout(stop, Math.max(0, context.deadlineAt - this.clock.now()))
      try {
        const result = await this.backend.run(threadId, params.content as string, {
          signal: abort.signal,
          drainSteer: () => {
            const text = run.pending.shift()
            if (text !== undefined) run.bytes -= Buffer.byteLength(text)
            return text
          }
        })
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
  }
}
