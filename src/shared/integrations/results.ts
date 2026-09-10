import type { McpErrorCategory } from '../integrations'

export type McpToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data?: string; artifactId?: string; bytes?: number }
  | {
      type: 'resource_link'
      uri: string
      name?: string
      mimeType?: string
      description?: string
    }
  | { type: 'resource'; uri?: string; text?: string; mimeType?: string; blob?: string }
  | { type: 'unknown'; rawType: string; summary: string }

export interface McpToolArtifact {
  artifactId: string
  uri: string
  mimeType: string
  bytes: number
  name?: string
}

export interface McpToolCallProvenance {
  profileId: string
  projectScope?: string
  serverId: string
  installationId: string
  configRevision: string
  toolName: string
  providerName: string
}

export interface McpToolCallResult {
  text: string
  isError: boolean
  content: McpToolContentBlock[]
  structuredContent?: unknown
  artifacts?: McpToolArtifact[]
  provenance: McpToolCallProvenance
  errorCategory?: McpErrorCategory
}

export interface McpServerTestResult {
  success: boolean
  error?: string
  errorCategory?: McpErrorCategory
  toolCount?: number
  connected?: boolean
  status?: string
  diagnostics?: string[]
}
