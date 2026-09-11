/**
 * Bounded reverse command transport: daemon → targeted GUI connection.
 * Command frames never enter event sequencing, subscriptions, or response replay.
 */

import { randomBytes } from 'crypto'
import {
  BROWSER_ATTACHED_DISPATCH_METHOD,
  BROWSER_ATTACHED_V1_CAPABILITY,
  isBrowserAttachedMutationMethod
} from '../../shared/browser/connectionCommands'
import {
  validateBrowserWorkerRequest,
  validateBrowserWorkerResponse
} from '../../shared/browser/envelope'
import type { BrowserWorkerRequest, BrowserWorkerResponse } from '../../shared/browser/types'
import { OwnedWorkBarrier } from '../execution/OwnedWorkBarrier'
import type { TrustedProfileBinding } from './domainRegistry'
import {
  correlationFromMalformedServerReq,
  payloadWithinCommandBound
} from './connectionCommandValidate'
import {
  MMS_PROTOCOL_COMMAND_DEFAULT_TIMEOUT_MS,
  MMS_PROTOCOL_MAX_COMMAND_SEEN_IDS,
  MMS_PROTOCOL_MAX_CONNECTION_COMMANDS,
  MMS_PROTOCOL_MAX_GLOBAL_COMMANDS,
  type ProtocolClientCommandResponse,
  type ProtocolClientType,
  type ProtocolServerCommandCancel,
  type ProtocolServerCommandRequest
} from './types'

export type CommandRevokeReason = 'close' | 'rebind' | 'profile_dispose' | 'shutdown'

export interface CommandConnectionHandle {
  readonly connectionId: string
  readonly clientType: ProtocolClientType
  readonly capabilities: ReadonlySet<string>
  currentBinding(): TrustedProfileBinding | undefined
  send(envelope: ProtocolServerCommandRequest | ProtocolServerCommandCancel): boolean
}

export interface AttachedBrowserCommand {
  readonly commandId: string
  readonly registrationId: string
  readonly registrationEpoch: number
  readonly profileId: string
  readonly profileEpoch: number
  readonly request: BrowserWorkerRequest
}

export type AttachedBrowserCommandHandler = (
  command: AttachedBrowserCommand,
  context: { signal: AbortSignal }
) => Promise<BrowserWorkerResponse>

export interface ConnectionCommandDispatchInput {
  connectionId: string
  registrationId: string
  registrationEpoch: number
  expectedBinding: TrustedProfileBinding
  request: BrowserWorkerRequest
  signal?: AbortSignal
  timeoutMs?: number
}

export type ConnectionCommandDispatchResult =
  | { status: 'completed'; dispatched: true; response: BrowserWorkerResponse }
  | { status: 'rejected'; dispatched: false; code: string; message: string }
  | {
      status: 'unknown-effect'
      dispatched: true
      code: string
      message: string
    }
  | {
      status: 'cancelled'
      dispatched: boolean
      code: string
      message: string
    }
  | {
      status: 'disconnected'
      dispatched: boolean
      code: string
      message: string
    }

interface PendingCommand {
  commandId: string
  connectionId: string
  registrationId: string
  registrationEpoch: number
  profileId: string
  profileEpoch: number
  requestId: string
  mutation: boolean
  dispatched: boolean
  cancelSent: boolean
  callerSettled: boolean
  resolveCaller: (result: ConnectionCommandDispatchResult) => void
  settleRaw: () => void
  timeout: ReturnType<typeof setTimeout> | null
  onAbort: (() => void) | null
  signal: AbortSignal | null
}

function rejected(code: string, message: string): ConnectionCommandDispatchResult {
  return { status: 'rejected', dispatched: false, code, message }
}

export class ConnectionCommandRouter {
  private readonly connections = new Map<string, CommandConnectionHandle>()
  private readonly pending = new Map<string, PendingCommand>()
  private readonly perConnection = new Map<string, number>()
  private readonly barrier = new OwnedWorkBarrier()
  private shutdownWait: Promise<void> | null = null

  attach(handle: CommandConnectionHandle): void {
    this.connections.set(handle.connectionId, handle)
  }

  revoke(connectionId: string, reason: CommandRevokeReason): void {
    const send = reason === 'close' ? false : true
    this.settleConnectionPending(connectionId, reason, send)
    if (reason !== 'rebind') this.connections.delete(connectionId)
  }

  revokeProfile(profileId: string): void {
    for (const [connectionId, handle] of [...this.connections.entries()]) {
      if (handle.currentBinding()?.profileId === profileId) {
        this.revoke(connectionId, 'profile_dispose')
      }
    }
  }

