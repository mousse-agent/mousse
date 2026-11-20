/**
 * Owner check `phase1b.editor-app` (design §9.2): an editor connection over the engine with v1 networking off. The
 * caller opens it through the same local methods `mousse-cli net ssh-proxy` uses; it rides a `mousse.tunnel` stream
 * to the owner's own `EditorTunnels`, which hand it to the owner's SSH endpoint (here a stand-in that echoes and
 * records). With the device's editor switch off the open is refused `editor_off` and the endpoint serves nothing;
 * turning the switch off, a block, a removal and turning "Work on threads" off each close an open tunnel with their
 * reason and sweep what the endpoint started for that device.
 *
 * Its controls: `tunnel-ignores-editor` (the refusal skips the editor switch) fails it with `tunnel_without_editor`;
 * `no-reconcile` (engine rights changes leave tunnels open) with `tunnel_outlived_right`.
 * `scripts/net-engine-check.mjs phase1b.editor-app` runs it and prints the marker.
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { NodeId } from '../../../src/shared/net'
import type { EditorEndpointPort } from '../../../src/mms/net/editor/endpoint/port'
import { KEY_B } from '../../net/ssh/bed'
import { eventually, Fabric, refused, step, type Computer } from './harness'

// Mousse's editor settings must not read the real ssh: the check that `~/.ssh/config` can still be read always passes.
vi.mock('../../../src/mms/net/editor/sshConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/mms/net/editor/sshConfig')>()),
  systemSshVerifier: () => async () => ({ ok: true as const })
}))

/** The owner's SSH endpoint: it echoes, and records what it served, what ended and what each sweep allowed. */
function standInEndpoint() {
  const served: Array<{ node: NodeId; forced: boolean[] }> = []
  const swept: NodeId[][] = []
  const endpoint: EditorEndpointPort = {
    available: () => true,
    hostKeys: () => [KEY_B],
    serve(stream: Duplex, node: NodeId) {
      const entry = { node, forced: [] as boolean[] }
      served.push(entry)
      stream.on('error', () => {})
      stream.pipe(stream)
      return {
        end: (forced) => {
          entry.forced.push(forced)
          stream.destroy()
        },
        counts: () => ({ exec: 0, shell: 0, sftp: 0, forwards: 0 })
      }
    },
    killDevice: async () => undefined,
    sweep: async (allowed) => swept.push([...allowed]) * 0
  }
  return { endpoint, served, swept }
}

