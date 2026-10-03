import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { executeNetCommand, netCliFailure, parseInviteTtl, prepareNetCommand, publicNetOutput, readInviteSecret, readPassphraseSecret, type InviteInput } from '../../../src/cli/commands/net'
import type { ParsedArgs } from '../../../src/cli/parseArgs'

function args(command: 'net' | 'bridge', subcommand: string, positional: string[] = [], flags: [string, string | boolean][] = []): ParsedArgs {
  return { command, subcommand, positional, flags: new Map(flags), raw: [], globals: { homeDir: '', mode: 'json', print: false, continueSession: false, version: false, help: false } }
}
const bearer = 'mj1_c2VjcmV0'
const nodeId = 'nod_00000000000000000000000000'
describe('network CLI validation', () => {
  it('prepares every P2 method with exact parameters before daemon access', () => {
    expect(prepareNetCommand(args('net', 'init', [], [['name', 'Laptop']]))).toEqual({ method: 'net.init', params: { name: 'Laptop' } })
    expect(prepareNetCommand(args('net', 'status'))).toEqual({ method: 'net.status', params: {} })
    expect(prepareNetCommand(args('net', 'doctor'))).toEqual({ method: 'net.doctor', params: {} })
    expect(prepareNetCommand(args('bridge', 'invite', [], [['ttl', '1h'], ['caps', 'read,chat']]))).toEqual({ method: 'bridge.invite', params: { ttlMs: 3_600_000, caps: ['read', 'chat'] } })
    expect(prepareNetCommand(args('bridge', 'join', [bearer], [['name', 'VPS']]))).toEqual({ method: 'bridge.join', params: { invite: bearer, name: 'VPS' } })
    expect(prepareNetCommand(args('bridge', 'join'))).toEqual({ method: 'bridge.join', params: {}, promptInvite: true })
    expect(prepareNetCommand(args('bridge', 'nodes'))).toEqual({ method: 'bridge.nodes', params: {} })
    expect(prepareNetCommand(args('bridge', 'revoke', [nodeId]))).toEqual({ method: 'bridge.revoke', params: { node: nodeId } })
    expect(prepareNetCommand(args('bridge', 'rename', [nodeId, 'Desk']))).toEqual({ method: 'bridge.rename', params: { node: nodeId, name: 'Desk' } })
  })
  it('rejects malformed, unexpected or privilege-confusing arguments without exposing them', () => {
    const cases = [args('net', 'init', ['extra']), args('net', 'status', [], [['token', bearer]]), args('bridge', 'join', ['not-an-invite']), args('bridge', 'join', [bearer, bearer]), args('bridge', 'rename', ['node']), args('bridge', 'invite', [], [['caps', 'read,read']]), args('bridge', 'invite', [], [['caps', 'admin']]), args('bridge', 'invite', [], [['name', true]]), args('net', 'init', [], [['name', 'line\nbreak']])]
    for (const value of cases) {
      expect(() => prepareNetCommand(value)).toThrow()
      try { prepareNetCommand(value) } catch (error) { expect(netCliFailure(error)).toMatchObject({ code: 'bad_request', exitCode: 2 }); expect(netCliFailure(error).error).not.toContain(bearer) }
    }
    const overridden = args('net', 'init'); overridden.globals.apiKey = bearer
    expect(() => prepareNetCommand(overridden)).toThrow(/overrides/)
  })
  it('bounds invite durations and prevents numeric coercion fallback', () => {
    expect(parseInviteTtl()).toBe(600_000)
    expect(parseInviteTtl('7d')).toBe(604_800_000)
    for (const value of ['0s', '-1m', '10', 'NaNm', 'Infinityh', '1.5h', '8d', '99999999999999999d']) expect(() => parseInviteTtl(value)).toThrow()
  })
  it('requires explicit listener opt-in and validates concrete bind address and port', () => {
    expect(prepareNetCommand(args('net', 'init', [], [['listen', true], ['host', '::1'], ['port', '0']]))).toEqual({ method: 'net.init', params: { listen: true, host: '::1', port: 0 } })
    expect(prepareNetCommand(args('net', 'init'))).toEqual({ method: 'net.init', params: {} })
    for (const flags of [[['port', '1234']], [['host', '127.0.0.1']], [['listen', 'true']], [['listen', true], ['host', 'example.com']], [['listen', true], ['port', '65536']], [['listen', true], ['port', '1.5']]] as [string, string | boolean][][]) expect(() => prepareNetCommand(args('net', 'init', [], flags))).toThrow()
  })
  it('counts names as Unicode code points consistently with delegation schemas', () => {
    expect(prepareNetCommand(args('net', 'init', [], [['name', '😀'.repeat(256)]])).params.name).toBe('😀'.repeat(256))
    expect(() => prepareNetCommand(args('net', 'init', [], [['name', '😀'.repeat(257)]]))).toThrow(/256/)
  })
  it('rejects unsupported display-name aliases and malformed node identifiers before connection', () => {
    for (const selector of ['Laptop', 'nod_short', 'usr_00000000000000000000000000', 'nod_0000000000000000000000000i']) {
      expect(() => prepareNetCommand(args('bridge', 'revoke', [selector]))).toThrow(/nod_ node identifier/)
      expect(() => prepareNetCommand(args('bridge', 'rename', [selector, 'Desk']))).toThrow(/nod_ node identifier/)
    }
  })
})

