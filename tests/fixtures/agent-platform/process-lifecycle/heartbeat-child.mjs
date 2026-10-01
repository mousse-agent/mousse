import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { isAbsolute, join } from 'node:path'

const dir = process.env.LIFECYCLE_HEARTBEAT_DIR
if (typeof dir !== 'string' || dir.length === 0 || !isAbsolute(dir)) {
  process.stderr.write('LIFECYCLE_HEARTBEAT_DIR must be an absolute path\n')
  process.exit(2)
}

const role = process.env.LIFECYCLE_ROLE || 'child'
if (role !== 'child' && role !== 'grandchild') {
  process.stderr.write('LIFECYCLE_ROLE must be child or grandchild\n')
  process.exit(2)
}

const ignoreStop = process.env.LIFECYCLE_IGNORE_STOP === '1'
const spawnGrandchild = process.env.LIFECYCLE_SPAWN_GRANDCHILD === '1'
const intervalMs = Number(process.env.LIFECYCLE_HEARTBEAT_MS || '100')
const beatEvery = Number.isFinite(intervalMs) && intervalMs >= 20 ? intervalMs : 100

mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, `${role}.pid`), `${process.pid}\n`, 'utf8')

if (ignoreStop) {
  process.on('SIGTERM', () => undefined)
  process.on('SIGINT', () => undefined)
  process.on('SIGHUP', () => undefined)
}

if (spawnGrandchild) {
  const grandchild = spawn(process.execPath, [process.argv[1]], {
    cwd: dir,
    env: {
      ...process.env,
      LIFECYCLE_ROLE: 'grandchild',
      LIFECYCLE_SPAWN_GRANDCHILD: '0',
      LIFECYCLE_IGNORE_STOP: ignoreStop || process.env.LIFECYCLE_GRANDCHILD_IGNORE_STOP === '1' ? '1' : '0'
    },
    stdio: 'ignore',
    windowsHide: true
  })
  grandchild.on('error', (error) => {
    writeFileSync(join(dir, 'grandchild.spawn-error'), String(error), 'utf8')
  })
  if (typeof grandchild.pid === 'number' && grandchild.pid > 0) {
    writeFileSync(join(dir, 'grandchild.spawn-pid'), `${grandchild.pid}\n`, 'utf8')
  }
}

setInterval(() => {
  try {
    appendFileSync(join(dir, `${role}.heartbeat`), `${Date.now()}\n`)
  } catch {
    /* heartbeat directory already removed */
  }
}, beatEvery)
