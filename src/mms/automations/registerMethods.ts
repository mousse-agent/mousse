import { AUTOMATIONS_CAPABILITY, type AutomationIndex, type AutomationMoveResult } from '../../shared/automations'
import { isId } from '../../shared/net'
import { isKeyName, MAX_KEY_VALUE_BYTES } from '../../shared/automationKeys'
import type { ScheduledJob } from '../../shared/types'
import type { AgentJobAsk } from './AgentJobAsks'
import type { DraftWho } from './AutomationDrafts'
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
  /** Resend: runs a request automation again with the payload one of its deliveries stored. */
  resend(jobId: string, occurrenceId: string): { occurrenceId: string }
  /** Saved keys: their names in the profile's secret store (never values), and storing one typed into a masked field. */
  keys: { list(): string[]; set(name: string, value: string): void }
  /** Drafts: Turn on (the person's creation), Discard, a blank one to set up by hand, and an answered question. */
  drafts: {
    turnOn(draftId: string): ScheduledJob
    discard(draftId: string): void
    blank(projectId?: string): ScheduledJob
    answered(draftId: string): void
    /** The person changed Who on a draft's card. */
    setWho(draftId: string, who: DraftWho): ScheduledJob
    /** The person's Who for the next drafts a manager (the Automation manager, or a bot) writes. */
    nextWho(botId: string | undefined, who: DraftWho): void
  }
  /** The Automation manager's hidden thread, made the first time. */
  managerThread(): { id: string }
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
    method: 'automations.request.resend',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'jobId', 'occurrenceId'])
      if (typeof p.jobId !== 'string' || !p.jobId || p.jobId.length > 256) throw new DomainRpcError('invalid_params', 'A job id is required')
      if (typeof p.occurrenceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(p.occurrenceId)) throw new DomainRpcError('invalid_params', 'A delivery id is required')
      return p
    },
    async handle(_context, params, binding) {
      try {
        return (await bound(binding)).resend(params.jobId as string, params.occurrenceId as string)
      } catch (error) {
        if (error instanceof DomainRpcError) throw error
        throw new DomainRpcError('resend_refused', error instanceof Error ? error.message : String(error))
      }
    }
  })
  domains.register({
    method: 'automations.keys.list',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params) => domainObject(params ?? {}, ['profileId']),
    async handle(_context, _params, binding) {
      return { keys: (await bound(binding)).keys.list().map((name) => ({ name })) }
    }
  })
  domains.register({
    method: 'automations.keys.set',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'name', 'value'])
      if (!isKeyName(p.name)) throw new DomainRpcError('invalid_params', 'A key name is a word like GITHUB_TOKEN')
      if (typeof p.value !== 'string' || !p.value || Buffer.byteLength(p.value, 'utf8') > MAX_KEY_VALUE_BYTES) throw new DomainRpcError('invalid_params', 'A key holds 1 byte to 16 KB')
      return p
    },
    async handle(context, params, binding) {
      // A person types it into a masked field in a window; no agent, CLI call or other computer stores one.
      if (context.connection?.clientType !== 'gui') throw new DomainRpcError('forbidden', 'Add a key from a Mousse window.')
      ;(await bound(binding)).keys.set(params.name as string, params.value as string)
      return { name: params.name }
    }
  })
  const draftId = (params: unknown) => {
    const p = domainObject(params ?? {}, ['profileId', 'draftId'])
    if (typeof p.draftId !== 'string' || !p.draftId || p.draftId.length > 256) throw new DomainRpcError('invalid_params', 'A draft id is required')
    return p
  }
  /** A person turns a draft on, discards it, or answers it: from a window or the CLI, never from another computer. */
  const personOnly = (client: string | undefined) => {
    if (client === 'bridge') throw new DomainRpcError('forbidden', 'A draft is turned on from the computer that holds it.')
  }
  const refused = (error: unknown): never => {
    if (error instanceof DomainRpcError) throw error
    throw new DomainRpcError('draft_refused', error instanceof Error ? error.message : String(error))
  }
  domains.register({
    method: 'automations.drafts.turnOn',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: draftId,
    async handle(context, params, binding) {
      personOnly(context.connection?.clientType)
      try {
        return { job: (await bound(binding)).drafts.turnOn(params.draftId as string) }
      } catch (error) {
        return refused(error)
      }
    }
  })
  domains.register({
    method: 'automations.drafts.discard',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: draftId,
    async handle(context, params, binding) {
      personOnly(context.connection?.clientType)
      try {
        ;(await bound(binding)).drafts.discard(params.draftId as string)
        return { ok: true }
      } catch (error) {
        return refused(error)
      }
    }
  })
  domains.register({
    method: 'automations.drafts.answered',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: draftId,
    async handle(context, params, binding) {
      personOnly(context.connection?.clientType)
      try {
        ;(await bound(binding)).drafts.answered(params.draftId as string)
        return { ok: true }
      } catch (error) {
        return refused(error)
      }
    }
  })
  const whoOf = (value: unknown): DraftWho => {
    const who = domainObject(value ?? {}, ['kind', 'botId'])
    if (who.kind === 'default') return { kind: 'default' }
    if (who.kind === 'bot' && typeof who.botId === 'string' && who.botId && who.botId.length <= 256) return { kind: 'bot', botId: who.botId }
    throw new DomainRpcError('invalid_params', 'who is { kind: "default" } or { kind: "bot", botId }')
  }
  domains.register({
    method: 'automations.drafts.setWho',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params): Record<string, unknown> => {
      const p = domainObject(params ?? {}, ['profileId', 'draftId', 'who'])
      if (typeof p.draftId !== 'string' || !p.draftId || p.draftId.length > 256) throw new DomainRpcError('invalid_params', 'A draft id is required')
      return { ...p, who: whoOf(p.who) }
    },
    async handle(context, params, binding) {
      personOnly(context.connection?.clientType)
      try {
        return { job: (await bound(binding)).drafts.setWho(params.draftId as string, params.who as DraftWho) }
      } catch (error) {
        return refused(error)
      }
    }
  })
  domains.register({
    method: 'automations.drafts.nextWho',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params): Record<string, unknown> => {
      const p = domainObject(params ?? {}, ['profileId', 'botId', 'who'])
      if (p.botId !== undefined && (typeof p.botId !== 'string' || !p.botId || p.botId.length > 256)) throw new DomainRpcError('invalid_params', 'botId is a bot id')
      return { ...p, who: whoOf(p.who) }
    },
    async handle(context, params, binding) {
      personOnly(context.connection?.clientType)
      ;(await bound(binding)).drafts.nextWho(params.botId as string | undefined, params.who as DraftWho)
      return { ok: true }
    }
  })
  domains.register({
    method: 'automations.drafts.create',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'projectId'])
      if (p.projectId !== undefined && (typeof p.projectId !== 'string' || p.projectId.length > 256)) throw new DomainRpcError('invalid_params', 'projectId is a project id')
      return p
    },
    async handle(context, params, binding) {
      personOnly(context.connection?.clientType)
      try {
        return { job: (await bound(binding)).drafts.blank(params.projectId as string | undefined) }
      } catch (error) {
        return refused(error)
      }
    }
  })
  domains.register({
    method: 'automations.manager.thread',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params) => domainObject(params ?? {}, ['profileId']),
    async handle(context, _params, binding) {
      if (context.connection?.clientType !== 'gui') throw new DomainRpcError('forbidden', 'The Automation manager is used from a Mousse window.')
      return { threadId: (await bound(binding)).managerThread().id }
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
