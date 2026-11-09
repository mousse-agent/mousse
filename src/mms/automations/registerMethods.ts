import { AUTOMATIONS_CAPABILITY, type AutomationIndex } from '../../shared/automations'
import { isId } from '../../shared/net'
import { isKeyName, MAX_KEY_VALUE_BYTES } from '../../shared/automationKeys'
import type { ScheduledJob } from '../../shared/types'
import type { AutomationInbox, InboxCounts, TuningNote } from '../../shared/automationInbox'
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
  /** The Automation manager's hidden thread, made the first time. Its turns work in the project the composer picked. */
  managerThread(projectId?: string): { id: string }
  /** The inbox: runs, the Needs you queue, Tuning notes and this month's usage. */
  inbox: {
    list(): AutomationInbox
    counts(): InboxCounts
    /** Resolve: every open item of the run. Opening a run never does this. */
    resolve(runId: string): number
    /** Undo the person's last Resolve; the run it reopened. */
    undo(): string | undefined
    /** Too noisy / Should have told me: a Tuning note, or taken back when given again. */
    calibrate(runId: string, kind: TuningNote['kind']): TuningNote | undefined
    removeTuning(noteId: string): boolean
  }
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
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'projectId'])
      if (p.projectId !== undefined && (typeof p.projectId !== 'string' || p.projectId.length > 256)) throw new DomainRpcError('invalid_params', 'projectId is a project id')
      return p
    },
    async handle(context, params, binding) {
      if (context.connection?.clientType !== 'gui') throw new DomainRpcError('forbidden', 'The Automation manager is used from a Mousse window.')
      return { threadId: (await bound(binding)).managerThread(params.projectId as string | undefined || undefined).id }
    }
  })
  // ── The inbox ──
  const runIdOf = (params: unknown, extra: string[] = []) => {
    const p = domainObject(params ?? {}, ['profileId', 'runId', ...extra])
    if (typeof p.runId !== 'string' || !/^run_[0-9a-f-]{36}$/i.test(p.runId)) throw new DomainRpcError('invalid_params', 'A run id is required')
    return p
  }
  /** The queue and the notes are changed by the person in a window (or the CLI), never from another computer. */
  const notBridge = (client: string | undefined) => {
    if (client === 'bridge') throw new DomainRpcError('forbidden', 'Runs are resolved on the computer that ran them.')
  }
  domains.register({
    method: 'automations.inbox.list',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params) => domainObject(params ?? {}, ['profileId']),
    async handle(_context, _params, binding) {
      try {
        return (await bound(binding)).inbox.list()
      } catch (error) {
        if (error instanceof DomainRpcError) throw error
        throw new DomainRpcError('inbox_unavailable', error instanceof Error ? error.message : String(error))
      }
    }
  })
  domains.register({
    method: 'automations.inbox.counts',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params) => domainObject(params ?? {}, ['profileId']),
    async handle(_context, _params, binding) {
      return (await bound(binding)).inbox.counts()
    }
  })
  domains.register({
    method: 'automations.inbox.resolve',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params) => runIdOf(params),
    async handle(context, params, binding) {
      notBridge(context.connection?.clientType)
      return { resolved: (await bound(binding)).inbox.resolve(params.runId as string) }
    }
  })
  domains.register({
    method: 'automations.inbox.undo',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params) => domainObject(params ?? {}, ['profileId']),
    async handle(context, _params, binding) {
      notBridge(context.connection?.clientType)
      const runId = (await bound(binding)).inbox.undo()
      return runId ? { runId } : {}
    }
  })
  domains.register({
    method: 'automations.inbox.calibrate',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params) => {
      const p = runIdOf(params, ['kind'])
      if (p.kind !== 'noisy' && p.kind !== 'missed') throw new DomainRpcError('invalid_params', 'kind is noisy or missed')
      return p
    },
    async handle(context, params, binding) {
      notBridge(context.connection?.clientType)
      try {
        const note = (await bound(binding)).inbox.calibrate(params.runId as string, params.kind as TuningNote['kind'])
        return note ? { note } : {}
      } catch (error) {
        if (error instanceof DomainRpcError) throw error
        throw new DomainRpcError('run_not_found', error instanceof Error ? error.message : String(error))
      }
    }
  })
  domains.register({
    method: 'automations.tuning.remove',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'noteId'])
      if (typeof p.noteId !== 'string' || !/^tune_[0-9a-f-]{36}$/i.test(p.noteId)) throw new DomainRpcError('invalid_params', 'A note id is required')
      return p
    },
    async handle(context, params, binding) {
      notBridge(context.connection?.clientType)
      return { removed: (await bound(binding)).inbox.removeTuning(params.noteId as string) }
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
