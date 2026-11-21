/**
 * `scripts/net-engine-check.mjs`: the route cases the engine kit gives a check (`cases` in checks/phase1b.toml) are
 * each taken with `--route`, and a check with no cases takes none. Only the refusals are run here: a run that is
 * taken starts the check itself. Over tcp a run has two passes (tailnet, then public), and the reason the first
 * failed step of the run recorded is the one it reports.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
      expect(refused.stderr).toContain(`${id} runs over --route tcp|ws|ssh, not udp.`)
    }
  )

  it('runs phase1b.routes-cross as a cross-machine cell over one route', () => {
    const noRole = run('phase1b.routes-cross', '--route', 'tcp')
    expect(noRole.status).toBe(2)
    expect(noRole.stderr).toContain('phase1b.routes-cross is a cross-machine cell: give --role.')
    const noRoute = run('phase1b.routes-cross', '--role', 'host')
    expect(noRoute.status).toBe(2)
    expect(noRoute.stderr).toContain('phase1b.routes-cross runs over one route: give --route tcp|ws|ssh.')
  })

  it('refuses a route for a check the kit gives no cases', () => {
    const refused = run('phase1b.link-app', '--route', 'tcp')
    expect(refused.status).toBe(2)
    expect(refused.stderr).toContain('phase1b.link-app takes no --route.')
  })

  // Loading the harness loads the whole daemon: longer than a test's default wait beside other files.
  it('keeps the first reason a run recorded when a later pass records another', async () => {
    const out = mkdtempSync(join(tmpdir(), 'engine-check-out-'))
    const before = process.env.MOUSSE_NET_ENGINE_CHECK_OUT
    process.env.MOUSSE_NET_ENGINE_CHECK_OUT = out
    try {
      // The tailnet pass recorded its reason; the public pass, a new process, fails another step.
      writeFileSync(join(out, 'reason'), 'probe_reached_app')
      const { step } = await import('./checks/harness')
      await expect(
        step('route_mismatch', () => {
          throw new Error('a later step failed')
        })
      ).rejects.toThrow()
      expect(readFileSync(join(out, 'reason'), 'utf8')).toBe('probe_reached_app')
    } finally {
      if (before === undefined) delete process.env.MOUSSE_NET_ENGINE_CHECK_OUT
      else process.env.MOUSSE_NET_ENGINE_CHECK_OUT = before
      rmSync(out, { recursive: true, force: true })
    }
  }, 60_000)
})