describe('network CLI command transport and presentation', () => {
  it('sends secret invite to only the join method, and prints only public result', async () => {
    const emitted: unknown[] = []
    const request = vi.fn(async (method: string, params?: unknown) => {
      expect(method).toBe('bridge.join'); expect(params).toEqual({ invite: bearer, name: 'VPS' })
      return { user: 'usr_public', node: 'nod_public', authority: 'nod_authority', token: bearer, diagnostic: bearer }
    })
    expect(await executeNetCommand({ method: 'bridge.join', params: { name: 'VPS' }, promptInvite: true }, { request }, { readInvite: async () => ` ${bearer}\n`, emit: (value) => emitted.push(value) })).toBe(0)
    expect(request).toHaveBeenCalledTimes(1)
    expect(emitted).toEqual([{ user: 'usr_public', node: 'nod_public', authority: 'nod_authority', diagnostic: '[redacted]' }])
  })
  it('outputs the explicit invite once and suppresses unexpected returned credentials', async () => {
    const emit = vi.fn()
    await executeNetCommand({ method: 'bridge.invite', params: { ttlMs: 600_000 } }, { request: vi.fn(async () => ({ invite: bearer, inviteId: 'inv_public', expiresAt: 1000, proofKey: 'private' })) }, { emit })
    expect(emit).toHaveBeenCalledWith({ invite: bearer, inviteId: 'inv_public', expiresAt: 1000 }, `mousse-cli bridge join ${bearer}\nExpires: 1970-01-01T00:00:01.000Z`)
  })
  it('redacts nested diagnostics and URL credentials', () => {
    expect(publicNetOutput({ sessions: [{ proofKey: 'hidden', lastError: `failed ${bearer}`, route: 'https://user:password@host/path' }], privateKey: 'hidden', password: 'hidden' })).toEqual({ sessions: [{ lastError: 'failed [redacted]', route: 'https://[redacted]@host/path' }] })
  })
  it('preserves stable error codes, using catalog messages rather than remote secret details', () => {
    expect(netCliFailure({ code: 'invite_invalid', message: bearer, details: { bearer } })).toEqual({ code: 'invite_invalid', error: 'The invite is invalid, expired or already used.', exitCode: 1 })
    expect(netCliFailure(new Error(bearer))).toEqual({ code: 'internal', error: 'Internal error.', exitCode: 1 })
    expect(netCliFailure({ code: 'cancelled' })).toMatchObject({ exitCode: 130 })
    expect(netCliFailure({ code: 'unknown', message: bearer })).toMatchObject({ code: 'internal' })
    for (const code of ['invalid_params', 'unknown_field', 'profile_mismatch', 'invalid_profile_binding', 'profile_binding_required']) expect(netCliFailure({ code, message: bearer })).toEqual({ code: 'bad_request', error: 'The request is malformed.', exitCode: 2 })
    expect(netCliFailure({ code: 'params_too_large', message: bearer })).toMatchObject({ code: 'too_large' })
    expect(netCliFailure({ code: 'profile_not_found', message: bearer })).toEqual({ code: 'bad_request', error: 'The selected profile does not exist. Choose an existing profile with --profile.', exitCode: 2 })
    expect(netCliFailure({ code: 'profile_archived', message: bearer })).toEqual({ code: 'bad_request', error: 'The selected profile is archived. Restore it or choose an active profile with --profile.', exitCode: 2 })
  })
  it('does not invoke a daemon method when prompted input is invalid', async () => {
    const request = vi.fn()
    await expect(executeNetCommand({ method: 'bridge.join', params: {}, promptInvite: true }, { request }, { readInvite: async () => 'invalid', emit: vi.fn() })).rejects.toThrow(/invite/)
    expect(request).not.toHaveBeenCalled()
  })
})