  acceptClientResponse(connectionId: string, envelope: ProtocolClientCommandResponse): void {
    const pending = this.pending.get(envelope.id)
    if (!pending) return
    if (pending.connectionId !== connectionId) return
    if (pending.registrationId !== envelope.registrationId) return
    if (pending.registrationEpoch !== envelope.registrationEpoch) return
    if (pending.requestId !== envelope.requestId) return
    if (envelope.ok) {
      if (!envelope.result || envelope.result.id !== pending.requestId) return
      this.finishPending(pending, {
        status: 'completed',
        dispatched: true,
        response: envelope.result
      })
      return
    }
    const code = envelope.error?.code ?? 'handler_error'
    const message = envelope.error?.message ?? 'Attached command handler failed'
    const neverExecuted = code === 'handler_unavailable' || code === 'malformed_command' || code === 'admission_closed'
    if (pending.dispatched && pending.mutation && !neverExecuted) {
      this.finishPending(pending, {
        status: 'unknown-effect',
        dispatched: true,
        code,
        message
      })
      return
    }
    if (!pending.dispatched) {
      this.finishPending(pending, { status: 'rejected', dispatched: false, code, message })
      return
    }
    this.finishPending(pending, { status: 'cancelled', dispatched: true, code, message })
  }

  async dispatch(input: ConnectionCommandDispatchInput): Promise<ConnectionCommandDispatchResult> {
    const prepared = this.prepareDispatch(input)
    if (prepared.status !== 'ready') return prepared.result
    const { handle, request, mutation, timeoutMs } = prepared

    const commandId = randomBytes(16).toString('hex')
    const envelope: ProtocolServerCommandRequest = {
      kind: 'server_req',
      id: commandId,
      method: BROWSER_ATTACHED_DISPATCH_METHOD,
      registrationId: input.registrationId,
      registrationEpoch: input.registrationEpoch,
      profileId: input.expectedBinding.profileId,
      profileEpoch: input.expectedBinding.epoch,
      request
    }
    if (!payloadWithinCommandBound(envelope.request) || !payloadWithinCommandBound(envelope)) {
      return rejected('command_too_large', 'Attached command exceeds the payload bound')
    }

    return new Promise<ConnectionCommandDispatchResult>((resolveCaller) => {
      let settleRaw!: () => void
      const raw = new Promise<void>((resolve) => {
        settleRaw = resolve
      })
      const pending: PendingCommand = {
        commandId,
        connectionId: input.connectionId,
        registrationId: input.registrationId,
        registrationEpoch: input.registrationEpoch,
        profileId: input.expectedBinding.profileId,
        profileEpoch: input.expectedBinding.epoch,
        requestId: request.id,
        mutation,
        dispatched: false,
        cancelSent: false,
        callerSettled: false,
        resolveCaller,
        settleRaw,
        timeout: null,
        onAbort: null,
        signal: input.signal ?? null
      }
      this.pending.set(commandId, pending)
      this.addConnectionCount(input.connectionId)
      void this.barrier.run('browser.attached.dispatch', () => raw)

      if (input.signal?.aborted) {
        this.finishPending(pending, {
          status: 'cancelled',
          dispatched: false,
          code: 'cancelled',
          message: 'Attached command aborted before dispatch'
        })
        return
      }

      const sent = handle.send(envelope)
      if (!sent) {
        this.finishPending(pending, {
          status: 'disconnected',
          dispatched: false,
          code: 'disconnected',
          message: 'Failed to write the attached command frame'
        })
        return
      }
      pending.dispatched = true

      pending.timeout = setTimeout(() => {
        this.interruptPending(pending, {
          status: mutation ? 'unknown-effect' : 'cancelled',
          dispatched: true,
          code: 'timeout',
          message: mutation
            ? 'Attached mutation timed out after dispatch; remote effect is uncertain'
            : 'Attached command timed out'
        })
      }, timeoutMs)

      if (input.signal) {
        const onAbort = (): void => {
          this.interruptPending(pending, {
            status: mutation ? 'unknown-effect' : 'cancelled',
            dispatched: true,
            code: 'cancelled',
            message: mutation
              ? 'Attached mutation aborted after dispatch; remote effect is uncertain'
              : 'Attached command aborted'
          })
        }
        pending.onAbort = onAbort
        input.signal.addEventListener('abort', onAbort, { once: true })
        if (input.signal.aborted) onAbort()
      }
    })
  }

