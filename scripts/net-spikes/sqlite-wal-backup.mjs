// Spike: node:sqlite WAL, per-stream uniqueness, range reads and online backup.
// Run under both runtimes:
//   node scripts/net-spikes/sqlite-wal-backup.mjs
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/net-spikes/sqlite-wal-backup.mjs
import { DatabaseSync, backup } from 'node:sqlite'
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'net-spike-')))
try {
  const db = new DatabaseSync(join(dir, 'net.db'))
  db.exec(
    'pragma journal_mode=wal; pragma synchronous=normal;' +
      'create table events(stream text, seq integer, id text, bytes blob,' +
      ' primary key(stream, seq), unique(stream, id)) strict'
  )
  const insert = db.prepare('insert into events values(?,?,?,?)')
  const started = performance.now()
  db.exec('begin')
  for (let i = 1; i <= 50_000; i++) insert.run('s', i, 'e' + i, Buffer.alloc(200))
  db.exec('commit')
  console.log('50k inserts ms', Math.round(performance.now() - started))
  console.log('journal mode', db.prepare('pragma journal_mode').get().journal_mode)

  let duplicateRejected = false
  try {
    insert.run('s', 60_000, 'e1', Buffer.alloc(1))
  } catch {
    duplicateRejected = true
  }
  console.log('duplicate id rejected', duplicateRejected)

  await backup(db, join(dir, 'bak.db'))
  const copy = new DatabaseSync(join(dir, 'bak.db'))
  console.log('backup rows', copy.prepare('select count(*) c from events').get().c)
  console.log('backup size > 0', statSync(join(dir, 'bak.db')).size > 0)

  const rows = db
    .prepare('select seq, bytes from events where stream=? and seq>? order by seq limit 3')
    .all('s', 49_998)
  console.log(
    'range read',
    rows.map((row) => row.seq),
    rows[0].bytes instanceof Uint8Array
  )
  copy.close()
  db.close()
} finally {
  rmSync(dir, { recursive: true, force: true })
}
