import type { NodeId } from '../../shared/net'
import type { Project } from '../../shared/types'
import { LOCAL_RUN_ON_ID, notSharingReason, type RunOnOption } from '../components/sideCard/deviceMenu'
import { joinFolder, usualParent } from '../components/newProjectLogic'
import { localProjectIdOf, type ComposerWorkspace } from './newThread'
import type { Device } from './netDevices'

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
