import { AppError } from '../../shared/errors'
import { NET_LOCAL_CAPABILITY } from '../../shared/net/local'
import { NET_ERRORS, NetError } from '../../shared/net'
import type { AccessPresetFields } from '../../shared/net/accessPresets'
import { isAgentReach, isBotLevel } from '../../shared/net/local'
import { isPermissionMode } from '../../shared/permissionMode'
import {
  isNetEngineWay,
  NET_ENGINE_LOCAL_METHODS,
  NET_ENGINE_WAYS,
  type NetEngineLocalMethod
} from '../../shared/netEngine/local'
import { DomainRpcError, type DomainHandlerRegistry } from '../protocol/domainRegistry'
import type { NetEngineService } from './NetEngineService'
import type { SshRemote } from './ssh/remote'

/** The string fields each method needs. */
const NEEDS: Partial<Record<NetEngineLocalMethod, string[]>> = {
  'netEngine.invite.cancel': ['invitation'],
  'netEngine.approve': ['request'],
  'netEngine.join': ['ticket'],
  'netEngine.join.code': ['invitation', 'code'],
  'netEngine.retry': ['node'],
  'netEngine.remove': ['node'],
  'netEngine.address.add': ['node', 'address'],
  'netEngine.removeEverywhere.plan': ['node'],
  'netEngine.removeEverywhere': ['node'],
  'netEngine.removeEverywhere.answer': ['identity', 'host'],
  'netEngine.address.remove': ['node', 'address'],
  'netEngine.address.use': ['node'],
  'netEngine.join.preview': ['ticket'],
  'netEngine.join.check': ['ticket'],
  'netEngine.join.probe': ['ticket'],
  'netEngine.join.probe.cancel': ['ticket'],
  'netEngine.routes.test': ['route'],
  'netEngine.ssh.resolve': ['target'],
  'netEngine.ssh.probe': ['routeId'],
  'netEngine.ssh.trust': ['routeId', 'sha256'],
  'netEngine.ssh.profiles': ['routeId'],
  'netEngine.ssh.connect': ['routeId', 'target', 'host'],
  'netEngine.relay.enroll': ['link'],
  'netEngine.relay.remove': ['relay'],
  'netEngine.relay.rotate': ['relay'],
  'netEngine.relay.allow': ['node', 'destination'],
  'netEngine.relay.disallow': ['node', 'destination'],
  'netEngine.relay.dismiss': ['node', 'destination'],
  'netEngine.access.ask': ['node'],
  'netEngine.access.cancel': ['node'],
  'netEngine.access.answer': ['node', 'request'],
  'netEngine.access.let': ['node'],
  'netEngine.versionNotice.claim': ['node']
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === 'string')

/** Allow's access level: every field a preset sets, each of its type, and nothing else. */
function accessFields(value: unknown): value is AccessPresetFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const fields = value as Record<string, unknown>
  const keys: Array<keyof AccessPresetFields> = ['work', 'terminal', 'editor', 'maxPermissionMode', 'agentReach', 'bots']
  return (
    Object.keys(fields).every((key) => (keys as string[]).includes(key)) &&
    isBotLevel(fields.bots) &&
    typeof fields.work === 'boolean' &&
    typeof fields.terminal === 'boolean' &&
    typeof fields.editor === 'boolean' &&
    isPermissionMode(fields.maxPermissionMode) &&
    isAgentReach(fields.agentReach)
  )
}

/** `netEngine.routes.config`: only Reach's fields, each of its type. */
function reach(fields: Record<string, unknown>): void {
  const bad = (field: string) => new DomainRpcError('bad_request', `netEngine.routes.config: bad ${field}`)
  for (const key of Object.keys(fields))
    if (!['lan', 'tailnet', 'public', 'forwardTo', 'tunnels', 'port'].includes(key)) throw bad(key)
  for (const key of ['lan', 'tailnet'])
    if (fields[key] !== undefined && typeof fields[key] !== 'boolean') throw bad(key)
  for (const key of ['public', 'tunnels'])
    if (fields[key] !== undefined && !strings(fields[key])) throw bad(key)
  if (fields.forwardTo !== undefined && typeof fields.forwardTo !== 'string') throw bad('forwardTo')
  if (fields.port !== undefined && typeof fields.port !== 'number') throw bad('port')
}

