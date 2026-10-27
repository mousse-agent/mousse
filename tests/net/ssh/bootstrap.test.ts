import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NodeId } from '../../../src/shared/net'
import { sshApprovalsPath } from '../../../src/mms/net/transports/ssh'
import { SshBootstrap, validDeviceName } from '../../../src/mms/net/ssh/bootstrap'
import { bed, fingerprint, hashedLine, KEY_A, KEY_B, KEY_RSA, type Bed } from './bed'

const fixtures = vi.hoisted(() => ({ binaries: new Set<string>() }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: ((...input: unknown[]) => {
      if (process.platform === 'win32' && fixtures.binaries.has(input[0] as string))
        return Reflect.apply(actual.spawn, undefined, [
          process.execPath,
          [input[0], ...(input[1] as string[])],
          ...input.slice(2)
        ])
      return Reflect.apply(actual.spawn, undefined, input)
    }) as typeof actual.spawn
  }
})

const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  fixtures.binaries.clear()
})
const make = (overrides = {}, config?: string[]) =>
  bed(cleanup, fixtures.binaries, overrides, config)

/** Runs a setup to the end and returns its final status. */
async function finish(ssh: SshBootstrap, id: string, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await ssh.status(id)
    if (status.phase !== 'running') return status
    if (Date.now() > deadline) throw new Error(`setup did not finish: ${JSON.stringify(status)}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
async function probed(b: Bed, options = {}) {
  const ssh = b.make(options)
  const first = await ssh.check('box')
  expect(first.phase).toBe('untrusted')
  expect((await ssh.trust({ host: 'box', fingerprint: first.hostKey!.fingerprint })).ok).toBe(true)
  const check = await ssh.check('box')
  expect(check.phase).toBe('probed')
  return { ssh, check }
}
const approvals = async (b: Bed) =>
  JSON.parse(await readFile(sshApprovalsPath(b.profileDir), 'utf8')) as Record<string, any>
const runs = async (b: Bed) => (await b.calls()).filter((call) => call.kind === 'run')

describe('host checks: phase 1 never authenticates or runs a command', () => {
  it('rejects option-like and backslash hosts before any spawn', async () => {
    const b = await make()
    const ssh = b.make()
    for (const host of ['-oProxyCommand=touch x', 'a b', 'host\\name', '--help', 'a/b']) {
      const result = await ssh.check(host)
      expect(result.problem).toBe('invalid_host')
    }
    expect(await b.calls()).toEqual([])
    expect(await b.configChecks()).toEqual([])
  })

  it('shows an unknown host key with its fingerprint and changes nothing', async () => {
    const b = await make()
    const result = await b.make().check('box')
    expect(result).toMatchObject({
      ok: false,
      phase: 'untrusted',
      hostKey: { state: 'unknown', type: KEY_A.type, fingerprint: fingerprint(KEY_A) }
    })
    const calls = await b.calls()
    // Only `ssh -G` and the key retrieval ran: no command, no forwarding probe.
    expect(calls.map((call) => call.kind)).toEqual(['retrieve'])
    expect(await b.configChecks()).toHaveLength(1)
    expect(existsSync(b.mousseKnownHosts)).toBe(false)
    const args: string[] = calls[0].args
    for (const option of [
      'StrictHostKeyChecking=accept-new',
      'GlobalKnownHostsFile=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      'HashKnownHosts=no',
      'CheckHostIP=no',
      'UpdateHostKeys=no',
      'PubkeyAuthentication=no',
      'PasswordAuthentication=no',
      'KbdInteractiveAuthentication=no',
      'GSSAPIAuthentication=no',
      'HostbasedAuthentication=no',
      'BatchMode=yes'
    ])
      expect(args).toContain(option)
    expect(args).toContain('-N')
    expect(args.slice(-2)).toEqual(['--', 'box'])
  })

  it('refuses a ProxyJump alias with a clear message and spawns nothing that connects', async () => {
    const b = await make({}, [
      'hostname box.example.com',
      'port 22',
      'user me',
      'proxyjump bastion'
    ])
    const result = await b.make().check('box')
    expect(result).toMatchObject({ ok: false, problem: 'proxy_refused' })
    expect(result.detail).toMatch(/ProxyJump/)
    expect(await b.calls()).toEqual([])
  })

  it('splits user@host:port the way the dial does and reads the key as [host]:port', async () => {
    const b = await make({}, [
      'hostname box.example.com',
      'port 2222',
      'user deploy',
      'globalknownhostsfile /none'
    ])
    const result = await b.make().check('deploy@box.example.com:2222')
    expect(result.resolved).toEqual({ hostname: 'box.example.com', port: 2222, user: 'deploy' })
    const [call] = await b.calls()
    expect(call.args).toEqual(expect.arrayContaining(['-l', 'deploy', '-p', '2222']))
    expect(call.args.slice(-2)).toEqual(['--', 'box.example.com'])
    const ssh = b.make()
    await ssh.check('deploy@box.example.com:2222')
    const trusted = await ssh.trust({
      host: 'deploy@box.example.com:2222',
      fingerprint: fingerprint(KEY_A)
    })
    expect(trusted.ok).toBe(true)
    expect(await readFile(b.mousseKnownHosts, 'utf8')).toBe(
      `[box.example.com]:2222 ${KEY_A.type} ${KEY_A.key}\n`
    )
  })

  it('finds a key in a hashed known_hosts file as trusted, and trust still writes the Mousse line', async () => {
    const b = await make()
    await writeFile(b.userKnownHosts, hashedLine('box', KEY_A) + '\n')
    const ssh = b.make()
    const result = await ssh.check('box')
    expect(result.phase).toBe('probed')
    expect(result.hostKey?.state).toBe('trusted')
    const trusted = await ssh.trust({ host: 'box', fingerprint: fingerprint(KEY_A) })
    expect(trusted.ok).toBe(true)
    expect(await readFile(b.mousseKnownHosts, 'utf8')).toContain(`box ${KEY_A.type} ${KEY_A.key}`)
  })

  it('reports a host known only by another key type', async () => {
    const b = await make()
    await writeFile(b.userKnownHosts, `box ${KEY_RSA.type} ${KEY_RSA.key}\n`)
    const result = await b.make().check('box')
    expect(result.hostKey).toMatchObject({ state: 'unknown', knownByOtherTypes: ['ssh-rsa'] })
  })

  it('refuses a revoked key outright', async () => {
    const b = await make()
    await writeFile(b.userKnownHosts, `@revoked box ${KEY_A.type} ${KEY_A.key}\n`)
    const ssh = b.make()
    const result = await ssh.check('box')
    expect(result).toMatchObject({ ok: false, problem: 'host_key_revoked' })
    expect(await ssh.trust({ host: 'box', fingerprint: fingerprint(KEY_A) })).toMatchObject({
      ok: false,
      state: 'revoked'
    })
    expect(existsSync(b.mousseKnownHosts)).toBe(false)
  })

  it('writes a trusted key only when the fingerprint matches the daemon’s own copy', async () => {
    const b = await make()
    const ssh = b.make()
    await ssh.check('box')
    const wrong = await ssh.trust({ host: 'box', fingerprint: fingerprint(KEY_B) })
    expect(wrong.ok).toBe(false)
    expect(existsSync(b.mousseKnownHosts)).toBe(false)
    // A host that was never checked has no key to write.
    expect((await ssh.trust({ host: 'other', fingerprint: fingerprint(KEY_A) })).ok).toBe(false)
    const ok = await ssh.trust({ host: 'box', fingerprint: fingerprint(KEY_A) })
    expect(ok.ok).toBe(true)
    if (process.platform !== 'win32')
      expect((await stat(b.mousseKnownHosts)).mode & 0o777).toBe(0o600)
    // Trusting again writes no second line.
    await ssh.trust({ host: 'box', fingerprint: fingerprint(KEY_A) })
    expect((await readFile(b.mousseKnownHosts, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('a changed key needs an acknowledgement, replaces only the Mousse line, and the rotation terminates', async () => {
    const b = await make()
    const original = `box ${KEY_B.type} ${KEY_B.key}\nother ${KEY_RSA.type} ${KEY_RSA.key}\n`
    await writeFile(b.userKnownHosts, original)
    const ssh = b.make()
    const first = await ssh.check('box')
    expect(first.phase).toBe('untrusted')
    expect(first.hostKey).toMatchObject({
      state: 'changed',
      changed: { previousFingerprint: fingerprint(KEY_B), file: b.userKnownHosts }
    })
    expect((await ssh.trust({ host: 'box', fingerprint: fingerprint(KEY_A) })).ok).toBe(false)
    expect(existsSync(b.mousseKnownHosts)).toBe(false)
    expect(
      (await ssh.trust({ host: 'box', fingerprint: fingerprint(KEY_A), acknowledgeChanged: true }))
        .ok
    ).toBe(true)
    // The user's file is untouched; the next check finds the Mousse line and probes.
    expect(await readFile(b.userKnownHosts, 'utf8')).toBe(original)
    const next = await ssh.check('box')
    expect(next.phase).toBe('probed')
    expect(next.hostKey).toMatchObject({
      state: 'trusted',
      stale: [{ file: b.userKnownHosts, previousFingerprint: fingerprint(KEY_B) }]
    })
    // A later rotation prompts again, and only the same-type Mousse line is replaced.
    await writeFile(
      b.mousseKnownHosts,
      (await readFile(b.mousseKnownHosts, 'utf8')) + `box ${KEY_RSA.type} ${KEY_RSA.key}\n`
    )
    await b.patch({ hostKey: KEY_B })
    await writeFile(b.userKnownHosts, original.replace(KEY_B.key, KEY_A.key))
    const again = await ssh.check('box')
    expect(again.hostKey?.state).toBe('changed')
    expect(again.hostKey?.changed?.file).toBe(b.mousseKnownHosts)
    await ssh.trust({ host: 'box', fingerprint: fingerprint(KEY_B), acknowledgeChanged: true })
    const lines = (await readFile(b.mousseKnownHosts, 'utf8')).trim().split('\n')
    expect(lines).toEqual(
      expect.arrayContaining([
        `box ${KEY_RSA.type} ${KEY_RSA.key}`,
        `box ${KEY_B.type} ${KEY_B.key}`
      ])
    )
    expect(lines).toHaveLength(2)
    expect(existsSync(b.mousseKnownHosts + '.old')).toBe(false)
  })
})

describe('phase 2: the probe runs only after the key is trusted', () => {
  it('uses the permanent strict options and never the retrieval file', async () => {
    const b = await make()
    const { check } = await probed(b)
    expect(check).toMatchObject({
      ok: true,
      auth: 'ok',
      os: 'Linux',
      arch: 'x86_64',
      installed: { cli: { owner: 'none' }, service: { owner: 'none' } }
    })
    const calls = await b.calls()
    const run = calls.find((call) => call.kind === 'run')!
    expect(run.args).toEqual(
      expect.arrayContaining([
        'StrictHostKeyChecking=yes',
        'BatchMode=yes',
        'ControlMaster=no',
        'ForwardAgent=no'
      ])
    )
    expect(run.args).not.toContain('StrictHostKeyChecking=accept-new')
    expect(run.args.join(' ')).not.toContain('hostkey-')
    const retrieveIndex = calls.findIndex((call) => call.kind === 'retrieve')
    const firstRun = calls.findIndex((call) => call.kind === 'run')
    expect(retrieveIndex).toBeLessThan(firstRun)
  })

  it('turns the two real forwarding failures into a failed prerequisite and a pass', async () => {
    const refused = await make()
    const ok = await probed(refused)
    expect(ok.check.prerequisites.find((item) => /TCP forwarding/.test(item.name))).toMatchObject({
      ok: true
    })
    const prohibited = await make({ forward: 'prohibited' })
    const bad = await probed(prohibited)
    expect(bad.check.prerequisites.find((item) => /TCP forwarding/.test(item.name))).toMatchObject({
      ok: false
    })
    expect(bad.check.ok).toBe(false)
  })

  it('returns the ssh-copy-id command for a denied key and runs nothing else', async () => {
    const b = await make({ auth: 'denied' })
    const ssh = b.make()
    const first = await ssh.check('box')
    await ssh.trust({ host: 'box', fingerprint: first.hostKey!.fingerprint })
    const result = await ssh.check('box')
    expect(result).toMatchObject({
      ok: false,
      auth: 'denied',
      copyId: 'ssh-copy-id me@box.example.com'
    })
    expect(await runs(b)).toHaveLength(0)
  })

  it('reports a daemon with no key or agent', async () => {
    const b = await make()
    const ssh = b.make({ sshDirectory: join(b.dir, 'empty') })
    const first = await ssh.check('box')
    await ssh.trust({ host: 'box', fingerprint: first.hostKey!.fingerprint })
    const result = await ssh.check('box')
    expect(result.prerequisites.find((item) => /key or agent/.test(item.name))).toMatchObject({
      ok: false
    })
  })
})

describe('plan', () => {
  it('lists every change and runs nothing', async () => {
    const b = await make()
    const { ssh } = await probed(b)
    const before = (await b.calls()).length
    const plan = ssh.plan({ host: 'box', name: 'Build box' })
    expect(plan.blocked).toBeUndefined()
    expect(plan.steps.map((step) => step.id)).toEqual([
      'install',
      'service',
      'linger',
      'join',
      'addon',
      'approval',
      'undo'
    ])
    expect((await b.calls()).length).toBe(before)
  })

  it('blocks on a missing checksum tool, an enrolled host and a stopped external service', async () => {
    const noSum = await probed(await make({ tools: ['curl', 'systemctl'] }))
    expect(noSum.ssh.plan({ host: 'box', name: 'x' }).blocked?.map((item) => item.name)).toContain(
      'sha256sum or shasum'
    )
    const enrolled = await probed(
      await make({
        externalCli: '/opt/m/mousse-cli',
        serviceInstalled: true,
        running: true,
        enrolled: true,
        node: 'nod_x'
      })
    )
    expect(enrolled.ssh.plan({ host: 'box', name: 'x' }).blocked?.[0]?.name).toMatch(
      /already part/i
    )
    const stopped = await probed(
      await make({ externalCli: '/opt/m/mousse-cli', serviceInstalled: true, running: false })
    )
    const blocked = stopped.ssh.plan({ host: 'box', name: 'x' }).blocked!
    expect(blocked[0]!.remedy).toContain('systemctl --user start mousse-mms')
  })

  it('an external running daemon yields no install or service step', async () => {
    const { ssh } = await probed(
      await make({ externalCli: '/opt/m/mousse-cli', serviceInstalled: true, running: true })
    )
    expect(ssh.plan({ host: 'box', name: 'x' }).steps.map((step) => step.id)).toEqual([
      'join',
      'addon',
      'approval',
      'undo'
    ])
  })
})

describe('setup', () => {
  it('runs the steps in order through the absolute launcher and writes the approval itself', async () => {
    const b = await make()
    // The invitation id is on disk before the fake ssh receives the invitation text.
    let manifestInviteId: string | undefined
    b.stub.onListener = async () => {
      const dirName = join(b.profileDir, 'net', 'ssh')
      const { readdir } = await import('node:fs/promises')
      const [file] = (await readdir(dirName)).filter(
        (name) => name.endsWith('.json') && name !== 'approvals.json'
      )
      manifestInviteId = JSON.parse(await readFile(join(dirName, file!), 'utf8')).inviteId
    }
    const { ssh } = await probed(b)
    const name = "it's; $(touch pwned) `id` here"
    const begun = await ssh.begin({ host: 'box', name })
    expect(begun.id).toBeTruthy()
    const status = await finish(ssh, begun.id!)
    expect(status, status.error).toMatchObject({ phase: 'done', recoverable: false })
    expect(manifestInviteId).toBe(b.stub.invites[0]!.id)

    const steps = await runs(b)
    const order = steps.map((call) => call.step)
    expect(order.filter((step) => !['probe', 'service-status'].includes(step))).toEqual([
      'install-fetch',
      'install-verify',
      'install-launcher',
      'service-install',
      'linger-enable',
      'join',
      'transports',
      'addon-configure',
      'routes'
    ])
    expect(order).not.toContain('service-start')
    // `net init` never runs: it would make the host its own authority.
    expect(
      steps.some((call) => call.script.includes('net init') || call.cli.includes('init'))
    ).toBe(false)
    const host = await b.host()
    expect(host.launcher).toContain('ELECTRON_DISABLE_SANDBOX=1')
    expect(host.launcher).toMatch(/^# mousse-managed ssh_/m)
    expect(host.serviceInstalled).toBe(true)
    // The invitation is on stdin: not in any argv, and no invite file.
    const joinCall = steps.find((call) => call.step === 'join')!
    expect(joinCall.args.join(' ')).not.toContain('mj1_')
    expect(joinCall.script).not.toContain('invite-file')
    expect(joinCall.cli).toEqual(expect.arrayContaining(['bridge', 'join', '--name', name]))
    expect(joinCall.args).toContain('ExitOnForwardFailure=yes')
    expect(joinCall.args).not.toContain('ClearAllForwardings=yes')
    expect(host.joinedAs).toBe(name)
    expect(String(host.joinedVia)).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/mousse-net$/)
    // The ssh add-on settings go through a private temporary file.
    expect(host.settingsViaFile).toBe(true)
    expect(host.transports).toEqual([
      { id: 'ssh', enabled: true, settings: { endpoint: 'box', port: expect.any(Number) } }
    ])
    // The approval is written by this computer, with the fingerprint, and the host's routes adopted.
    expect((await approvals(b))[host.node as string]).toMatchObject({
      endpoint: 'box',
      fingerprint: fingerprint(KEY_A)
    })
    expect(b.stub.adopted).toEqual([host.node])
    // The enrollment listener was closed and nothing else was opened.
    expect(b.stub.listeners).toBe(1)
    expect(b.stub.closed).toBe(1)
    // Every remote script was one `exec /bin/sh -c` word with no backslash.
    for (const call of steps) {
      const command = call.args[call.args.length - 1] as string
      expect(command.startsWith('exec /bin/sh -c ')).toBe(true)
      expect(command).not.toContain('\\')
    }
  })

  it('rejects a name with a backslash or a control character before any spawn', async () => {
    const b = await make()
    const { ssh } = await probed(b)
    const before = (await b.calls()).length
    for (const name of ['a\\b', 'line\nbreak', ' padded', '']) {
      expect(validDeviceName(name)).toBe(false)
      expect((await ssh.begin({ host: 'box', name })).error).toBeTruthy()
    }
    expect((await b.calls()).length).toBe(before)
  })

  it('aborts on a checksum mismatch before the service is installed', async () => {
    const b = await make({ badChecksum: true })
    const { ssh } = await probed(b)
    const { id } = await ssh.begin({ host: 'box', name: 'x' })
    const status = await finish(ssh, id!)
    expect(status.phase).toBe('failed')
    expect(status.recoverable).toBe(true)
    expect(await b.steps()).not.toContain('service-install')
  })

  it('sends the file over ssh when the host cannot reach GitHub, after checking it here', async () => {
    const bytes = 'appimage-bytes'
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const b = await make({ noGithub: true })
    const { ssh } = await probed(b, {
      fetch: (async (url: string) =>
        String(url).endsWith('.txt')
          ? new Response(`${hash}  mousse-cli-0.1.2-linux-x86_64.AppImage\n`)
          : new Response(bytes)) as unknown as typeof fetch
    })
    const { id } = await ssh.begin({ host: 'box', name: 'x' })
    expect((await finish(ssh, id!)).phase).toBe('done')
    const order = await b.steps()
    expect(order).toEqual(
      expect.arrayContaining(['install-fetch', 'install-upload', 'install-verify'])
    )
    expect((await b.host()).uploadedBytes).toBe(bytes.length)
  })

  it('a refused linger is skipped with the command to run, and setup still completes', async () => {
    const b = await make({ lingerFails: true })
    const { ssh } = await probed(b)
    const { id } = await ssh.begin({ host: 'box', name: 'x' })
    const status = await finish(ssh, id!)
    expect(status.phase).toBe('done')
    expect(status.lingerCommand).toBe('sudo loginctl enable-linger me')
    expect(status.steps.find((step) => step.step === 'linger')?.state).toBe('skipped')
  })

  it('cancel kills the active command and runs no further step', async () => {
    const b = await make({ hangOn: 'service-install' })
    const { ssh } = await probed(b)
    const { id } = await ssh.begin({ host: 'box', name: 'x' })
    for (let i = 0; i < 400 && !(await b.steps()).includes('service-install'); i++)
      await new Promise((resolve) => setTimeout(resolve, 25))
    const status = await ssh.cancel(id!)
    expect(status.phase).toBe('cancelled')
    expect(status.recoverable).toBe(true)
    expect(status.steps.find((step) => step.step === 'service')?.state).toBe('unknown')
    expect(await b.steps()).not.toContain('join')
  })

  it('an external running daemon gets only join, add-on and approval; undo restores its previous ssh settings', async () => {
    const before = { id: 'ssh', enabled: true, settings: { endpoint: 'old', port: 41000 } }
    const b = await make({
      externalCli: '/opt/m/mousse-cli',
      serviceInstalled: true,
      running: true,
      transports: [before]
    })
    const { ssh } = await probed(b)
    const { id } = await ssh.begin({ host: 'box', name: 'x' })
    expect((await finish(ssh, id!)).phase).toBe('done')
    const order = (await b.steps()).filter((step) => step !== 'probe')
    expect(order).not.toContain('install-fetch')
    expect(order).not.toContain('service-install')
    expect(order).not.toContain('service-uninstall')
    const undone = await ssh.undo(id!)
    expect(undone.ok).toBe(true)
    expect((await b.host()).transports).toEqual([before])
    // Mousse did not install it, so it is never stopped or uninstalled.
    expect(await b.steps()).not.toContain('service-uninstall')
    expect((await b.host()).serviceInstalled).toBe(true)
  })
})

describe('undo', () => {
  it('reverses what setup journaled, revokes the node, and leaves a rewritten launcher alone', async () => {
    const b = await make()
    const { ssh } = await probed(b)
    const { id } = await ssh.begin({ host: 'box', name: 'x' })
    await finish(ssh, id!)
    const node = (await b.host()).node as NodeId
    const result = await ssh.undo(id!)
    expect(result.ok).toBe(true)
    expect(result.report.map((item) => item.result)).not.toContain('left')
    expect(result.commands.join('\n')).toContain('rm -rf ~/.mousse')
    const host = await b.host()
    expect(host.launcher).toBeUndefined()
    expect(host.serviceInstalled).toBe(false)
    expect(host.removedInstall).toBe(true)
    expect(host.transports).toEqual([{ id: 'ssh', enabled: false, settings: expect.any(Object) }])
    expect(b.stub.revokedNodes).toEqual([node])
    expect(await approvals(b)).toEqual({})
    expect((await ssh.list()).records).toEqual([])
    // No other record uses the host name, so its known_hosts line is dropped.
    expect(await readFile(b.mousseKnownHosts, 'utf8')).toBe('')
  })

  it('reports a launcher the user changed and keeps the record', async () => {
    const b = await make()
    const { ssh } = await probed(b)
    const { id } = await ssh.begin({ host: 'box', name: 'x' })
    await finish(ssh, id!)
    await b.patch({ launcher: '#!/bin/sh\nexport ELECTRON_DISABLE_SANDBOX=1\necho mine\n' })
    const result = await ssh.undo(id!)
    expect(result.ok).toBe(false)
    expect(result.report.find((item) => item.result === 'left')?.detail).toMatch(
      /launcher was changed/
    )
    expect((await b.host()).launcher).toContain('mine')
    expect((await ssh.list()).records).toHaveLength(1)
  })

  it('keeps the known_hosts line while another record shares the host name', async () => {
    const b = await make()
    const { ssh } = await probed(b)
    const first = await ssh.begin({ host: 'box', name: 'one' })
    await finish(ssh, first.id!)
    await b.patch({
      enrolled: false,
      serviceInstalled: false,
      running: false,
      launcher: undefined,
      extracted: false,
      transports: []
    })
    const check = await ssh.check('box')
    expect(check.phase).toBe('probed')
    const second = await ssh.begin({ host: 'box', name: 'two' })
    expect(second.id).toBeTruthy()
    await finish(ssh, second.id!)
    await ssh.undo(first.id!)
    expect(await readFile(b.mousseKnownHosts, 'utf8')).toContain('box ')
  })
})

/** Waits until the machine has seen no new call for a moment. */
async function settle(b: Bed) {
  let last = -1,
    stable = 0
  for (let i = 0; i < 200 && stable < 4; i++) {
    const count = (await b.calls()).length
    stable = count === last ? stable + 1 : 0
    last = count
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
}

describe('crashes and retries are recoverable from the journal', () => {
  /** A bootstrap whose `fault` hook throws once at `point`: the process "dies" there. */
  async function crashAt(point: string, overrides = {}) {
    const b = await make(overrides)
    let armed = true
    const first = b.make({
      fault: (name) => {
        if (armed && name === point) {
          armed = false
          throw new Error('crash')
        }
      }
    })
    const check = await first.check('box')
    await first.trust({ host: 'box', fingerprint: check.hostKey!.fingerprint })
    await first.check('box')
    const { id } = await first.begin({ host: 'box', name: 'x' })
    // A crash leaves the manifest `running` on disk and writes nothing more.
    await settle(b)
    const text = JSON.parse(await readFile(join(b.profileDir, 'net', 'ssh', `${id}.json`), 'utf8'))
    return { b, id: id!, text }
  }

  it('install: a crash after the remote change leaves a pending step that retry reconciles without downloading again', async () => {
    const { b, id, text } = await crashAt('install.afterEffect')
    expect(text.phase).toBe('running')
    expect(text.steps.find((step: any) => step.step === 'install')).toMatchObject({
      state: 'pending',
      resource: expect.stringContaining('.local/bin/mousse-cli')
    })
    const ssh = b.make()
    await ssh.start()
    expect((await ssh.status(id)).phase).toBe('interrupted')
    await ssh.check('box')
    const fetchesBefore = (await b.steps()).filter((step) => step === 'install-fetch').length
    await ssh.retry(id)
    expect((await finish(ssh, id)).phase).toBe('done')
    expect((await b.steps()).filter((step) => step === 'install-fetch').length).toBe(fetchesBefore)
  })

  it('join: retry recovers the admitted node by invite id and issues no second invitation', async () => {
    const { b, id } = await crashAt('join.afterEffect')
    expect(b.stub.invites).toHaveLength(1)
    // Another device with the same display name must not be mistaken for the one this invite admitted.
    const ssh = b.make()
    await ssh.start()
    await ssh.retry(id)
    expect((await finish(ssh, id)).phase).toBe('done')
    expect(b.stub.invites).toHaveLength(1)
    expect((await ssh.status(id)).node).toBe((await b.host()).node)
    const undone = await ssh.undo(id)
    expect(undone.ok).toBe(true)
    expect(b.stub.revokedNodes).toEqual([(await b.host()).node])
  })

  it('a lost join reply is recognised from the invitation row', async () => {
    const b = await make({ dropJoinReply: true })
    const { ssh } = await probed(b)
    const { id } = await ssh.begin({ host: 'box', name: 'x' })
    expect((await finish(ssh, id!)).phase).toBe('done')
    expect(b.stub.invites).toHaveLength(1)
    expect((await ssh.status(id!)).node).toBe((await b.host()).node)
  })

  it('a consumed row that disagrees with the host stays interrupted and revokes nothing', async () => {
    const b = await make({ dropJoinReply: true })
    const { ssh } = await probed(b)
    const stranger = ('nod_' + 'z'.repeat(26)) as NodeId
    const original = b.stub.host.inviteOutcome
    b.stub.host.inviteOutcome = (invite) => {
      const real = original(invite)
      return real.state === 'consumed' ? { ...real, node: stranger } : real
    }
    const { id } = await ssh.begin({ host: 'box', name: 'x' })
    const status = await finish(ssh, id!)
    expect(status.phase).toBe('interrupted')
    expect(status.node).toBeUndefined()
    const undone = await ssh.undo(id!)
    expect(b.stub.revokedNodes).toEqual([])
    expect(undone.report.some((item) => /No device was added/.test(item.detail))).toBe(true)
  })

  it('service: a crash after the unit was installed is reconciled from the host', async () => {
    const { b, id } = await crashAt('service.afterEffect')
    const ssh = b.make()
    await ssh.start()
    await ssh.check('box')
    await ssh.retry(id)
    expect((await finish(ssh, id)).phase).toBe('done')
    expect((await b.steps()).filter((step) => step === 'service-install')).toHaveLength(1)
  })

  it('approval: a crash after the approval was written still ends with the node open', async () => {
    const { b, id } = await crashAt('approval.afterApproval')
    const ssh = b.make()
    await ssh.start()
    await ssh.retry(id)
    expect((await finish(ssh, id)).phase).toBe('done')
    expect(b.stub.invites).toHaveLength(1)
  })
})

describe('update, rename and approve', () => {
  it('updates beside the old version, never stops the service, and rolls back on failure', async () => {
    const b = await make()
    const { ssh } = await probed(b)
    const { id } = await ssh.begin({ host: 'box', name: 'x' })
    await finish(ssh, id!)
    const newer = b.make({ version: () => '0.1.3' })
    await newer.start()
    const result = await newer.update(id!)
    expect(result).toMatchObject({ ok: true, version: '0.1.3' })
    const order = await b.steps()
    const tail = order.slice(order.lastIndexOf('install-fetch'))
    expect(tail).toEqual(
      expect.arrayContaining([
        'install-verify',
        'install-launcher',
        'service-install',
        'service-restart',
        'service-status'
      ])
    )
    expect(order.some((step) => step.includes('stop'))).toBe(false)
    expect((await b.host()).launcher).toContain('/cli/0.1.3/')

    await b.patch({ brokenVersions: ['0.1.4'] })
    const broken = b.make({ version: () => '0.1.4' })
    await broken.start()
    const failed = await broken.update(id!)
    expect(failed.ok).toBe(false)
    expect((await b.host()).launcher).toContain('/cli/0.1.3/')
  })

  it('an external machine gets the command, not an update', async () => {
    const b = await make({
      externalCli: '/opt/m/mousse-cli',
      serviceInstalled: true,
      running: true
    })
    const { ssh } = await probed(b)
    const { id } = await ssh.begin({ host: 'box', name: 'x' })
    await finish(ssh, id!)
    const result = await ssh.update(id!)
    expect(result.ok).toBe(false)
    expect(result.command).toContain('github.com')
    expect(await b.steps()).not.toContain('install-fetch')
  })

  it('rename keeps the record id, needs the same host key, and undo still works', async () => {
    const b = await make()
    const { ssh } = await probed(b)
    const { id } = await ssh.begin({ host: 'box', name: 'x' })
    await finish(ssh, id!)
    const node = (await b.host()).node as string
    expect((await ssh.rename(id!, 'box2')).ok).toBe(false)
    const first = await ssh.check('box2')
    await ssh.trust({ host: 'box2', fingerprint: first.hostKey!.fingerprint })
    const renamed = await ssh.rename(id!, 'box2')
    expect(renamed.ok).toBe(true)
    expect((await ssh.list()).records[0]).toMatchObject({ id, endpoint: 'box2' })
    expect((await approvals(b))[node]!.endpoint).toBe('box2')
    expect((await b.host()).transports).toEqual([
      { id: 'ssh', enabled: true, settings: { endpoint: 'box2', port: expect.any(Number) } }
    ])
    // A different key at the new endpoint is a different machine.
    await b.patch({ hostKey: KEY_B })
    const other = await ssh.check('box3')
    await ssh.trust({ host: 'box3', fingerprint: other.hostKey!.fingerprint })
    expect((await ssh.rename(id!, 'box3')).ok).toBe(false)
    await b.patch({ hostKey: KEY_A })
    expect((await ssh.undo(id!)).report.some((item) => item.result === 'left')).toBe(false)
  })

  it('approve stops after phase 1 on an untrusted endpoint and writes nothing', async () => {
    const b = await make()
    const node = ('nod_' + 'a'.repeat(26)) as NodeId
    b.stub.known.add(node)
    const ssh = b.make()
    const first = await ssh.approve(node, 'box')
    expect(first).toMatchObject({
      approved: false,
      phase: 'untrusted',
      hostKey: { state: 'unknown' }
    })
    expect(existsSync(sshApprovalsPath(b.profileDir))).toBe(false)
    expect(await runs(b)).toHaveLength(0)
    await ssh.trust({ host: 'box', fingerprint: first.hostKey!.fingerprint })
    const second = await ssh.approve(node, 'box')
    expect(second.approved).toBe(true)
    expect((await approvals(b))[node]).toMatchObject({
      endpoint: 'box',
      fingerprint: fingerprint(KEY_A)
    })
    // An unknown device cannot be approved.
    await expect(ssh.approve(('nod_' + 'b'.repeat(26)) as NodeId, 'box')).rejects.toThrow()
  })

  it('approve through a key rotation ends with the approval written and the user file untouched', async () => {
    const b = await make()
    const node = ('nod_' + 'a'.repeat(26)) as NodeId
    b.stub.known.add(node)
    await mkdir(dirname(b.userKnownHosts), { recursive: true })
    const original = `box ${KEY_B.type} ${KEY_B.key}\n`
    await writeFile(b.userKnownHosts, original)
    const ssh = b.make()
    const first = await ssh.approve(node, 'box')
    expect(first.hostKey?.state).toBe('changed')
    await ssh.trust({
      host: 'box',
      fingerprint: first.hostKey!.fingerprint,
      acknowledgeChanged: true
    })
    expect((await ssh.approve(node, 'box')).approved).toBe(true)
    expect(await readFile(b.userKnownHosts, 'utf8')).toBe(original)
  })
})
