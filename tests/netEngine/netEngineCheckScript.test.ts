/**
 * `scripts/net-engine-check.mjs`: the route cases the engine kit gives a check (`cases` in checks/phase1b.toml) are
 * each taken with `--route`, and a check with no cases takes none. Only the refusals are run here: a run that is
 * taken starts the check itself.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = join(__dirname, '..', '..', 'scripts', 'net-engine-check.mjs')
const run = (...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30_000 })

describe('net-engine-check.mjs route cases', () => {
  it.each(['phase1b.routes-app', 'phase1b.no-rpc-without-grant'])(
    '%s takes the kit’s tcp, ws and ssh cases, and only those',
    (id) => {
      const refused = run(id, '--route', 'udp')
      expect(refused.status).toBe(2)
      expect(refused.stderr).toContain(`${id} runs over one route: give --route tcp|ws|ssh.`)
    }
  )

  it('refuses a route for a check the kit gives no cases', () => {
    const refused = run('phase1b.link-app', '--route', 'tcp')
    expect(refused.status).toBe(2)
    expect(refused.stderr).toContain('phase1b.link-app takes no --route.')
  })
})
