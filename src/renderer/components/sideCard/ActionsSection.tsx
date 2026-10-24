import { SideCardSection, type SideCardSectionContext } from './SideCardSection'

/** Placeholder body until this section is built. */
export function ActionsSection({ threadId }: SideCardSectionContext) {
  return (
    <SideCardSection title="Actions" threadId={threadId}>
      <p className="side-card-placeholder">Quick actions will appear here.</p>
    </SideCardSection>
  )
}
