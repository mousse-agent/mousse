import { AGENT_DEFINITION_CAPABILITY, AGENT_DEFINITION_METHODS, type AgentDefinitionMethod } from '../../shared/agentPlatform'
import { AgentDefinitionError, type AgentDefinitionIssue } from '../../shared/agents/errors'
import { resolveEffectiveGrants } from '../../shared/agents/grants'
import { isAgentDefinitionId, isAgentRuntimeKind } from '../../shared/agents/schema'
import type { PendingUserQuestions, UserQuestionAnswers } from '../../shared/types'
import type { AgentDefinitionRecord, AgentExportBundle, AgentIntegrationLookup, CreateAgentDefinitionInput, ResolvedAgentDefinition, SaveAgentDraftInput } from '../../shared/agents/types'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../protocol/domainRegistry'
import type { HandlerContext } from '../protocol/handlers'
import type { AgentDefinitionServices } from './index'

export interface DefinitionTryRunResult {
  ok: boolean
  status: 'completed' | 'failed' | 'blocked'
  summary: string
  trace: Array<{ at: string; message: string }>
  issues?: AgentDefinitionIssue[]
  runId?: string
  threadId?: string
}

export interface AgentDefinitionDomainServices extends AgentDefinitionServices {
  integrationLookup: AgentIntegrationLookup
  /**
   * Where the definition would run (`gateway.check()` on its models' instances, PR 4 §6), as editor
   * issues. Root binds it to the profile's orchestrator; absent, no such issue is reported.
   */
  checkRuntime?: (input: { definitionId: string; revision: string; settings: AgentDefinitionRecord['settings']; grants: ResolvedAgentDefinition['grants'] }) => AgentDefinitionIssue[]
  /** Root attaches the real native/CLI executor; the domain never invents a successful run. */
  tryRun?: (input: {
    resolved: ResolvedAgentDefinition; record: AgentDefinitionRecord; prompt: string;
    exampleId?: string; connectionId: string
  }) => Promise<DefinitionTryRunResult>
  /**
   * The questions this connection's running Try Runs of a definition wait on (a shell command's
   * approval, an `ask_user`): the Try Run panel shows them, since their thread is not on screen.
   */
  tryRunPending?: (input: { definitionId: string; connectionId: string }) => DefinitionTryRunPending
  /** Answers (or dismisses) one of those questions; any other request is refused. */
  tryRunAnswer?: (input: { definitionId: string; connectionId: string; requestId: string; answers?: UserQuestionAnswers; dismiss?: boolean; via: 'gui' | 'cli' | 'internal' }) => { ok: boolean }
}

/** A connection's running Try Runs of one definition, and what each waits on. */
export interface DefinitionTryRunPending {
  runs: Array<{ runId: string; threadId: string; threadTitle: string; questions: PendingUserQuestions[] }>
}

type Params = Record<string, unknown>
const keys: Record<AgentDefinitionMethod, readonly string[]> = {
  'agentDefinitions.list': ['archived'],
  'agentDefinitions.get': ['id'],
  'agentDefinitions.create': ['runtimeKind', 'settings', 'systemPrompt', 'visual', 'flags'],
  'agentDefinitions.saveDraft': ['id', 'expectedDraftHash', 'runtimeKind', 'settings', 'systemPrompt', 'visual', 'flags'],
  'agentDefinitions.publish': ['id', 'expectedDraftHash'],
  'agentDefinitions.archive': ['id'],
  'agentDefinitions.duplicate': ['id'],
  'agentDefinitions.importBundle': ['bundle', 'conflict'],
  'agentDefinitions.exportBundle': ['id', 'revision'],
  'agentDefinitions.validate': ['id', 'expectedDraftHash', 'runtimeOnly'],
  'agentDefinitions.tryRun': ['id', 'expectedDraftHash', 'revision', 'prompt', 'exampleId'],
  'agentDefinitions.tryRunPending': ['id'],
  'agentDefinitions.tryRunAnswer': ['id', 'requestId', 'answers', 'dismiss']
}

