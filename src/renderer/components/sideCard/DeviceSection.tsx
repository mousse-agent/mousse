import { SideCardSection, type SideCardSectionContext } from './SideCardSection'

/** Placeholder body until this section is built. */
export function DeviceSection({ threadId }: SideCardSectionContext) {
  return (
    <SideCardSection title="Device" threadId={threadId}>
      <p className="side-card-placeholder">Device details will appear here.</p>
    </SideCardSection>
  )
}
