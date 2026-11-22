import { useAppStore } from '../stores/appStore'
import { fileWorkspaceScope, useFileWorkspaceStore } from '../stores/filesStore'

export function useActiveFileWorkspace() {
  const profileId = useAppStore((s) => s.profileId)
  const threadId = useAppStore((s) => s.activeThreadId)
  const projectId = useAppStore((s) => s.threads.find((thread) => thread.id === s.activeThreadId)?.projectId)
  const scope = fileWorkspaceScope(profileId, threadId, projectId)
  const workspace = useFileWorkspaceStore((s) => s.workspaces[scope])
  return { scope, workspace }
}
