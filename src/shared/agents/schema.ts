import { randomUUID } from 'node:crypto'
import { AgentDefinitionError } from './errors'
import {
  AGENT_EXAMPLE_PROMPT_MAX_BYTES,
  AGENT_SLUG_MAX_LENGTH,
  AGENT_SLUG_PATTERN,
  defaultAgentSettings
} from './defaults'
import { assertPromptSize, assertSafeBundlePath, utf8ByteLength } from './pathSafety'
import {
  AGENT_BUNDLE_FILES,
  AGENT_CAPABILITY_KINDS,
  AGENT_DEFINITION_SCHEMA_VERSION,
  AGENT_GRANT_MODES,
  AGENT_RUNTIME_KINDS,
  AGENT_SYSTEM_PROMPT_FILE,
  type AgentCapabilityKind,
  type AgentDefinitionManifest,
  type AgentDefinitionSettings,
  type AgentExample,
  type AgentIdentitySettings,
  type AgentModelRef,
  type AgentRuntimeKind,
  type AgentVisualMetadata
} from './types'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isAgentDefinitionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function createAgentDefinitionId(): string {
  return randomUUID()
}

export function isAgentRuntimeKind(value: unknown): value is AgentRuntimeKind {
  return typeof value === 'string' && (AGENT_RUNTIME_KINDS as readonly string[]).includes(value)
}

export function normalizeSlug(value: string): string {
  return value.trim().toLowerCase()
}

export function assertSlug(slug: string, pointer = '/settings/identity/slug'): string {
  const normalized = normalizeSlug(slug)
  if (normalized.length === 0 || normalized.length > AGENT_SLUG_MAX_LENGTH || !AGENT_SLUG_PATTERN.test(normalized)) {
    throw new AgentDefinitionError(
      'INVALID_BUNDLE',
      'Slug must be 1–64 characters of lowercase letters, digits, underscore, or hyphen.',
      { pointer, details: { slug } }
    )
  }
  return normalized
}

function requireString(value: unknown, pointer: string): string {
  if (typeof value !== 'string') {
    throw new AgentDefinitionError('INVALID_BUNDLE', `Expected a string at ${pointer}.`, { pointer })
  }
  return value
}

function requireBoolean(value: unknown, pointer: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AgentDefinitionError('INVALID_BUNDLE', `Expected a boolean at ${pointer}.`, { pointer })
  }
  return value
}

function requireFiniteNumber(value: unknown, pointer: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new AgentDefinitionError('INVALID_BUNDLE', `Expected a finite number ≥ ${min} at ${pointer}.`, {
      pointer,
      details: { value }
    })
  }
  return value
}

function requireStringArray(value: unknown, pointer: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AgentDefinitionError('INVALID_BUNDLE', `Expected a string array at ${pointer}.`, { pointer })
  }
  return value.map((item) => item.trim()).filter(Boolean)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], pointer: string, fallback: T): T {
  if (value === undefined) return fallback
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  throw new AgentDefinitionError('INVALID_BUNDLE', `Unsupported value at ${pointer}.`, {
    pointer,
    details: { value, allowed }
  })
}

export function parseModelRef(value: unknown, pointer: string): AgentModelRef {
  if (!isPlainObject(value)) {
    throw new AgentDefinitionError('INVALID_BUNDLE', `Expected a model reference at ${pointer}.`, { pointer })
  }
  const ref: AgentModelRef = {
    providerId: requireString(value.providerId, `${pointer}/providerId`).trim(),
    modelId: requireString(value.modelId, `${pointer}/modelId`).trim()
  }
  if (typeof value.familyId === 'string' && value.familyId.trim()) ref.familyId = value.familyId.trim()
  if (typeof value.variantId === 'string' && value.variantId.trim()) ref.variantId = value.variantId.trim()
  if (typeof value.effort === 'string' && value.effort.trim()) ref.effort = value.effort.trim()
  if (typeof value.speed === 'string' && value.speed.trim()) ref.speed = value.speed.trim()
  if (typeof value.context === 'string' && value.context.trim()) ref.context = value.context.trim()
  return ref
}