function validate(method: AgentDefinitionMethod, value: unknown): Params {
  const p = domainObject(value ?? {}, ['profileId', ...keys[method]])
  if (p.id !== undefined && !isAgentDefinitionId(p.id)) throw new DomainRpcError('invalid_params', 'Invalid agent definition identity')
  if (!['agentDefinitions.list', 'agentDefinitions.create', 'agentDefinitions.importBundle', 'agentDefinitions.validate'].includes(method) && p.id === undefined) throw new DomainRpcError('invalid_params', 'Agent definition identity is required')
  for (const key of ['expectedDraftHash', 'revision']) {
    if (p[key] !== undefined && (typeof p[key] !== 'string' || !/^[a-f0-9]{64}$/.test(p[key] as string))) throw new DomainRpcError('invalid_params', 'Invalid revision hash')
  }
  if (['agentDefinitions.saveDraft', 'agentDefinitions.publish'].includes(method) && p.expectedDraftHash === undefined) throw new DomainRpcError('invalid_params', 'Expected draft hash is required')
  if (p.runtimeKind !== undefined && !isAgentRuntimeKind(p.runtimeKind)) throw new DomainRpcError('invalid_params', 'Unsupported agent runtime')
  if (p.archived !== undefined && typeof p.archived !== 'boolean') throw new DomainRpcError('invalid_params', 'archived must be boolean')
  if (p.runtimeOnly !== undefined && typeof p.runtimeOnly !== 'boolean') throw new DomainRpcError('invalid_params', 'runtimeOnly must be boolean')
  if (p.flags !== undefined) {
    const flags = domainObject(p.flags, ['enabled', 'favorite'])
    if (Object.values(flags).some((flag) => typeof flag !== 'boolean')) throw new DomainRpcError('invalid_params', 'Agent flags must be boolean')
  }
  for (const key of ['systemPrompt', 'prompt', 'exampleId']) {
    if (p[key] !== undefined && (typeof p[key] !== 'string' || (p[key] as string).length > (key === 'exampleId' ? 256 : 512 * 1024))) throw new DomainRpcError('invalid_params', 'Invalid ' + key)
  }
  if (method === 'agentDefinitions.tryRun' && (typeof p.prompt !== 'string' || !p.prompt.trim())) throw new DomainRpcError('invalid_params', 'A try-run prompt is required')
  if (method === 'agentDefinitions.tryRun' && p.revision !== undefined && p.expectedDraftHash !== undefined) throw new DomainRpcError('invalid_params', 'Choose an exact draft or a published revision')
  if (method === 'agentDefinitions.tryRunAnswer') {
    if (typeof p.requestId !== 'string' || !p.requestId || p.requestId.length > 256) throw new DomainRpcError('invalid_params', 'A question request id is required')
    if (p.dismiss !== undefined && typeof p.dismiss !== 'boolean') throw new DomainRpcError('invalid_params', 'dismiss must be boolean')
    if ((p.answers === undefined) === (p.dismiss !== true)) throw new DomainRpcError('invalid_params', 'Give the answers, or dismiss the question')
    if (p.answers !== undefined) {
      if (!p.answers || typeof p.answers !== 'object' || Array.isArray(p.answers)) throw new DomainRpcError('invalid_params', 'Invalid answers')
      const values = Object.values(p.answers as Record<string, unknown>)
      const valid = (value: unknown) => typeof value === 'string' && value.length <= 64 * 1024
      if (values.length > 32 || values.some((value) => !valid(value) && !(Array.isArray(value) && value.length <= 64 && value.every(valid))))
        throw new DomainRpcError('invalid_params', 'Invalid answers')
    }
  }
  if (p.conflict !== undefined && p.conflict !== 'fail' && p.conflict !== 'rename') throw new DomainRpcError('invalid_params', 'Invalid import conflict choice')
  if (p.settings !== undefined) domainObject(p.settings, ['identity', 'instructions', 'primaryModel', 'fallbacks', 'output', 'context', 'memory', 'skills', 'mcp', 'tools', 'browser', 'delegation', 'workspace', 'script', 'approval', 'limits', 'recovery', 'examples'])
  if (method === 'agentDefinitions.create' && p.settings === undefined) throw new DomainRpcError('invalid_params', 'Agent settings are required')
  if (p.bundle !== undefined) domainObject(p.bundle, ['format', 'formatVersion', 'manifest', 'files', 'visual', 'publishedRevision'])
  if (method === 'agentDefinitions.importBundle' && p.bundle === undefined) throw new DomainRpcError('invalid_params', 'Agent bundle is required')
  return p
}

function issues(error: unknown): AgentDefinitionIssue[] {
  if (!(error instanceof AgentDefinitionError)) throw error
  const nested = error.details?.issues
  return Array.isArray(nested) ? nested as AgentDefinitionIssue[] : [error.toIssue()]
}

/** Bind once before server seal. Services resolve from the daemon's admitted profile, never a path supplied by a client. */
export function registerAgentDefinitionMethods(
  domains: DomainHandlerRegistry,
  servicesForProfile: (profileId: string, request: {
    method: AgentDefinitionMethod; params: Readonly<Params>
  }) => AgentDefinitionDomainServices | Promise<AgentDefinitionDomainServices>
): void {
  for (const method of AGENT_DEFINITION_METHODS) {
    domains.register({
      method, scope: 'profile', capability: AGENT_DEFINITION_CAPABILITY,
      requiredCapabilities: [AGENT_DEFINITION_CAPABILITY],
      validate: (params) => validate(method, params),
      async handle(context, params, binding) {
        try {
          const service = await servicesForProfile(binding!.profileId, { method, params })
          if (service.registry.profileId !== binding!.profileId) throw new DomainRpcError('profile_mismatch', 'Agent registry does not belong to the admitted profile')
          return await handle(method, params, service, context)
        }
        catch (error) {
          if (error instanceof AgentDefinitionError) throw new DomainRpcError(error.code, error.message, { ...error.details, pointer: error.pointer, retryable: error.retryable })
          throw error
        }
      }
    })
  }
}

