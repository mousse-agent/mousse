import { MOUSSE_BUILTIN_TOOL_IDS } from '../integrations'
import { AGENT_SYSTEM_PROMPT_FILE, type AgentDefinitionSettings, type AgentRuntimeKind } from './types'

export const AGENT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/
export const AGENT_SLUG_MAX_LENGTH = 64
export const AGENT_PROMPT_MAX_BYTES = 512 * 1024
export const AGENT_BUNDLE_MAX_BYTES = 2 * 1024 * 1024
export const AGENT_EXAMPLE_PROMPT_MAX_BYTES = 64 * 1024

export const DEFAULT_AGENT_LIMITS = {
  maxTurns: 32,
  maxToolCalls: 64,
  maxElapsedMs: 10 * 60 * 1000,
  maxArtifactBytes: 10 * 1024 * 1024
} as const

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
