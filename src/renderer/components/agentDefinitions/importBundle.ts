import { AGENT_BUNDLE_MAX_BYTES } from '../../../shared/agents/defaults'
import { AgentDefinitionError } from '../../../shared/agents/errors'
import type { AgentExportBundle } from '../../../shared/agents/types'

export interface ImportFileCandidate {
  name: string
  size: number
  text: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Renderer-side size/shape gate. The daemon remains authoritative. */
export function parseAgentImportFile(file: ImportFileCandidate): AgentExportBundle {
  if (file.size > AGENT_BUNDLE_MAX_BYTES || file.text.length > AGENT_BUNDLE_MAX_BYTES) {
    throw new AgentDefinitionError(
      'IMPORT_LIMIT',
      `Import is larger than ${AGENT_BUNDLE_MAX_BYTES} bytes.`,
      { details: { size: file.size, maxBytes: AGENT_BUNDLE_MAX_BYTES } }
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(file.text) as unknown
  } catch {
    throw new AgentDefinitionError('INVALID_BUNDLE', 'Import is not valid JSON.')
  }
  if (!isPlainObject(parsed) || parsed.format !== 'mousse-agent' || parsed.formatVersion !== 1) {
    throw new AgentDefinitionError('INVALID_BUNDLE', 'Import must be a mousse-agent v1 bundle.')
  }
  if (!isPlainObject(parsed.manifest) || !isPlainObject(parsed.files)) {
    throw new AgentDefinitionError('INVALID_BUNDLE', 'Import is missing manifest or files.')
  }
  const files: Record<string, string> = {}
  for (const [path, content] of Object.entries(parsed.files)) {
    if (typeof content !== 'string') {
      throw new AgentDefinitionError('INVALID_BUNDLE', `Bundle file "${path}" must be text.`)
    }
    files[path] = content
  }
  return {
    format: 'mousse-agent',
    formatVersion: 1,
    manifest: parsed.manifest as unknown as AgentExportBundle['manifest'],
    files,
    visual: isPlainObject(parsed.visual) ? parsed.visual : {},
    publishedRevision: parsed.publishedRevision as AgentExportBundle['publishedRevision'] | undefined
  }
}

export function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