describe('no-echo invite input', () => {
  it('hides typed input, handles backspace and restores terminal state', async () => {
    const input = new PassThrough() as PassThrough & InviteInput
    input.isTTY = true; input.isRaw = false; input.setRawMode = vi.fn()
    const output = { write: vi.fn(() => true) }
    const pending = readInviteSecret(input, output)
    input.write(`${bearer}x\x7f\r`)
    expect(await pending).toBe(bearer)
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true)
    expect(input.setRawMode).toHaveBeenNthCalledWith(2, false)
    expect(output.write.mock.calls.flat().join('')).toBe('Invite (input hidden): \n')
    expect(input.listenerCount('data')).toBe(0)
  })
  it('restores raw mode and removes listeners when interrupted', async () => {
    const input = new PassThrough() as PassThrough & InviteInput
    input.isTTY = true; input.isRaw = true; input.setRawMode = vi.fn()
    const pending = readInviteSecret(input, { write: () => true })
    input.write(`${bearer}\x03`)
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(input.setRawMode).toHaveBeenLastCalledWith(true)
    expect(input.listenerCount('data')).toBe(0)
  })
  it('handles a process SIGINT while hidden input is active and removes its scoped handler', async () => {
    const input = new PassThrough() as PassThrough & InviteInput
    input.isTTY = true; input.isRaw = false; input.setRawMode = vi.fn()
    const before = process.listenerCount('SIGINT')
    const pending = readInviteSecret(input, { write: () => true })
    expect(process.listenerCount('SIGINT')).toBe(before + 1)
    process.emit('SIGINT')
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(input.setRawMode).toHaveBeenLastCalledWith(false)
    expect(process.listenerCount('SIGINT')).toBe(before)
    expect(input.listenerCount('data')).toBe(0)
  })
  it('accepts piped input without prompting and enforces a bounded input', async () => {
    const input = new PassThrough(); const output = { write: vi.fn(() => true) }
    const pending = readInviteSecret(input, output); input.end(bearer)
    expect(await pending).toBe(bearer); expect(output.write).not.toHaveBeenCalled()
    const oversized = new PassThrough(); const rejected = readInviteSecret(oversized, output)
    oversized.end('a'.repeat(65537))
    await expect(rejected).rejects.toThrow(/size limit/)
  })
  it('refuses a terminal where echo cannot be disabled', async () => {
    const input = new PassThrough() as PassThrough & InviteInput; input.isTTY = true
    await expect(readInviteSecret(input)).rejects.toThrow(/cannot disable echo/)
  })
  it('cleans up when a terminal rejects the request to disable echo', async () => {
    const input = new PassThrough() as PassThrough & InviteInput; input.isTTY = true
    input.setRawMode = vi.fn(() => { throw new Error('terminal failed') })
    await expect(readInviteSecret(input, { write: () => true })).rejects.toThrow(/cannot disable echo/)
    expect(input.listenerCount('data')).toBe(0)
    expect(input.listenerCount('end')).toBe(0)
  })
})

describe('headless keystore protect and unlock', () => {
  it('accepts only hidden or piped passphrases, rejecting secret arguments and flags', () => {
    for (const command of ['protect', 'unlock']) {
      expect(prepareNetCommand(args('net', command))).toEqual({ method: `net.${command}`, params: {}, promptPassphrase: true })
      expect(() => prepareNetCommand(args('net', command, ['secret']))).toThrow(/0 positional/)
      expect(() => prepareNetCommand(args('net', command, [], [['passphrase', 'secret']]))).toThrow(/Unsupported flag/)
      expect(() => prepareNetCommand(args('net', command, [], [['password', 'secret']]))).toThrow(/Unsupported flag/)
    }
  })
  it('sends the exact passphrase to only its protection method and suppresses returned secrets', async () => {
    for (const method of ['net.protect', 'net.unlock'] as const) {
      const secret = '  å secret \t\n'
      const request = vi.fn(async (actual: string, params?: unknown) => {
        expect(actual).toBe(method); expect(params).toEqual({ passphrase: secret })
        return { protected: true, passphrase: secret }
      })
      const emit = vi.fn()
      await executeNetCommand({ method, params: {}, promptPassphrase: true }, { request }, { readPassphrase: async () => secret, emit })
      expect(emit).toHaveBeenCalledWith({ protected: true }, JSON.stringify({ protected: true }, null, 2))
    }
  })
  it('rejects empty, oversized or invalid UTF-8 before any daemon request', async () => {
    for (const secret of ['', 'å'.repeat(2049), '\ud800']) {
      const request = vi.fn()
      await expect(executeNetCommand({ method: 'net.protect', params: {}, promptPassphrase: true }, { request }, { readPassphrase: async () => secret, emit: vi.fn() })).rejects.toThrow(/4096 bytes/)
      expect(request).not.toHaveBeenCalled()
    }
  })
  it('preserves every byte of a valid UTF-8 piped passphrase including BOM and whitespace', async () => {
    const input = new PassThrough(); const output = { write: vi.fn(() => true) }
    const pending = readPassphraseSecret(input, output)
    input.end('\ufeff  å\t\n')
    expect(await pending).toBe('\ufeff  å\t\n')
    expect(output.write).not.toHaveBeenCalled()
  })
  it('enforces the passphrase bound in UTF-8 bytes and rejects malformed encoding', async () => {
    const maximum = new PassThrough(); const accepted = readPassphraseSecret(maximum, { write: () => true }); maximum.end('å'.repeat(2048))
    expect(await accepted).toBe('å'.repeat(2048))
    const large = new PassThrough(); const rejected = readPassphraseSecret(large, { write: () => true }); large.end('å'.repeat(2049))
    await expect(rejected).rejects.toThrow(/size limit/)
    const malformed = new PassThrough(); const invalid = readPassphraseSecret(malformed, { write: () => true }); malformed.end(Buffer.from([0xc3, 0x28]))
    await expect(invalid).rejects.toThrow(/valid UTF-8/)
  })
  it('deletes whole Unicode code points at a no-echo terminal', async () => {
    const input = new PassThrough() as PassThrough & InviteInput; input.isTTY = true; input.setRawMode = vi.fn()
    const output = { write: vi.fn(() => true) }
    const pending = readPassphraseSecret(input, output); input.write('space 😀\x7få\r')
    expect(await pending).toBe('space å')
    expect(output.write.mock.calls.flat().join('')).toBe('Passphrase (input hidden): \n')
  })
})

