import type { NodeId } from '../../shared/net'
import type { Project } from '../../shared/types'
import { LOCAL_RUN_ON_ID, notSharingReason, type RunOnOption } from '../components/sideCard/deviceMenu'
import { joinFolder, usualParent } from '../components/newProjectLogic'
import { localProjectIdOf, type ComposerWorkspace } from './newThread'
import type { Device } from './netDevices'
import type { BrowsedFolders } from './sourceControl'

type ProjectRow = Pick<Project, 'id' | 'node' | 'sameAs' | 'similarTo' | 'path' | 'name'>

/**
 * The project of this computer a draft stands for: its own project here, or, on another computer, the one it was
 * picked from here (`localProjectId`) or the project there is the same repository as (`sameAs`). None for a draft
 * without a project, or with a project of another computer that this one does not have.
 */
export function draftLocalProject(workspace: ComposerWorkspace, projects: readonly ProjectRow[]): ProjectRow | undefined {
  const there = workspace.node && workspace.projectId ? projects.find((project) => project.id === workspace.projectId) : undefined
  const id = there?.sameAs ?? localProjectIdOf(workspace)
  return id ? projects.find((project) => !project.node && project.id === id) : undefined
}

/** The computers that list a project for the same repository as `localProjectId` (its `sameAs`). */
export function computersWithProject(projects: readonly ProjectRow[], localProjectId: string): Set<string> {
  return new Set(projects.filter((project) => project.node && project.sameAs === localProjectId).map((project) => project.node!))
}

/**
 * The Run on rows for a draft with a project: this computer and the computers that have it. The computer picked stays
 * listed, so a person can see where the chat runs and leave it.
 */
export function runOnWithProject(options: readonly RunOnOption[], withProject: ReadonlySet<string>): RunOnOption[] {
  return options.filter((option) => option.id === LOCAL_RUN_ON_ID || option.active || withProject.has(option.id))
}

/** A computer the project can be added to, and whether it can be picked now. */
export interface AddTarget {
  node: NodeId
  name: string
  online: boolean
  /** Why it cannot be picked: it is offline, or it stopped sharing its threads with this one. */
  reason?: string
}

/** The user's other computers (not phones) that do not have the project: the connected ones first. */
export function addTargets(devices: readonly Device[], withProject: ReadonlySet<string>, notSharing?: ReadonlySet<string>): AddTarget[] {
  return devices
    .filter((device) => !device.self && !device.revoked && device.kind !== 'phone' && device.kind !== 'unknown' && !withProject.has(device.node))
    .map((device): AddTarget => {
      const online = device.state === 'open'
      const reason = !online ? `${device.name} is offline` : notSharing?.has(device.node) ? notSharingReason(device.name) : undefined
      return { node: device.node, name: device.name, online, ...(reason ? { reason } : {}) }
    })
    .sort((a, b) => Number(Boolean(a.reason)) - Number(Boolean(b.reason)))
}

/** What adding the project to a computer would do there. */
export interface AddPlan {
  /** A project there with the same root commit: a checkout of it already, offered first. */
  existing?: ProjectRow
  /** A clone of its GitHub repository into `folder`, on `branch` when GitHub has it. */
  clone?: { repository: string; name: string; branch?: string }
  /** Where that computer's projects are, the folder a clone goes in unless another is picked. */
  folder: string | null
}

export function addPlan(input: {
  projects: readonly ProjectRow[]
  node: string
  localProjectId: string
  source: { repository?: string; branch?: string }
}): AddPlan {
  const there = input.projects.filter((project) => project.node === input.node)
  const existing = there.find((project) => project.similarTo === input.localProjectId)
  const repository = input.source.repository
  return {
    ...(existing ? { existing } : {}),
    ...(repository ? { clone: { repository, name: repository.split('/')[1]!, ...(input.source.branch ? { branch: input.source.branch } : {}) } } : {}),
    folder: usualParent(there.map((project) => project.path))
  }
}

/** Where a clone into `folder` lands: a new folder named after the repository. */
export const cloneDestination = (folder: string, name: string): string => joinFolder(folder, name)

/** Whether a path of another computer is written the Windows way: a drive letter, or backslashes only. */
export const isWindowsPath = (path: string): boolean => /^[A-Za-z]:/.test(path) || (path.includes('\\') && !path.includes('/'))

