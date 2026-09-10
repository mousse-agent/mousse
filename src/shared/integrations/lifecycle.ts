import type {
  IntegrationDiagnostic,
  IntegrationScope,
  McpAuthMode,
  McpServerConfig,
  McpTransport,
  SkillDescriptor,
  SkillPackageFile,
  SkillReadResult
} from '../integrations'

export interface SkillCreateInput {
  name: string
  description: string
  scope: IntegrationScope
  projectPath?: string
  instructions?: string
  license?: string
  compatibility?: string
  enable?: boolean
}

export interface SkillUpdateInput {
  installationId: string
  content?: string
  description?: string
  enable?: boolean
  projectPath?: string
  expectedRevision?: string
}

export interface SkillImportInput {
  scope: IntegrationScope
  projectPath?: string
  /** Directory containing SKILL.md or a single SKILL.md file. */
  sourcePath?: string
  zipBytes?: Uint8Array
  zipName?: string
  replaceInstallationId?: string
  enable?: boolean
}

export interface SkillExportResult {
  fileName: string
  bytes: Uint8Array
  contentType: 'application/zip' | 'text/markdown'
}

export interface ManagedSkillRecord {
  installationId: string
  skill: SkillDescriptor
  enabled: boolean
  archived: boolean
  revision: string
  diagnostics: IntegrationDiagnostic[]
}

export interface SkillEditorDto extends SkillReadResult {
  packageTree: SkillPackageFile[]
  source: string
  previewMarkdown: string
}

export interface McpCreateInput {
  name: string
  scope: IntegrationScope
  projectPath?: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  authMode?: McpAuthMode
  auth?: McpServerConfig['auth']
  enabledTools?: string[]
  deniedTools?: string[]
  enable?: boolean
}

export interface McpUpdateInput extends Partial<Omit<McpCreateInput, 'scope' | 'projectPath'>> {
  installationId: string
  expectedRevision?: string
  projectPath?: string
}

export interface ManagedMcpRecord {
  installationId: string
  server: McpServerConfig
  enabled: boolean
  archived: boolean
  revision: string
  diagnostics: IntegrationDiagnostic[]
}