  beginShutdown(): void {
    this.barrier.beginShutdown()
    for (const pending of [...this.pending.values()]) {
      this.sendCancel(pending)
    }
  }

  getActiveCount(): number {
    return this.barrier.count
  }

  async shutdown(options?: { timeoutMs?: number }): Promise<void> {
    this.beginShutdown()
    if (!this.shutdownWait) {
      const timeoutMs = options?.timeoutMs ?? 30_000
      this.shutdownWait = this.barrier.waitForIdle(timeoutMs).finally(() => {
        this.shutdownWait = null
      })
    }
    return this.shutdownWait
  }

  private prepareDispatch(input: ConnectionCommandDispatchInput):
    | { status: 'ready'; handle: CommandConnectionHandle; request: BrowserWorkerRequest; mutation: boolean; timeoutMs: number }
    | { status: 'rejected'; result: ConnectionCommandDispatchResult } {
    try {
      this.barrier.assertAccepting()
    } catch {
      return {
        status: 'rejected',
        result: rejected('admission_closed', 'Attached command transport is shutting down')
      }
    }
    const handle = this.connections.get(input.connectionId)
    if (!handle) {
      return { status: 'rejected', result: rejected('connection_not_found', 'Target connection is not attached') }
    }
    if (handle.clientType !== 'gui' || !handle.capabilities.has(BROWSER_ATTACHED_V1_CAPABILITY)) {
      return {
        status: 'rejected',
        result: rejected(
          'capability_required',
          'Target connection does not have browser-attached-v1 (gui declaration plus opt-in request)'
        )
      }
    }
    const binding = handle.currentBinding()
    if (
      !binding ||
      binding.profileId !== input.expectedBinding.profileId ||
      binding.epoch !== input.expectedBinding.epoch
    ) {
      return {
        status: 'rejected',
        result: rejected('stale_binding', 'Connection profile binding/epoch does not match the command')
      }
    }
    let request: BrowserWorkerRequest
    try {
      request = validateBrowserWorkerRequest(input.request)
    } catch (err) {
      return {
        status: 'rejected',
        result: rejected(
          'malformed_command',
          err instanceof Error ? err.message : 'Invalid BrowserWorkerRequest'
        )
      }
    }
    if (request.profileId !== input.expectedBinding.profileId) {
      return {
        status: 'rejected',
        result: rejected('profile_mismatch', 'Inner worker request profile does not match the binding')
      }
    }
    if (!isCommandCorrelation(input.registrationId) || !Number.isSafeInteger(input.registrationEpoch) || input.registrationEpoch < 1) {
      return {
        status: 'rejected',
        result: rejected('malformed_command', 'registrationId/epoch is invalid')
      }
    }
    if ((this.perConnection.get(input.connectionId) ?? 0) >= MMS_PROTOCOL_MAX_CONNECTION_COMMANDS) {
      return {
        status: 'rejected',
        result: rejected('backpressure', 'Too many outstanding attached commands on this connection')
      }
    }
    if (this.pending.size >= MMS_PROTOCOL_MAX_GLOBAL_COMMANDS) {
      return {
        status: 'rejected',
        result: rejected('backpressure', 'Too many outstanding attached commands')
      }
    }
    const timeoutMs =
      typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? input.timeoutMs
        : MMS_PROTOCOL_COMMAND_DEFAULT_TIMEOUT_MS
    return {
      status: 'ready',
      handle,
      request,
      mutation: isBrowserAttachedMutationMethod(request.method),
      timeoutMs
    }
  }

  private interruptPending(pending: PendingCommand, result: ConnectionCommandDispatchResult): void {
    if (!this.pending.has(pending.commandId)) return
    if (pending.timeout) {
      clearTimeout(pending.timeout)
      pending.timeout = null
    }
    this.sendCancel(pending)
    this.settleCaller(pending, result)
    // Raw ownership remains until matching ack, disconnect, rebind, or dispose.
  }

  private sendCancel(pending: PendingCommand): void {
    if (pending.cancelSent || !pending.dispatched) return
    pending.cancelSent = true
    const handle = this.connections.get(pending.connectionId)
    handle?.send({
      kind: 'server_cancel',
      id: pending.commandId,
      registrationId: pending.registrationId,
      registrationEpoch: pending.registrationEpoch
    })
  }

