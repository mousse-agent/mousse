import { WORKFLOW_MAX_BUNDLE_BYTES, isPlainObject, type WorkflowBundle } from '../../../shared/workflows'
import { WorkflowUiClientError } from './client'
import { parseManifestSource } from './sourceParse'

export interface ImportFileCandidate {
  name: string
  size: number
  text: string
}

/** Renderer-side size/shape gate. The daemon remains authoritative. */
export function parseWorkflowImportFile(file: ImportFileCandidate): WorkflowBundle {
  if (file.size > WORKFLOW_MAX_BUNDLE_BYTES || file.text.length > WORKFLOW_MAX_BUNDLE_BYTES) {
    throw new WorkflowUiClientError(
      'IMPORT_LIMIT',
      `Import is larger than ${WORKFLOW_MAX_BUNDLE_BYTES} bytes.`,
      { details: { size: file.size, maxBytes: WORKFLOW_MAX_BUNDLE_BYTES } }
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(file.text) as unknown
  } catch {
    throw new WorkflowUiClientError('INVALID_BUNDLE', 'Import is not valid JSON.')
  }
  if (!isPlainObject(parsed)) {
    throw new WorkflowUiClientError('INVALID_BUNDLE', 'Import must be a JSON object.')
  }
  const manifestSource = parsed.manifest ?? parsed.workflow ?? (parsed.schemaVersion === 1 ? parsed : null)
  if (!isPlainObject(manifestSource)) {
    throw new WorkflowUiClientError('INVALID_BUNDLE', 'Import must include a v1 workflow manifest.')
  }
  const parsedManifest = parseManifestSource(JSON.stringify(manifestSource))
  if (!parsedManifest.ok) {
    throw new WorkflowUiClientError('INVALID_BUNDLE', parsedManifest.error)
  }
  const assets: WorkflowBundle['assets'] = []
  const files = isPlainObject(parsed.files)
    ? parsed.files
    : isPlainObject(parsed.assets)
      ? parsed.assets
      : {}
  for (const [relativePath, content] of Object.entries(files)) {
    if (typeof content === 'string') {
      assets.push({ relativePath, bytes: content })
    } else if (isPlainObject(content) && typeof content.bytes === 'string') {
      assets.push({ relativePath, bytes: content.bytes, sha256: typeof content.sha256 === 'string' ? content.sha256 : undefined })
    } else {
      throw new WorkflowUiClientError('INVALID_BUNDLE', `Bundle file "${relativePath}" must be text.`)
    }
  }
  const editor = isPlainObject(parsed.editor) ? (parsed.editor as unknown as WorkflowBundle['editor']) : undefined
  const lock = isPlainObject(parsed.lock) ? (parsed.lock as unknown as WorkflowBundle['lock']) : undefined
  return {
    manifest: parsedManifest.manifest,
    editor,
    lock,
    assets
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

export function bundleToExportJson(bundle: WorkflowBundle): Record<string, unknown> {
  const files: Record<string, string> = {}
  for (const asset of bundle.assets) {
    files[asset.relativePath] = typeof asset.bytes === 'string' ? asset.bytes : new TextDecoder().decode(asset.bytes)
  }
  return {
    format: 'mousse-workflow',
    formatVersion: 1,
    manifest: bundle.manifest,
    editor: bundle.editor,
    lock: bundle.lock,
    files
  }
}
