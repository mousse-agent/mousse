import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface FakeTailscale {
  /** Path to pass as the add-on's `binary` setting. */
  binary: string
  /** Every command line the fake was run with, in order. */
  commands(): string[][]
  /** `TCP` entries of the fake's Serve configuration, by tailnet port. */
  entries(): Record<string, unknown>
  /** Pretends someone configured a Serve entry on a port. */
  setEntry(port: number, entry: unknown): void
  clearEntries(): void
  /** The next `serve --bg` prints this to stderr and fails. */
  failServeWith(stderr: string): void
  /** `serve status --json` never answers. */
  hangServeStatus(): void
  /** `serve status --json` prints this text instead of its configuration. */
  setServeOutput(raw: string): void
  /** `serve status --json` prints far more than Mousse reads. */
  floodServeStatus(): void
  /** After a `serve --bg` has run, `serve status --json` fails. */
  failServeStatusAfterWrite(): void
  stopFailingServeStatus(): void
  /** The next `serve --bg` succeeds but leaves this entry on the port instead of its own. */
  replaceOnWrite(entry: unknown): void
  /** Funnel is on for `host:port`. */
  setFunnel(hostPort: string): void
  /** The tailnet that `status --json` reports. */
  setTailnet(name: string): void
  setVersion(version: string): void
  restore(): void
}

/**
 * A `tailscale` that is logged in as 127.0.0.1 on one tailnet and keeps Serve entries in a file. It knows only
 * `status`, `version`, `serve status --json`, `serve --bg --tcp=… tcp://…` and `serve --tcp=… off`;
 * anything else exits 2, so a test fails when the add-on runs a command it should not.
 * Windows cannot run a shebang file, so there a copy of node preloaded with the script stands in.
 */
export async function fakeTailscale(where: string): Promise<FakeTailscale> {
  const file = (name: string) => join(where, `fake-tailscale-${name}`)
  const state = file('serve.json'),
    log = file('commands.log'),
    failure = file('failure'),
    hang = file('hang'),
    raw = file('raw'),
    flood = file('flood'),
    failAfter = file('fail-after-write'),
    wrote = file('wrote'),
    replace = file('replace'),
    tailnet = file('tailnet'),
    version = file('version')
  writeFileSync(state, '{"TCP":{}}')
  const q = JSON.stringify
  const code = `
const fs = require('fs')
const argv = process.argv.slice(2)
const read = (path, fallback) => (fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : fallback)
fs.appendFileSync(${q(log)}, JSON.stringify(argv) + '\\n')
const serve = JSON.parse(read(${q(state)}, '{"TCP":{}}'))
const port = (argv.find((value) => value.startsWith('--tcp=')) || '').slice(6)
if (argv[0] === 'status') {
  console.log(
    JSON.stringify({
      BackendState: 'Running',
      CurrentTailnet: { Name: read(${q(tailnet)}, 'example.ts.net') },
      Self: { ID: 'node-1', TailscaleIPs: ['127.0.0.1'] }
    })
  )
} else if (argv[0] === 'version') {
  console.log(read(${q(version)}, '1.76.1') + '\\n  tailscale commit: fake')
} else if (argv[0] === 'serve' && argv[1] === 'status') {
  // Blocks until the caller's timeout kills this process.
  if (fs.existsSync(${q(hang)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000)
  if (fs.existsSync(${q(failAfter)}) && fs.existsSync(${q(wrote)})) { console.error('status failed'); process.exit(1) }
  if (fs.existsSync(${q(flood)})) console.log('x'.repeat(2 * 1024 * 1024))
  else if (fs.existsSync(${q(raw)})) console.log(fs.readFileSync(${q(raw)}, 'utf8'))
  else console.log(JSON.stringify(serve))
} else if (argv[0] === 'serve' && argv.includes('off')) {
  delete serve.TCP[port]
  fs.writeFileSync(${q(state)}, JSON.stringify(serve))
} else if (argv[0] === 'serve' && argv[1] === '--bg') {
  if (fs.existsSync(${q(failure)})) { console.error(fs.readFileSync(${q(failure)}, 'utf8')); process.exit(1) }
  serve.TCP[port] = fs.existsSync(${q(replace)})
    ? JSON.parse(fs.readFileSync(${q(replace)}, 'utf8'))
    : { TCPForward: argv[3].slice('tcp://'.length) }
  fs.writeFileSync(${q(state)}, JSON.stringify(serve))
  fs.writeFileSync(${q(wrote)}, '')
} else {
  console.error('unexpected: ' + argv.join(' '))
  process.exit(2)
}
process.exit(0)
`
  let binary: string,
    restore = () => {}
  if (process.platform === 'win32') {
    const script = join(where, 'fake-tailscale.js').replaceAll('\\', '/')
    // The copy sees `serve status --json` where node expects a script name, and has already made
    // the first word an absolute path. Put a name in front and take the word back out of the path.
    await writeFile(
      script,
      `process.argv.splice(1, 1, 'tailscale', require('path').basename(process.argv[1]))\n${code}`
    )
    binary = join(where, 'tailscale.exe')
    await copyFile(process.execPath, binary)
    const before = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = `--require "${script}"`
    restore = () => {
      if (before === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = before
    }
  } else {
    binary = join(where, 'tailscale')
    await writeFile(binary, `#!${process.execPath}\n${code}`, { mode: 0o700 })
  }
  const entries = () =>
    (JSON.parse(readFileSync(state, 'utf8')) as { TCP: Record<string, unknown> }).TCP
  const remove = (path: string) => rmSync(path, { force: true })
  return {
    binary,
    commands: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[])
        : [],
    entries,
    setEntry: (port, entry) =>
      writeFileSync(state, JSON.stringify({ TCP: { ...entries(), [String(port)]: entry } })),
    clearEntries: () => writeFileSync(state, '{"TCP":{}}'),
    failServeWith: (stderr) => writeFileSync(failure, stderr),
    hangServeStatus: () => writeFileSync(hang, ''),
    setServeOutput: (value) => writeFileSync(raw, value),
    floodServeStatus: () => writeFileSync(flood, ''),
    failServeStatusAfterWrite: () => writeFileSync(failAfter, ''),
    stopFailingServeStatus: () => remove(failAfter),
    replaceOnWrite: (entry) => writeFileSync(replace, JSON.stringify(entry)),
    setFunnel: (hostPort) => {
      const current = JSON.parse(readFileSync(state, 'utf8')) as Record<string, unknown>
      writeFileSync(state, JSON.stringify({ ...current, AllowFunnel: { [hostPort]: true } }))
    },
    setTailnet: (name) => writeFileSync(tailnet, name),
    setVersion: (value) => writeFileSync(version, value),
    restore
  }
}
