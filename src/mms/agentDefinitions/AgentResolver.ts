import { AgentDefinitionError, type AgentDefinitionIssue } from '../../shared/agents/errors'
import { collectUnsupportedCliSettings, getRuntimeCompatibility } from '../../shared/agents/compatibility'
import { grantDependencyHashes, resolveEffectiveGrants } from '../../shared/agents/grants'
import { compileAgentInstructions } from '../../shared/agents/prompt'
import type {
  AgentCapabilityKind,
  AgentDefinitionRecord,
  AgentImmutableRevision,
  AgentIntegrationLookup,
  AgentModelCapabilityProfile,
  AgentModelLookup,
  AgentModelRef,
  AgentResolveRequest,
  ResolvedAgentDefinition
} from '../../shared/agents/types'
import type { AgentDefinitionRegistry } from './AgentDefinitionRegistry'

export interface AgentResolverOptions {
  registry: AgentDefinitionRegistry
  modelLookup: AgentModelLookup
  integrationLookup: AgentIntegrationLookup
}

function formatModelRef(ref: AgentModelRef): string {
  const effort = ref.effort ? ` effort=${ref.effort}` : ''
  const speed = ref.speed ? ` speed=${ref.speed}` : ''
  const context = ref.context ? ` context=${ref.context}` : ''
  return `${ref.providerId}/${ref.modelId}${effort}${speed}${context}`
}

function validateCapability(
  ref: AgentModelRef,
  profile: AgentModelCapabilityProfile,
  pointer: string
): AgentDefinitionIssue[] {
  const issues: AgentDefinitionIssue[] = []
  if (!profile.available) {
    issues.push({
      code: 'MODEL_CAPABILITY_MISSING',
      message: `Model ${formatModelRef(ref)} is not available in the shared catalog.`,
      pointer,
      retryable: false,
      details: { ref, reasons: profile.unavailableReasons }
    })
    return issues
  }
  if (ref.effort && profile.efforts.length > 0 && !profile.efforts.includes(ref.effort)) {
    issues.push({
      code: 'MODEL_CAPABILITY_MISSING',
      message: `Effort "${ref.effort}" is not supported by ${formatModelRef(ref)}. Supported: ${profile.efforts.join(', ')}.`,
      pointer: `${pointer}/effort`,
      retryable: false,
      details: { ref, supported: profile.efforts }
    })
  }
  if (ref.speed && profile.speeds.length > 0 && !profile.speeds.includes(ref.speed)) {
    issues.push({
      code: 'MODEL_CAPABILITY_MISSING',
      message: `Speed "${ref.speed}" is not supported by ${formatModelRef(ref)}. Supported: ${profile.speeds.join(', ')}.`,
      pointer: `${pointer}/speed`,
      retryable: false,
      details: { ref, supported: profile.speeds }
    })
  }
  if (ref.context && profile.contexts.length > 0 && !profile.contexts.includes(ref.context)) {
    issues.push({
      code: 'MODEL_CAPABILITY_MISSING',
      message: `Context "${ref.context}" is not supported by ${formatModelRef(ref)}. Supported: ${profile.contexts.join(', ')}.`,
      pointer: `${pointer}/context`,
      retryable: false,
      details: { ref, supported: profile.contexts }
    })
  }
  return issues
}

export class AgentResolver {
  constructor(private readonly options: AgentResolverOptions) {}

