import { MOUSSE_BUILTIN_TOOL_IDS } from '../integrations'
import { AGENT_SYSTEM_PROMPT_FILE, type AgentDefinitionSettings, type AgentLimitsSettings, type AgentRuntimeKind } from './types'

export const AGENT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/
export const AGENT_SLUG_MAX_LENGTH = 64
export const AGENT_PROMPT_MAX_BYTES = 512 * 1024
export const AGENT_BUNDLE_MAX_BYTES = 2 * 1024 * 1024
export const AGENT_EXAMPLE_PROMPT_MAX_BYTES = 64 * 1024

/**
 * A turn or tool-call limit that is none. Kept as a number, so every runtime's arithmetic stays as it was (a budget of
 * 0 turns still means none may run); only the run's policy leaves it out (`countLimited`).
 */
export const NO_COUNT_LIMIT = Number.MAX_SAFE_INTEGER

/**
 * A definition's run limits when its owner sets none. Turns, tool calls and time have no limit, as a coding agent
 * session has none (`NO_COUNT_LIMIT`, and a time of 0, which already meant no deadline); an owner who wants a budget
 * sets one on the definition. Artifact size keeps a ceiling no real run reaches: it bounds one file written into
 * Mousse's own store, which a runaway could fill.
 */
export const DEFAULT_AGENT_LIMITS = {
  maxTurns: NO_COUNT_LIMIT,
  maxToolCalls: NO_COUNT_LIMIT,
  maxElapsedMs: 0,
  maxArtifactBytes: 1024 * 1024 * 1024
} as const

/** Whether a turn or tool-call limit is one (below `NO_COUNT_LIMIT`). */
export function countLimited(value: number): boolean {
  return value < NO_COUNT_LIMIT
}

/** The defaults definitions were saved with before the ones above. */
const LEGACY_DEFAULT_AGENT_LIMITS = {
  maxTurns: 32,
  maxToolCalls: 64,
  maxElapsedMs: 10 * 60 * 1000,
  maxArtifactBytes: 10 * 1024 * 1024
} as const

/**
 * The limits a definition runs under: its own, except that a definition still holding all four old defaults was never
 * given limits by its owner, so it runs under today's defaults. Read at run time and in the editor, never written back:
 * a published revision's bytes, and so its hash, stay as they were.
 */
export function effectiveAgentLimits(limits: AgentLimitsSettings): AgentLimitsSettings {
  const legacy = (Object.keys(LEGACY_DEFAULT_AGENT_LIMITS) as Array<keyof typeof LEGACY_DEFAULT_AGENT_LIMITS>)
    .every((key) => limits[key] === LEGACY_DEFAULT_AGENT_LIMITS[key])
  return legacy ? { ...limits, ...DEFAULT_AGENT_LIMITS } : limits
}

export function defaultAgentSettings(identity: {
  name: string
  slug: string
  purpose?: string
  tags?: string[]
}): AgentDefinitionSettings {
  return {
    identity: {
      name: identity.name,
      slug: identity.slug,
      purpose: identity.purpose ?? '',
      tags: identity.tags ?? []
    },
    instructions: { systemPromptFile: AGENT_SYSTEM_PROMPT_FILE },
    primaryModel: {
      ref: { providerId: '', modelId: '' },
      capabilityOverrides: {}
    },
    fallbacks: {
      enabled: false,
      models: [],
      retryOn: [],
      allowHigherCost: false
    },
    output: {
      verbosity: 'normal',
      citationPreference: 'none',
      format: 'markdown'
    },
    context: {
      includeCurrentThread: true,
      selectedFiles: [],
      includeProjectInstructions: true,
      attachmentPolicy: 'thread',
      sources: [{ kind: 'thread', required: false }]
    },
    memory: { scope: 'thread' },
    skills: { mode: 'inherit', selections: [] },
    mcp: { mode: 'inherit', servers: [] },
    tools: { mode: 'inherit', allowlist: [...MOUSSE_BUILTIN_TOOL_IDS] },
    browser: {
      mode: 'disabled',
      allowedDomains: [],
      traceRetention: 'none'
    },
    delegation: {
      allowedChildDefinitionIds: [],
      maxConcurrentChildren: 0,
      maxDepth: 0
    },
    workspace: {
      mode: 'thread_worktree',
      permittedRoots: []
    },
    script: {
      enabled: false,
      interpreters: [],
      executionMode: 'workspace',
      allowNetwork: false,
      allowFilesystem: false
    },
    approval: {
      askUser: true,
      policy: 'inherit',
      unattendedBehavior: 'pause'
    },
    limits: { ...DEFAULT_AGENT_LIMITS },
    recovery: {
      retryCount: 1,
      backoffMs: 1000,
      transientCategories: ['rate_limit', 'timeout', 'unavailable']
    },
    examples: []
  }
}

export function defaultRuntimeKind(): AgentRuntimeKind {
  return 'mousse'
}
