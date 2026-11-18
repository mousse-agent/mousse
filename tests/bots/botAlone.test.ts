import { expect, it } from 'vitest'
import { actionPlace } from '../../src/mms/bots/actions/BotAlone'

const names = 'folder folderid parent parentid path dir directory channel channelid repo repository owner project projectid calendar calendarid list listid board to recipient recipients email space spaceid database databaseid drive driveid cc bcc from sender replyto url uri link webhook endpoint host domain account accountid address destination target remote branch'.split(' ')
it.each(names)('reads exact top-level %s place values from the schema', name => {
  const key = name.toUpperCase().replace('ID', '_ID')
  expect(actionPlace({ properties: { [key]: {}, body: {} } }, { [key]: ['one', { id: 2 }], body: 'ignored' })).toEqual({ [key]: ['one', { id: 2 }] })
})
it('does not infer a place from undeclared, nested or missing arguments', () => {
  expect(actionPlace({ properties: { body: {}, nested: { properties: { folder: {} } }, folder: {} } }, { path: '/x', nested: { folder: 'x' } })).toBeUndefined()
})

import { placeLabel } from '../../src/mms/bots/actions/BotAlone'
it('uses a result name only when it names the exact destination id', () => {
  expect(placeLabel('folder-1', '{"folder":{"id":"folder-1","name":"Scans"}}')).toBe('Scans')
  expect(placeLabel('folder-2', '{"folder":{"id":"folder-1","name":"Scans"}}')).toBe('folder-2')
})
