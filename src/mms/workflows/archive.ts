import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'
import {
  WORKFLOW_MAX_ASSET_BYTES,
  WORKFLOW_MAX_BUNDLE_BYTES,
  WORKFLOW_MAX_COMPRESSION_RATIO,
  WORKFLOW_MAX_IMPORT_ENTRIES,
  WorkflowArchiveUnsupportedError,
  type WorkflowBundle
} from '../../shared/workflows'
import { writeWorkflowDirectory } from './bundleIo'
import { checkBundleRelativePath, posixJoin } from './pathSafety'

export interface WorkflowArchiveExtractResult {
  /** Directory that contains workflow.json after extraction. */
  rootDir: string
  entryCount: number
  decompressedBytes: number
  compressedBytes: number
  compressionRatio: number
}

/**
 * Archive import is an explicit adapter. Directory packages remain a supported v1 path.
 * ZIP import uses fflate with bounded expansion; it never executes assets.
 */
export interface WorkflowArchiveImporter {
  readonly format: string
  extractToStaging(archivePath: string, stagingDir: string): Promise<WorkflowArchiveExtractResult>
}

/** Explicit "not configured" adapter for tests; production registry uses fflate. */
export class ZipArchiveImportNotConfigured implements WorkflowArchiveImporter {
  readonly format = 'application/zip'

  async extractToStaging(_archivePath: string, _stagingDir: string): Promise<WorkflowArchiveExtractResult> {
    throw new WorkflowArchiveUnsupportedError(
      'ZIP import adapter is not configured on this registry instance. Use FflateZipArchiveImporter or directory import.'
    )
  }
}

const MAX_ZIP_COMPRESSED = WORKFLOW_MAX_BUNDLE_BYTES
const MAX_EXPANDED_TOTAL = WORKFLOW_MAX_BUNDLE_BYTES
const MAX_ENTRY_EXPANDED = WORKFLOW_MAX_ASSET_BYTES

export class FflateZipArchiveImporter implements WorkflowArchiveImporter {
  readonly format = 'application/zip'

