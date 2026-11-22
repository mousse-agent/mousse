/**
 * Computer use: threads get it by default, a thread a bot started (or anything below it) only while that bot holds
 * "use the computer", and nothing while Settings → Computer use is off. Cua Driver is found (the chosen file, the PATH,
 * the installer's folder) or installed, and Settings is told what was found.
 */
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ComputerUseDriver, locateDriver, parseDriverVersion } from '../src/mms/computerUse/ComputerUseDriver'
import { computerTools, computerUseAllowed, driverOutcome, type ComputerUseLineage, type ComputerUseToolHost } from '../src/mms/run/mcp/appTools/computer'
import type { AppToolHost } from '../src/mms/run/mcp/appTools/host'
import type { ComputerUseStatus } from '../src/shared/computerUse'
import { asSettingsPartial } from '../src/mms/protocol/validators'
import { normalizeAgentAccessSettings } from '../src/shared/settings'

describe('which threads may use the computer', () => {
  // Bot "yes" holds the permission, bot "no" doesn't.
  const threads: Record<string, ComputerUseLineage> = {
    plain: {},
    child: { lineage: { parentThreadId: 'plain' } },
    'bot-yes': { startedByBot: { botId: 'yes' } },
    'bot-no': { startedByBot: { botId: 'no' } },
    'sub-of-bot-no': { lineage: { parentThreadId: 'bot-no' } },
    'started-by-agent-of-bot-no': { createdByThreadId: 'bot-no' },
    'deep-under-bot-yes': { lineage: { parentThreadId: 'sub-of-bot-yes' } },
    'sub-of-bot-yes': { lineage: { parentThreadId: 'bot-yes' } },
    // The nearest bot decides: "no" started a thread that "yes"'s agent then started work below.
    'bot-yes-under-bot-no': { startedByBot: { botId: 'yes' }, lineage: { parentThreadId: 'bot-no' } },
    // Its parent is gone: it may have been a bot's thread.
    orphan: { lineage: { parentThreadId: 'deleted' } },
    'loop-a': { lineage: { parentThreadId: 'loop-b' } },
    'loop-b': { lineage: { parentThreadId: 'loop-a' } }
  }
  const allowed = (id: string) => computerUseAllowed(id, (thread) => threads[thread], (bot) => bot === 'yes')

  it.each([
    ['plain', true],
    ['child', true],
    ['not-in-store', true],
    ['bot-yes', true],
    ['bot-no', false],
    ['sub-of-bot-no', false],
    ['started-by-agent-of-bot-no', false],
    ['deep-under-bot-yes', true],
    ['bot-yes-under-bot-no', true],
    ['orphan', false],
    ['loop-a', false]
  ] as const)('%s → %s', (id, expected) => {
    expect(allowed(id)).toBe(expected)
  })

  it('a chain longer than any real lineage allows nothing', () => {
    const chain = (id: string): ComputerUseLineage => ({ lineage: { parentThreadId: `t${Number(id.slice(1)) + 1}` } })
    expect(computerUseAllowed('t0', chain, () => true)).toBe(false)
  })
})

describe('the computer tools a thread is listed and may call', () => {
  function tools(opts: { enabled?: boolean; known?: ComputerUseStatus['state']; allowed?: (threadId: string) => boolean }) {
    const cu: ComputerUseToolHost = {
      enabled: () => opts.enabled ?? true,
      known: () => (opts.known ? { state: opts.known, enabled: true, installable: true } : undefined),
      allowedFor: opts.allowed ?? (() => true),
      listTools: async () => ({ tools: [{ name: 'click', description: 'Clicks an element. More text.', inputSchema: {} }], instructions: 'Read the window first.' }),
      call: vi.fn(async () => ({ content: [{ type: 'text', text: 'clicked' }] }))
    }
    const list = computerTools({ computerUse: () => cu } as unknown as AppToolHost)
    return { cu, list, listedFor: (threadId: string) => list.filter((tool) => tool.listed?.({ threadId } as never) !== false).map((tool) => tool.name) }
  }

  it('lists both tools for a thread, none for a thread a bot without it started, and none while off or the driver is missing', () => {
    expect(tools({}).listedFor('t1')).toEqual(['computer_tools', 'computer_use'])
    expect(tools({ known: 'found' }).listedFor('t1')).toEqual(['computer_tools', 'computer_use'])
    expect(tools({ allowed: (id) => id !== 'bot-thread' }).listedFor('bot-thread')).toEqual([])
    expect(tools({ enabled: false }).listedFor('t1')).toEqual([])
    expect(tools({ known: 'missing' }).listedFor('t1')).toEqual([])
  })

  it('refuses a call from a thread that may not use it, and runs one that may', async () => {
    const denied = tools({ allowed: () => false })
    expect(denied.list[1].available?.({ threadId: 'bot-thread' } as never)).toMatch(/started by a bot/)
    const off = tools({ enabled: false })
    expect(off.list[1].available?.({ threadId: 't1' } as never)).toMatch(/off in Settings/)
    const ok = tools({})
    expect(ok.list[1].available?.({ threadId: 't1' } as never)).toBe(true)
    const result = await ok.list[1].handler({ tool: 'click', arguments: { element: 3 } }, { signal: new AbortController().signal } as never)
    expect(ok.cu.call).toHaveBeenCalledWith('click', { element: 3 }, expect.any(AbortSignal))
    expect(result).toMatchObject({ text: 'clicked' })
    const listing = await ok.list[0].handler({}, {} as never)
    expect(listing.text).toContain('Read the window first.')
    expect(listing.text).toContain('- click: Clicks an element.')
  })

  it("keeps a driver result's images within bounds and says what it left out", () => {
    const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
    const outcome = driverOutcome({ content: [{ type: 'text', text: 'shot' }, image, image, image, image, image, { type: 'image', data: 'x'.repeat(2_000_001), mimeType: 'image/png' }] })
    expect(outcome.images).toHaveLength(4)
    expect(outcome.text).toBe('shot\n[2 more images left out]')
  })
})

