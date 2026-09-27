// Test-only process fault injection. The shipped daemon executes its real rename;
// SIGKILL happens before the caller can update the external mapping/index.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'

const rename = fs.renameSync
fs.renameSync = function (from, to) {
  const result = rename(from, to)
  const control = process.env.RESOURCE_LIFECYCLE_CRASH_CONTROL
  if (!control || !fs.existsSync(control)) return result
  const fault = JSON.parse(fs.readFileSync(control, 'utf8'))
  if ((fault.from && resolve(String(from)) === resolve(fault.from)) ||
      (fault.to && resolve(String(to)) === resolve(fault.to))) {
    fs.writeFileSync(fault.marker, JSON.stringify({ from: String(from), to: String(to), pid: process.pid }))
    process.kill(process.pid, 'SIGKILL')
  }
  return result
}
syncBuiltinESMExports()
// Isolate model-catalog discovery from the deterministic local storage test.
globalThis.fetch = async () => { throw new Error('resource-lifecycle fixture: network catalog disabled') }