  async extractToStaging(archivePath: string, stagingDir: string): Promise<WorkflowArchiveExtractResult> {
    let compressed: Uint8Array
    try {
      compressed = new Uint8Array(readFileSync(archivePath))
    } catch {
      throw new Error(`ZIP archive cannot be read: ${archivePath}`)
    }
    if (compressed.byteLength > MAX_ZIP_COMPRESSED) {
      throw new Error(`ZIP compressed size ${compressed.byteLength} exceeds ${MAX_ZIP_COMPRESSED}`)
    }
    if (compressed.byteLength < 22) throw new Error('ZIP archive is too small')

    const seen = new Map<string, string>()
    let plannedExpanded = 0
    let entryCount = 0
    let unzipped: Record<string, Uint8Array>
    try {
      unzipped = unzipSync(compressed, {
        filter(file) {
          entryCount += 1
          if (entryCount > WORKFLOW_MAX_IMPORT_ENTRIES) {
            throw new Error(`ZIP has more than ${WORKFLOW_MAX_IMPORT_ENTRIES} entries`)
          }
          if (file.name.endsWith('/')) return false
          const normalized = normalizeZipName(file.name)
          const key = normalized.toLowerCase()
          const existing = seen.get(key)
          if (existing && existing !== normalized) {
            throw new Error(`ZIP case-colliding paths ${existing} and ${normalized}`)
          }
          if (existing) throw new Error(`ZIP duplicate path ${normalized}`)
          seen.set(key, normalized)
          const expanded = file.originalSize ?? file.size
          if (expanded > MAX_ENTRY_EXPANDED) {
            throw new Error(`ZIP entry ${normalized} expands to ${expanded} bytes`)
          }
          plannedExpanded += expanded
          if (plannedExpanded > MAX_EXPANDED_TOTAL) {
            throw new Error('ZIP expanded total exceeds the bundle byte limit')
          }
          const ratio = compressed.byteLength === 0 ? 0 : plannedExpanded / compressed.byteLength
          if (ratio > WORKFLOW_MAX_COMPRESSION_RATIO) {
            throw new Error(`ZIP compression ratio ${ratio.toFixed(1)} exceeds ${WORKFLOW_MAX_COMPRESSION_RATIO}`)
          }
          return true
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`ZIP expansion rejected: ${message}`)
    }

    let decompressedBytes = 0
    const files: Array<{ relativePath: string; bytes: Uint8Array }> = []
    for (const [name, bytes] of Object.entries(unzipped)) {
      if (name.endsWith('/')) continue
      const relativePath = normalizeZipName(name)
      decompressedBytes += bytes.byteLength
      if (bytes.byteLength > MAX_ENTRY_EXPANDED) {
        throw new Error(`ZIP entry ${relativePath} exceeds per-entry expanded limit`)
      }
      files.push({ relativePath, bytes })
    }
    if (decompressedBytes > MAX_EXPANDED_TOTAL) {
      throw new Error('ZIP expanded total exceeds the bundle byte limit')
    }
    const ratio = compressed.byteLength === 0 ? 0 : decompressedBytes / compressed.byteLength
    if (ratio > WORKFLOW_MAX_COMPRESSION_RATIO) {
      throw new Error(`ZIP compression ratio ${ratio.toFixed(1)} exceeds ${WORKFLOW_MAX_COMPRESSION_RATIO}`)
    }

    mkdirSync(stagingDir, { recursive: true })
    for (const file of files) {
      const abs = posixJoin(stagingDir, file.relativePath)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, file.bytes)
    }
    const rootDir = locateWorkflowRoot(stagingDir, files.map((file) => file.relativePath))
    return {
      rootDir,
      entryCount: files.length,
      decompressedBytes,
      compressedBytes: compressed.byteLength,
      compressionRatio: ratio
    }
  }
}

export function exportWorkflowZip(bundle: WorkflowBundle): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'workflow.json': strToU8(`${JSON.stringify(bundle.manifest, null, 2)}\n`)
  }
  if (bundle.editor) files['editor.json'] = strToU8(`${JSON.stringify(bundle.editor, null, 2)}\n`)
  if (bundle.lock) files['workflow.lock.json'] = strToU8(`${JSON.stringify(bundle.lock, null, 2)}\n`)
  for (const asset of bundle.assets) {
    const checked = checkBundleRelativePath(asset.relativePath)
    if (!checked.ok) throw new Error(`Unsafe asset path ${asset.relativePath}: ${checked.reason}`)
    files[checked.relativePath] =
      typeof asset.bytes === 'string' ? strToU8(asset.bytes) : new Uint8Array(asset.bytes)
  }
  return zipSync(files, { level: 6 })
}

export function writeWorkflowZipFile(destination: string, bundle: WorkflowBundle): void {
  writeFileSync(destination, exportWorkflowZip(bundle))
}

function normalizeZipName(name: string): string {
  const unified = name.replace(/\\/g, '/')
  if (unified.includes('\0')) throw new Error('ZIP path contains a NUL byte')
  const checked = checkBundleRelativePath(unified)
  if (!checked.ok) throw new Error(`ZIP path rejected (${unified}): ${checked.reason}`)
  return checked.relativePath
}

function locateWorkflowRoot(stagingDir: string, names: string[]): string {
  if (names.includes('workflow.json')) return stagingDir
  const prefixes = new Set(
    names.filter((name) => name.endsWith('/workflow.json') || /\/workflow\.json$/.test(name)).map((name) => {
      const idx = name.lastIndexOf('/')
      return name.slice(0, idx)
    })
  )
  if (prefixes.size === 1) return join(stagingDir, [...prefixes][0]!)
  throw new Error('ZIP package is missing workflow.json')
}

void writeWorkflowDirectory
void strFromU8
