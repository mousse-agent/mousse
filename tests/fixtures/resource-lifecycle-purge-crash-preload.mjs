// Fault injection wraps actual filesystem effects in the built daemon. It is
// never imported by production code or an ordinary application launch.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'

const fault = () => {
  const control = process.env.RESOURCE_LIFECYCLE_PURGE_CRASH_CONTROL
  return control && fs.existsSync(control) ? JSON.parse(fs.readFileSync(control, 'utf8')) : {}
}
const kill = (config, details) => {
  fs.writeFileSync(config.marker, JSON.stringify({ pid: process.pid, ...details }))
  process.kill(process.pid, 'SIGKILL')
}
const rename = fs.renameSync
fs.renameSync = function (from, to) {
  const result = rename(from, to), config = fault()
  if (config.recordPath && resolve(String(to)) === resolve(config.recordPath)) {
    const record = JSON.parse(fs.readFileSync(to, 'utf8'))
    if (record.state === 'purge-started' && record.purge && config.stage === 'purge-started') kill(config, { stage: config.stage, state: record.state })
  }
  return result
}
const unlink = fs.unlinkSync
fs.unlinkSync = function (path) {
  const result = unlink(path), config = fault()
  if (config.stage === 'partial-unlink' && config.unlinkPath && resolve(String(path)) === resolve(config.unlinkPath)) kill(config, { stage: config.stage, removedPath: String(path) })
  return result
}
syncBuiltinESMExports()
globalThis.fetch = async () => { throw new Error('Lifecycle purge qualification disables provider catalog discovery') }
