import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SqliteNetStore } from '../../../src/mms/net/store'
import { decodeEnvelope } from '../../../src/mms/net/sync/codec'
import { fixture } from './helpers'

const [path, mode] = process.argv.slice(2)
const f = fixture()
const key = f.key()
const receipt = f.record(1)
const id = decodeEnvelope(receipt.envelope).envelope.id
let armed = false
const crashPoint =
  mode === 'snapshot' ? 'snapshot.activate.beforeCommit' : 'transaction.beforeCommit'
const store = new SqliteNetStore({
  profileDir: path,
  clock: f.clock,
  fault(point) {
    if (armed && point === crashPoint) process.exit(77)
  }
})
store.streams.createStream(f.descriptor, 1)
store.budgets.setDailyBudget(f.bot, f.space, 100)
writeFileSync(
  join(path, 'test-state.json'),
  JSON.stringify({
    key,
    bot: f.bot,
    space: f.space,
    stream: f.descriptor.id,
    receipt: id,
    now: f.clock.now()
  })
)

if (mode === 'admission') {
  armed = true
  store.executions.admit(key, 'a'.repeat(64), f.clock.now(), (r) => {
    store.budgets.reserve(f.bot, f.space, r.id, 100, f.clock.now())
    store.outbox.enqueue({
      id,
      stream: f.descriptor.id,
      envelope: receipt.envelope,
      sig: receipt.sig
    })
  })
} else if (mode === 'snapshot') {
  store.streams.applyFromAuthority(f.descriptor.id, [f.record(1)])
  const stage = store.streams.beginSnapshot(f.descriptor.id, { epoch: 2, seq: 1 })
  stage.append([f.record(1, 2)])
  armed = true
  stage.commit()
} else if (mode === 'completion') {
  const run = store.executions.admit(key, 'a'.repeat(64), f.clock.now(), (r) =>
    store.budgets.reserve(f.bot, f.space, r.id, 100, f.clock.now())
  ).record
  store.executions.transition(run.id, 'running', f.clock.now())
  store.budgets.authorizeCall(run.id, 'effect', 100)
  writeFileSync(join(path, 'external-effect'), 'effect happened')
  armed = true
  store.executions.transition(run.id, 'completed', f.clock.now(), { result: 'done' }, (r) => {
    store.budgets.settleCall(r.id, 'effect', 20)
    store.budgets.settle(r.id, 20)
    store.outbox.enqueue({
      id,
      stream: f.descriptor.id,
      envelope: receipt.envelope,
      sig: receipt.sig
    })
  })
}
throw new Error('Crash injection did not execute')
