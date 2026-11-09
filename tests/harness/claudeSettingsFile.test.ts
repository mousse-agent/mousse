import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { claudeSettingsPath, maskSecret, readClaudeSettingsFile, writeClaudeSetting } from '../../src/mms/harness/vendors/claude/claudeSettingsFile'
import { classifyRoutedMethod } from '../../src/shared/bridge/routed'
import { dispatchMethod } from '../../src/mms/protocol/handlers'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import type { HarnessGatewayEvent } from '../../src/mms/harness/gateway'
import type { ProviderAdapter } from '../../src/mms/harness/adapter'
import { PiStubAdapter } from '../support/piStub'

/**
 * Settings → Providers edits Claude Code's own settings.json (base URL, key, model, flags) in the
 * account home the entry runs with. Every other key and the file's layout stay, the first edit keeps
 * a copy, the write is atomic, a secret never leaves the daemon, and a file shared with the terminal
 * is written only with the user's say-so. All files here are in a temporary folder.
 */

const KEY = 'sk-ant-api03-secret-value-WXYZ'
const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-settings-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
/** The revision a page would hold after reading the file now. */
const rev = (path: string) => readClaudeSettingsFile(path, { shared: false }).revision!

const ORIGINAL = [
  '{',
  '    "permissions": {',
  '        "allow": ["Bash(git status)"]',
  '    },',
  '    "env": {',
  `        "ANTHROPIC_API_KEY": "${KEY}",`,
  '        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",',
  '        "OTHER": "kept"',
  '    },',
  '    "hooks": {}',
  '}'
].join('\r\n') + '\r\n'

describe("reading Claude's settings.json", () => {
  it('lists the useful settings present, masks secrets, and offers the common ones missing', () => {
    const dir = tempDir()
    const path = join(dir, 'settings.json')
    writeFileSync(path, ORIGINAL)
    const view = readClaudeSettingsFile(path, { shared: true })
    expect(view.entries).toEqual([
      { key: 'env.ANTHROPIC_API_KEY', label: 'API key', secret: true, masked: '•••• WXYZ' },
      { key: 'env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', label: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', secret: false, value: '1' }
    ])
    expect(view.addable.map((option) => option.key)).toEqual(['env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_AUTH_TOKEN', 'model'])
    // The key itself is nowhere in what is sent on.
    expect(JSON.stringify(view)).not.toContain('secret-value')
    expect(maskSecret('short')).toBe('••••')
  })

  it('a missing file offers the common settings; a broken one is left alone', () => {
    const dir = tempDir()
    expect(readClaudeSettingsFile(join(dir, 'settings.json'), { shared: false })).toMatchObject({ exists: false, entries: [], addable: expect.arrayContaining([expect.objectContaining({ key: 'model' })]) })
    writeFileSync(join(dir, 'settings.json'), '{ "env": ')
    expect(readClaudeSettingsFile(join(dir, 'settings.json'), { shared: false }).error).toMatch(/can't read/)
    expect(() => writeClaudeSetting(join(dir, 'settings.json'), 'model', 'opus', rev(join(dir, 'settings.json')))).toThrow(/can't read/)
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{ "env": ')
  })

  it('reads the home the entry runs with', () => {
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: '/tmp/own' }, '/home/u')).toBe(join('/tmp/own', 'settings.json'))
    expect(claudeSettingsPath({}, '/home/u')).toBe(join('/home/u', '.claude', 'settings.json'))
    // A relative folder is resolved by Claude against each project: no one file to edit.
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: 'claude-home' }, '/home/u')).toBeUndefined()
  })
})

