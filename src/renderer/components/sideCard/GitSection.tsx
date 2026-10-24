import { SideCardSection, type SideCardSectionContext } from './SideCardSection'

/** Placeholder body until this section is built. */
export function GitSection({ threadId }: SideCardSectionContext) {
  return (
    <SideCardSection title="Git" threadId={threadId}>
      <p className="side-card-placeholder">Branch and changes will appear here.</p>
    </SideCardSection>
  )
}
