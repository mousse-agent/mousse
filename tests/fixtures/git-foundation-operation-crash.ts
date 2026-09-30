import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ThreadJournal } from '../../src/mms/data/ThreadJournal'
import { ThreadActionService } from '../../src/mms/actions/ThreadActionService'
import { CodeRevertService } from '../../src/mms/actions/CodeRevertService'
import { PublishService } from '../../src/mms/actions/PublishService'
import { ChildAgentIntegrationService } from '../../src/mms/agents/ChildAgentIntegrationService'
import { waitAcquireExecutionLease } from '../../src/mms/queue/ThreadExecutionLease'

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const append = ThreadJournal.prototype.append
ThreadJournal.prototype.append = function (record) {
  const target = record.operationType === `change-${config.kind === 'nested-checkpoint' ? 'checkpoint' : config.kind}` && record.state === 'git_applied'
  if (target && config.phase === 'before') process.exit(86)
  const result = append.call(this, record)
  if (target && config.phase === 'after') process.exit(86)
  return result
} as typeof append
switch (config.kind) {
  case 'nested-checkpoint': {
    const heldThreadLease = await waitAcquireExecutionLease(config.thread, { source: 'crash-parent' })
    const service = new ThreadActionService(config.thread)
    service.beginTurn({ ...config.options, heldThreadLease }, config.baseSha)
    writeFileSync(join(config.repo, 'value.txt'), 'nested parent change\n')
    await service.checkpointExistingTurn({ ...config.options, turnId: 'nested-snapshot', heldThreadLease }, config.baseSha, 'completed')
    break
  }
  case 'checkpoint':
    await new ThreadActionService(config.thread).runCheckpointedAction(config.options, () => writeFileSync(join(config.repo, 'value.txt'), 'checkpoint result\n'))
    break
  case 'revert': await new CodeRevertService(config.thread).revertCode(config.actionId, config.repo); break
  case 'integration': await new ChildAgentIntegrationService(config.thread).integrate(config.request); break
  case 'publish': await new PublishService(config.thread).publish(config.source, config.repo, config.target, undefined, config.options); break
}
throw new Error('Crash boundary was not reached')
