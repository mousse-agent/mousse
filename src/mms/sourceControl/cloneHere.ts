import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { UserAction } from '../git/gitPolicy'
import type { ExecutableRunner } from '../git/ghRunner'
import { execRunner } from '../git/ghRunner'
import { DomainRpcError } from '../protocol/domainRegistry'
import { hasHiddenSegment, isNetworkOrDevicePath, remoteFolderProblem } from '../bridge/remote/remoteFolders'
import type { FolderRuleEnvironment } from '../files/sensitiveFolders'
import type { Project } from '../../shared/types'

/** What `cloneHere` needs of the profile: its GitHub clone, its projects, and its data folders. */
export interface CloneHereServices {
  clone(input: { repository: string; destination: string }, userRequested: UserAction): Promise<string>
  openProject(path: string): Project
  /** The Mousse data folders (the profile's and the installation's), which no project may be in or hold. */
  homes: readonly string[]
  rules?: FolderRuleEnvironment
  run?: ExecutableRunner
}

export interface CloneHereResult {
  project: Project
  /** The branch the checkout is on, when the one asked for was there and is now checked out. */
  branch?: string
}

const refuse = (message: string) => new DomainRpcError('project_refused', message)

/**
 * Clones a repository into a new folder on this computer and adds it as a project, for a window on another computer.
 * The folder the clone goes in must exist here; the new folder must not, or be empty, and must be one that computer
 * could open as a project (`remoteFolderProblem`). With `branch`, the checkout moves to it when the remote has it, and
 * stays on the default branch otherwise. A clone that fails leaves nothing: Git removes the folder it was making, and a
 * project that cannot be added removes the folder this call made.
 */
export async function cloneHere(
  input: { repository: string; path: string; branch?: string },
  services: CloneHereServices,
  userRequested: UserAction
): Promise<CloneHereResult> {
  const path = input.path.trim()
  if (!path || path.includes('\0')) throw refuse('Choose a folder for the clone.')
  if (isNetworkOrDevicePath(path)) throw refuse('Network and device paths cannot be used from another computer.')
  if (!isAbsolute(path)) throw refuse('Choose a folder for the clone, by its full path.')
  const lexical = resolve(path)
  const parent = dirname(lexical)
  if (parent === lexical) throw refuse('Pick a folder, not the root of the disk.')
  let realParent: string
  try {
    realParent = realpathSync.native(parent)
    if (!statSync(realParent).isDirectory()) throw new Error('not a folder')
  } catch {
    throw refuse('The folder it goes in does not exist on this computer.')
  }
  if (isNetworkOrDevicePath(realParent)) throw refuse('Network and device paths cannot be used from another computer.')
  const destination = join(realParent, basename(lexical))
  // A hidden folder is not offered when browsing, so naming one does not clone into it either.
  if (hasHiddenSegment(lexical) || hasHiddenSegment(destination)) throw refuse('Hidden folders cannot be used from another computer.')
  const problem = remoteFolderProblem([lexical, destination], services.homes, services.rules)
  if (problem?.kind === 'data') throw refuse('That folder is part of the Mousse data folder, or contains it.')
  if (problem) throw refuse(`That folder holds ${problem.holds}, or is inside or above a folder that does, so another computer cannot use it.`)
  const existed = existsSync(destination)
  if (existed && readdirSync(destination).length > 0) throw refuse('That folder is not empty. Choose a new or empty folder.')

  await services.clone({ repository: input.repository, destination }, userRequested)
  try {
    let branch: string | undefined
    if (input.branch) {
      try {
        // Git makes the branch from the remote's when it has one; with none, the clone stays on its default branch.
        await (services.run ?? execRunner)('git', ['checkout', input.branch], { cwd: destination, userRequested })
        branch = input.branch
      } catch {
        branch = undefined
      }
    }
    const project = services.openProject(destination)
    return { project, ...(branch ? { branch } : {}) }
  } catch (error) {
    // Nothing half made: the folder this call made goes, and an empty folder that was there is left empty.
    await rm(destination, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    if (existed) await mkdir(destination, { recursive: true }).catch(() => undefined)
    throw error
  }
}

/** A branch name as Git takes it, from another computer's draft. */
export function validBranch(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 250 || !/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith('-') || value.includes('..') || value.endsWith('/') || value.endsWith('.lock')) {
    throw new DomainRpcError('invalid_params', 'branch is not a branch name')
  }
  return value
}