/** Every method takes an object, with the string fields it needs (`approve` takes `yes`, `loginStart` `start`). */
function validate(method: NetEngineLocalMethod, params: unknown): Record<string, unknown> {
  const value = params ?? {}
  if (typeof value !== 'object' || Array.isArray(value))
    throw new DomainRpcError('bad_request', `${method} takes an object`)
  const fields = value as Record<string, unknown>
  for (const field of NEEDS[method] ?? [])
    if (typeof fields[field] !== 'string' || !fields[field])
      throw new DomainRpcError('bad_request', `${method} needs ${field}`)
  if (
    (method === 'netEngine.approve' || method === 'netEngine.removeEverywhere.answer') &&
    typeof fields.yes !== 'boolean'
  )
    throw new DomainRpcError('bad_request', `${method} needs yes`)
  if (method === 'netEngine.removeEverywhere.answer' && !Number.isSafeInteger(fields.grant))
    throw new DomainRpcError('bad_request', `${method} needs grant`)
  if (method === 'netEngine.removeEverywhere') {
    const hosts = fields.hosts
    const ok =
      Array.isArray(hosts) &&
      hosts.length > 0 &&
      hosts.every(
        (h) =>
          h &&
          typeof h === 'object' &&
          typeof (h as Record<string, unknown>).host === 'string' &&
          Number.isSafeInteger((h as Record<string, unknown>).grant)
      )
    if (!ok) throw new DomainRpcError('bad_request', `${method} needs hosts [{host, grant}]`)
  }
  if (method === 'netEngine.loginStart' && typeof fields.start !== 'boolean')
    throw new DomainRpcError('bad_request', `${method} needs start`)
  if (method === 'netEngine.workOnThreads' && typeof fields.enabled !== 'boolean')
    throw new DomainRpcError('bad_request', `${method} needs enabled`)
  if (method === 'netEngine.invite' && fields.kind !== undefined && fields.kind !== 'link')
    throw new DomainRpcError('bad_request', `${method} takes kind "link" or none`)
  if (method === 'netEngine.invite' && fields.way !== undefined && !isNetEngineWay(fields.way))
    throw new DomainRpcError('bad_request', `${method} takes way as one of ${NET_ENGINE_WAYS.join(', ')}`)
  if (method === 'netEngine.invite' && fields.access !== undefined && (fields.kind !== 'link' || !accessFields(fields.access)))
    throw new DomainRpcError('bad_request', `${method} takes access, as a preset's fields, with kind "link"`)
  if (method === 'netEngine.approve' && fields.access !== undefined && !accessFields(fields.access))
    throw new DomainRpcError('bad_request', `${method} takes access as a preset's fields`)
  if (method === 'netEngine.access.answer' && typeof fields.yes !== 'boolean')
    throw new DomainRpcError('bad_request', `${method} needs yes`)
  // Letting a computer in always names its level: nothing is let in under a default the owner did not see.
  if (
    (method === 'netEngine.access.let' || (method === 'netEngine.access.answer' && fields.yes === true)) &&
    !accessFields(fields.access)
  )
    throw new DomainRpcError('bad_request', `${method} needs access as a preset's fields`)
  if (method === 'netEngine.join' && fields.share !== undefined && !strings(fields.share))
    throw new DomainRpcError('bad_request', `${method} takes share as a list of addresses`)
  if (method === 'netEngine.join' && fields.back !== undefined && typeof fields.back !== 'boolean')
    throw new DomainRpcError('bad_request', `${method} takes back as true or false`)
  if (
    method === 'netEngine.remove' &&
    fields.direction !== undefined &&
    fields.direction !== 'in' &&
    fields.direction !== 'out'
  )
    throw new DomainRpcError('bad_request', `${method} takes direction "in" or "out"`)
  if (
    (method === 'netEngine.join' ||
      method === 'netEngine.join.check' ||
      method === 'netEngine.join.probe') &&
    fields.arrival !== undefined &&
    fields.arrival !== 'scan' &&
    fields.arrival !== 'link'
  )
    throw new DomainRpcError('bad_request', `${method} takes arrival "scan" or "link"`)
  if (method === 'netEngine.routes.config') reach(fields)
  if (method === 'netEngine.relay.rotate' && fields.cancel !== undefined && typeof fields.cancel !== 'boolean')
    throw new DomainRpcError('bad_request', `${method} takes cancel as true or false`)
  if (method === 'netEngine.ssh.connect' && !text(fields.selector) === !text(fields.newLabel))
    throw new DomainRpcError('bad_request', `${method} needs selector or newLabel, one of them`)
  return fields
}

