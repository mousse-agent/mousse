import { describe, expect, it } from 'vitest'
import { SSH_PROBE_TIMEOUT_MS, runSshProbe, sshProbeArguments, type SshProbeIo } from '../src/main/sshProbe'
import { sshSignInAdvice } from '../src/main/remoteEditorFlow'

const CONFIG = '/home/me/.mousse/ssh/config'

describe('the sign-in check after an editor connection was found open', () => {
  it('runs ssh with no question possible, once, against the name, from Mousse’s own file of names', () => {
    expect(sshProbeArguments('mousse-workbox-3fa2c1', CONFIG)).toEqual([
      '-F', CONFIG,
      '-o', 'BatchMode=yes',
      '-o', 'NumberOfPasswordPrompts=0',
      '-o', 'ConnectTimeout=5',
      '-o', 'LogLevel=ERROR',
      '--', 'mousse-workbox-3fa2c1', 'exit'
    ])
  })

  it('names nothing but one of Mousse’s own SSH names, in a file that is not an option', () => {
    for (const bad of ['', '-oProxyCommand=x', 'Workbox', 'a b', 'user@host', 'host:22', 'a/b', '..', 'a'.repeat(65), 'mousse-x\n'])
      expect(() => sshProbeArguments(bad, CONFIG), bad).toThrow()
    for (const config of ['', '-oProxyCommand=x', 'a\0b']) expect(() => sshProbeArguments('mousse-a', config), config).toThrow()
  })

  it('is short: advice must not hold the editor back', () => {
    expect(SSH_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(8_000)
  })

  const io = (run: Partial<Awaited<ReturnType<SshProbeIo['run']>>>, clients = ['/usr/bin/ssh']): SshProbeIo & { ran: Array<{ program: string; args: string[]; env: NodeJS.ProcessEnv }> } => {
    const ran: Array<{ program: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    return {
      ran,
      clients: () => clients,
      run: async (program, args, _timeout, env) => {
        ran.push({ program, args, env })
        return { code: 0, stderr: '', timedOut: false, ...run }
      }
    }
  }

  it('passes on a login that worked, in the environment the editor will start with', async () => {
    const fake = io({})
    const env = { PATH: '/usr/bin' }
    expect(await runSshProbe('mousse-a', CONFIG, env, fake)).toEqual({ ok: true })
    expect(fake.ran).toHaveLength(1)
    expect(fake.ran[0].program).toBe('/usr/bin/ssh')
    expect(fake.ran[0].env).toBe(env)
  })

  it('carries what ssh said when it failed, and says so when it did not finish', async () => {
    expect(await runSshProbe('mousse-a', CONFIG, {}, io({ code: 255, stderr: 'Permission denied (publickey).' }))).toEqual({ ok: false, stderr: 'Permission denied (publickey).' })
    expect(await runSshProbe('mousse-a', CONFIG, {}, io({ code: null, timedOut: true }))).toEqual({ ok: false, stderr: 'ssh did not finish signing in.' })
  })

  it('is skipped, not failed, when this computer has no ssh', async () => {
    const fake = io({}, [])
    expect(await runSshProbe('mousse-a', CONFIG, {}, fake)).toEqual({ skipped: true })
    expect(fake.ran).toEqual([])
  })
})

describe('what a sign-in check that did not pass advises', () => {
  it('says keys alone were refused, with the command where this computer has one', () => {
    expect(sshSignInAdvice('dev@x: Permission denied (publickey).', 'mousse-a', false)).toEqual({ failure: 'key_refused', command: 'ssh-copy-id mousse-a' })
    expect(sshSignInAdvice('Permission denied (publickey).', 'mousse-a', true)).toEqual({ failure: 'key_refused' })
    expect(sshSignInAdvice('Permission denied (publickey,gssapi-keyex,gssapi-with-mic).', 'mousse-a', false)).toMatchObject({ failure: 'key_refused' })
  })

  it('says nothing for a computer that also takes a password or a one-time code: the editor will ask', () => {
    expect(sshSignInAdvice('dev@x: Permission denied (publickey,password).', 'mousse-a', false)).toBeUndefined()
    expect(sshSignInAdvice('Permission denied (publickey,keyboard-interactive).', 'mousse-a', false)).toBeUndefined()
    expect(sshSignInAdvice('Permission denied (password).', 'mousse-a', true)).toBeUndefined()
  })

  it('keeps ssh’s own last line for any other failure, shortened', () => {
    expect(sshSignInAdvice('Warning: x\nConnection timed out during banner exchange\r\n', 'mousse-a', false)).toEqual({
      failure: 'ssh_failed',
      message: 'Connection timed out during banner exchange'
    })
    expect(sshSignInAdvice('x'.repeat(500), 'mousse-a', false)!.message!.length).toBeLessThanOrEqual(200)
    expect(sshSignInAdvice('', 'mousse-a', false)).toBeUndefined()
  })
})
