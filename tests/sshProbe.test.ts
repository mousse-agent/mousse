import { describe, expect, it } from 'vitest'
import { runSshProbe, sshProbeArguments, type SshProbeIo } from '../src/main/sshProbe'
import { sshProbeFailure } from '../src/main/remoteEditorFlow'

describe('the sign-in check before an editor opens', () => {
  it('runs ssh with no question possible, once, against the name only', () => {
    expect(sshProbeArguments('mousse-workbox-3fa2c1')).toEqual([
      '-o', 'BatchMode=yes',
      '-o', 'NumberOfPasswordPrompts=0',
      '-o', 'ConnectTimeout=15',
      '-o', 'LogLevel=ERROR',
      '--', 'mousse-workbox-3fa2c1', 'exit'
    ])
  })

  it('names nothing but one of Mousse’s own SSH names', () => {
    for (const bad of ['', '-oProxyCommand=x', 'Workbox', 'a b', 'user@host', 'host:22', 'a/b', '..', 'a'.repeat(65), 'mousse-x\n'])
      expect(() => sshProbeArguments(bad), bad).toThrow()
  })

  const io = (run: Partial<Awaited<ReturnType<SshProbeIo['run']>>>, clients = ['/usr/bin/ssh']): SshProbeIo & { ran: Array<{ program: string; args: string[] }> } => {
    const ran: Array<{ program: string; args: string[] }> = []
    return {
      ran,
      clients: () => clients,
      run: async (program, args) => {
        ran.push({ program, args })
        return { code: 0, stderr: '', timedOut: false, ...run }
      }
    }
  }

  it('passes on a login that worked', async () => {
    const fake = io({})
    expect(await runSshProbe('mousse-a', fake)).toEqual({ ok: true })
    expect(fake.ran).toHaveLength(1)
    expect(fake.ran[0].program).toBe('/usr/bin/ssh')
  })

  it('carries what ssh said when it failed, and says so when it did not finish', async () => {
    expect(await runSshProbe('mousse-a', io({ code: 255, stderr: 'Permission denied (publickey).' }))).toEqual({ ok: false, stderr: 'Permission denied (publickey).' })
    expect(await runSshProbe('mousse-a', io({ code: null, timedOut: true }))).toEqual({ ok: false, stderr: 'ssh did not finish signing in within 20 seconds.' })
  })

  it('is skipped, not failed, when this computer has no ssh', async () => {
    const fake = io({}, [])
    expect(await runSshProbe('mousse-a', fake)).toEqual({ skipped: true })
    expect(fake.ran).toEqual([])
  })

  it('tells a refused key from any other failure, and keeps ssh’s own last line', () => {
    expect(sshProbeFailure('dev@x: Permission denied (publickey,password).', 'mousse-a', false)).toEqual({
      ok: false,
      reason: 'connection',
      failure: 'key_refused',
      command: 'ssh-copy-id mousse-a'
    })
    expect(sshProbeFailure('Permission denied (publickey).', 'mousse-a', true)).toEqual({ ok: false, reason: 'connection', failure: 'key_refused' })
    expect(sshProbeFailure('Connection timed out during banner exchange\r\n', 'mousse-a', false)).toEqual({
      ok: false,
      reason: 'connection',
      failure: 'ssh_failed',
      message: 'Connection timed out during banner exchange'
    })
    const long = sshProbeFailure(`${'x'.repeat(500)}`, 'mousse-a', false)
    expect(long.message!.length).toBeLessThanOrEqual(200)
  })
})
