import {
  diagnostic,
  isPlainObject,
  WORKFLOW_FORMAT_SCHEMA_VERSION,
  WORKFLOW_MAX_MANIFEST_BYTES,
  jsonByteLength,
  type WorkflowDiagnostic,
  type WorkflowManifest
} from '../../../shared/workflows'

export type SourceParseResult =
  | { ok: true; manifest: WorkflowManifest; extrasPreserved: boolean }
  | { ok: false; error: string; diagnostics: WorkflowDiagnostic[]; rawText: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null
}

/**
 * Parse workflow.json. Invalid JSON is retained by the caller.
 * Unknown top-level fields stay on the object so round-trips do not drop them.
 */
export function parseManifestSource(text: string): SourceParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid JSON',
      diagnostics: [diagnostic('MALFORMED_SOURCE', 'workflow.json is not valid JSON')],
      rawText: text
    }
  }
  const record = asRecord(parsed)
  if (!record) {
    return {
      ok: false,
      error: 'workflow.json must be a JSON object',
      diagnostics: [diagnostic('MALFORMED_SOURCE', 'workflow.json must be a JSON object')],
      rawText: text
    }
  }
  if (jsonByteLength(record) > WORKFLOW_MAX_MANIFEST_BYTES) {
    return {
      ok: false,
      error: 'Manifest exceeds maximum byte size',
      diagnostics: [diagnostic('GRAPH_TOO_LARGE', 'Manifest exceeds maximum byte size')],
      rawText: text
    }
  }
  if (record.schemaVersion !== WORKFLOW_FORMAT_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `Unsupported schemaVersion ${String(record.schemaVersion)}; v1 is required.`,
      diagnostics: [
        diagnostic(
          'UNSUPPORTED_SCHEMA_VERSION',
          `Unsupported schemaVersion ${String(record.schemaVersion)}; v1 is required. Unknown majors stay read-only.`
        )
      ],
      rawText: text
    }
  }
  if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) {
    return {
      ok: false,
      error: 'nodes and edges arrays are required',
      diagnostics: [diagnostic('INVALID_MANIFEST', 'nodes and edges arrays are required')],
      rawText: text
    }
  }
  const known = new Set([
    'schemaVersion',
    'id',
    'name',
    'slug',
    'description',
    'instructionsFile',
    'inputSchema',
    'outputSchema',
    'entryNodeId',
    'nodes',
    'edges',
    'limits',
    'permissions',
    'dependencyPolicy',
    'extensions'
  ])
  const extrasPreserved = Object.keys(record).some((key) => !known.has(key))
  return { ok: true, manifest: record as unknown as WorkflowManifest, extrasPreserved }
}

export function stringifyManifest(manifest: WorkflowManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}
