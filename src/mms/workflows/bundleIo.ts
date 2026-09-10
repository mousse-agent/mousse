import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  isPlainObject,
  WORKFLOW_MAX_ASSET_BYTES,
  WORKFLOW_MAX_ASSET_COUNT,
  WORKFLOW_MAX_BUNDLE_BYTES,
  WORKFLOW_MAX_IMPORT_ENTRIES,
  WORKFLOW_MAX_MANIFEST_BYTES,
  type WorkflowBundle,
  type WorkflowBundleAsset,
  type WorkflowEditorDocument,
  type WorkflowLockDocument,
  type WorkflowManifest
} from '../../shared/workflows'
import { parseWorkflowManifest } from './compiler/parseManifest'
import { digestAsset, type AssetDigest } from './hash'
import { checkBundleRelativePath, posixJoin, resolveContainedPath } from './pathSafety'

const TEXT_EXTENSIONS = new Set([
  '.json',
  '.md',
  '.mjs',
  '.js',
  '.cjs',
  '.ts',
  '.txt',
  '.py',
  '.ps1',
  '.sh',
  '.css',
  '.html',
  '.yaml',
  '.yml'
])

export interface LoadedDirectoryBundle {
  bundle: WorkflowBundle
  diagnostics: string[]
  assets: AssetDigest[]
  totalBytes: number
  entryCount: number
}

export function loadWorkflowDirectory(directory: string): LoadedDirectoryBundle {
  const root = resolveContainedPath(directory, '.')
  if (!root.ok) {
    throw new Error(`Cannot read workflow directory: ${root.reason}`)
  }
  const diagnostics: string[] = []
  const entries = listFilesRecursive(root.resolved, root.real, '', diagnostics)
  if (entries.length > WORKFLOW_MAX_IMPORT_ENTRIES) {
    throw new Error(`Package has ${entries.length} entries; max is ${WORKFLOW_MAX_IMPORT_ENTRIES}`)
  }
  const manifestEntry = entries.find((entry) => entry.relativePath === 'workflow.json')
  if (!manifestEntry) throw new Error('Package is missing workflow.json')
  if (manifestEntry.bytes > WORKFLOW_MAX_MANIFEST_BYTES) {
    throw new Error(`workflow.json exceeds the maximum byte size`)
  }
  const packageBytes = entries.reduce((total, entry) => total + entry.bytes, 0)
  if (packageBytes > WORKFLOW_MAX_BUNDLE_BYTES) {
    throw new Error('Package exceeds the maximum bundle size')
  }

  const manifestJson = JSON.parse(readFileSync(manifestEntry.abs, 'utf8')) as unknown
  const parsed = parseWorkflowManifest(manifestJson)
  if (!isPlainObject(manifestJson)) throw new Error('workflow.json is not an object')

  let editor: WorkflowEditorDocument | undefined
  const editorEntry = entries.find((entry) => entry.relativePath === 'editor.json')
  if (editorEntry) {
    const raw = JSON.parse(readFileSync(editorEntry.abs, 'utf8')) as unknown
    if (isPlainObject(raw) && raw.schemaVersion === 1) {
      editor = raw as unknown as WorkflowEditorDocument
    } else {
      diagnostics.push('editor.json is not a v1 editor document and was ignored for semantics')
    }
  }

  let lock: WorkflowLockDocument | undefined
  const lockEntry = entries.find((entry) => entry.relativePath === 'workflow.lock.json')
  if (lockEntry) {
    const raw = JSON.parse(readFileSync(lockEntry.abs, 'utf8')) as unknown
    if (isPlainObject(raw) && raw.schemaVersion === 1) {
      lock = raw as unknown as WorkflowLockDocument
    }
  }

  const assets: WorkflowBundleAsset[] = []
  const digests: AssetDigest[] = []
  let totalBytes = manifestEntry.bytes + (editorEntry?.bytes ?? 0) + (lockEntry?.bytes ?? 0)
  for (const entry of entries) {
    if (entry.relativePath === 'workflow.json' || entry.relativePath === 'editor.json' || entry.relativePath === 'workflow.lock.json') {
      continue
    }
    if (entry.bytes > WORKFLOW_MAX_ASSET_BYTES) {
      throw new Error(`Asset ${entry.relativePath} exceeds the maximum byte size`)
    }
    const bytes = readFileSync(entry.abs)
    totalBytes += bytes.byteLength
    const digest = digestAsset(entry.relativePath, bytes)
    digests.push(digest)
    assets.push({
      relativePath: entry.relativePath,
      bytes: shouldKeepText(entry.relativePath) ? bytes.toString('utf8') : bytes,
      sha256: digest.sha256
    })
  }
  if (assets.length > WORKFLOW_MAX_ASSET_COUNT) {
    throw new Error(`Package has ${assets.length} assets; max is ${WORKFLOW_MAX_ASSET_COUNT}`)
  }
  if (totalBytes > WORKFLOW_MAX_BUNDLE_BYTES) {
    throw new Error(`Package exceeds the maximum bundle size`)
  }

  const bundle: WorkflowBundle = {
    manifest: parsed.manifest,
    editor,
    lock,
    assets
  }
  return { bundle, diagnostics: [...diagnostics, ...parsed.diagnostics.map((d) => d.message)], assets: digests, totalBytes, entryCount: entries.length }
}

