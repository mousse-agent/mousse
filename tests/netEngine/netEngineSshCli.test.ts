/**
 * `mousse-cli net-engine ssh` (1b §3.3, §3.4): the marker comes first on stdout, then one JSON reply; with no
 * daemon running it answers `remote_not_running` and never starts one.
 */
import { PassThrough } from 'node:stream'
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
