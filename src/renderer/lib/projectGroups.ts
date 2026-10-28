import type { Project } from '../../shared/types'

type Groupable = Pick<Project, 'id' | 'node' | 'sameAs'>

/**
 * The projects of one repository, as the sidebar lists them. A project of another computer joins this
 * computer's project when the other computer says it holds the same repository (`sameAs`, a shared remote);
 * otherwise it is a group of its own. A weaker match (`similarTo`, the same first commit only) never groups.
 */
export interface ProjectGroup<P extends Groupable = Project> {
  /** Names the group: this computer's project when it has one, else the other computer's own id. */
  id: string
  /** The project that names the group and that its menu acts on: this computer's when there is one. */
  project: P
  /** Every project in the group, this computer's first, then the others in list order. */
  members: P[]
}

export interface ProjectGroups<P extends Groupable = Project> {
  /** In the order of the project list: each group sits where its main project sits. */
  groups: ProjectGroup<P>[]
  /** The id of the group a project is in, by the project's own id. */
  groupOf: ReadonlyMap<string, string>
}

/**
 * Groups the projects by `sameAs ?? id`. A `sameAs` that names no project of this computer (the project was
 * removed, or the match is out of date) is ignored: that project is a group of its own.
 */
export function groupProjects<P extends Groupable>(projects: readonly P[]): ProjectGroups<P> {
  const own = new Set(projects.filter((project) => !project.node).map((project) => project.id))
  const members = new Map<string, P[]>()
  const groupOf = new Map<string, string>()
  for (const project of projects) {
    const key = project.node && project.sameAs && own.has(project.sameAs) ? project.sameAs : project.id
    groupOf.set(project.id, key)
    const list = members.get(key) ?? []
    list.push(project)
    members.set(key, list)
  }
  const groups: ProjectGroup<P>[] = []
  for (const [id, list] of members) {
    // This computer's project first; the others keep the order they were listed in.
    const ordered = [...list.filter((project) => !project.node), ...list.filter((project) => project.node)]
    groups.push({ id, project: ordered[0]!, members: ordered })
  }
  const position = new Map(projects.map((project, index) => [project.id, index]))
  groups.sort((a, b) => position.get(a.project.id)! - position.get(b.project.id)!)
  return { groups, groupOf }
}

/** The computers other than this one that hold a project of the group, in the order their projects were listed. */
export function groupComputers(group: Pick<ProjectGroup<Groupable>, 'members'>): string[] {
  const nodes: string[] = []
  for (const member of group.members) if (member.node && !nodes.includes(member.node)) nodes.push(member.node)
  return nodes
}