export function writeWorkflowDirectory(directory: string, bundle: WorkflowBundle): void {
  mkdirSync(directory, { recursive: true })
  const seen = new Set<string>()
  for (const asset of bundle.assets) {
    const checked = checkBundleRelativePath(asset.relativePath)
    if (!checked.ok) throw new Error(`Unsafe asset path ${asset.relativePath}: ${checked.reason}`)
    if (seen.has(checked.relativePath)) throw new Error(`Duplicate asset path ${checked.relativePath}`)
    if (checked.relativePath === 'workflow.json' || checked.relativePath === 'editor.json' || checked.relativePath === 'workflow.lock.json') {
      throw new Error(`Asset path ${checked.relativePath} is reserved`)
    }
    seen.add(checked.relativePath)
  }
  writeFileSync(join(directory, 'workflow.json'), `${JSON.stringify(bundle.manifest, null, 2)}\n`, 'utf8')
  if (bundle.editor) {
    writeFileSync(join(directory, 'editor.json'), `${JSON.stringify(bundle.editor, null, 2)}\n`, 'utf8')
  }
  if (bundle.lock) {
    writeFileSync(join(directory, 'workflow.lock.json'), `${JSON.stringify(bundle.lock, null, 2)}\n`, 'utf8')
  }
  for (const asset of bundle.assets) {
    const checked = checkBundleRelativePath(asset.relativePath)
    if (!checked.ok) throw new Error(`Unsafe asset path ${asset.relativePath}: ${checked.reason}`)
    const abs = posixJoin(directory, checked.relativePath)
    mkdirSync(dirname(abs), { recursive: true })
    if (typeof asset.bytes === 'string') writeFileSync(abs, asset.bytes, 'utf8')
    else writeFileSync(abs, asset.bytes)
  }
}

function shouldKeepText(relativePath: string): boolean {
  const lower = relativePath.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return TEXT_EXTENSIONS.has(lower.slice(dot))
}

interface ListedFile {
  relativePath: string
  abs: string
  bytes: number
}