  private settleConnectionPending(
    connectionId: string,
    reason: CommandRevokeReason,
    sendCancel: boolean
  ): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.connectionId !== connectionId) continue
      if (sendCancel) this.sendCancel(pending)
      const mutationUnknown = pending.dispatched && pending.mutation
      const result: ConnectionCommandDispatchResult = mutationUnknown
        ? {
            status: 'unknown-effect',
            dispatched: true,
            code: reason === 'close' ? 'disconnected' : reason,
            message:
              'Attached mutation was interrupted; remote effect is uncertain and will not be retried'
          }
        : pending.dispatched
          ? {
              status: reason === 'close' ? 'disconnected' : 'cancelled',
              dispatched: true,
              code: reason === 'close' ? 'disconnected' : reason,
              message: 'Attached command was interrupted before settlement'
            }
          : {
              status: reason === 'close' ? 'disconnected' : 'cancelled',
              dispatched: false,
              code: reason === 'close' ? 'disconnected' : 'cancelled',
              message: 'Attached command was revoked before dispatch'
            }
      this.finishPending(pending, result)
    }
  }

  private finishPending(pending: PendingCommand, result: ConnectionCommandDispatchResult): void {
    if (!this.pending.delete(pending.commandId)) return
    this.removeConnectionCount(pending.connectionId)
    this.clearPendingListeners(pending)
    this.settleCaller(pending, result)
    pending.settleRaw()
  }

  private settleCaller(pending: PendingCommand, result: ConnectionCommandDispatchResult): void {
    if (pending.callerSettled) return
    pending.callerSettled = true
    pending.resolveCaller(result)
  }

  private clearPendingListeners(pending: PendingCommand): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout)
      pending.timeout = null
    }
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort)
      pending.onAbort = null
    }
  }

  private addConnectionCount(connectionId: string): void {
    this.perConnection.set(connectionId, (this.perConnection.get(connectionId) ?? 0) + 1)
  }

  private removeConnectionCount(connectionId: string): void {
    const next = (this.perConnection.get(connectionId) ?? 1) - 1
    if (next <= 0) this.perConnection.delete(connectionId)
    else this.perConnection.set(connectionId, next)
  }
}

function isCommandCorrelation(value: string): boolean {
  return /^[a-zA-Z0-9:_-]+$/.test(value) && value.length > 0 && value.length <= 128
}

interface InFlightClientCommand {
  generation: number
  registrationId: string
  registrationEpoch: number
  requestId: string
  controller: AbortController
}

export class ClientCommandReceiver {
  private handler: AttachedBrowserCommandHandler | null = null
  private generation = 0
  private writer: ((envelope: ProtocolClientCommandResponse) => void) | null = null
  private readonly inflight = new Map<string, InFlightClientCommand>()
  private readonly seen = new Map<string, ProtocolClientCommandResponse>()
  private readonly barrier = new OwnedWorkBarrier()
  private shutdownWait: Promise<void> | null = null

  setHandler(handler: AttachedBrowserCommandHandler | null): void {
    this.handler = handler
  }

  bindWriter(writer: (envelope: ProtocolClientCommandResponse) => void): void {
    this.generation += 1
    this.writer = writer
  }

  unbindWriter(): void {
    this.generation += 1
    this.writer = null
    this.seen.clear()
    for (const state of this.inflight.values()) {
      if (!state.controller.signal.aborted) state.controller.abort()
    }
  }

  handleServerRequest(envelope: ProtocolServerCommandRequest): void {
    const cached = this.seen.get(envelope.id)
    if (cached) {
      this.writer?.(cached)
      return
    }
    if (this.inflight.has(envelope.id)) return
    if (this.barrier.stopping) {
      this.writeOnce(envelope, this.errorResponse(envelope, 'admission_closed', 'Command receiver is shutting down'))
      return
    }
    const handler = this.handler
    if (!handler) {
      this.writeOnce(envelope, this.errorResponse(envelope, 'handler_unavailable', 'No attached browser command handler is installed'))
      return
    }
    const generation = this.generation
    const controller = new AbortController()
    this.inflight.set(envelope.id, {
      generation,
      registrationId: envelope.registrationId,
      registrationEpoch: envelope.registrationEpoch,
      requestId: envelope.request.id,
      controller
    })
    const command: AttachedBrowserCommand = {
      commandId: envelope.id,
      registrationId: envelope.registrationId,
      registrationEpoch: envelope.registrationEpoch,
      profileId: envelope.profileId,
      profileEpoch: envelope.profileEpoch,
      request: envelope.request
    }
    try {
      void this.barrier.run('browser.attached.dispatch', async () => {
        try {
          const raw = await handler(command, { signal: controller.signal })
          this.complete(envelope, generation, this.successResponse(envelope, raw))
        } catch (err) {
          this.complete(
            envelope,
            generation,
            this.errorResponse(
              envelope,
              'handler_error',
              err instanceof Error ? err.message : String(err)
            )
          )
        }
      })
    } catch {
      this.inflight.delete(envelope.id)
      this.writeOnce(envelope, this.errorResponse(envelope, 'admission_closed', 'Command receiver is shutting down'))
    }
  }