describe('phase1b.editor-app', () => {
  const fabric = new Fabric()
  const far = standInEndpoint()
  let owner: Computer
  beforeAll(async () => {
    // The person's home is a throwaway folder: the editor settings write its `~/.ssh` only.
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'editor-app-home-')))
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('HOME', home)
    owner = await fabric.computer('owner', (mms) => {
      mms.netEngine.editorTest = { endpoint: far.endpoint }
    })
  }, 120_000)
  afterAll(async () => {
    await fabric.close()
    vi.unstubAllEnvs()
  }, 120_000)

  /** A caller paired with the owner and connected, with its editor switch there as given. */
  async function caller(name: string, editor: boolean) {
    const computer = await fabric.computer(name)
    const { callerOnOwner, ownerOnCaller } = await fabric.pair(owner, computer)
    await fabric.connect(computer, ownerOnCaller)
    if (editor) await owner.dispatch('bridge.policy', { node: callerOnOwner, editor: true }, true)
    // The caller's editor settings, with an alias for the owner: the host keys are pinned under it.
    const prepared = await computer.dispatch('net.editor.ssh.prepare', {}, true)
    expect(prepared).toMatchObject({ ok: true })
    return { computer, onOwner: callerOnOwner, ownerOn: ownerOnCaller }
  }
  /** A tunnel opened from `computer` to the owner, through its Net service as ssh-proxy's local methods do. */
  const open = (computer: Computer, node: NodeId) => computer.mms.net.openEditorTunnel(node)

  it('carries an editor connection with v1 off, to the owner\'s own endpoint, through the local methods', async () => {
    const one = await caller('one', true)
    expect(one.computer.mms.net.featureEnabled('netBridge')).toBe(false)
    await step('tunnel_failed', async () => {
      const opened = await one.computer.dispatch('net.editor.tunnel.open', { node: one.ownerOn }, true)
      expect(opened).toMatchObject({ ok: true })
      await one.computer.dispatch('net.editor.tunnel.write', { tunnel: opened.handle, data: Buffer.from('hello').toString('base64') }, true)
      let echoed = ''
      await eventually(async () => {
        const read = await one.computer.dispatch('net.editor.tunnel.read', { tunnel: opened.handle, waitMs: 0 }, true)
        if (read.data) echoed += Buffer.from(read.data, 'base64').toString()
        expect(echoed).toBe('hello')
      })
      expect(far.served.at(-1)?.node).toBe(one.onOwner)
      await one.computer.dispatch('net.editor.tunnel.close', { tunnel: opened.handle }, true)
    })
    // The host keys came over the engine and were pinned under the owner's alias by the first open.
    const tunnel = await open(one.computer, one.ownerOn)
    expect(tunnel.tunnel.hostKeys).toEqual([KEY_B])
    expect(tunnel.info.hostKey).toBe('present')
    tunnel.tunnel.close()
  }, 120_000)

  it('refuses an open with the device\'s editor switch off, and the endpoint serves nothing', async () => {
    const two = await caller('two', false)
    const before = far.served.length
    const error = await refused('tunnel_without_editor', () => open(two.computer, two.ownerOn))
    expect(error).toMatchObject({ reason: 'editor_off' })
    expect(far.served.length).toBe(before)
  }, 120_000)

  it('holds the routed editor rows to the same refusal; the ask to turn the editor on works while it is off', async () => {
    const four = await caller('four', false)
    const row = owner.mms.netEngine.peerRows().find((entry) => entry.localId === four.onOwner)!
    const who = {
      source: 'engine' as const,
      node: four.onOwner,
      user: owner.mms.net.runtime().identity.self()!.user,
      role: 'owner' as const,
      grant: row.grant,
      endpoint: row.endpoint
    }
    const call = (method: string) => () =>
      owner.mms.netEngine.authorizeEngine({ method, family: 'routed', capability: 'settings' } as never, who, 'settings')
    await step('tunnel_without_editor', () => expect(call('routed.editor.folder')).toThrow(expect.objectContaining({ code: 'forbidden' })))
    expect(call('routed.editor.ask')).not.toThrow()
    await owner.dispatch('bridge.policy', { node: four.onOwner, editor: true }, true)
    expect(call('routed.editor.folder')).not.toThrow()
    // A grant that is not the pairing's live one is refused before any of this.
    expect(() => owner.mms.netEngine.authorizeEngine({ method: 'routed.editor.ask', family: 'routed', capability: 'settings' } as never, { ...who, grant: 'stale' }, 'settings')).toThrow()
  }, 120_000)

  it.each([
    ['the editor switch off', 'editor_off', (node: NodeId) => owner.dispatch('bridge.policy', { node, editor: false }, true)],
    ['a block', 'blocked', (node: NodeId) => owner.dispatch('bridge.policy', { node, blocked: true }, true)],
    ['a removal', undefined, (node: NodeId) => owner.dispatch('netEngine.remove', { node }, true)],
    // The owner's own switch, for every device: with v1 off, the new networking's Devices group has it. It is turned
    // back on after the case.
    ['"Work on threads" off', 'setting_off', () => owner.dispatch('netEngine.workOnThreads', { enabled: false }, true)]
  ] as const)('%s closes an open tunnel and sweeps what the endpoint started for it', async (_what, reason, change) => {
    const three = await caller(`three-${reason ?? 'removed'}`, true)
    const { tunnel } = await open(three.computer, three.ownerOn)
    const served = far.served.at(-1)!
    expect(served.node).toBe(three.onOwner)
    const sweeps = far.swept.length
    await change(three.onOwner)
    if (reason === 'setting_off') {
      onTestFinished(() => owner.dispatch('netEngine.workOnThreads', { enabled: true }, true))
      expect((await owner.dispatch('netEngine.status', {}, true)).workOnThreads).toBe(false)
    }
    await step('tunnel_outlived_right', async () => {
      const why = await Promise.race([tunnel.closed, new Promise((resolve) => setTimeout(() => resolve('open'), 10_000))])
      // A removal closes the pairing's connections as its row goes: the caller hears either first.
      expect(reason ? [reason] : ['offline', 'blocked']).toContain(why)
      await eventually(() => expect(served.forced.length).toBeGreaterThan(0))
      await eventually(() => {
        const after = far.swept.slice(sweeps)
        expect(after.length).toBeGreaterThan(0)
        expect(after.at(-1)).not.toContain(three.onOwner)
      })
    })
  }, 120_000)
})
