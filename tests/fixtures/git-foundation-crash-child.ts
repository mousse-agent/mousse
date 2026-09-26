import { ThreadJournal } from '../../src/mms/data/ThreadJournal'
import { UndoService } from '../../src/mms/actions/UndoService'

const [thread, workspace, phase, operation = 'undo'] = process.argv.slice(2)
if (operation !== 'undo' && operation !== 'redo') throw new Error('Invalid fixture operation')
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
