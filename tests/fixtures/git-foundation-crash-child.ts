import { ThreadJournal } from '../../src/mms/data/ThreadJournal'
import { UndoService } from '../../src/mms/actions/UndoService'

const [thread, workspace, phase] = process.argv.slice(2)
const append = ThreadJournal.prototype.append
// Fault instrumentation preserves every real write and exits immediately after the selected durable boundary.
ThreadJournal.prototype.append = function (record) {
  const result = append.call(this, record)
  if ((phase === 'receipt' && record.operationType === 'change-undo' && record.state === 'git_applied') ||
      (phase === 'context' && record.operationType === 'undo' && record.state === 'context_pending')) {
    process.exit(86)
  }
  return result
} as typeof append

await new UndoService(thread).undoLatest('main', workspace, undefined, undefined, () => {
  throw new Error('Unexpected context callback after crash boundary')
})
throw new Error('Crash boundary was not reached')
