import { spawnSync } from 'node:child_process'

/** Node has no portable openat. A short-lived child pins the checked directory as its cwd;
 * every create/unlink is relative to that kernel-held directory, never the bot's mutable path.
 * It runs fixed daemon code, receives only masked bytes on stdin, and returns only an exit status.
 */
const SAVE = String.raw`
const fs = require('node:fs')
const same = (a, b) => a.dev === b.dev && a.ino === b.ino
const [folder, dev, ino, name, ...prune] = process.argv.slice(1)
const checked = { dev: Number(dev), ino: Number(ino) }
let fd, identity, wrote = false, unsafe = false
const current = () => {
  const atPath = fs.lstatSync(folder)
  return atPath.isDirectory() && !atPath.isSymbolicLink()
    && same(fs.statSync('.'), checked) && same(atPath, checked)
}
try {
  if (![name, ...prune].every(value => /^[0-9a-f-]{36}$/.test(value)) || !current()) {
    unsafe = true
    throw new Error()
  }
  fd = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600)
  identity = fs.fstatSync(fd)
  if (!identity.isFile() || !same(identity, fs.lstatSync(name)) || !current()) {
    unsafe = true
    throw new Error()
  }
  // The open fd and the pinned cwd have both been checked before the first byte.
  fs.writeFileSync(fd, fs.readFileSync(0))
  for (const previous of prune) {
    if (!current()) { unsafe = true; throw new Error() }
    try { fs.unlinkSync(previous) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  wrote = true
} catch {
  process.exitCode = unsafe ? 2 : 1
} finally {
  if (fd !== undefined) {
    fs.closeSync(fd)
    if (!wrote) {
      try {
        const entry = fs.lstatSync(name)
        if (entry.isFile() && same(entry, identity)) fs.unlinkSync(name)
      } catch {}
    }
  }
}
`

export function saveSecretFetchAtCwd(input: {
  folder: string
  dev: number
  ino: number
  name: string
  prune: readonly string[]
  bytes: Buffer
}): 'saved' | 'unsafe' | 'failed' {
  const result = spawnSync(process.execPath, ['-e', SAVE, input.folder, String(input.dev), String(input.ino), input.name, ...input.prune], {
    cwd: input.folder,
    input: input.bytes,
    // No NODE_OPTIONS, owner credentials or inherited startup scripts reach this helper.
    env: { ELECTRON_RUN_AS_NODE: '1', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    timeout: 30_000,
    maxBuffer: 1024,
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore']
  })
  return result.status === 0 ? 'saved' : result.status === 2 ? 'unsafe' : 'failed'
}