function parseCapabilityOverrides(
  value: unknown,
  pointer: string
): Partial<Record<AgentCapabilityKind, AgentModelRef>> {
  if (value === undefined) return {}
  if (!isPlainObject(value)) {
    throw new AgentDefinitionError('INVALID_BUNDLE', `Expected capability overrides at ${pointer}.`, { pointer })
  }
  const overrides: Partial<Record<AgentCapabilityKind, AgentModelRef>> = {}
  for (const [key, ref] of Object.entries(value)) {
    if (!(AGENT_CAPABILITY_KINDS as readonly string[]).includes(key)) {
      throw new AgentDefinitionError('INVALID_BUNDLE', `Unknown capability override "${key}".`, {
        pointer: `${pointer}/${key}`
      })
    }
    overrides[key as AgentCapabilityKind] = parseModelRef(ref, `${pointer}/${key}`)
  }
  return overrides
}

function parseExamples(value: unknown, pointer: string): AgentExample[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new AgentDefinitionError('INVALID_BUNDLE', `Expected examples array at ${pointer}.`, { pointer })
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new AgentDefinitionError('INVALID_BUNDLE', `Expected example object at ${pointer}/${index}.`, {
        pointer: `${pointer}/${index}`
      })
    }
    const prompt = requireString(item.prompt, `${pointer}/${index}/prompt`)
    if (utf8ByteLength(prompt) > AGENT_EXAMPLE_PROMPT_MAX_BYTES) {
      throw new AgentDefinitionError(
        'PROMPT_TOO_LARGE',
        `Example prompt exceeds ${AGENT_EXAMPLE_PROMPT_MAX_BYTES} bytes.`,
        { pointer: `${pointer}/${index}/prompt` }
      )
    }
    const example: AgentExample = {
      id: requireString(item.id, `${pointer}/${index}/id`).trim() || createAgentDefinitionId(),
      name: requireString(item.name, `${pointer}/${index}/name`).trim(),
      prompt
    }
    if (isPlainObject(item.expectedSchema)) example.expectedSchema = item.expectedSchema
    if (Array.isArray(item.assertions)) {
      example.assertions = item.assertions.filter((entry): entry is string => typeof entry === 'string')
    }
    if (isPlainObject(item.fixtureContext)) example.fixtureContext = item.fixtureContext
    return example
  })
}

function parseIdentity(value: unknown, pointer: string): AgentIdentitySettings {
  if (!isPlainObject(value)) {
    throw new AgentDefinitionError('INVALID_BUNDLE', `Expected identity settings at ${pointer}.`, { pointer })
  }
  const name = requireString(value.name, `${pointer}/name`).trim()
  if (!name) {
    throw new AgentDefinitionError('INVALID_BUNDLE', 'Agent name is required.', { pointer: `${pointer}/name` })
  }
  return {
    name,
    slug: assertSlug(requireString(value.slug, `${pointer}/slug`), `${pointer}/slug`),
    purpose: typeof value.purpose === 'string' ? value.purpose : '',
    tags: Array.isArray(value.tags) ? requireStringArray(value.tags, `${pointer}/tags`) : []
  }
}

