import { SideCardSection, type SideCardSectionContext } from './SideCardSection'

/** Placeholder body until this section is built. */
export function LineageSection({ threadId }: SideCardSectionContext) {
  return (
    <SideCardSection title="Lineage" threadId={threadId}>
      <p className="side-card-placeholder">Related threads will appear here.</p>
    </SideCardSection>
  )
}
