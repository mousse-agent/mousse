import { afterEach, expect, it, vi } from 'vitest'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareNetCommand, executeNetCommand, netCliFailure } from '../../../src/cli/commands/net'
import type { ParsedArgs } from '../../../src/cli/parseArgs'
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})
function args(
  subcommand: string,
  positional: string[],
  flags: [string, string | boolean][]
): ParsedArgs {
  return {
    command: subcommand === 'join' ? 'bridge' : 'net',
    subcommand,
    positional,
    flags: new Map(flags),
    raw: [],
    globals: {
      homeDir: '',
      mode: 'json',
      print: false,
      continueSession: false,
      version: false,
      help: false
    }
  }
}
it('reads exact bounded regular settings and private invite files before any daemon connection', () => {
  const path = mkdtempSync(join(tmpdir(), 'mousse-net-cli-files-'))
  cleanup.push(() => rmSync(path, { recursive: true, force: true }))
  const settings = join(path, 'settings.json'),
    secret = join(path, 'invite'),
    link = join(path, 'link')
  writeFileSync(settings, JSON.stringify({ address: 'ws://127.0.0.1:1234/mousse-relay' }))
  expect(
    prepareNetCommand(args('transport', ['configure', 'relay'], [['settings-file', settings]]))
  ).toEqual({
    method: 'net.transport.configure',
    params: {
      id: 'relay',
      enabled: true,
      settings: { address: 'ws://127.0.0.1:1234/mousse-relay' }
    }
  })
  expect(
    prepareNetCommand(
      args(
        'transport',
        ['configure', 'relay'],
        [
          ['settings-file', settings],
          ['disable', true]
        ]
      )
    ).params.enabled
  ).toBe(false)
  writeFileSync(secret, 'mj1_c2VjcmV0\n', { mode: 0o600 })
  symlinkSync(secret, link)
  expect(
    prepareNetCommand(
      args(
        'join',
        [],
        [
          ['invite-file', secret],
          ['protect', true]
        ]
      )
    )
  ).toEqual({ method: 'bridge.join', params: { invite: 'mj1_c2VjcmV0' }, promptPassphrase: true })
  for (const input of [
    args('join', [], [['invite-file', link]]),
    args('join', ['mj1_c2VjcmV0'], [['invite-file', secret]])
  ])
    expect(() => prepareNetCommand(input)).toThrow()
  chmodSync(secret, 0o644)
  expect(() => prepareNetCommand(args('join', [], [['invite-file', secret]]))).toThrow(/private/)
  writeFileSync(settings, '{"token":"do not print this input",')
  try {
    prepareNetCommand(args('transport', ['configure', 'relay'], [['settings-file', settings]]))
    throw new Error('did not reject')
  } catch (error) {
    const failure = netCliFailure(error)
    expect(failure.code).toBe('bad_request')
    expect(failure.error).not.toContain('do not print this input')
    expect(failure.error).not.toContain(path)
  }
  writeFileSync(settings, Buffer.alloc(16 * 1024 + 1))
  expect(() =>
    prepareNetCommand(args('transport', ['configure', 'relay'], [['settings-file', settings]]))
  ).toThrow()
  writeFileSync(settings, Buffer.from([0xff]))
  expect(() =>
    prepareNetCommand(args('transport', ['configure', 'relay'], [['settings-file', settings]]))
  ).toThrow()
})

it('exports only encrypted recovery bytes into a new private file and refuses overwrite even after a path race', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mousse-recovery-cli-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'backup'),
    encrypted = Buffer.from(
      JSON.stringify({
        v: 1,
        salt: Buffer.alloc(32).toString('base64url'),
        nonce: Buffer.alloc(12).toString('base64url'),
        ct: Buffer.alloc(32).toString('base64url')
      })
    )
  const emit = vi.fn(),
    request = vi.fn(async () => ({ file: encrypted.toString('base64url') }))
  const prepared = prepareNetCommand(args('recovery', ['export'], [['output', path]]))
  expect(prepared).toEqual({
    method: 'net.recovery.export',
    params: {},
    recoveryOutput: path,
    promptPassphrase: true
  })
  await executeNetCommand(
    prepared,
    { request },
    { emit, readPassphrase: async () => ' exact recovery password\n' }
  )
  expect(request).toHaveBeenCalledWith('net.recovery.export', {
    passphrase: ' exact recovery password\n'
  })
  expect(readFileSync(path)).toEqual(encrypted)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(emit).toHaveBeenCalledWith({ file: path }, `Encrypted recovery file: ${path}`)
  expect(() => prepareNetCommand(args('recovery', ['export'], [['output', path]]))).toThrow(
    /overwrite/
  )
  const other = join(directory, 'race'),
    race = prepareNetCommand(args('recovery', ['export'], [['output', other]]))
  writeFileSync(other, 'existing content')
  await expect(
    executeNetCommand(race, { request }, { emit, readPassphrase: async () => 'password' })
  ).rejects.toThrow(/new private recovery file/)
  expect(readFileSync(other, 'utf8')).toBe('existing content')
  const imported = prepareNetCommand(
    args(
      'recovery',
      ['import'],
      [
        ['file', path],
        ['become-authority', true]
      ]
    )
  )
  expect(imported).toEqual({
    method: 'net.recovery.import',
    params: { file: encrypted.toString('base64url'), becomeAuthority: true },
    promptPassphrase: true
  })
  expect(() => prepareNetCommand(args('recovery', ['import'], [['file', path]]))).toThrow(
    /become-authority/
  )
  expect(() =>
    prepareNetCommand(
      args(
        'recovery',
        ['import'],
        [
          ['file', path],
          ['become-authority', true],
          ['passphrase', 'visible-secret']
        ]
      )
    )
  ).toThrow(/Unsupported/)
  writeFileSync(path, '{"root":"PRIVATE KEY"}')
  expect(() =>
    prepareNetCommand(
      args(
        'recovery',
        ['import'],
        [
          ['file', path],
          ['become-authority', true]
        ]
      )
    )
  ).toThrow(/encrypted backup/)
})
