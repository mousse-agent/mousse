import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { devGuiBridge } from '../src/mms/devgui/DevGuiBridge'
import { DevGuiTools } from '../src/mms/devgui/DevGuiTools'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'

afterEach(() => {
  // Keep the process singleton isolated between cases.
  devGuiBridge.resetForTests()
})

describe('DevGuiBridge', () => {
  it('round-trips a request through poll/respond', async () => {
    vi.stubEnv('MOUSSE_DEV_GUI_TOOLS', '1')
    try {
      const tools = new DevGuiTools()
      const pending = tools.execute('mousse_gui_console', { limit: 10 })
      const requests = devGuiBridge.poll()
      expect(requests).toHaveLength(1)
      expect(requests[0].action).toBe('console')
      expect(requests[0].payload).toEqual({ limit: 10, level: 'all' })
      devGuiBridge.respond(requests[0].id, { ok: true, text: '[ts] [log] hi (src)' })
      const result = await pending
      expect(result.isError).toBe(false)
      expect(result.text).toContain('hi')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('respond returns false for unknown ids', () => {
    expect(devGuiBridge.respond('missing', { ok: true })).toBe(false)
  })

  it('times out when the GUI never answers', async () => {
    vi.stubEnv('MOUSSE_DEV_GUI_TOOLS', '1')
    try {
      await expect(devGuiBridge.request('reload', {}, 20)).rejects.toThrow(
        /did not answer/
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('refuses to queue outside dev sessions', async () => {
    vi.stubEnv('MOUSSE_DEV_GUI_TOOLS', '0')
    try {
      await expect(devGuiBridge.request('reload')).rejects.toThrow(/only available in development/)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('DevGuiTools', () => {
  it('exposes the six dev GUI tool definitions', () => {
    const tools = new DevGuiTools()
    const names = tools.getToolDefinitions().map((tool) => tool.name).sort()
    expect(names).toEqual([
      'mousse_gui_console',
      'mousse_gui_devtools',
      'mousse_gui_evaluate',
      'mousse_gui_reload',
      'mousse_gui_screenshot',
      'mousse_gui_status'
    ])
    for (const name of names) expect(tools.isDevGuiTool(name)).toBe(true)
    expect(tools.isDevGuiTool('read')).toBe(false)
  })

  it('rejects unknown tools', async () => {
    const tools = new DevGuiTools()
    const result = await tools.execute('nope', {})
    expect(result.isError).toBe(true)
  })

  it('validates evaluate args without touching the bridge', async () => {
    const tools = new DevGuiTools()
    expect((await tools.execute('mousse_gui_evaluate', {})).isError).toBe(true)
    expect((await tools.execute('mousse_gui_evaluate', { expression: 'x'.repeat(9000) })).isError).toBe(
      true
    )
    expect(devGuiBridge.poll()).toHaveLength(0)
  })

  it('returns screenshot images as vision blocks', async () => {
    vi.stubEnv('MOUSSE_DEV_GUI_TOOLS', '1')
    try {
      const tools = new DevGuiTools()
      const pending = tools.execute('mousse_gui_screenshot', {})
      const [req] = devGuiBridge.poll()
      devGuiBridge.respond(req.id, {
        ok: true,
        text: 'Screenshot captured.',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        savedPath: '/tmp/shot.png',
        width: 10,
        height: 10
      })
      const result = await pending
      expect(result.isError).toBe(false)
      expect(result.image).toEqual({ mimeType: 'image/png', data: 'iVBORw0KGgo=' })
      expect(result.text).toContain('/tmp/shot.png')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('status is instant and reports attach state without queueing', async () => {
    vi.stubEnv('MOUSSE_DEV_GUI_TOOLS', '1')
    try {
      const tools = new DevGuiTools()
      const result = await tools.execute('mousse_gui_status', {})
      expect(result.isError).toBe(false)
      expect(result.text).toContain('dev window attached: NO')
      expect(result.text).toContain('last GUI poll: never')
      // Status never queues — nothing for a GUI to pick up.
      expect(devGuiBridge.poll()).toHaveLength(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('fails fast instead of hanging when no GUI is attached', async () => {
    vi.stubEnv('MOUSSE_DEV_GUI_TOOLS', '1')
    try {
      const started = Date.now()
      await expect(
        devGuiBridge.request('console', { limit: 10 }, 30_000, { graceMs: 30 })
      ).rejects.toThrow(/No dev GUI is attached/)
      // Fast failure: well under the 30s tool timeout.
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(devGuiBridge.poll()).toHaveLength(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('DevGui protocol round-trip', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let ownerToken: string
  let endpoint: string

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-devgui-'))
    process.env.MOUSSE_HOME = home
    vi.stubEnv('MOUSSE_DEV_GUI_TOOLS', '1')
    mms = await MousseMainService.create({
      homeDir: home,
      headless: true,
      ownerKind: 'test'
    })
    await mms.start()
    ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    endpoint = await server.start()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    devGuiBridge.resetForTests()
    await server.stop()
    await mms.stop()
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    delete process.env.MOUSSE_HOME
  })

  async function guiClient(): Promise<LocalMmsClient> {
    const c = new LocalMmsClient({ homeDir: home, ownerToken, endpoint, clientType: 'gui' })
    await c.connect()
    return c
  }

  it('serves a tool request to a polling GUI client and back', async () => {
    const tools = new DevGuiTools()
    const pending = tools.execute('mousse_gui_evaluate', { expression: 'document.title' })
    const gui = await guiClient()
    try {
      const pollRes = await gui.request<{
        requests: Array<{ id: string; action: string; payload: Record<string, unknown> }>
      }>('gui.devtoolsPoll')
      expect(pollRes.requests).toHaveLength(1)
      expect(pollRes.requests[0].action).toBe('evaluate')
      expect(pollRes.requests[0].payload).toMatchObject({ expression: 'document.title' })
      const respondRes = await gui.request<{ ok: boolean }>('gui.devtoolsRespond', {
        requestId: pollRes.requests[0].id,
        ok: true,
        text: 'Mousse'
      })
      expect(respondRes.ok).toBe(true)
      const result = await pending
      expect(result.isError).toBe(false)
      expect(result.text).toBe('Mousse')
    } finally {
      await gui.close()
    }
  })

  it('status shows attached after a GUI poll', async () => {
    const gui = await guiClient()
    try {
      await gui.request('gui.devtoolsPoll')
      const tools = new DevGuiTools()
      const status = await tools.execute('mousse_gui_status', {})
      expect(status.text).toContain('dev window attached: yes')
    } finally {
      await gui.close()
    }
  })
})