export function parseAgentSettings(
  value: unknown,
  identityFallback?: AgentIdentitySettings
): AgentDefinitionSettings {
  if (!isPlainObject(value)) {
    throw new AgentDefinitionError('INVALID_BUNDLE', 'Expected settings object.', { pointer: '/settings' })
  }
  const identity = parseIdentity(value.identity ?? identityFallback, '/settings/identity')
  const defaults = defaultAgentSettings(identity)
  const settings = value as Record<string, unknown>
  const instructions = isPlainObject(settings.instructions) ? settings.instructions : {}
  const systemPromptFile = typeof instructions.systemPromptFile === 'string'
    ? assertSafeBundlePath(instructions.systemPromptFile, '/settings/instructions/systemPromptFile')
    : AGENT_SYSTEM_PROMPT_FILE
  if (systemPromptFile !== AGENT_SYSTEM_PROMPT_FILE) {
    throw new AgentDefinitionError(
      'INVALID_BUNDLE',
      `System prompt file must be ${AGENT_SYSTEM_PROMPT_FILE}.`,
      { pointer: '/settings/instructions/systemPromptFile', details: { systemPromptFile } }
    )
  }

  const primary = isPlainObject(settings.primaryModel) ? settings.primaryModel : {}
  const fallbacks = isPlainObject(settings.fallbacks) ? settings.fallbacks : {}
  const output = isPlainObject(settings.output) ? settings.output : {}
  const context = isPlainObject(settings.context) ? settings.context : {}
  const memory = isPlainObject(settings.memory) ? settings.memory : {}
  const skills = isPlainObject(settings.skills) ? settings.skills : {}
  const mcp = isPlainObject(settings.mcp) ? settings.mcp : {}
  const tools = isPlainObject(settings.tools) ? settings.tools : {}
  const browser = isPlainObject(settings.browser) ? settings.browser : {}
  const delegation = isPlainObject(settings.delegation) ? settings.delegation : {}
  const workspace = isPlainObject(settings.workspace) ? settings.workspace : {}
  const script = isPlainObject(settings.script) ? settings.script : {}
  const approval = isPlainObject(settings.approval) ? settings.approval : {}
  const limits = isPlainObject(settings.limits) ? settings.limits : {}
  const recovery = isPlainObject(settings.recovery) ? settings.recovery : {}

  return {
    identity,
    instructions: { systemPromptFile },
    primaryModel: {
      ref: primary.ref !== undefined ? parseModelRef(primary.ref, '/settings/primaryModel/ref') : defaults.primaryModel.ref,
      capabilityOverrides: parseCapabilityOverrides(primary.capabilityOverrides, '/settings/primaryModel/capabilityOverrides')
    },
    fallbacks: {
      enabled: typeof fallbacks.enabled === 'boolean' ? fallbacks.enabled : false,
      models: Array.isArray(fallbacks.models)
        ? fallbacks.models.map((model, index) => parseModelRef(model, `/settings/fallbacks/models/${index}`))
        : [],
      retryOn: Array.isArray(fallbacks.retryOn)
        ? fallbacks.retryOn.filter(
            (item): item is AgentDefinitionSettings['fallbacks']['retryOn'][number] =>
              item === 'rate_limit' || item === 'timeout' || item === 'unavailable' || item === 'content_filter'
          )
        : [],
      allowHigherCost: typeof fallbacks.allowHigherCost === 'boolean' ? fallbacks.allowHigherCost : false
    },
    output: {
      language: typeof output.language === 'string' ? output.language : undefined,
      tone: typeof output.tone === 'string' ? output.tone : undefined,
      verbosity: optionalEnum(output.verbosity, ['concise', 'normal', 'verbose'] as const, '/settings/output/verbosity', 'normal'),
      citationPreference: optionalEnum(
        output.citationPreference,
        ['none', 'inline', 'footnotes'] as const,
        '/settings/output/citationPreference',
        'none'
      ),
      format: optionalEnum(output.format, ['markdown', 'json', 'schema'] as const, '/settings/output/format', 'markdown'),
      jsonSchema: isPlainObject(output.jsonSchema) ? output.jsonSchema : undefined
    },
    context: {
      includeCurrentThread: typeof context.includeCurrentThread === 'boolean' ? context.includeCurrentThread : true,
      selectedFiles: Array.isArray(context.selectedFiles)
        ? context.selectedFiles.map((path, index) =>
            typeof path === 'string' ? assertSafeBundlePath(path, `/settings/context/selectedFiles/${index}`) : ''
          ).filter(Boolean)
        : [],
      includeProjectInstructions:
        typeof context.includeProjectInstructions === 'boolean' ? context.includeProjectInstructions : true,
      attachmentPolicy: optionalEnum(
        context.attachmentPolicy,
        ['none', 'explicit', 'thread'] as const,
        '/settings/context/attachmentPolicy',
        'thread'
      ),
      maxContextTokens:
        typeof context.maxContextTokens === 'number'
          ? requireFiniteNumber(context.maxContextTokens, '/settings/context/maxContextTokens', 1)
          : undefined,
      sources: Array.isArray(context.sources)
        ? context.sources.map((source, index) => {
            if (!isPlainObject(source)) {
              throw new AgentDefinitionError('INVALID_BUNDLE', 'Invalid context source.', {
                pointer: `/settings/context/sources/${index}`
              })
            }
            return {
              kind: optionalEnum(
                source.kind,
                ['thread', 'selected_files', 'project_instructions', 'attachment'] as const,
                `/settings/context/sources/${index}/kind`,
                'thread'
              ),
              required: typeof source.required === 'boolean' ? source.required : false,
              path: typeof source.path === 'string' ? assertSafeBundlePath(source.path, `/settings/context/sources/${index}/path`) : undefined
            }
          })
        : defaults.context.sources
    },
    memory: {
      scope: optionalEnum(memory.scope, ['off', 'thread', 'profile_agent'] as const, '/settings/memory/scope', 'thread'),
      retentionDays:
        typeof memory.retentionDays === 'number'
          ? requireFiniteNumber(memory.retentionDays, '/settings/memory/retentionDays', 1)
          : undefined
    },
    skills: {
      mode: optionalEnum(skills.mode, AGENT_GRANT_MODES, '/settings/skills/mode', 'inherit'),
      selections: Array.isArray(skills.selections)
        ? skills.selections.map((selection, index) => {
            if (!isPlainObject(selection)) {
              throw new AgentDefinitionError('INVALID_BUNDLE', 'Invalid skill selection.', {
                pointer: `/settings/skills/selections/${index}`
              })
            }
            return {
              skillId: requireString(selection.skillId, `/settings/skills/selections/${index}/skillId`).trim(),
              enabled: requireBoolean(selection.enabled, `/settings/skills/selections/${index}/enabled`),
              pinRevision: typeof selection.pinRevision === 'string' ? selection.pinRevision : undefined
            }
          })
        : []
    },
    mcp: {
      mode: optionalEnum(mcp.mode, AGENT_GRANT_MODES, '/settings/mcp/mode', 'inherit'),
      servers: Array.isArray(mcp.servers)
        ? mcp.servers.map((server, index) => {
            if (!isPlainObject(server)) {
              throw new AgentDefinitionError('INVALID_BUNDLE', 'Invalid MCP server selection.', {
                pointer: `/settings/mcp/servers/${index}`
              })
            }
            return {
              serverId: requireString(server.serverId, `/settings/mcp/servers/${index}/serverId`).trim(),
              enabled: requireBoolean(server.enabled, `/settings/mcp/servers/${index}/enabled`),
              tools: Array.isArray(server.tools)
                ? server.tools.map((tool, toolIndex) => {
                    if (!isPlainObject(tool)) {
                      throw new AgentDefinitionError('INVALID_BUNDLE', 'Invalid MCP tool selection.', {
                        pointer: `/settings/mcp/servers/${index}/tools/${toolIndex}`
                      })
                    }
                    return {
                      toolName: requireString(tool.toolName, `/settings/mcp/servers/${index}/tools/${toolIndex}/toolName`).trim(),
                      enabled: requireBoolean(tool.enabled, `/settings/mcp/servers/${index}/tools/${toolIndex}/enabled`)
                    }
                  })
                : []
            }
          })
        : []
    },
    tools: {
      mode: optionalEnum(tools.mode, AGENT_GRANT_MODES, '/settings/tools/mode', 'inherit'),
      allowlist: Array.isArray(tools.allowlist) ? requireStringArray(tools.allowlist, '/settings/tools/allowlist') : defaults.tools.allowlist
    },
    browser: {
      mode: optionalEnum(
        browser.mode,
        ['disabled', 'structured', 'hybrid', 'native'] as const,
        '/settings/browser/mode',
        'disabled'
      ),
      workspaceId: typeof browser.workspaceId === 'string' ? browser.workspaceId : undefined,
      allowedDomains: Array.isArray(browser.allowedDomains)
        ? requireStringArray(browser.allowedDomains, '/settings/browser/allowedDomains')
        : [],
      traceRetention: optionalEnum(
        browser.traceRetention,
        ['none', 'run', 'profile'] as const,
        '/settings/browser/traceRetention',
        'none'
      )
    },
    delegation: {
      allowedChildDefinitionIds: Array.isArray(delegation.allowedChildDefinitionIds)
        ? delegation.allowedChildDefinitionIds.filter((id): id is string => isAgentDefinitionId(id))
        : [],
      maxConcurrentChildren:
        typeof delegation.maxConcurrentChildren === 'number'
          ? requireFiniteNumber(delegation.maxConcurrentChildren, '/settings/delegation/maxConcurrentChildren')
          : 0,
      maxDepth:
        typeof delegation.maxDepth === 'number'
          ? requireFiniteNumber(delegation.maxDepth, '/settings/delegation/maxDepth')
          : 0
    },
    workspace: {
      mode: optionalEnum(
        workspace.mode,
        ['read_only', 'thread_worktree', 'dedicated_child_worktree'] as const,
        '/settings/workspace/mode',
        'thread_worktree'
      ),
      permittedRoots: Array.isArray(workspace.permittedRoots)
        ? requireStringArray(workspace.permittedRoots, '/settings/workspace/permittedRoots')
        : []
    },
    script: {
      enabled: typeof script.enabled === 'boolean' ? script.enabled : false,
      interpreters: Array.isArray(script.interpreters)
        ? requireStringArray(script.interpreters, '/settings/script/interpreters')
        : [],
      executionMode: optionalEnum(
        script.executionMode,
        ['sandboxed', 'workspace'] as const,
        '/settings/script/executionMode',
        'sandboxed'
      ),
      allowNetwork: typeof script.allowNetwork === 'boolean' ? script.allowNetwork : false,
      allowFilesystem: typeof script.allowFilesystem === 'boolean' ? script.allowFilesystem : false
    },
    approval: {
      askUser: typeof approval.askUser === 'boolean' ? approval.askUser : true,
      policy: optionalEnum(
        approval.policy,
        ['inherit', 'always', 'unattended_deny', 'unattended_allow_readonly'] as const,
        '/settings/approval/policy',
        'inherit'
      ),
      unattendedBehavior: optionalEnum(
        approval.unattendedBehavior,
        ['pause', 'skip', 'fail'] as const,
        '/settings/approval/unattendedBehavior',
        'pause'
      )
    },
    limits: {
      maxTurns:
        typeof limits.maxTurns === 'number'
          ? requireFiniteNumber(limits.maxTurns, '/settings/limits/maxTurns', 1)
          : defaults.limits.maxTurns,
      maxToolCalls:
        typeof limits.maxToolCalls === 'number'
          ? requireFiniteNumber(limits.maxToolCalls, '/settings/limits/maxToolCalls', 1)
          : defaults.limits.maxToolCalls,
      maxElapsedMs:
        typeof limits.maxElapsedMs === 'number'
          ? requireFiniteNumber(limits.maxElapsedMs, '/settings/limits/maxElapsedMs', 1)
          : defaults.limits.maxElapsedMs,
      maxInputTokens:
        typeof limits.maxInputTokens === 'number'
          ? requireFiniteNumber(limits.maxInputTokens, '/settings/limits/maxInputTokens', 1)
          : undefined,
      maxOutputTokens:
        typeof limits.maxOutputTokens === 'number'
          ? requireFiniteNumber(limits.maxOutputTokens, '/settings/limits/maxOutputTokens', 1)
          : undefined,
      maxCostUsd:
        typeof limits.maxCostUsd === 'number'
          ? requireFiniteNumber(limits.maxCostUsd, '/settings/limits/maxCostUsd', 0)
          : undefined,
      maxArtifactBytes:
        typeof limits.maxArtifactBytes === 'number'
          ? requireFiniteNumber(limits.maxArtifactBytes, '/settings/limits/maxArtifactBytes', 1)
          : defaults.limits.maxArtifactBytes
    },
    recovery: {
      retryCount:
        typeof recovery.retryCount === 'number'
          ? requireFiniteNumber(recovery.retryCount, '/settings/recovery/retryCount')
          : defaults.recovery.retryCount,
      backoffMs:
        typeof recovery.backoffMs === 'number'
          ? requireFiniteNumber(recovery.backoffMs, '/settings/recovery/backoffMs')
          : defaults.recovery.backoffMs,
      transientCategories: Array.isArray(recovery.transientCategories)
        ? recovery.transientCategories.filter(
            (item): item is AgentDefinitionSettings['recovery']['transientCategories'][number] =>
              item === 'rate_limit' || item === 'timeout' || item === 'unavailable' || item === 'content_filter'
          )
        : defaults.recovery.transientCategories,
      stopCondition: typeof recovery.stopCondition === 'string' ? recovery.stopCondition : undefined,
      finalReportTemplate: typeof recovery.finalReportTemplate === 'string' ? recovery.finalReportTemplate : undefined
    },
    examples: parseExamples(settings.examples, '/settings/examples')
  }
}

