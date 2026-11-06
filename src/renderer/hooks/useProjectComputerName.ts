import { UNKNOWN_COMPUTER_NAME, useComputers } from '../lib/computers'
import { useAppStore } from '../stores/appStore'

/** The computer that holds a project of another of the user's computers; null for this computer's own. */
export function useProjectComputerName(projectId: string | null): string | null {
  const node = useAppStore((state) => (projectId ? state.projects.find((project) => project.id === projectId)?.node ?? null : null))
  const { byNode } = useComputers(node !== null)
  return node ? byNode[node]?.name ?? UNKNOWN_COMPUTER_NAME : null
}