/** Connect's profile: the one picked, or the new one named (`validate` made sure there is exactly one). */
function sshProfileChoice(
  fields: Record<string, unknown>
): { selector: string } | { newLabel: string } {
  const selector = text(fields.selector)
  return selector ? { selector } : { newLabel: text(fields.newLabel)! }
}

/**
 * The new networking's local methods (`NET_ENGINE_LOCAL_METHODS`), for this computer's windows only: a paired
 * computer's calls go through the engine dispatcher, which allows only `ENGINE_OWNER_METHODS`.
 */
export function registerNetEngineMethods(
  registry: DomainHandlerRegistry,
  forProfile: (id: string) => NetEngineService | Promise<NetEngineService>
): void {
  for (const method of NET_ENGINE_LOCAL_METHODS)
    registry.register({
      method,
      scope: 'profile',
      capability: NET_LOCAL_CAPABILITY,
      requiredCapabilities: [NET_LOCAL_CAPABILITY],
      validate: (params) => validate(method, params),
      async handle(context, params, binding) {
        const engine = await forProfile(binding!.profileId)
        const p = params as Record<string, any>
        try {
          switch (method) {
            case 'netEngine.status':
              return engine.status()
            case 'netEngine.enable':
              await engine.switchOn()
              return engine.status()
            case 'netEngine.disable':
              await engine.disable()
              return engine.status()
            case 'netEngine.invite': {
              await engine.tellName()
              await engine.leakBeforeInvite()
              const invite = await engine
                .pairing()
                .invite(engine.ownName(), p.kind === 'link' ? 'link' : undefined, p.way, p.access)
              // The window that showed the code closed, or switched profile: its invitation ends (§8).
              context.connection?.lifetime?.addEventListener(
                'abort',
                () => void engine.cancelInvite(invite.invitation),
                { once: true }
              )
              return invite
            }
            case 'netEngine.invite.cancel':
              await engine.pairing().cancelInvite(p.invitation)
              return engine.status()
            case 'netEngine.approve':
              await engine.tellName()
              await engine.pairing().approve(p.request, p.yes, p.access)
              return engine.status()
            case 'netEngine.join': {
              const row = await engine.join(
                p.ticket,
                p.share ?? [],
                p.arrival === 'link' ? 'link' : undefined,
                p.back !== false
              )
              return { node: row.localId, status: engine.status() }
            }
            case 'netEngine.routes.available':
              return { ways: await engine.waysAvailable() }
            case 'netEngine.join.check':
              return await engine.joinCheck(p.ticket, p.arrival === 'link' ? 'link' : 'scan')
            case 'netEngine.join.probe':
              // A window that closes, or a newer check of the same link, cancels this one.
              return await engine.joinProbe(
                p.ticket,
                p.arrival === 'link' ? 'link' : 'scan',
                context.connection?.lifetime
              )
            case 'netEngine.join.probe.cancel':
              return { cancelled: await engine.cancelProbe(p.ticket) }
            case 'netEngine.join.code':
              await engine.pairing().submitCode(p.invitation, p.code)
              return engine.status()
            case 'netEngine.retry':
              await engine.retry(p.node)
              return engine.status()
            case 'netEngine.remove':
              if (p.direction === 'in' || p.direction === 'out')
                await engine.pairing().removeDirection(p.node, p.direction)
              else await engine.pairing().remove(p.node)
              return engine.status()
            case 'netEngine.address.add':
              await engine.addAddress(p.node, p.address)
              return engine.status()
            case 'netEngine.plus.signIn':
              return await engine.plus.signIn()
            case 'netEngine.plus.cancel':
              await engine.plus.cancelSignIn()
              return engine.status()
            case 'netEngine.plus.refresh':
              await engine.plus.refresh()
              return engine.status()
            case 'netEngine.plus.signOut':
              await engine.plus.signOut()
              return engine.status()
            case 'netEngine.removeEverywhere.plan': {
              const { identity } = engine.device(p.node)
              return { hosts: await engine.plus.plan(identity) }
            }
            case 'netEngine.removeEverywhere': {
              const { identity, name } = engine.device(p.node)
              await engine.plus.removeEverywhere(identity, name, p.hosts)
              return engine.status()
            }
            case 'netEngine.removeEverywhere.answer':
              await engine.plus.answer(p.identity, p.host, p.grant, p.yes)
              return engine.status()
            case 'netEngine.loginStart':
              await engine.answerLoginStart(p.start)
              return engine.status()
            case 'netEngine.workOnThreads':
              engine.setWorkOnThreads(p.enabled)
              return engine.status()
            case 'netEngine.address.remove':
              await engine.removeAddress(p.node, p.address)
              return engine.status()
            case 'netEngine.address.use':
              await engine.useOffered(p.node)
              return engine.status()
            case 'netEngine.join.preview':
              return engine.joinPreview(p.ticket)
            case 'netEngine.routes.config': {
              const { restarted } = await engine.setReach(p)
              return { restarted, status: engine.status() }
            }
            case 'netEngine.routes.test':
              return engine.testRoute(p.route)
            case 'netEngine.cloudflare.connect':
              engine.cloudflare.start()
              return engine.status()
            case 'netEngine.cloudflare.stop':
              await engine.cloudflare.stop()
              return engine.status()
            case 'netEngine.cloudflare.forget':
              await engine.cloudflare.forget()
              return engine.status()
            case 'netEngine.ssh.resolve':
              return engine.sshAdd().resolve(p.target)
            case 'netEngine.ssh.probe':
              return engine.sshAdd().probe(p.routeId, text(p.host))
            case 'netEngine.ssh.trust':
              await engine.sshAdd().trust(p.routeId, p.sha256, text(p.host))
              return {}
            case 'netEngine.ssh.profiles':
              return engine.sshAdd().profiles(p.routeId, text(p.host), text(p.user))
            case 'netEngine.ssh.connect': {
              const row = await engine.sshConnect({
                routeId: p.routeId,
                target: p.target,
                host: p.host,
                user: text(p.user) ?? '',
                // The owner picks a profile or names a new one: none is ever made unasked.
                ...sshProfileChoice(p)
              })
              return { node: row.localId, status: engine.status() }
            }
            case 'netEngine.relay.enroll':
              await engine.enrollRelay(p.link)
              return engine.status()
            case 'netEngine.relay.remove':
              await engine.removeRelay(p.relay)
              return engine.status()
            case 'netEngine.relay.rotate':
              await engine.rotateRelay(p.relay, p.cancel === true)
              return engine.status()
            case 'netEngine.relay.allow':
            case 'netEngine.relay.disallow':
              await engine.allowRelay(p.node, p.destination, method === 'netEngine.relay.allow')
              return engine.status()
            case 'netEngine.relay.dismiss':
              engine.dismissRelay(p.node, p.destination)
              return engine.status()
            case 'netEngine.access.ask':
              engine.refuseCutOff(p.node)
              engine.access().ask(p.node)
              return engine.status()
            case 'netEngine.access.cancel':
              engine.access().cancel(p.node)
              return engine.status()
            case 'netEngine.access.answer':
              await engine.access().answer(p.node, p.request, p.yes, p.access)
              return engine.status()
            case 'netEngine.access.let':
              engine.refuseCutOff(p.node)
              await engine.access().let(p.node, p.access)
              return engine.status()
            case 'netEngine.versionNotice.claim':
              if (typeof p.since !== 'number' || !Number.isFinite(p.since))
                throw new NetError('bad_request', 'since must be a number.')
              return engine.claimVersionNotice(p.node, p.since)
          }
        } catch (error) {
          if (error instanceof NetError) {
            const entry = NET_ERRORS[error.code]
            throw new AppError(
              {
                code: error.code,
                message: error.message || entry.message,
                ...(error.details === undefined ? {} : { details: error.details }),
                errorInfo: { category: entry.category, retryable: entry.retryable }
              },
              error
            )
          }
          throw error
        }
      }
    })
}

/**
 * `netEngine.ssh.serve`: one request of `mousse-cli net-engine ssh`, which an SSH session on this computer runs for
 * another computer's Add over SSH (1b §3.4). Local only (the CLI, with the local capability); the trust is the SSH
 * login the other computer made.
 */
export function registerNetEngineSshServe(
  registry: DomainHandlerRegistry,
  remote: () => SshRemote | undefined
): void {
  registry.register({
    method: 'netEngine.ssh.serve',
    scope: 'installation',
    capability: NET_LOCAL_CAPABILITY,
    requiredCapabilities: [NET_LOCAL_CAPABILITY],
    validate: (params) => {
      const value = params as { request?: unknown } | undefined
      if (!value || typeof value !== 'object' || !value.request || typeof value.request !== 'object')
        throw new DomainRpcError('bad_request', 'netEngine.ssh.serve needs request')
      return value
    },
    async handle(_context, params) {
      const service = remote()
      if (!service) return { error: 'remote_not_running' }
      return service.serve((params as { request: unknown }).request)
    }
  })
}
