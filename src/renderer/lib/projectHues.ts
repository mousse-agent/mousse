/** How many identity hues the themes define: `--hue-1` to `--hue-6`. */
export const PROJECT_HUE_COUNT = 6

export interface HuedProject {
  /** The project group's id, so a project held by several computers is one color. */
  id: string
  createdAt: string
}

/**
 * Each project's hue, 1 to 6, as the Threads tab colors its rows. A project's own hue comes from its id, so it
 * survives restarts. When an older project already has that hue, the project takes the next free one, so up to
 * six projects all differ. Projects are placed oldest first: adding a project never changes an existing one's hue.
 * Past six, the hues are shared again, each one used once more before any is used a third time.
 */
export function projectHues(projects: readonly HuedProject[]): Map<string, number> {
  const ordered = [...projects].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const hues = new Map<string, number>()
  let taken = new Set<number>()
  for (const project of ordered) {
    if (hues.has(project.id)) continue
    if (taken.size === PROJECT_HUE_COUNT) taken = new Set()
    let hue = preferredHue(project.id)
    while (taken.has(hue)) hue = (hue % PROJECT_HUE_COUNT) + 1
    taken.add(hue)
    hues.set(project.id, hue)
  }
  return hues
}

function preferredHue(id: string): number {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0
  return (Math.abs(hash) % PROJECT_HUE_COUNT) + 1
}
