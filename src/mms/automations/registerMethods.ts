import { AUTOMATIONS_CAPABILITY, type AutomationIndex, type AutomationMoveResult } from '../../shared/automations'
import { isId } from '../../shared/net'
import type { ScheduledJob } from '../../shared/types'
import type { AgentJobAsk } from './AgentJobAsks'
import { DomainRpcError, domainObject, type DomainHandlerRegistry } from '../protocol/domainRegistry'

/** What the Automations methods need from the profile. */
export interface AutomationsDomain {
  /**
   * The list for who asks: a window of this computer gets the other computers' automations too; another computer
   * (over Bridge) gets only what it may see; anyone else (the CLI) gets this computer's.
   */
  index(viewer: 'window' | 'computer' | 'local', signal?: AbortSignal): AutomationIndex | Promise<AutomationIndex>
  /** Allow or Not now on an agent's first-creation ask. */
  answerAsk(askId: string, answer: 'allow' | 'not_now'): AgentJobAsk
  /** Keep on an agent-added automation: removes only its end. */
  keep(jobId: string): ScheduledJob | null
  /** Move to computer: this computer's automations to another online computer of the person. */
  move(jobIds: string[], node: string, signal?: AbortSignal): Promise<AutomationMoveResult>
}

/**
 * The Automations page's methods: `automations.list` (jobs, bot schedules, pull request watches and agents' asks in one
 * list; the page refreshes it when the scheduler or a bot changes, and every 15 seconds while it is open),
 * `automations.asks.answer` and `automations.keep`.
 */
export function registerAutomationMethods(
  domains: DomainHandlerRegistry,
  domainFor: (profileId: string) => Promise<AutomationsDomain>
): void {
  const bound = async (binding: { profileId: string } | undefined) => {
    if (!binding) throw new DomainRpcError('profile_required', 'Automations need a profile')
    return domainFor(binding.profileId)
  }
  domains.register({
    method: 'automations.list',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params) => domainObject(params ?? {}, ['profileId']),
    async handle(context, _params, binding) {
      const client = context.connection?.clientType
      const viewer = client === 'gui' ? 'window' : client === 'bridge' ? 'computer' : 'local'
      return (await bound(binding)).index(viewer, context.connection?.lifetime)
    }
  })
  domains.register({
    method: 'automations.asks.answer',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'askId', 'answer'])
      if (typeof p.askId !== 'string' || !/^[0-9a-f-]{36}$/i.test(p.askId)) throw new DomainRpcError('invalid_params', 'An ask id is required')
      if (p.answer !== 'allow' && p.answer !== 'not_now') throw new DomainRpcError('invalid_params', 'The answer is allow or not_now')
      return p
    },
    async handle(_context, params, binding) {
      try {
        return { ask: (await bound(binding)).answerAsk(params.askId as string, params.answer as 'allow' | 'not_now') }
      } catch (error) {
        if (error instanceof DomainRpcError) throw error
        throw new DomainRpcError('ask_refused', error instanceof Error ? error.message : String(error))
      }
    }
  })
  domains.register({
    method: 'automations.move',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'jobIds', 'node'])
      if (!Array.isArray(p.jobIds) || !p.jobIds.length || p.jobIds.length > 100 || !p.jobIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256))
        throw new DomainRpcError('invalid_params', 'jobIds is a list of 1 to 100 automation ids')
      if (!isId('node', p.node)) throw new DomainRpcError('invalid_params', 'node is not a computer')
      return p
    },
    async handle(context, params, binding) {
      // A person in a window moves them; the CLI and agents never move an automation to another computer.
      if (context.connection?.clientType !== 'gui') throw new DomainRpcError('forbidden', 'Only a Mousse window can move an automation to another computer.')
      return (await bound(binding)).move(params.jobIds as string[], params.node as string, context.connection?.lifetime)
    }
  })
  domains.register({
    method: 'automations.keep',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'jobId'])
      if (typeof p.jobId !== 'string' || !p.jobId || p.jobId.length > 256) throw new DomainRpcError('invalid_params', 'A job id is required')
      return p
    },
    async handle(_context, params, binding) {
      try {
        const job = (await bound(binding)).keep(params.jobId as string)
        if (!job) throw new DomainRpcError('job_not_found', 'This automation is gone.')
        return { job }
      } catch (error) {
        if (error instanceof DomainRpcError) throw error
        throw new DomainRpcError('keep_refused', error instanceof Error ? error.message : String(error))
      }
    }
  })
}
