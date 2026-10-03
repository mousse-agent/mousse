import { afterEach, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareNetCommand, netCliFailure } from '../../../src/cli/commands/net'
import type { ParsedArgs } from '../../../src/cli/parseArgs'
const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
function args(subcommand: string, positional: string[], flags: [string, string | boolean][]): ParsedArgs {
  return { command: subcommand === 'join' ? 'bridge' : 'net', subcommand, positional, flags: new Map(flags), raw: [], globals: { homeDir: '', mode: 'json', print: false, continueSession: false, version: false, help: false } }
}
it('reads exact bounded regular settings and private invite files before any daemon connection', () => {
  const path = mkdtempSync(join(tmpdir(), 'mousse-net-cli-files-')); cleanup.push(() => rmSync(path, { recursive: true, force: true }))
  const settings = join(path, 'settings.json'), secret = join(path, 'invite'), link = join(path, 'link')
  writeFileSync(settings, JSON.stringify({ address: 'ws://127.0.0.1:1234/mousse-relay' }))
  expect(prepareNetCommand(args('transport', ['configure', 'relay'], [['settings-file', settings]]))).toEqual({ method: 'net.transport.configure', params: { id: 'relay', enabled: true, settings: { address: 'ws://127.0.0.1:1234/mousse-relay' } } })
  expect(prepareNetCommand(args('transport', ['configure', 'relay'], [['settings-file', settings], ['disable', true]])).params.enabled).toBe(false)
  writeFileSync(secret, 'mj1_c2VjcmV0\n', { mode: 0o600 }); symlinkSync(secret, link)
  expect(prepareNetCommand(args('join', [], [['invite-file', secret], ['protect', true]]))).toEqual({ method: 'bridge.join', params: { invite: 'mj1_c2VjcmV0' }, promptPassphrase: true })
  for (const input of [args('join', [], [['invite-file', link]]), args('join', ['mj1_c2VjcmV0'], [['invite-file', secret]])]) expect(() => prepareNetCommand(input)).toThrow()
  chmodSync(secret, 0o644); expect(() => prepareNetCommand(args('join', [], [['invite-file', secret]]))).toThrow(/private/)
  writeFileSync(settings, '{"token":"do not print this input",')
  try { prepareNetCommand(args('transport', ['configure', 'relay'], [['settings-file', settings]])); throw new Error('did not reject') }
  catch (error) { const failure = netCliFailure(error); expect(failure.code).toBe('bad_request'); expect(failure.error).not.toContain('do not print this input'); expect(failure.error).not.toContain(path) }
  writeFileSync(settings, Buffer.alloc(16 * 1024 + 1)); expect(() => prepareNetCommand(args('transport', ['configure', 'relay'], [['settings-file', settings]]))).toThrow()
  writeFileSync(settings, Buffer.from([0xff])); expect(() => prepareNetCommand(args('transport', ['configure', 'relay'], [['settings-file', settings]]))).toThrow()
})