describe("writing Claude's settings.json", () => {
  it('changes one setting, keeps every other key and the layout, and keeps a copy of the first version', () => {
    const dir = tempDir()
    const path = join(dir, 'settings.json')
    writeFileSync(path, ORIGINAL)
    writeClaudeSetting(path, 'env.ANTHROPIC_BASE_URL', 'https://proxy.example.com', rev(path))
    const text = readFileSync(path, 'utf8')
    const written = JSON.parse(text)
    expect(written).toEqual({
      permissions: { allow: ['Bash(git status)'] },
      env: { ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', OTHER: 'kept', ANTHROPIC_BASE_URL: 'https://proxy.example.com' },
      hooks: {}
    })
    // Four-space indentation, CRLF line endings and the final newline stay.
    expect(text).toContain('\r\n    "permissions": {')
    expect(text.endsWith('}\r\n')).toBe(true)
    expect(text.replace(/\r\n/g, '')).not.toContain('\n')
    expect(readFileSync(`${path}.mousse-bak`, 'utf8')).toBe(ORIGINAL)
    // A later edit leaves the copy of the original alone; removing drops only that key.
    writeClaudeSetting(path, 'env.ANTHROPIC_API_KEY', null, rev(path))
    expect(JSON.parse(readFileSync(path, 'utf8')).env).toEqual({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', OTHER: 'kept', ANTHROPIC_BASE_URL: 'https://proxy.example.com' })
    expect(readFileSync(`${path}.mousse-bak`, 'utf8')).toBe(ORIGINAL)
    // Replaced in one step: no temporary file is left beside it.
    expect(readdirSync(dir).sort()).toEqual(['settings.json', 'settings.json.mousse-bak'])
  })

  it('writes through an atomic replace; a failed write leaves the file as it was', () => {
    const dir = tempDir()
    const path = join(dir, 'settings.json')
    writeFileSync(path, ORIGINAL)
    const writeAtomic = vi.fn(() => { throw new Error('disk full') })
    expect(() => writeClaudeSetting(path, 'model', 'claude-opus-5-5', rev(path), { writeAtomic })).toThrow('disk full')
    expect(writeAtomic).toHaveBeenCalledWith(path, expect.stringContaining('"model": "claude-opus-5-5"'), expect.any(Number))
    expect(readFileSync(path, 'utf8')).toBe(ORIGINAL)
  })

  it('creates a missing file (no copy to keep) and validates what it is given', () => {
    const dir = tempDir()
    const path = join(dir, 'nested', 'settings.json')
    writeClaudeSetting(path, 'model', 'claude-opus-5-5', rev(path))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ model: 'claude-opus-5-5' })
    expect(existsSync(`${path}.mousse-bak`)).toBe(false)
    expect(() => writeClaudeSetting(path, 'env.ANTHROPIC_BASE_URL', 'not a url', rev(path))).toThrow(/URL/)
    expect(() => writeClaudeSetting(path, 'env.ANTHROPIC_BASE_URL', 'ftp://example.com', rev(path))).toThrow(/http/)
    expect(() => writeClaudeSetting(path, 'env.ANTHROPIC_API_KEY', '  ', rev(path))).toThrow(/empty/)
    expect(() => writeClaudeSetting(path, 'env.ANTHROPIC_API_KEY', 'two words', rev(path))).toThrow(/spaces/)
    expect(() => writeClaudeSetting(path, 'env.PATH', '/bin', rev(path))).toThrow(/does not edit/)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ model: 'claude-opus-5-5' })
  })

  it('refuses an edit made on a file that changed on disk since it was read', () => {
    const dir = tempDir()
    const path = join(dir, 'settings.json')
    writeFileSync(path, ORIGINAL)
    const read = rev(path)
    // The terminal (or an editor) rewrites the file while the page shows the old one.
    const theirs = ORIGINAL.replace('"hooks": {}', '"hooks": { "Stop": [] }')
    writeFileSync(path, theirs)
    expect(() => writeClaudeSetting(path, 'model', 'claude-opus-5-5', read)).toThrow('File changed, reload.')
    expect(readFileSync(path, 'utf8')).toBe(theirs)
    expect(existsSync(`${path}.mousse-bak`)).toBe(false)
    // A file created since the page saw none counts as changed too.
    const fresh = join(dir, 'fresh', 'settings.json')
    const none = rev(fresh)
    mkdirSync(join(dir, 'fresh'))
    writeFileSync(fresh, '{}')
    expect(() => writeClaudeSetting(fresh, 'model', 'x', none)).toThrow('File changed, reload.')
    // The revision is an opaque tag: no value of the file can be read from it.
    expect(read).toMatch(/^[0-9a-f]{24}$/)
  })

  it('never puts a value it refuses in the error', () => {
    const dir = tempDir()
    const path = join(dir, 'settings.json')
    const attempts: Array<[string, string]> = [
      ['env.ANTHROPIC_API_KEY', 'sk-ant leaked-secret-value'],
      ['env.ANTHROPIC_AUTH_TOKEN', `leaked-secret-value${'x'.repeat(5000)}`],
      ['env.ANTHROPIC_BASE_URL', 'https://leaked-secret-value example.com']
    ]
    for (const [key, value] of attempts) {
      let message = ''
      try {
        writeClaudeSetting(path, key, value, rev(path))
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toContain('leaked-secret-value')
    }
  })

  it('removing a setting that is not there leaves the file and makes no copy', () => {
    const dir = tempDir()
    const path = join(dir, 'settings.json')
    writeFileSync(path, ORIGINAL)
    writeClaudeSetting(path, 'model', null, rev(path))
    expect(readFileSync(path, 'utf8')).toBe(ORIGINAL)
    expect(existsSync(`${path}.mousse-bak`)).toBe(false)
  })

  it('keeps a copy that is already there, even one made while it was writing', () => {
    const dir = tempDir()
    const path = join(dir, 'settings.json')
    writeFileSync(path, ORIGINAL)
    const copyFile = vi.fn(() => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }) })
    writeClaudeSetting(path, 'model', 'claude-opus-5-5', rev(path), { copyFile })
    expect(copyFile).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(path, 'utf8')).model).toBe('claude-opus-5-5')
    // Any other failure to keep the copy stops the edit before the file is touched.
    const failing = vi.fn(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
    const before = readFileSync(path, 'utf8')
    expect(() => writeClaudeSetting(path, 'model', 'other', rev(path), { copyFile: failing })).toThrow('denied')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('edits the file a symbolic link points to, so the link stays', (context) => {
    const dir = tempDir()
    const dotfiles = join(dir, 'dotfiles')
    mkdirSync(dotfiles)
    const real = join(dotfiles, 'claude-settings.json')
    writeFileSync(real, ORIGINAL)
    const path = join(dir, 'settings.json')
    try {
      symlinkSync(real, path, 'file')
    } catch {
      // Windows without Developer Mode cannot make links.
      context.skip()
    }
    writeClaudeSetting(path, 'model', 'claude-opus-5-5', rev(path))
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(real, 'utf8')).model).toBe('claude-opus-5-5')
    expect(readFileSync(`${real}.mousse-bak`, 'utf8')).toBe(ORIGINAL)
  })

  it('refuses a settings.json that is not a file', () => {
    const dir = tempDir()
    const path = join(dir, 'settings.json')
    mkdirSync(path)
    expect(() => writeClaudeSetting(path, 'model', 'x', 'none')).toThrow(/not a file/)
  })

  it.skipIf(process.platform === 'win32')('keeps the permission bits of the file it replaces', () => {
    const dir = tempDir()
    const path = join(dir, 'settings.json')
    writeFileSync(path, ORIGINAL)
    chmodSync(path, 0o600)
    writeClaudeSetting(path, 'model', 'claude-opus-5-5', rev(path))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    // A new file holds a key from its first write: readable by its owner only.
    const fresh = join(dir, 'fresh.json')
    writeClaudeSetting(fresh, 'env.ANTHROPIC_API_KEY', KEY, rev(fresh))
    expect(statSync(fresh).mode & 0o777).toBe(0o600)
  })
})

