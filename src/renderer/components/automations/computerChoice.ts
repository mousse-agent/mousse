import { offlineText, type AutomationIndex } from '../../../shared/automations'
import type { Project } from '../../../shared/types'
import type { SelectOption } from '../ui/Select'

/**
 * The Computer chip: which of the person's computers owns an automation. It shows only with two or more computers,
 * lists the computers that hold a project of the chosen Where's group (every computer when there is no Where), and
 * greys an offline one. The value is the computer's node, `''` for this computer.
 */
export interface ComputerChoice {
  node: string
  name: string
  /** Its IANA zone; `''` while it has not said. */
  timeZone: string
  offline?: boolean
}

type GroupProject = Pick<Project, 'id' | 'name' | 'node' | 'sameAs'>

/** This computer, then the person's other computers, from the list the page read. */
export function computerChoicesOf(index: Pick<AutomationIndex, 'computer' | 'computers'> | null | undefined, viewerZone: string): ComputerChoice[] {
  const here: ComputerChoice = { node: '', name: index?.computer.name ?? 'This computer', timeZone: index?.computer.timeZone ?? viewerZone }
  return [here, ...(index?.computers ?? []).flatMap((computer) => (computer.node ? [{ node: computer.node, name: computer.name, timeZone: computer.timeZone, ...(computer.offline ? { offline: true } : {}) }] : []))]
}

/** The projects of one computer, as Where offers them once a computer is chosen. */
export function projectsOn<P extends GroupProject>(projects: readonly P[], node: string): P[] {
  return projects.filter((project) => (project.node ?? '') === node)
}

/** The chip's options: an offline computer is greyed and says so. */
export function computerOptions(computers: readonly ComputerChoice[]): SelectOption[] {
  return computers.map((computer) => ({
    value: computer.node,
    label: computer.name,
    ...(computer.offline ? { disabled: true, description: offlineText(computer) } : {})
  }))
}