export function parseVisualMetadata(value: unknown): AgentVisualMetadata {
  if (value === undefined) return {}
  if (!isPlainObject(value)) {
    throw new AgentDefinitionError('INVALID_BUNDLE', 'Visual metadata must be an object.', { pointer: '/visual' })
  }
  return { ...value }
}

export function parseManifest(value: unknown): AgentDefinitionManifest {
  if (!isPlainObject(value)) {
    throw new AgentDefinitionError('INVALID_BUNDLE', 'agent.json must be an object.', { pointer: '/' })
  }
  if (value.schemaVersion !== AGENT_DEFINITION_SCHEMA_VERSION) {
    throw new AgentDefinitionError(
      'INVALID_BUNDLE',
      `Unsupported agent schema version ${String(value.schemaVersion)}.`,
      { pointer: '/schemaVersion', details: { schemaVersion: value.schemaVersion } }
    )
  }
  if (!isAgentDefinitionId(value.id)) {
    throw new AgentDefinitionError('INVALID_BUNDLE', 'Agent definition id must be a UUID.', { pointer: '/id' })
  }
  if (!isAgentRuntimeKind(value.runtimeKind)) {
    throw new AgentDefinitionError(
      'INVALID_BUNDLE',
      `Unknown runtime kind ${String(value.runtimeKind)}. Supported: ${AGENT_RUNTIME_KINDS.join(', ')}.`,
      { pointer: '/runtimeKind', details: { runtimeKind: value.runtimeKind } }
    )
  }
  return {
    schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
    id: value.id,
    runtimeKind: value.runtimeKind,
    settings: parseAgentSettings(value.settings)
  }
}