  resolve(request: AgentResolveRequest): ResolvedAgentDefinition {
    const { registry, modelLookup, integrationLookup } = this.options
    let settings: AgentDefinitionRecord['settings']
    let systemPrompt: string
    let runtimeKind: AgentDefinitionRecord['runtimeKind']
    let visual: AgentDefinitionRecord['visual']
    let revision: string
    let visualRevision: string
    let dependencyHashes: Record<string, string>

    if (request.revision) {
      const pinned = this.loadPinned(request.definitionId, request.revision)
      settings = pinned.settings
      systemPrompt = pinned.systemPrompt
      runtimeKind = pinned.runtimeKind
      visual = pinned.visual
      revision = pinned.revision
      visualRevision = pinned.visualRevision
      dependencyHashes = { ...pinned.dependencyHashes }
    } else {
      const draft = registry.get(request.definitionId)
      if (draft.flags.archived && !draft.published) {
        throw new AgentDefinitionError('AGENT_ARCHIVED', 'Archived definition has no published revision to resolve.', {
          details: { id: request.definitionId }
        })
      }
      if (!draft.published) {
        throw new AgentDefinitionError(
          'REVISION_NOT_FOUND',
          'Definition has not been published. Resolve a pinned revision or publish first.',
          { details: { id: request.definitionId } }
        )
      }
      const pinned = this.loadPinned(request.definitionId, draft.published.revision)
      settings = pinned.settings
      systemPrompt = pinned.systemPrompt
      runtimeKind = pinned.runtimeKind
      visual = pinned.visual
      revision = pinned.revision
      visualRevision = pinned.visualRevision
      dependencyHashes = { ...pinned.dependencyHashes }
    }

    const issues: AgentDefinitionIssue[] = []
    const unsupported = collectUnsupportedCliSettings(runtimeKind, settings)
    if (unsupported.length > 0) {
      issues.push({
        code: 'SETTINGS_UNSUPPORTED',
        message: `Runtime ${runtimeKind} does not support ${unsupported.join(', ')}.`,
        retryable: false,
        details: { runtimeKind, pointers: unsupported, compatibility: getRuntimeCompatibility(runtimeKind) }
      })
    }

    const primaryProfile = this.lookupModel(settings.primaryModel.ref, '/settings/primaryModel/ref', modelLookup, issues)
    const fallbacks: AgentModelCapabilityProfile[] = []
    if (settings.fallbacks.enabled) {
      settings.fallbacks.models.forEach((ref, index) => {
        fallbacks.push(this.lookupModel(ref, `/settings/fallbacks/models/${index}`, modelLookup, issues))
      })
    }
    const capabilityOverrides: Partial<Record<AgentCapabilityKind, AgentModelCapabilityProfile>> = {}
    for (const [capability, ref] of Object.entries(settings.primaryModel.capabilityOverrides) as Array<
      [AgentCapabilityKind, AgentModelRef]
    >) {
      const profile = this.lookupModel(
        ref,
        `/settings/primaryModel/capabilityOverrides/${capability}`,
        modelLookup,
        issues
      )
      if (!profile.capabilities.includes(capability)) {
        issues.push({
          code: 'MODEL_CAPABILITY_MISSING',
          message: `Override model ${formatModelRef(ref)} does not advertise capability "${capability}".`,
          pointer: `/settings/primaryModel/capabilityOverrides/${capability}`,
          retryable: false,
          details: { ref, capability, advertised: profile.capabilities }
        })
      }
      capabilityOverrides[capability] = profile
    }

    const grants = resolveEffectiveGrants(settings, integrationLookup)
    const requiredSkills = settings.skills.selections.filter((selection) => selection.enabled)
    for (const selection of requiredSkills) {
      const granted = grants.skills.some((entry) => entry.id === selection.skillId)
      if (!granted) {
        issues.push({
          code: 'DEPENDENCY_MISSING',
          message: `Skill "${selection.skillId}" is required by this definition but is not available.`,
          pointer: '/settings/skills',
          retryable: false,
          details: { skillId: selection.skillId }
        })
      }
    }
    for (const server of settings.mcp.servers.filter((item) => item.enabled)) {
      for (const tool of server.tools.filter((item) => item.enabled)) {
        const granted = grants.mcpTools.some(
          (entry) => entry.serverId === server.serverId && entry.toolName === tool.toolName
        )
        if (!granted) {
          issues.push({
            code: 'DEPENDENCY_MISSING',
            message: `MCP tool "${server.serverId}/${tool.toolName}" is required but is not available.`,
            pointer: '/settings/mcp',
            retryable: false,
            details: { serverId: server.serverId, toolName: tool.toolName }
          })
        }
      }
    }

    const liveHashes = grantDependencyHashes(grants)
    dependencyHashes = { ...dependencyHashes, ...liveHashes }

    const blocking = issues.filter(
      (issue) => issue.code === 'MODEL_CAPABILITY_MISSING' || issue.code === 'DEPENDENCY_MISSING' || issue.code === 'SETTINGS_UNSUPPORTED'
    )
    if (blocking.length > 0) {
      const first = blocking[0]
      throw new AgentDefinitionError(first.code, first.message, {
        pointer: first.pointer,
        details: { issues: blocking }
      })
    }

    return {
      definitionId: request.definitionId,
      profileId: this.options.registry.profileId,
      revision,
      visualRevision,
      runtimeKind,
      settings,
      instructions: compileAgentInstructions({
        applicationRules: request.applicationRules,
        profileProjectContext: request.profileProjectContext,
        definitionInstructions: systemPrompt,
        workflowNodeInstructions: request.workflowNodeInstructions,
        task: request.task,
        output: settings.output
      }),
      model: {
        primary: primaryProfile,
        fallbacks,
        capabilityOverrides
      },
      grants,
      dependencyHashes,
      visual,
      issues
    }
  }

  private loadPinned(definitionId: string, revision: string): AgentImmutableRevision {
    return this.options.registry.getRevision(definitionId, revision)
  }

  private lookupModel(
    ref: AgentModelRef,
    pointer: string,
    lookup: AgentModelLookup,
    issues: AgentDefinitionIssue[]
  ): AgentModelCapabilityProfile {
    if (!ref.providerId || !ref.modelId) {
      const missing: AgentModelCapabilityProfile = {
        ref,
        available: false,
        efforts: [],
        speeds: [],
        contexts: [],
        capabilities: [],
        unavailableReasons: ['Model reference is incomplete.']
      }
      issues.push({
        code: 'MODEL_CAPABILITY_MISSING',
        message: 'Primary model is not configured.',
        pointer,
        retryable: false,
        details: { ref }
      })
      return missing
    }
    const profile = lookup.resolve(ref)
    if (!profile) {
      const missing: AgentModelCapabilityProfile = {
        ref,
        available: false,
        efforts: [],
        speeds: [],
        contexts: [],
        capabilities: [],
        unavailableReasons: ['Model is not present in the injected catalog.']
      }
      issues.push({
        code: 'MODEL_CAPABILITY_MISSING',
        message: `Model ${formatModelRef(ref)} is not present in the injected catalog.`,
        pointer,
        retryable: false,
        details: { ref }
      })
      return missing
    }
    issues.push(...validateCapability(ref, profile, pointer))
    return profile
  }
}
