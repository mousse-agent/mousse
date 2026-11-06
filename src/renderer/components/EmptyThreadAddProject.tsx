import { FolderPlus } from '../lib/icons'

/** A new chat offers "Add project" only on this computer, and only while there is no project at all. */
export const offersAddProject = (projectCount: number, node: string | undefined): boolean => !node && projectCount === 0

/** The one action of an empty new chat with no projects: a plain button centred under the composer. */
export function EmptyThreadAddProject({ onAdd }: { onAdd: () => void }) {
  return (
    <button type="button" className="settings-btn chat-empty-action chat-empty-add-project" onClick={onAdd}>
      <FolderPlus size={14} aria-hidden="true" />Add project
    </button>
  )
}