export function mergeSettings(
  base: AgentDefinitionSettings,
  patch: Partial<AgentDefinitionSettings> | undefined
): AgentDefinitionSettings {
  if (!patch) return parseAgentSettings(base)
  return parseAgentSettings({
    ...base,
    ...patch,
    identity: { ...base.identity, ...patch.identity },
    instructions: { ...base.instructions, ...patch.instructions },
    primaryModel: {
      ...base.primaryModel,
      ...patch.primaryModel,
      ref: patch.primaryModel?.ref ?? base.primaryModel.ref,
      capabilityOverrides: patch.primaryModel?.capabilityOverrides ?? base.primaryModel.capabilityOverrides
    },
    fallbacks: { ...base.fallbacks, ...patch.fallbacks },
    output: { ...base.output, ...patch.output },
    context: { ...base.context, ...patch.context },
    memory: { ...base.memory, ...patch.memory },
    skills: { ...base.skills, ...patch.skills },
    mcp: { ...base.mcp, ...patch.mcp },
    tools: { ...base.tools, ...patch.tools },
    browser: { ...base.browser, ...patch.browser },
    delegation: { ...base.delegation, ...patch.delegation },
    workspace: { ...base.workspace, ...patch.workspace },
    script: { ...base.script, ...patch.script },
    approval: { ...base.approval, ...patch.approval },
    limits: { ...base.limits, ...patch.limits },
    recovery: { ...base.recovery, ...patch.recovery },
    examples: patch.examples ?? base.examples
  })
}

export function toManifest(record: {
  id: string
  runtimeKind: AgentRuntimeKind
  settings: AgentDefinitionSettings
}): AgentDefinitionManifest {
  return {
    schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
    id: record.id,
    runtimeKind: record.runtimeKind,
    settings: record.settings
  }
}

export function assertSystemPrompt(prompt: string): string {
  assertPromptSize(prompt)
  return prompt
}

export { AGENT_BUNDLE_FILES }