describe('transport and protected-join CLI controls', () => {
  it('prepares public transport discovery and keeps protected-join passphrase out of argv', () => {
    expect(prepareNetCommand(args('net', 'transports'))).toEqual({ method: 'net.transport.list', params: {} })
    expect(prepareNetCommand(args('bridge', 'join', [bearer], [['protect', true]]))).toEqual({ method: 'bridge.join', params: { invite: bearer }, promptPassphrase: true })
    expect(() => prepareNetCommand(args('bridge', 'join', [bearer], [['protect', 'visible password']]))).toThrow(/switch/)
    expect(() => prepareNetCommand(args('bridge', 'join', [bearer], [['passphrase', 'visible password']]))).toThrow(/Unsupported flag/)
  })
  it('sends exact protected-join input only to the local daemon and suppresses returned transport admission credentials', async () => {
    const request = vi.fn(async () => ({ node: nodeId, ticket: 'transport bearer', authorization: { ticket: 'nested bearer' } })), emit = vi.fn()
    await executeNetCommand(prepareNetCommand(args('bridge', 'join', [bearer], [['protect', true]])), { request }, { emit, readPassphrase: async () => '  exact passphrase\n' })
    expect(request).toHaveBeenCalledWith('bridge.join', { invite: bearer, passphrase: '  exact passphrase\n' })
    expect(emit).toHaveBeenCalledWith({ node: nodeId }, JSON.stringify({ node: nodeId }, null, 2))
  })
})


it('validates authority selectors and recovery command arity without accepting credentials in argv', () => {
  expect(prepareNetCommand(args('net', 'authority', ['status']))).toEqual({ method: 'net.authority.status', params: {} })
  expect(prepareNetCommand(args('net', 'authority', ['transfer', nodeId]))).toEqual({ method: 'net.authority.transfer', params: { node: nodeId } })
  for (const value of [args('net', 'authority', ['transfer', 'Laptop']), args('net', 'authority', ['status', 'extra']), args('net', 'recovery', ['export', 'visible password']), args('net', 'recovery', ['import'], [['passphrase', 'visible password']]), args('net', 'authority', ['unknown'])]) expect(() => prepareNetCommand(value)).toThrow()
})

it('admits explicit rollback and hidden passphrase re-enrollment without secret argv', () => {
  expect(prepareNetCommand(args('net', 'disable'))).toEqual({ method: 'net.disable', params: {} })
  expect(prepareNetCommand(args('net', 'init', [], [['unlock', true]]))).toEqual({
    method: 'net.init', params: {}, promptPassphrase: true
  })
  expect(() => prepareNetCommand(args('net', 'init', [], [['unlock', 'secret']]))).toThrow(/switch/)
  expect(() => prepareNetCommand(args('net', 'init', [], [['passphrase', 'secret']]))).toThrow(/Unsupported flag/)
  expect(netCliFailure({ code: 'disabled', message: bearer })).toEqual({
    code: 'disabled', exitCode: 1,
    error: 'Mousse Net is disabled for this profile. Opt in with net init or bridge join.'
  })
})