describe('finding Cua Driver', () => {
  const home = join('/home', 'me')

  it('takes a chosen file only, the PATH next, then the installer folder', () => {
    const onPath = join('/opt', 'tools', 'cua-driver')
    const installed = join(home, '.local', 'bin', 'cua-driver')
    const env = { PATH: ['/usr/bin', join('/opt', 'tools')].join(process.platform === 'win32' ? ';' : ':') }
    const has = (...files: string[]) => (path: string) => files.includes(path)
    expect(locateDriver({ chosen: '/mine/cua-driver', platform: 'linux', env, home, exists: has('/mine/cua-driver', onPath) })).toEqual({ path: '/mine/cua-driver', source: 'chosen' })
    // A chosen file that is gone is not replaced by another one.
    expect(locateDriver({ chosen: '/mine/cua-driver', platform: 'linux', env, home, exists: has(onPath) })).toBeUndefined()
    expect(locateDriver({ platform: 'linux', env, home, exists: has(onPath, installed) })).toEqual({ path: onPath, source: 'path' })
    expect(locateDriver({ platform: 'linux', env, home, exists: has(installed) })).toEqual({ path: installed, source: 'default' })
    expect(locateDriver({ platform: 'linux', env, home, exists: has() })).toBeUndefined()
  })

  it("on Windows, looks for cua-driver.exe in the installer's folder under LOCALAPPDATA", () => {
    const exe = join('C:\\Users\\me\\AppData\\Local', 'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe')
    expect(locateDriver({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, home, exists: (path) => path === exe })).toEqual({ path: exe, source: 'default' })
  })

  it('reads the version the driver prints', () => {
    expect(parseDriverVersion('cua-driver 0.38.0 — Cua Driver for Windows')).toBe('0.38.0')
    expect(parseDriverVersion('cua-driver v1.2.3-beta.1\n')).toBe('1.2.3-beta.1')
    expect(parseDriverVersion('no version here')).toBeUndefined()
  })
})

