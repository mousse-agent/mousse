import type { ConversationBranchId } from '../../shared/workspace'
import type { ThreadAction } from '../../shared/threadActions'
import { ThreadActionService } from './ThreadActionService'
import { UndoService } from './UndoService'

/** Redo is a revert of the latest compensation action; original history is never replayed. */
export class RedoService {
  private readonly actions: ThreadActionService
  private readonly undo: UndoService
  constructor(threadDirectory: string) {
    this.actions = new ThreadActionService(threadDirectory)
    this.undo = new UndoService(threadDirectory)
  }

  async redoLatest(branchId: ConversationBranchId, workspacePath: string): Promise<ThreadAction> {
    const latest = this.actions.latest(branchId)
    if (!latest) throw new Error('There is no action to redo.')
    const original = this.actions.list().find((action) => action.compensationActionId === latest.id)
    if (!original || original.state !== 'undone') throw new Error('Latest action is not an undo compensation.')
    return this.undo.undoLatest(branchId, workspacePath)
  }
}
