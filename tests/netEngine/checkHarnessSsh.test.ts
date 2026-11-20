/**
 * The owner checks' SSH test server in a real-helper run (`Fabric.sshHost`): over SSH the remote's `/bin/sh` runs
 * `<HOME>/.mousse/bin/mousse-cli`, a launcher the app writes in its Mousse home, so the server's session HOME must
 * hold that Mousse home as its `.mousse`. The kit's `startSshRoute` is replaced by a module that keeps what it was
 * given.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Fabric } from './checks/harness'

describe('the checks’ SSH test server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-ssh-routes-'))
  const saved = { ...process.env }
  const fabric = new Fabric()
  afterAll(async () => {
    await fabric.close()
    process.env = saved
    rmSync(dir, { recursive: true, force: true })
  }, 60_000)

  it('runs its sessions with a HOME whose .mousse is the computer’s Mousse home', async () => {
    const options = join(dir, 'options.json')
    const config = join(dir, 'ssh_config')
    writeFileSync(config, 'Host mousse-test-sshd\n  HostName 127.0.0.1\n')
    const routes = join(dir, 'ssh-routes.mjs')
    writeFileSync(
      routes,
      `import { writeFileSync } from 'node:fs'
export async function startSshRoute(options) {
  writeFileSync(${JSON.stringify(options)}, JSON.stringify(options))
  return { config: ${JSON.stringify(config)}, stop: async () => undefined }
}
`
    )
    process.env.MOUSSE_CHECK_SSH_ROUTES = routes
    process.env.MOUSSE_CHECK_TEST_SSHD = join(dir, 'test-sshd')
    process.env.MOUSSE_NET_HELPER ||= join(dir, 'mousse-helper')
    const b = await fabric.computer('b')
    await (
      fabric as unknown as { sshHost(alias: string, mms: unknown, home: string): Promise<unknown> }
    ).sshHost('b.test', b.mms, b.home)
    const given = JSON.parse(readFileSync(options, 'utf8')) as { home?: string; mousseHome: string }
    expect(given.mousseHome).toBe(b.home)
    expect(given.home).toBeTruthy()
    expect(realpathSync(join(given.home!, '.mousse'))).toBe(realpathSync(b.home))
  }, 60_000)
})
