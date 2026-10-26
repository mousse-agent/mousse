import { describePermissionMode } from '../../../shared/permissionMode'
import { useAppStore } from '../../stores/appStore'
import { SideCardSection, type SideCardSectionContext } from './SideCardSection'

/** The thread's permission mode in one line; it is changed from the composer. */
export function PermissionSection({ threadId }: SideCardSectionContext) {
  const mode = useAppStore((s) => s.threads.find((thread) => thread.id === s.activeThreadId)?.permissionMode)
  const text = mode ? describePermissionMode(mode) : 'Profile default'
  return (
    <SideCardSection title="Permissions" threadId={threadId}>
      <p className="side-card-device-name" title={text}>{text}</p>
    </SideCardSection>
  )
}
