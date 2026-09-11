import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  cloneJson,
  getJsonPointer,
  setJsonPointer,
  type WorkflowFileInputDeclaration,
  type WorkspaceFileAdapter
} from '../../../shared/workflows'
import type { ExecutionContext } from '../../../shared/execution/types'
import { checkBundleRelativePath, isUnsafeWorkspaceFileInput, resolveContainedPath } from '../pathSafety'

export interface StagedFileInputs {
  input: unknown
  env: Record<string, string>
}

export async function stageFileInputs(options: {
  declarations: WorkflowFileInputDeclaration[]
  input: unknown
  runRoot: string
  context: ExecutionContext
  workspace?: WorkspaceFileAdapter
}): Promise<StagedFileInputs> {
  const input = cloneJson(options.input)
  const env: Record<string, string> = {}
  const stagingRoot = join(options.runRoot, 'staging')
  const writtenTargets = new Set<string>()
  for (const declaration of options.declarations) {
    const found = getJsonPointer(input, declaration.pointer)
    if (!found.ok) throw new Error(`fileInputs pointer ${declaration.pointer} is missing`)
    const values = Array.isArray(found.value) ? found.value : [found.value]
    if (!values.every((item) => typeof item === 'string')) {
      throw new Error('fileInputs values must be strings')
    }
    const destCheck = checkBundleRelativePath(declaration.destination)
    if (!destCheck.ok) throw new Error(destCheck.reason)
    const destDir = join(stagingRoot, destCheck.relativePath)
    const contained = resolveContainedPath(stagingRoot, destCheck.relativePath)
    if (!contained.ok) throw new Error(contained.reason)
    mkdirSync(destDir, { recursive: true })
    let total = 0
    const stagedNames: string[] = []
    for (const raw of values as string[]) {
      if (isUnsafeWorkspaceFileInput(raw)) {
        throw new Error(`Rejected file input path ${raw}`)
      }
      const safe = checkBundleRelativePath(raw.replace(/\\/g, '/'))
      if (!safe.ok) throw new Error(`Rejected file input path ${raw}: ${safe.reason}`)
      if (!options.workspace) throw new Error('Workspace file adapter is required to stage fileInputs')
      const file = await options.workspace.readAuthorizedFile(safe.relativePath, options.context)
      total += file.bytes.byteLength
      if (total > declaration.maxTotalBytes) throw new Error('fileInputs exceed maxTotalBytes')
      const stagedName = `${destCheck.relativePath}/${safe.relativePath}`.replace(/\\/g, '/')
      if (writtenTargets.has(stagedName)) throw new Error(`fileInputs destination collision at ${stagedName}`)
      writtenTargets.add(stagedName)
      const targetContained = resolveContainedPath(stagingRoot, stagedName)
      if (!targetContained.ok) throw new Error(targetContained.reason)
      mkdirSync(dirname(targetContained.resolved), { recursive: true })
      writeFileSync(targetContained.resolved, file.bytes)
      stagedNames.push(stagedName)
    }
    const rewritten = Array.isArray(found.value) ? stagedNames : stagedNames[0]
    const set = setJsonPointer(input, declaration.pointer, rewritten)
    if (!set.ok) throw new Error(set.error)
    env.MOUSSE_INPUT_DIR = stagingRoot
  }
  return { input, env }
}
