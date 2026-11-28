/**
 * `mousse-cli net-engine ssh` (1b §3.3, §3.4): the marker comes first on stdout, then one JSON reply; with no
 * daemon running it answers `remote_not_running` and never starts one.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runNetEngineSsh, SSH_MARKER } from '../../src/cli/commands/netEngineSsh'

async function run(input: string, serve: (request: unknown) => Promise<Record<string, unknown> | undefined>) {
  const stdin = new PassThrough()
  let out = ''
  const done = runNetEngineSsh({ stdin, stdout: { write: (text: string) => (out += text) }, serve })
  stdin.end(input)
  await done
  return out
}

describe('mousse-cli net-engine ssh', () => {
  it('writes the marker, then the daemon reply to the request read from stdin', async () => {
    const asked: unknown[] = []
    const out = await run('{"op":"profiles"}\n', async (request) => {
      asked.push(request)
      return { computer: 'B', profiles: [] }
    })
    expect(out).toBe(`${SSH_MARKER}\n{"computer":"B","profiles":[]}\n`)
    expect(asked).toEqual([{ op: 'profiles' }])
  })

  it('answers remote_not_running with no daemon, and bad_request for what is not JSON', async () => {
    expect(await run('{"op":"profiles"}\n', async () => undefined)).toBe(`${SSH_MARKER}\n{"error":"remote_not_running"}\n`)
    expect(await run('not json\n', async () => ({}))).toBe(`${SSH_MARKER}\n{"error":"bad_request"}\n`)
  })
})

/**
 * On Windows the app's own `--cli` mode reads an empty stdin, so the packaged `mousse-cli.cmd` runs `net-engine ssh`
 * on the app's runtime as plain Node (`ELECTRON_RUN_AS_NODE`) on `out\cli\index.js`. The real launcher, in a folder
 * with a space and an ampersand; Node stands in for `mousse-cli.exe` and a folder for `app.asar`, whose `index.js`
 * reports how it was started and the stdin it read.
 */
describe.skipIf(process.platform !== 'win32')('the packaged mousse-cli.cmd on Windows', () => {
  it('runs net-engine ssh as plain Node, so the request on stdin arrives; other commands keep --cli', () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse cli cmd '))
    try {
      const app = join(root, 'Program Files & Co', 'Mousse')
      const cli = join(app, 'resources', 'app.asar', 'out', 'cli')
      mkdirSync(cli, { recursive: true })
      writeFileSync(
        join(cli, 'index.js'),
        "let input = ''; process.stdin.on('data', (c) => (input += c)); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ node: process.env.ELECTRON_RUN_AS_NODE ?? null, args: process.argv.slice(2), input })); process.exit(5) })"
      )
      copyFileSync(process.execPath, join(app, 'mousse-cli.exe'))
      const launcher = join(app, 'mousse-cli.cmd')
      copyFileSync(fileURLToPath(new URL('../../resources/cli/mousse-cli.cmd', import.meta.url)), launcher)
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const run = (args: string) =>
        spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${launcher}" ${args}"`], {
          windowsVerbatimArguments: true,
          env,
          input: '{"op":"profiles"}\n',
          encoding: 'utf8'
        })
      const ssh = run('net-engine ssh')
      expect(ssh.status, ssh.stderr).toBe(5)
      expect(JSON.parse(ssh.stdout)).toEqual({ node: '1', args: ['net-engine', 'ssh'], input: '{"op":"profiles"}\n' })
      // Anything else goes to the app's --cli mode (which Node refuses here).
      for (const args of ['net-engine ssh status', 'net-engine status']) {
        const other = run(args)
        expect(other.status).not.toBe(5)
        expect(other.stderr).toContain('--cli')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