/** A full path, as another computer takes it: `/…`, or `C:\…`. */
export const isFullPath = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)

/** The last name of a path: the folder it names. */
export function leafName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1)
}

/** A folder on a path, by its name and its own full path. */
export interface PathCrumb {
  name: string
  path: string
}

/**
 * The folders a full path goes through, from the top: `/Users/me` → `/`, `/Users`, `/Users/me`; `C:\dev` → `C:`,
 * `C:\dev`. The top is the root (`/`) or the drive (`C:\`).
 */
export function pathCrumbs(path: string): PathCrumb[] {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  if (isWindowsPath(path)) {
    const [drive, ...rest] = parts
    if (!drive) return []
    const crumbs: PathCrumb[] = [{ name: drive, path: `${drive}\\` }]
    for (const part of rest) crumbs.push({ name: part, path: `${crumbs.length === 1 ? drive : crumbs[crumbs.length - 1]!.path}\\${part}` })
    return crumbs
  }
  const crumbs: PathCrumb[] = [{ name: '/', path: '/' }]
  for (const part of parts) crumbs.push({ name: part, path: `${crumbs.length === 1 ? '' : crumbs[crumbs.length - 1]!.path}/${part}` })
  return crumbs
}

/** A folder name that browsing another computer does not show, so a clone cannot go in it either. */
const hiddenName = (name: string) => name.startsWith('.') || name.startsWith('$')

/** Whether a path goes through a hidden folder (`~/.config/x`), which another computer may not clone into. */
export const goesThroughHidden = (path: string): boolean => path.split(/[\\/]+/).some(hiddenName)

/**
 * A path typed for another computer, as the clone takes it: trimmed, `~` for its home folder, and a trailing `/`
 * meaning "in this folder", so the clone's own folder (`name`) goes in it.
 */
export function typedDestination(text: string, name: string, home?: string): string {
  let path = text.trim()
  if (home && (path === '~' || /^~[\\/]/.test(path))) path = `${home.replace(/[\\/]+$/, '')}${path.slice(1)}`
  if (/[\\/]$/.test(path) && pathCrumbs(path).length > 0) return joinFolder(path, name)
  return path
}

/** Why `name` cannot be a new folder on that computer, in a few words; nothing when it can. */
export function newFolderProblem(name: string, windows: boolean): string | undefined {
  const value = name.trim()
  if (!value) return undefined
  if (/[\\/]/.test(value)) return 'A folder name has no / or \\'
  if (value === '.' || value === '..') return 'Pick another name'
  if (hiddenName(value)) return 'Hidden folders can’t be used from another computer'
  if (windows && (/[<>:"|?*]/.test(value) || /[. ]$/.test(value))) return 'Windows does not take that name'
  return undefined
}

/** What browsing that computer says of a clone into `destination`. */
export interface FolderCheck {
  /** The folder the clone goes in when it is there, else the deepest of its parents that is, with its folders. */
  view: BrowsedFolders
  /** The folders under `view` that the clone makes first, outermost first. */
  missing: string[]
  /** A folder with the clone's name is there already: the clone needs it empty. */
  taken: boolean
}

/**
 * Browses that computer up from the folder `destination` goes in, to the first one that is there. A folder that is
 * not there (`not_found`) is one the clone makes; any other refusal is that computer's answer, and is thrown.
 */
export async function checkDestination(destination: string, browse: (path: string) => Promise<BrowsedFolders>): Promise<FolderCheck> {
  const crumbs = pathCrumbs(destination)
  const leaf = leafName(destination)
  const windows = isWindowsPath(destination)
  const missing: string[] = []
  for (let index = crumbs.length - 2; index >= 0; index--) {
    try {
      const view = await browse(crumbs[index]!.path)
      const same = (name: string) => (windows ? name.toLowerCase() === leaf.toLowerCase() : name === leaf)
      return { view, missing, taken: missing.length === 0 && view.folders.some((folder) => same(folder.name)) }
    } catch (failure) {
      if ((failure as { code?: unknown } | null)?.code !== 'not_found' || index === 0) throw failure
      missing.unshift(crumbs[index]!.name)
    }
  }
  throw Object.assign(new Error('Pick a folder, not the root of the disk.'), { code: 'project_refused' })
}