async function handle(method: AgentDefinitionMethod, p: Params, service: AgentDefinitionDomainServices, context: HandlerContext): Promise<unknown> {
  const { registry, resolver } = service
  const id = p.id as string
  const revision = p.revision as string | undefined
  const expectedDraftHash = p.expectedDraftHash as string | undefined
  switch (method) {
    case 'agentDefinitions.list': return registry.list({ archived: p.archived as boolean | undefined }).map((entry) => {
      const record = registry.get(entry.id)
      return { ...entry, model: record.settings.primaryModel.ref, visual: record.visual }
    })
    case 'agentDefinitions.get': return registry.get(id)
    case 'agentDefinitions.create': return registry.createDraft(p as unknown as CreateAgentDefinitionInput)
    case 'agentDefinitions.saveDraft': return registry.saveDraft(id, p as unknown as SaveAgentDraftInput)
    case 'agentDefinitions.publish': {
      const resolved = resolver.resolveDraft({ definitionId: id, expectedDraftHash })
      return registry.publish(id, expectedDraftHash!, {
        dependencyHashes: resolved.dependencyHashes
      })
    }
    case 'agentDefinitions.archive': return registry.archive(id)
    case 'agentDefinitions.duplicate': return registry.duplicate(id)
    case 'agentDefinitions.importBundle': return registry.importBundle(p.bundle as AgentExportBundle, { conflict: p.conflict as 'fail' | 'rename' | undefined })
    case 'agentDefinitions.exportBundle': return registry.exportBundle(id, revision)
    case 'agentDefinitions.validate': {
      if (!id) return { issues: [] }
      if (p.runtimeOnly === true) {
        // The editor's check of where the saved draft would run: no integration is started for it.
        const record = registry.get(id)
        if (expectedDraftHash !== undefined && expectedDraftHash !== record.draftHash) {
          throw new AgentDefinitionError('REVISION_CONFLICT', 'Draft changed since it was loaded. Reload and retry.', { retryable: true, details: { expectedDraftHash, actualDraftHash: record.draftHash } })
        }
        return { issues: service.checkRuntime?.({ definitionId: id, revision: record.semanticHash, settings: record.settings, grants: resolveEffectiveGrants(record.settings, service.integrationLookup) }) ?? [] }
      }
      try {
        const resolved = resolver.resolveDraft({ definitionId: id, expectedDraftHash })
        return { issues: [...resolved.issues, ...(service.checkRuntime?.({ definitionId: id, revision: resolved.revision, settings: resolved.settings, grants: resolved.grants }) ?? [])] }
      }
      catch (error) {
        if (error instanceof AgentDefinitionError && error.code === 'REVISION_CONFLICT') throw error
        return { issues: issues(error) }
      }
    }
    case 'agentDefinitions.tryRun': {
      const record = registry.get(id)
      if (record.flags.archived || !record.flags.enabled) return { ok: false, status: 'blocked', summary: 'Enable an active agent before trying it.', trace: [] }
      const resolved = expectedDraftHash !== undefined
        ? resolver.resolveDraft({ definitionId: id, expectedDraftHash, task: p.prompt as string })
        : resolver.resolve({ definitionId: id, revision, task: p.prompt as string })
      if (!service.tryRun) return { ok: false, status: 'blocked', summary: 'Agent execution is unavailable in this daemon.', trace: [] }
      return service.tryRun({ resolved, record, prompt: p.prompt as string, exampleId: p.exampleId as string | undefined, connectionId: context.connection!.id })
    }
    case 'agentDefinitions.tryRunPending':
      return service.tryRunPending?.({ definitionId: id, connectionId: context.connection!.id }) ?? { runs: [] }
    case 'agentDefinitions.tryRunAnswer': {
      if (!service.tryRunAnswer) return { ok: false }
      const via = context.connection?.clientType === 'gui' ? 'gui' : context.connection?.clientType === 'cli' ? 'cli' : 'internal'
      return service.tryRunAnswer({ definitionId: id, connectionId: context.connection!.id, requestId: p.requestId as string,
        ...(p.answers !== undefined ? { answers: p.answers as UserQuestionAnswers } : {}), ...(p.dismiss === true ? { dismiss: true } : {}), via })
    }
  }
}
