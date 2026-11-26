import { NetError, isNetErrorCode, newId } from '../../../shared/net'
import type { BridgeMethod, BridgeRemoteParams } from '../../../shared/bridge'
import {
  ROUTED_METHODS,
  isRoutedPagedReply,
  isRoutedReply,
  routedKeysAt,
  routedNetMethod,
  type RoutedPage,
  type RoutedReply
} from '../../../shared/bridge/routed'
import { engineLimits } from '../../netEngine/limits'
import type { BridgeClient } from '../peers'
import { reassemblePagedReply } from '../routed/pages'

/**
 * The Hub's engine branch (Phase 1b §9.1). An engine pairing serves the routed rows, not v1's phone API, so each
 * Hub method that has a routed twin is sent as that row (`routed.<method>`), with the v1 params turned into the
 * row's own. `bridge.dispatch` is sent as itself: it is on the engine allowlist. A method without a twin answers
 * `not_supported` for an engine id, and never reaches a v1 session.
 *
 * Every key sent is one the row has had since version 1, so an engine owner of any build takes it and no version
 * needs asking.
 */
interface Twin {
  method: string
  params(params: unknown): Record<string, unknown>
}

const same =
  (method: string): Twin => ({ method: routedNetMethod(method), params: (params) => ({ ...(params as object) }) })

/** The Hub's methods (`HUB_METHODS`) an engine pairing answers, and what each is sent as. */
const TWINS: Partial<Record<BridgeMethod, Twin>> = {
  'projects.list': same('projects.list'),
  'threads.list': same('threads.list'),
  'threads.get': same('threads.get'),
  'threads.search': same('threads.search'),
  'threads.create': same('threads.create'),
  'projects.open': same('projects.open'),
  'projects.match': same('projects.match'),
  'composer.options': same('composer.options'),
  'threads.setModel': same('threads.setModel'),
  'orchestrator.pendingQuestions': same('orchestrator.pendingQuestions'),
  // The routed send answers once the turn is admitted. Images go with v1's `attachments.stage`, which has no twin,
  // so a send that names staged uploads is refused before anything is sent.
  'orchestrator.send': {
    method: routedNetMethod('orchestrator.send'),
    params: (value) => {
      const params = value as BridgeRemoteParams['orchestrator.send']
      if (params.attachments?.length) throw notSupported()
      return {
        threadId: params.threadId,
        content: params.content,
        ...(params.mode === undefined ? {} : { mode: params.mode })
      }
    }
  },
  // v1's `run` is the id of the v1 send that started the run, which an engine owner never saw: the routed steer and
  // Stop act on the thread's current run, as a window on the owner does.
  'orchestrator.steer': {
    method: routedNetMethod('orchestrator.steer'),
    params: (value) => {
      const params = value as BridgeRemoteParams['orchestrator.steer']
      return { threadId: params.threadId, text: params.text }
    }
  },
  'orchestrator.abort': {
    method: routedNetMethod('orchestrator.abort'),
    params: (value) => ({ threadId: (value as BridgeRemoteParams['orchestrator.abort']).threadId })
  },
  'bridge.dispatch': { method: 'bridge.dispatch', params: (params) => ({ ...(params as object) }) }
}

export function notSupported(): NetError {
  return new NetError('profile_unsupported', 'Not supported for this device.', {
    details: { reason: 'not_supported' }
  })
}

/** What `method` is sent to an engine pairing as; `not_supported` when it has no twin. */
export function engineTwin(method: BridgeMethod): { method: string; params(params: unknown): Record<string, unknown> } {
  const twin = TWINS[method]
  if (!twin) throw notSupported()
  return {
    method: twin.method,
    params: (params) => {
      const sent = twin.params(params)
      const row = ROUTED_METHODS[method]
      // A key the owner's oldest version of the row does not take would be refused there as outdated.
      if (row && Object.keys(sent).some((key) => !routedKeysAt(row, 1).includes(key)))
        throw new NetError('internal')
      return sent
    }
  }
}

/** The Hub methods with a routed twin (the rest answer `not_supported` for engine ids). */
export function engineTwinMethods(): BridgeMethod[] {
  return Object.keys(TWINS) as BridgeMethod[]
}

/** The refusals the other computer worded for a person ("That folder does not exist on this computer."). */
const worded = new WeakSet<NetError>()

/** A refusal whose message is the other computer's own words, which a window may show as they are. */
export function isWordedRefusal(error: unknown): error is NetError {
  return error instanceof NetError && worded.has(error)
}

/** A routed refusal, as the error the Hub's callers get: its code when it is a Net code, its word in the details. */
function refusal(reply: Extract<RoutedReply, { ok: false }>): NetError {
  const code = reply.error.code
  const error = new NetError(isNetErrorCode(code) ? code : 'bad_request', reply.error.message, {
    details: { reason: code }
  })
  if (reply.error.message.trim()) worded.add(error)
  return error
}

/**
 * The result a routed row answered: a paged reply is fetched page by page (`routed.page`) and checked, and a
 * refusal is thrown.
 */
export async function routedResult(value: unknown, client: BridgeClient, signal?: AbortSignal): Promise<unknown> {
  let reply: RoutedReply
  if (isRoutedPagedReply(value))
    reply = await reassemblePagedReply(value.paged, async (id, index): Promise<RoutedPage> => {
      const page = await client.rpc(
        routedNetMethod('page'),
        { id, index },
        { id: newId('rpc'), deadlineMs: engineLimits().hubRoutedDeadlineMs, ...(signal ? { signal } : {}) }
      )
      if (!isRoutedReply(page)) throw new NetError('bad_request')
      if (!page.ok) throw refusal(page)
      return page.result as RoutedPage
    })
  else if (isRoutedReply(value)) reply = value
  else throw new NetError('bad_request')
  if (!reply.ok) throw refusal(reply)
  return reply.result
}

/** Opens the thread's private stream on an engine pairing (`routed.stream.open`), as a Hub attachment opens it. */
export async function openPrivateThread(
  client: BridgeClient,
  threadId: string
): Promise<{ descriptor: unknown; head: { epoch: number; seq: number } }> {
  const opened = (await routedResult(
    await client.rpc(
      routedNetMethod('stream.open'),
      { kind: 'thread', threadId },
      { id: newId('rpc'), deadlineMs: engineLimits().hubRoutedDeadlineMs }
    ),
    client
  )) as { descriptor?: unknown; head?: { epoch: number; seq: number }; kind?: unknown } | null
  if (!opened || opened.kind !== 'thread' || !opened.head)
    throw new NetError('forbidden')
  return { descriptor: opened.descriptor, head: opened.head }
}
