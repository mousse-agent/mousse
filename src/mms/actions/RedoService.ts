import type { ConversationBranchId } from '../../shared/workspace'
import type { ThreadAction } from '../../shared/threadActions'
import { UndoService, type RestoreActionContext } from './UndoService'

/** Redo compensates the latest undo; eligibility and context share its owning locks. */
export class RedoService {
  constructor(private readonly threadDirectory: string) {}
  async redoLatest(branchId: ConversationBranchId, workspacePath: string, expectedJournalRevision?: number, restoreContext?: RestoreActionContext): Promise<ThreadAction> {
    return new UndoService(this.threadDirectory).undoLatest(branchId, workspacePath, undefined, expectedJournalRevision, restoreContext, 'redo')
  }
}
