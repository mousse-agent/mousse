import { ThreadJournal } from '../../src/mms/data/ThreadJournal'
import { UndoService } from '../../src/mms/actions/UndoService'
import { ResourceLifecycleStore } from '../../src/mms/lifecycle/ResourceLifecycleStore'
import { registerThreadLifecycleGate } from '../../src/mms/queue/ThreadLifecycleAdmission'

const [thread, workspace, phase, operation = 'undo', profileHome, profileId] = process.argv.slice(2)
if (operation !== 'undo' && operation !== 'redo') throw new Error('Invalid fixture operation')
// Managed-storage crash writers initialize the same profile gate as the daemon.
// Standalone Git unit fixtures have no lifecycle manifest and need no profile binding.
if (profileHome || profileId) {
  if (!profileHome || !profileId) throw new Error('Crash fixture requires both profile home and identity')
  const lifecycle = new ResourceLifecycleStore({ profileHome, profileId })
  const owner = lifecycle.findByLocation(thread)
  if (!owner) throw new Error('Crash fixture task has no durable lifecycle owner')
  lifecycle.assertAdmission(lifecycle.captureAdmission(owner.taskId, thread))
  registerThreadLifecycleGate(profileHome, lifecycle)
}
const append = ThreadJournal.prototype.append
// Fault instrumentation preserves every real write and exits immediately after the selected durable boundary.
ThreadJournal.prototype.append = function (record) {
  const result = append.call(this, record)
  if ((phase === 'receipt' && record.operationType === `change-${operation}` && record.state === 'git_applied') ||
      (phase === 'context' && record.operationType === operation && record.state === 'context_pending')) {
    process.exit(86)
  }
  return result
} as typeof append

await new UndoService(thread).undoLatest('main', workspace, undefined, undefined, () => {
  throw new Error('Unexpected context callback after crash boundary')
}, operation)
throw new Error('Crash boundary was not reached')