function listFilesRecursive(
  absRoot: string,
  realRoot: string,
  relative: string,
  diagnostics: string[]
): ListedFile[] {
  const contained = resolveContainedPath(absRoot, relative || '.')
  if (!contained.ok) {
    diagnostics.push(contained.reason)
    return []
  }
  let dirents
  try {
    dirents = readdirSync(contained.resolved, { withFileTypes: true })
  } catch {
    return []
  }
  const files: ListedFile[] = []
  for (const dirent of dirents) {
    const childRel = relative ? `${relative}/${dirent.name}` : dirent.name
    const checked = checkBundleRelativePath(childRel)
    if (!checked.ok) {
      diagnostics.push(`Skipped unsafe path ${childRel}: ${checked.reason}`)
      continue
    }
    const childAbs = join(contained.resolved, dirent.name)
    if (dirent.isSymbolicLink()) {
      const resolved = resolveContainedPath(absRoot, checked.relativePath)
      if (!resolved.ok) {
        diagnostics.push(`Rejected symlink ${childRel}: ${resolved.reason}`)
        continue
      }
      const stat = statSync(resolved.resolved)
      if (stat.isDirectory()) {
        files.push(...listFilesRecursive(absRoot, realRoot, checked.relativePath, diagnostics))
      } else if (stat.isFile()) {
        files.push({ relativePath: checked.relativePath, abs: resolved.resolved, bytes: stat.size })
      }
      continue
    }
    if (dirent.isDirectory()) {
      files.push(...listFilesRecursive(absRoot, realRoot, checked.relativePath, diagnostics))
      continue
    }
    if (dirent.isFile()) {
      const stat = statSync(childAbs)
      files.push({ relativePath: checked.relativePath, abs: childAbs, bytes: stat.size })
    }
  }
  return files
}

export function semanticAssetsFromBundle(bundle: WorkflowBundle): AssetDigest[] {
  const referenced = new Set(
    [
      bundle.manifest.instructionsFile,
      ...bundle.manifest.nodes.flatMap((node) => {
        const file = typeof node.config.file === 'string' ? node.config.file : undefined
        return file ? [file] : []
      })
    ].filter((item): item is string => Boolean(item))
  )
  return bundle.assets
    .filter((asset) => {
      const path = asset.relativePath.replace(/\\/g, '/')
      if (referenced.has(path)) return true
      if (path.startsWith('scripts/') || path.startsWith('schemas/')) return true
      if (path.endsWith('.schema.json')) return true
      return false
    })
    .map((asset) => digestAsset(asset.relativePath, asset.bytes))
}

export function collectLockDependencies(manifest: WorkflowManifest, assets: AssetDigest[]): WorkflowLockDocument {
  const dependencies = []
  for (const node of manifest.nodes) {
    if (node.type === 'agent' && isPlainObject(node.config.agent) && node.config.agent.kind === 'user') {
      dependencies.push({
        kind: 'agent' as const,
        id: String(node.config.agent.definitionId ?? ''),
        revision: typeof node.config.agent.revision === 'string' ? node.config.agent.revision : undefined
      })
    }
    if (node.type === 'load-skill' && isPlainObject(node.config.skill)) {
      dependencies.push({
        kind: 'skill' as const,
        id: String(node.config.skill.id),
        revision: typeof node.config.skill.revision === 'string' ? node.config.skill.revision : undefined
      })
    }
    if (node.type === 'subworkflow' && isPlainObject(node.config.workflow)) {
      dependencies.push({
        kind: 'subworkflow' as const,
        id: String(node.config.workflow.id ?? node.config.workflow.slug ?? ''),
        revision: typeof node.config.workflow.revision === 'string' ? node.config.workflow.revision : undefined
      })
    }
    if (node.type === 'mcp-tool') {
      dependencies.push({
        kind: 'mcp-tool' as const,
        id: `${String(node.config.serverId)}/${String(node.config.toolName)}`
      })
    }
    if (node.type === 'tool' && isPlainObject(node.config.tool)) {
      dependencies.push({ kind: 'tool' as const, id: String(node.config.tool.id) })
    }
    if (node.type === 'script' && typeof node.config.file === 'string') {
      const digest = assets.find((asset) => asset.relativePath === node.config.file)
      dependencies.push({
        kind: 'asset' as const,
        id: node.config.file,
        hash: digest?.sha256
      })
    }
  }
  if (manifest.instructionsFile) {
    const digest = assets.find((asset) => asset.relativePath === manifest.instructionsFile)
    dependencies.push({
      kind: 'asset' as const,
      id: manifest.instructionsFile,
      hash: digest?.sha256
    })
  }
  return {
    schemaVersion: 1,
    workflowId: manifest.id,
    semanticHash: '',
    dependencies
  }
}
