import { WorkflowArchiveUnsupportedError } from '../../shared/workflows'

export interface WorkflowArchiveExtractResult {
  /** Directory that contains workflow.json after extraction. */
  rootDir: string
  entryCount: number
  decompressedBytes: number
  compressionRatio?: number
}

/**
 * Archive import is an explicit adapter. Directory packages are the v1 production path.
 * Do not silently treat zip as a directory, and do not fake a successful extract.
 */
export interface WorkflowArchiveImporter {
  readonly format: string
  extractToStaging(archivePath: string, stagingDir: string): Promise<WorkflowArchiveExtractResult>
}

/**
 * Production-safe stand-in until WG0 pins a zip library (e.g. yauzl) in package.json.
 * Calling extract always fails with a clear dependency requirement.
 */
export class ZipArchiveImportNotConfigured implements WorkflowArchiveImporter {
  readonly format = 'application/zip'

  async extractToStaging(_archivePath: string, _stagingDir: string): Promise<WorkflowArchiveExtractResult> {
    throw new WorkflowArchiveUnsupportedError(
      'ZIP .mousse-workflow.zip import is not configured. Pin a zip library (recommended: yauzl) as a direct dependency via the foundation package.json; directory packages are the supported v1 import path. This adapter does not unpack archives and does not pretend zip import succeeded.'
    )
  }
}
