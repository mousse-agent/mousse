/**
 * Child process for `compactionOutOfRoom.test.ts`: rewrites a net.db with too little room. SQLite's heap limit only
 * ever goes down, for the whole process, so it is set here, never in a test worker.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NetDatabase } from '../../../src/mms/net/store/database'

const [profileDir] = process.argv.slice(2)
const db = new NetDatabase({ profileDir: profileDir! })
let outcome: {
  threw: boolean
  message?: string
  result?: unknown
  wroteAfter?: boolean
  writeError?: string
}
// The rewrite builds its copy in memory: a limit below what it needs stands in for a disk with no room.
db.database.exec('PRAGMA shrink_memory')
db.database.exec(`PRAGMA hard_heap_limit=${4 * 2 ** 20}`)
try {
  outcome = { threw: false, result: db.rewriteToReclaim() }
} catch (error) {
  outcome = { threw: true, message: (error as Error).message }
}
// The same connection writes on: a rewrite that failed does not suspend writes.
try {
  db.transaction(() => db.database.exec("INSERT INTO filler(data) VALUES(x'00')"))
  outcome = { ...outcome, wroteAfter: true }
} catch (error) {
  outcome = { ...outcome, wroteAfter: false, writeError: (error as Error).message }
}
db.close()
writeFileSync(join(profileDir!, 'outcome.json'), JSON.stringify(outcome))