const claudeAdapter = (): ProviderAdapter => ({
  driver: 'claude',
  capabilities: new PiStubAdapter().capabilities,
  configured: () => true,
  startTurn: async () => { throw new Error('unused') },
  interrupt: async () => 'not_active'
})

function harnessWithConfigDir(configDir: string, profileHome = tempDir()) {
  let value: unknown
  let seedVersion: number | undefined
  const instances = new ProviderInstanceService({
    store: { read: () => ({ instances: value, seedVersion }), write: (next) => { value = next.instances; seedVersion = next.seedVersion } },
    providerAuth: { credentials: { listProviderIds: () => [] } }
  })
  // The user's own Claude home, pointed at a temporary folder while the test runs: nothing here
  // touches the real ~/.claude.
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  const harness = testHarness({ drivers: [adapterDriver(new PiStubAdapter()), adapterDriver(claudeAdapter())], instances, profileHome })
  const restore = () => {
    harness.stop()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
  return { harness, restore }
}

describe('the gateway on a home shared with the terminal', () => {
  it('writes only with the say-so, answers masked, and reports the change to every client', async () => {
    const configDir = tempDir()
    const path = join(configDir, 'settings.json')
    writeFileSync(path, ORIGINAL)
    const { harness, restore } = harnessWithConfigDir(configDir)
    onTestFinished(restore)
    const view = harness.instances.vendorSettings('claude')
    expect(view).toMatchObject({ path, shared: true })
    const events: HarnessGatewayEvent[] = []
    harness.instances.subscribe((event) => events.push(event))

    expect(view?.confirmed).toBe(false)
    await expect(harness.instances.setVendorSetting({ instanceId: 'claude', key: 'model', value: 'claude-opus-5-5', expectedRevision: view!.revision! })).rejects.toThrow(/terminal/)
    expect(readFileSync(path, 'utf8')).toBe(ORIGINAL)

    const next = await harness.instances.setVendorSetting({ instanceId: 'claude', key: 'env.ANTHROPIC_API_KEY', value: 'sk-ant-new-key-value-1234', expectedRevision: view!.revision!, confirmShared: true })
    expect(JSON.parse(readFileSync(path, 'utf8')).env.ANTHROPIC_API_KEY).toBe('sk-ant-new-key-value-1234')
    expect(JSON.stringify(next)).not.toContain('new-key-value')
    expect(next.entries).toContainEqual({ key: 'env.ANTHROPIC_API_KEY', label: 'API key', secret: true, masked: '•••• 1234' })
    const snapshot = events.flatMap((event) => (event.type === 'snapshots' ? event.data.snapshots : [])).find((entry) => entry.instanceId === 'claude')
    expect(snapshot?.settingsFile).toMatchObject({ path, shared: true, revision: expect.any(Number) })
    // Snapshots go to every window and other computers: they name the file, never a value in it.
    expect(JSON.stringify(events)).not.toContain('new-key-value')
  })

  it('keeps the agreement per file, across restarts, and still refuses a stale edit', async () => {
    const configDir = tempDir()
    const profileHome = tempDir()
    const path = join(configDir, 'settings.json')
    writeFileSync(path, ORIGINAL)
    const first = harnessWithConfigDir(configDir, profileHome)
    const view = first.harness.instances.vendorSettings('claude')!
    const agreed = await first.harness.instances.setVendorSetting({ instanceId: 'claude', key: 'model', value: 'claude-opus-5-5', expectedRevision: view.revision!, confirmShared: true })
    expect(agreed.confirmed).toBe(true)
    first.restore()

    // After a restart the service still has the answer: an edit without the flag goes through.
    const second = harnessWithConfigDir(configDir, profileHome)
    onTestFinished(second.restore)
    const again = second.harness.instances.vendorSettings('claude')!
    expect(again.confirmed).toBe(true)
    await second.harness.instances.setVendorSetting({ instanceId: 'claude', key: 'model', value: 'claude-sonnet-5-5', expectedRevision: again.revision! })
    expect(JSON.parse(readFileSync(path, 'utf8')).model).toBe('claude-sonnet-5-5')
    // The page still holds the earlier revision: refused, the file stays.
    await expect(second.harness.instances.setVendorSetting({ instanceId: 'claude', key: 'model', value: 'stale', expectedRevision: again.revision! })).rejects.toThrow('File changed, reload.')
    expect(JSON.parse(readFileSync(path, 'utf8')).model).toBe('claude-sonnet-5-5')
  })

  it('asks again for another shared file', async () => {
    const profileHome = tempDir()
    const one = tempDir()
    writeFileSync(join(one, 'settings.json'), '{}')
    const first = harnessWithConfigDir(one, profileHome)
    await first.harness.instances.setVendorSetting({ instanceId: 'claude', key: 'model', value: 'a', expectedRevision: first.harness.instances.vendorSettings('claude')!.revision!, confirmShared: true })
    first.restore()
    const other = tempDir()
    writeFileSync(join(other, 'settings.json'), '{}')
    const second = harnessWithConfigDir(other, profileHome)
    onTestFinished(second.restore)
    const view = second.harness.instances.vendorSettings('claude')!
    expect(view.confirmed).toBe(false)
    await expect(second.harness.instances.setVendorSetting({ instanceId: 'claude', key: 'model', value: 'b', expectedRevision: view.revision! })).rejects.toThrow(/terminal/)
  })
})

describe('the settings-file methods', () => {
  const services = () => {
    const vendorSettings = vi.fn(() => ({ path: '/tmp/settings.json', shared: false, exists: true, entries: [{ key: 'env.ANTHROPIC_API_KEY', label: 'API key', secret: true, masked: '•••• 1234' }], addable: [] }))
    const setVendorSetting = vi.fn(async () => vendorSettings())
    return { mms: { harness: { instances: { vendorSettings, setVendorSetting } } }, vendorSettings, setVendorSetting }
  }
  const call = (mms: unknown, method: string, params: unknown, clientType = 'gui') =>
    dispatchMethod({ mms: mms as never, globalSequence: () => 0, connection: { clientType } as never }, method, params)

  it('answer a window on this computer, passing the confirmation on', async () => {
    const { mms, setVendorSetting } = services()
    expect(await call(mms, 'providers.instances.vendorSettings', { instanceId: 'claude' })).toMatchObject({ settings: { entries: [{ masked: '•••• 1234' }] } })
    await call(mms, 'providers.instances.setVendorSetting', { instanceId: 'claude', key: 'model', value: 'opus', expectedRevision: 'r1', confirmShared: true })
    expect(setVendorSetting).toHaveBeenCalledWith({ instanceId: 'claude', key: 'model', value: 'opus', expectedRevision: 'r1', confirmShared: true })
    await call(mms, 'providers.instances.setVendorSetting', { instanceId: 'claude', key: 'model', value: null, expectedRevision: 'r2' })
    expect(setVendorSetting).toHaveBeenLastCalledWith({ instanceId: 'claude', key: 'model', value: null, expectedRevision: 'r2' })
    // An edit that does not say which revision it was made on is refused.
    await expect(call(mms, 'providers.instances.setVendorSetting', { instanceId: 'claude', key: 'model', value: 'x' })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(setVendorSetting).toHaveBeenCalledTimes(2)
  })

  it('are never routed to another computer', () => {
    for (const method of ['providers.instances.vendorSettings', 'providers.instances.setVendorSetting'])
      expect(classifyRoutedMethod(method)?.kind).toBe('local')
  })

  it('refuse another computer, before reading or writing anything', async () => {
    const { mms, vendorSettings, setVendorSetting } = services()
    await expect(call(mms, 'providers.instances.vendorSettings', { instanceId: 'claude' }, 'bridge')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(call(mms, 'providers.instances.setVendorSetting', { instanceId: 'claude', key: 'model', value: 'x', expectedRevision: 'r1', confirmShared: true }, 'bridge')).rejects.toMatchObject({ code: 'forbidden' })
    expect(vendorSettings).not.toHaveBeenCalled()
    expect(setVendorSetting).not.toHaveBeenCalled()
  })
})
