import { afterEach, expect, it } from 'vitest'
import { createBotMemoryAdmin } from '../../../src/mms/bots/memory/admin'
import { disposeFixtures, memoryFixture } from './memoryFixture'

afterEach(disposeFixtures)

// Rough source links: an old owner message, a newer unrelated message after an edit,
// and identical schedule prompts in separate runs. No entry in these cases was combined.
it('editing then forgetting a fact preserves unrelated owner messages and another fact', () => {
  const { store, db, message } = memoryFixture()
  message({ botId: 'ada', id: 'home', author: 'owner', text: 'I live in Leeds and my sister is called Ana.' })
  store.save('ada', { lane: 'chat', kind: 'owner', text: 'The owner lives in Leeds.' })
  store.save('ada', { lane: 'chat', kind: 'owner', text: 'The owner has a sister called Ana.' })
  message({ botId: 'ada', id: 'dentist', author: 'owner', text: 'Please book the dentist for Thursday at 3pm, it is urgent.' })
  const admin = createBotMemoryAdmin({ store })
  const edited = admin.edit!('ada', 'm1', 'The owner lives in York.')
  const before = store.journal('ada').filter(row => row.kind === 'owner_msg')
  const messages = db.statement('SELECT * FROM bot_messages ORDER BY id').all()
  admin.forget('ada', edited.ref)
  expect(store.journal('ada').filter(row => row.kind === 'owner_msg')).toEqual(before)
  expect(db.statement('SELECT * FROM bot_messages ORDER BY id').all()).toEqual(messages)
  expect(store.active('ada').map(entry => entry.text)).toEqual(['The owner has a sister called Ana.'])
})

it('forgetting a run note preserves its run prompt and identical prompts in other runs', () => {
  const { store } = memoryFixture()
  for (const activationId of ['run-1', 'run-2']) {
    store.append({ botId: 'ada', kind: 'run_start', activationId, lane: 'run', who: 'mousse',
      sourceKey: `start:${activationId}`, text: 'Check the clinic website for changes and summarize any news.' })
  }
  store.save('ada', { lane: 'run', kind: 'note', activationId: 'run-2', text: 'The clinic website moved to /news.' })
  const before = store.journal('ada').filter(row => row.kind === 'run_start')
  store.forget('ada', { id: 'm1', by: 'owner_ui' })
  expect(store.journal('ada').filter(row => row.kind === 'run_start')).toEqual(before)
  expect(store.active('ada')).toEqual([])
})