describe('what Settings is told about the driver', () => {
  const exe = join('/home', 'me', '.local', 'bin', 'cua-driver')

  function driver(opts: { files?: string[]; version?: () => Promise<string>; installer?: () => Promise<void>; chosen?: string }) {
    const files = new Set(opts.files ?? [])
    const runInstaller = vi.fn(async () => { await opts.installer?.(); files.add(exe) })
    const telemetryOff = vi.fn(async () => undefined)
    const d = new ComputerUseDriver({
      settings: () => ({ enabled: true, ...(opts.chosen ? { driverPath: opts.chosen } : {}) }),
      platform: 'linux', env: { PATH: '' }, home: join('/home', 'me'),
      version: opts.version ?? (async () => 'cua-driver 0.38.0 — test'),
      runInstaller,
      telemetryOff,
      exists: (path: string) => files.has(path)
    })
    return { d, runInstaller, telemetryOff }
  }

  it('says installed with its version and where it came from, and turns its telemetry off once', async () => {
    const { d, telemetryOff } = driver({ files: [exe] })
    expect(await d.status(true)).toMatchObject({ state: 'found', version: '0.38.0', path: exe, source: 'default' })
    await d.status(true)
    expect(telemetryOff.mock.calls).toEqual([[exe]])
  })

  it("knows at the first listing that no driver is there, so the tool list doesn't change at the next turn", async () => {
    expect(driver({}).d.known()).toMatchObject({ state: 'missing' })
    const present = driver({ files: [exe] })
    expect(present.d.known()).toBeUndefined()
    await present.d.status()
    expect(present.d.known()).toMatchObject({ state: 'found', version: '0.38.0' })
  })

  it('says missing with the install command, installs once for two clicks, then says installed', async () => {
    const { d, runInstaller } = driver({})
    expect(await d.status(true)).toMatchObject({ state: 'missing', installable: true, installCommand: expect.stringContaining('cua.ai/driver/install.sh') })
    const [first, second] = await Promise.all([d.install(), d.install()])
    expect(runInstaller).toHaveBeenCalledTimes(1)
    expect(first).toMatchObject({ state: 'found', version: '0.38.0' })
    expect(second).toBe(first)
  })

  it('never runs an action twice when the driver goes away during it; the next call starts it again', async () => {
    const callTool = vi.fn(async () => { throw new Error('Connection closed') })
    const connect = vi.fn(async () => ({ listTools: async () => [], instructions: () => undefined, callTool, close: async () => undefined }))
    const d = new ComputerUseDriver({ settings: () => ({ enabled: true }), platform: 'linux', env: { PATH: '' }, home: join('/home', 'me'), telemetryOff: async () => undefined, version: async () => 'cua-driver 0.38.0', exists: (path) => path === exe, connect })
    await expect(d.call('click', {}, new AbortController().signal)).rejects.toThrow(/may or may not have run/)
    expect(callTool).toHaveBeenCalledTimes(1)
    await expect(d.call('click', {}, new AbortController().signal)).rejects.toThrow()
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('runs nothing when computer use is switched off while the driver is being checked', async () => {
    const setting = { enabled: true }
    const connect = vi.fn()
    const d = new ComputerUseDriver({
      settings: () => setting, platform: 'linux', env: { PATH: '' }, home: join('/home', 'me'), telemetryOff: async () => undefined, exists: (path) => path === exe, connect,
      version: async () => { setting.enabled = false; return 'cua-driver 0.38.0' }
    })
    await expect(d.call('click', {}, new AbortController().signal)).rejects.toThrow(/off in Settings/)
    expect(connect).not.toHaveBeenCalled()
  })

  it('an older look that ends after a newer one does not replace it', async () => {
    const other = join('/opt', 'cua-driver')
    const setting: { enabled: boolean; driverPath?: string } = { enabled: true }
    let finishOld: (output: string) => void = () => undefined
    const d = new ComputerUseDriver({
      settings: () => setting, platform: 'linux', env: { PATH: '' }, home: join('/home', 'me'), telemetryOff: async () => undefined, exists: (path) => path === exe || path === other,
      version: (path) => (path === exe ? new Promise<string>((resolve) => { finishOld = resolve }) : Promise.resolve('cua-driver 0.39.0'))
    })
    const old = d.status(true)
    setting.driverPath = other
    expect(await d.status(true)).toMatchObject({ path: other, version: '0.39.0' })
    finishOld('cua-driver 0.38.0')
    await old
    expect(d.known()).toMatchObject({ path: other, version: '0.39.0' })
  })

  it("says it didn't start when the driver fails to run, and says why an install failed", async () => {
    expect(await driver({ files: [exe], version: async () => { throw new Error('spawn EACCES') } }).d.status(true)).toMatchObject({ state: 'broken', error: 'spawn EACCES' })
    const failing = driver({ installer: async () => { throw new Error('network down') } })
    expect(await failing.d.install()).toMatchObject({ state: 'missing', error: 'The installer failed: network down' })
  })
})

describe('the computer use settings', () => {
  it('are on by default, keep a valid chosen driver and drop anything else', () => {
    expect(normalizeAgentAccessSettings().computerUse).toBe(true)
    expect(normalizeAgentAccessSettings({ computerUse: false }).computerUse).toBe(false)
    const chosen = process.platform === 'win32' ? 'C:\\Tools\\cua-driver.exe' : '/opt/cua-driver'
    expect(normalizeAgentAccessSettings({ computerDriver: chosen }).computerDriver).toBe(chosen)
    for (const bad of ['cua-driver', 'bin/cua-driver', '', `${chosen}\nrm -rf`])
      expect(normalizeAgentAccessSettings({ computerDriver: bad }).computerDriver, JSON.stringify(bad)).toBeUndefined()
  })

  it('the settings protocol takes the switch and a driver path, or an empty path to clear it, and refuses the rest', () => {
    const chosen = process.platform === 'win32' ? 'C:\\Tools\\cua-driver.exe' : '/opt/cua-driver'
    expect(asSettingsPartial({ agentAccess: { computerUse: false, computerDriver: chosen } })).toEqual({ agentAccess: { computerUse: false, computerDriver: chosen } })
    expect(() => asSettingsPartial({ agentAccess: { computerDriver: '' } })).not.toThrow()
    for (const bad of [{ computerUse: 'yes' }, { computerDriver: 'relative/cua-driver' }, { computerDriver: 7 }])
      expect(() => asSettingsPartial({ agentAccess: bad }), JSON.stringify(bad)).toThrow(/agentAccess/)
  })
})