  rejectMalformed(raw: unknown): void {
    const correlation = correlationFromMalformedServerReq(raw)
    if (!correlation) return
    const envelope: ProtocolServerCommandRequest = {
      kind: 'server_req',
      id: correlation.id,
      method: BROWSER_ATTACHED_DISPATCH_METHOD,
      registrationId: correlation.registrationId,
      registrationEpoch: correlation.registrationEpoch,
      profileId: 'invalid',
      profileEpoch: 1,
      request: {
        version: 1,
        id: correlation.requestId,
        profileId: 'invalid',
        method: 'observe',
        params: {}
      }
    }
    if (this.inflight.has(correlation.id) || this.seen.has(correlation.id)) return
    this.writeOnce(
      envelope,
      this.errorResponse(envelope, 'malformed_command', 'Invalid attached command envelope')
    )
  }

  handleCancel(envelope: ProtocolServerCommandCancel): void {
    const state = this.inflight.get(envelope.id)
    if (!state) return
    if (
      state.registrationId !== envelope.registrationId ||
      state.registrationEpoch !== envelope.registrationEpoch
    ) {
      return
    }
    if (!state.controller.signal.aborted) state.controller.abort()
  }

  beginShutdown(): void {
    this.barrier.beginShutdown()
    for (const state of this.inflight.values()) {
      if (!state.controller.signal.aborted) state.controller.abort()
    }
  }

  getActiveCount(): number {
    return this.barrier.count
  }

  async shutdown(timeoutMs = 30_000): Promise<void> {
    this.beginShutdown()
    if (!this.shutdownWait) {
      this.shutdownWait = this.barrier.waitForIdle(timeoutMs).finally(() => {
        this.shutdownWait = null
      })
    }
    return this.shutdownWait
  }

  private complete(
    envelope: ProtocolServerCommandRequest,
    generation: number,
    response: ProtocolClientCommandResponse
  ): void {
    const state = this.inflight.get(envelope.id)
    if (!state) return
    this.inflight.delete(envelope.id)
    this.remember(envelope.id, response)
    if (state.generation !== generation || generation !== this.generation) return
    this.writer?.(response)
  }

  private writeOnce(
    envelope: ProtocolServerCommandRequest,
    response: ProtocolClientCommandResponse
  ): void {
    this.remember(envelope.id, response)
    this.writer?.(response)
  }

  private remember(id: string, response: ProtocolClientCommandResponse): void {
    this.seen.set(id, response)
    while (this.seen.size > MMS_PROTOCOL_MAX_COMMAND_SEEN_IDS) {
      const first = this.seen.keys().next().value
      if (first === undefined) break
      this.seen.delete(first)
    }
  }

  private successResponse(
    envelope: ProtocolServerCommandRequest,
    raw: BrowserWorkerResponse
  ): ProtocolClientCommandResponse {
    try {
      const result = validateBrowserWorkerResponse(raw)
      if (result.id !== envelope.request.id) {
        return this.errorResponse(envelope, 'malformed_command', 'Handler result id does not match the request')
      }
      if (!payloadWithinCommandBound(result)) {
        return this.errorResponse(envelope, 'command_too_large', 'Handler result exceeds the payload bound')
      }
      return {
        kind: 'client_res',
        id: envelope.id,
        registrationId: envelope.registrationId,
        registrationEpoch: envelope.registrationEpoch,
        requestId: envelope.request.id,
        ok: true,
        result
      }
    } catch (err) {
      return this.errorResponse(
        envelope,
        'malformed_command',
        err instanceof Error ? err.message : 'Invalid handler result'
      )
    }
  }

  private errorResponse(
    envelope: ProtocolServerCommandRequest,
    code: string,
    message: string
  ): ProtocolClientCommandResponse {
    return {
      kind: 'client_res',
      id: envelope.id,
      registrationId: envelope.registrationId,
      registrationEpoch: envelope.registrationEpoch,
      requestId: envelope.request.id,
      ok: false,
      error: { code, message }
    }
  }
}
