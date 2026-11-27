import { REMOTE_UPDATE_APP_METHODS, REMOTE_UPDATE_ERRORS, REMOTE_UPDATE_EVENT, type RemoteUpdateError } from '../../shared/remoteUpdates'
import { DomainRpcError, domainObject, type DomainHandlerRegistry } from '../protocol/domainRegistry'
import type { HandlerContext } from '../protocol/handlers'
import type { AppProgress, RemoteUpdates } from './remoteUpdates'

const JOB = /^[0-9A-Za-z-]{1,64}$/

function appConnection(ctx: HandlerContext): { id: string } {
  const connection = ctx.connection
  // Only the desktop app installs; the CLI or another computer never registers.
  if (!connection || connection.clientType !== 'gui') throw new DomainRpcError('forbidden', 'Only the desktop app takes update requests.')
  return { id: connection.id }
}

function jobParam(params: unknown, extra: readonly string[] = []): Record<string, unknown> & { job: string } {
  const p = domainObject(params ?? {}, ['job', ...extra])
  if (typeof p.job !== 'string' || !JOB.test(p.job)) throw new DomainRpcError('invalid_params', 'A request id is required')
  return p as Record<string, unknown> & { job: string }
}

function progressOf(p: Record<string, unknown>): AppProgress {
  if (p.phase === 'ready') return { phase: 'ready' }
  if (p.phase === 'failed' && REMOTE_UPDATE_ERRORS.includes(p.error as RemoteUpdateError)) return { phase: 'failed', error: p.error as RemoteUpdateError }
  if (p.phase === 'preparing')
    return typeof p.percent === 'number' && p.percent >= 0 && p.percent <= 100 ? { phase: 'preparing', percent: Math.floor(p.percent) } : { phase: 'preparing' }
  throw new DomainRpcError('invalid_params', 'A known phase is required')
}

/**
 * The service side of update requests for the desktop app's main process (`REMOTE_UPDATE_APP_METHODS`), and the
 * event that tells it to read the request again. `activeTurns` counts turns in every live profile.
 */
export function registerRemoteUpdateMethods(
  registry: DomainHandlerRegistry,
  hub: RemoteUpdates,
  opts: { emit: (type: string, data: unknown) => void; activeTurns: () => number }
): void {
  hub.activeTurns = opts.activeTurns
  hub.notify = () => opts.emit(REMOTE_UPDATE_EVENT, {})
  // The registration lasts as long as the app's connection (a profile switch keeps it).
  registry.onConnectionClosed((connection) => hub.detach(connection))
  const empty = (params: unknown) => domainObject(params ?? {}, [])
  registry.register({
    method: REMOTE_UPDATE_APP_METHODS.attach,
    scope: 'installation',
    validate: empty,
    handle: (ctx) => {
      return { job: hub.attach(appConnection(ctx).id) }
    }
  })
  registry.register({
    method: REMOTE_UPDATE_APP_METHODS.job,
    scope: 'installation',
    validate: empty,
    handle: (ctx) => {
      appConnection(ctx)
      return { job: hub.current() }
    }
  })
  registry.register({
    method: REMOTE_UPDATE_APP_METHODS.progress,
    scope: 'installation',
    validate: (params) => {
      const p = jobParam(params, ['phase', 'percent', 'error'])
      return { job: p.job, report: progressOf(p) }
    },
    handle: (ctx, input) => ({ job: hub.progress(appConnection(ctx).id, input.job, input.report) })
  })
  registry.register({
    method: REMOTE_UPDATE_APP_METHODS.begin,
    scope: 'installation',
    validate: (params) => ({ job: jobParam(params).job }),
    handle: (ctx, input) => hub.begin(appConnection(ctx).id, input.job)
  })
  registry.register({
    method: REMOTE_UPDATE_APP_METHODS.turns,
    scope: 'installation',
    validate: empty,
    handle: (ctx) => {
      appConnection(ctx)
      return { runningTurns: hub.runningTurns() }
    }
  })
  registry.register({
    method: REMOTE_UPDATE_APP_METHODS.cancel,
    scope: 'installation',
    validate: (params) => {
      const p = jobParam(params, ['error'])
      if (p.error !== undefined && !REMOTE_UPDATE_ERRORS.includes(p.error as RemoteUpdateError))
        throw new DomainRpcError('invalid_params', 'Unknown error')
      return { job: p.job, error: (p.error as RemoteUpdateError | undefined) ?? 'cancelled' }
    },
    handle: (ctx, input) => {
      appConnection(ctx)
      hub.cancelHere(input.job, input.error)
      return { job: hub.current() }
    }
  })
}
