import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm, readFile, readdir, chmod } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TransportAddonContext } from '../../../src/mms/net/contracts'
import { TransportRegistry } from '../../../src/mms/net/transports/registry'
import {
  commandText,
  parseServeStatus,
  serveFailure,
  tailscaleAddon,
  TailscaleTransport
} from '../../../src/mms/net/transports/tailscale'
import { cloudflaredAddon, CloudflaredTransport } from '../../../src/mms/net/transports/cloudflared'
import { systemClock } from '../../../src/mms/net/clock'
import { FakeClock } from '../harness/FakeClock'
import { fakeTailscale, type FakeTailscale } from '../harness/fakeTailscale'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'mousse-addon-'))
  cleanup.push(() => rm(value, { recursive: true, force: true }))
  return value
}
async function binary(where: string, name: string, code: string) {
  const file = join(where, name)
  await writeFile(file, `#!${process.execPath}\n${code}`, { mode: 0o700 })
  return file
}
async function until(predicate: () => boolean) {
  for (let index = 0; index < 100 && !predicate(); index++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}

describe('transport registry', () => {
  it('accepts only registered in-tree add-ons and validates exact settings without coercion', async () => {
    const registry = new TransportRegistry({ clock: systemClock, profileDir: await directory() })
    cleanup.push(() => registry.teardown())
    registry.register(tailscaleAddon)
    registry.register(cloudflaredAddon)
    expect(registry.manifests().map((value) => value.id)).toEqual(['tailscale', 'cloudflared'])
    expect(() => registry.register(tailscaleAddon)).toThrow(/duplicate/)
    for (const config of [
      { id: 'unknown', enabled: true, settings: {} },
      { id: 'tailscale', enabled: true, settings: { port: '1' } },
      { id: 'cloudflared', enabled: true, settings: { mode: 'quick', token: 'secret' } },
      { id: 'cloudflared', enabled: true, settings: { mode: 'named' } }
    ])
      expect(() => registry.validate(config)).toThrow(/settings/)
    await registry.configure({ id: 'cloudflared', enabled: false, settings: { mode: 'quick' } })
    expect(registry.statuses()).toEqual([
      { id: 'cloudflared', status: { state: 'disabled', routes: [] } }
    ])
  })
  it('provisions selected settings through the real fake-binary process, then disables cleanly', async () => {
    const where = await directory(),
      fake = await binary(
        where,
        'tailscale',
        "console.log(JSON.stringify({BackendState:'Running',Self:{TailscaleIPs:['127.0.0.1']}}))"
      )
    const registry = new TransportRegistry({ clock: systemClock, profileDir: where })
    cleanup.push(() => registry.teardown())
    registry.register(tailscaleAddon)
    const active = await registry.configure({
      id: 'tailscale',
      enabled: true,
      settings: { binary: fake, port: 0 }
    })
    await active!.listen((raw) => raw.destroy())
    expect(active!.status().routes[0]).toMatchObject({
      transport: 'direct',
      address: expect.stringMatching(/127\.0\.0\.1/),
      priority: 10
    })
    await registry.configure({ id: 'tailscale', enabled: false, settings: { binary: fake } })
    expect(registry.transports()).toEqual([])
    expect(active!.status().state).toBe('disabled')
  })
})

describe('Tailscale process detection', () => {
  it('fails with guided setup when missing or logged out, without executing account-changing commands', async () => {
    const where = await directory(),
      log = join(where, 'args.json'),
      fake = await binary(
        where,
        'tailscale',
        `require('fs').writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({BackendState:'NeedsLogin'}))`
      )
    const transport = new TailscaleTransport({ binary: fake })
    cleanup.push(() => transport.teardown())
    await expect(transport.provision()).rejects.toMatchObject({ code: 'route_unreachable' })
    expect(JSON.parse(await readFile(log, 'utf8'))).toEqual(['status', '--json'])
    expect(transport.status()).toMatchObject({
      state: 'failed',
      detail: expect.stringMatching(/sign into/)
    })
    const missing = new TailscaleTransport({ binary: join(where, 'absent') })
    cleanup.push(() => missing.teardown())
    await expect(missing.provision()).rejects.toMatchObject({ code: 'route_unreachable' })
  })
})

describe('Tailscale Serve', () => {
  const SERVE_PORT = 47890
  const TAILNET = { name: 'example.ts.net', node: 'node-1' }
  async function freePort() {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    await new Promise((resolve) => server.close(resolve))
    return port
  }
  async function setup(options: { listening?: boolean } = {}) {
    const where = await directory(),
      fake = await fakeTailscale(where),
      port = await freePort()
    cleanup.push(async () => fake.restore())
    const settings = { binary: fake.binary, mode: 'serve' as const, port, servePort: SERVE_PORT },
      entry = { TCPForward: `127.0.0.1:${port}` }
    let record: unknown
    /** Every change to the record, with how many commands had run by then. */
    const saved: Array<{ state: string; commands: number }> = []
    const store = {
      record: () => record,
      remember: (value: unknown) => {
        record = value
        saved.push({ state: (value as { state: string }).state, commands: fake.commands().length })
      },
      forget: () => {
        record = undefined
        saved.push({ state: 'forgotten', commands: fake.commands().length })
      }
    }
    const context: TransportAddonContext = {
      clock: systemClock,
      profileDir: where,
      ...store,
      listening: () => options.listening ?? true
    }
    const serve = tailscaleAddon.actions!.serve
    const applied = (state: 'pending' | 'applied' | 'removing' = 'applied', more = {}) => ({
      servePort: SERVE_PORT,
      port,
      tailnet: TAILNET,
      state,
      ...more
    })
    return {
      fake,
      settings,
      entry,
      context,
      serve,
      saved,
      applied,
      recorded: () => record as { state: string; completionTried?: boolean } | undefined,
      remember: (value: unknown) => {
        record = value
      },
      transport: () => {
        const created = new TailscaleTransport(settings, systemClock, store)
        cleanup.push(() => created.teardown())
        return created
      }
    }
  }
  const ran = (fake: FakeTailscale) => fake.commands().map((args) => args.join(' '))
  const writes = (fake: FakeTailscale) =>
    ran(fake).filter((line) => line.includes('--bg') || line.includes(' off'))
  /** Waits for the Serve check that follows `listen` to settle. */
  async function settled(transport: TailscaleTransport) {
    for (let index = 0; index < 400; index++) {
      if (transport.status().state !== 'provisioning') return transport.status()
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('the Serve check never settled')
  }
  async function started(transport: TailscaleTransport) {
    await transport.provision()
    await transport.listen((raw) => raw.destroy())
    return settled(transport)
  }

  it('lists its actions in the manifest', () => {
    const registry = new TransportRegistry({ clock: systemClock, profileDir: tmpdir() })
    registry.register(tailscaleAddon)
    registry.register(cloudflaredAddon)
    const [tailscale, cloudflared] = registry.manifests()
    expect(tailscale.actions).toEqual([{ id: 'serve', title: 'Serve' }])
    expect(cloudflared.actions).toBeUndefined()
    expect(registry.action('tailscale', 'serve')).toBe(tailscaleAddon.actions!.serve)
    expect(registry.action('tailscale', 'toString')).toBeUndefined()
    expect(registry.action('cloudflared', 'serve')).toBeUndefined()
  })

  it('needs fixed ports in serve mode, refuses a Serve port without it, and never uses a Funnel port', () => {
    const registry = new TransportRegistry({ clock: systemClock, profileDir: tmpdir() })
    registry.register(tailscaleAddon)
    expect(() =>
      registry.validate({ id: 'tailscale', enabled: true, settings: { servePort: 0 } })
    ).toThrow(/settings/)
    expect(() => new TailscaleTransport({ mode: 'serve', servePort: 47890 })).toThrow(/fixed/)
    expect(() => new TailscaleTransport({ mode: 'serve', port: 47891 })).toThrow(/fixed/)
    expect(() => new TailscaleTransport({ port: 47891, servePort: 47890 })).toThrow(/Serve mode/)
    expect(() => new TailscaleTransport({ mode: 'bind', port: 0 })).not.toThrow()
    for (const servePort of [443, 8443, 10000])
      expect(() => new TailscaleTransport({ mode: 'serve', port: 47891, servePort })).toThrow(
        /Funnel/
      )
  })

  it('keeps the default bind mode as it was: tailnet address, only a status read', async () => {
    const { fake } = await setup()
    const active = new TailscaleTransport({ binary: fake.binary, port: 0 })
    cleanup.push(() => active.teardown())
    await active.provision()
    await active.listen((raw) => raw.destroy())
    expect(active.status().routes[0]).toMatchObject({
      transport: 'direct',
      address: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+/),
      priority: 10
    })
    expect(ran(fake)).toEqual(['status --json'])
  })

  it('holds its loopback port before it looks at Serve, then advertises the tailnet address', async () => {
    const { fake, applied, settings, remember, transport } = await setup()
    fake.setEntry(SERVE_PORT, { TCPForward: `127.0.0.1:${settings.port}` })
    remember(applied())
    const active = transport()
    await active.provision()
    // Provisioned, but not listening: Serve has not been looked at.
    expect(ran(fake)).toEqual(['status --json'])
    expect(active.status().routes).toEqual([])
    await active.listen((raw) => raw.destroy())
    const status = await settled(active)
    expect(status.state).toBe('ready')
    expect(status.routes).toEqual([
      { transport: 'direct', address: `ws://127.0.0.1:${SERVE_PORT}/mousse-net`, priority: 10 }
    ])
    // The listener itself is on the fixed loopback port that Serve forwards to.
    await new Promise<void>((resolve, reject) => {
      const socket = connect(settings.port, '127.0.0.1', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', reject)
    })
    expect(ran(fake)).toEqual(['status --json', 'serve status --json'])
  })

  it('never touches Serve when another program already holds the loopback port', async () => {
    const { fake, applied, settings, remember, transport } = await setup()
    remember(applied('pending'))
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(settings.port, '127.0.0.1', resolve))
    cleanup.push(() => new Promise((resolve) => blocker.close(resolve)))
    const active = transport()
    await active.provision()
    await expect(active.listen((raw) => raw.destroy())).rejects.toBeInstanceOf(Error)
    expect(active.status()).toMatchObject({
      state: 'failed',
      detail: expect.stringContaining(`127.0.0.1:${settings.port}`)
    })
    // Not even a restore of an unfinished change runs: nothing is forwarded to someone else's port.
    expect(ran(fake)).toEqual(['status --json'])
  })

  it('refuses to apply unless this daemon holds the loopback port', async () => {
    const { fake, serve, settings, context, saved } = await setup({ listening: false })
    await expect(serve.apply(settings, context)).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/not listening on 127\.0\.0\.1/)
    })
    expect(writes(fake)).toEqual([])
    expect(saved).toEqual([])
  })

  it('describes the change without running anything but version and status', async () => {
    const { fake, serve, settings, context } = await setup()
    const { changes } = await serve.describe(settings, context)
    expect(changes.map((change) => change.command).filter(Boolean)).toEqual([
      commandText(fake.binary, [
        'serve',
        '--bg',
        `--tcp=${SERVE_PORT}`,
        `tcp://127.0.0.1:${settings.port}`
      ]),
      commandText(fake.binary, ['serve', `--tcp=${SERVE_PORT}`, 'off'])
    ])
    expect(changes.map((change) => change.detail).join(' ')).toMatch(/Funnel/)
    expect(ran(fake)).toEqual(['version', 'status --json', 'serve status --json'])
    fake.setVersion('1.50.2')
    await expect(serve.describe(settings, context)).rejects.toMatchObject({
      code: 'unsupported_version',
      message: expect.stringMatching(/1\.52/)
    })
  })

  it('writes the record before the mapping, then applies and undoes exactly that mapping', async () => {
    const { fake, serve, settings, context, entry, saved, applied, remember } = await setup()
    const { record } = await serve.apply(settings, context)
    expect(record).toEqual(applied('applied'))
    expect(fake.entries()).toEqual({ [SERVE_PORT]: entry })
    // The pending record was saved after the three reads and before the write.
    expect(saved).toEqual([{ state: 'pending', commands: 3 }])
    remember(record)
    await expect(serve.undo(record, settings, context)).resolves.toMatchObject({
      outcome: 'removed'
    })
    expect(fake.entries()).toEqual({})
    expect(saved.map((row) => row.state)).toEqual(['pending', 'removing'])
    expect(ran(fake)).toEqual([
      'version',
      'status --json',
      'serve status --json',
      `serve --bg --tcp=${SERVE_PORT} tcp://127.0.0.1:${settings.port}`,
      'serve status --json',
      'status --json',
      'serve status --json',
      `serve --tcp=${SERVE_PORT} off`,
      'serve status --json'
    ])
    expect(ran(fake).some((line) => /funnel|reset|\bup\b|\bset\b/.test(line))).toBe(false)
  })

  it('applies twice without a second change', async () => {
    const { fake, serve, settings, context, remember } = await setup()
    const first = await serve.apply(settings, context)
    remember(first.record)
    expect(await serve.apply(settings, context)).toEqual(first)
    expect(ran(fake).filter((line) => line.includes('--bg'))).toHaveLength(1)
  })

  it('refuses a second mapping while one is recorded, so every mapping stays undoable', async () => {
    const { fake, serve, settings, context, remember } = await setup()
    const first = await serve.apply(settings, context)
    remember(first.record)
    const other = { ...settings, servePort: SERVE_PORT + 1 }
    await expect(serve.apply(other, context)).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining(`port ${SERVE_PORT}`)
    })
    await expect(serve.describe(other, context)).rejects.toMatchObject({ code: 'conflict' })
    expect(ran(fake).filter((line) => line.includes('--bg'))).toHaveLength(1)
  })

  it('refuses to apply over a Serve entry Mousse did not add, and records nothing', async () => {
    const { fake, serve, settings, context, saved } = await setup()
    fake.setEntry(SERVE_PORT, { TCPForward: '127.0.0.1:9999' })
    await expect(serve.apply(settings, context)).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/already forwards to 127\.0\.0\.1:9999/)
    })
    await expect(serve.describe(settings, context)).rejects.toMatchObject({ code: 'conflict' })
    expect(writes(fake)).toEqual([])
    expect(saved).toEqual([])
  })

  it('offers the removal command when a leftover entry already points at this daemon', async () => {
    const { fake, serve, settings, context, entry } = await setup()
    fake.setEntry(SERVE_PORT, entry)
    await expect(serve.apply(settings, context)).rejects.toMatchObject({
      code: 'conflict',
      details: { remedy: commandText(fake.binary, ['serve', `--tcp=${SERVE_PORT}`, 'off']) }
    })
    expect(writes(fake)).toEqual([])
  })

  it('does not claim an entry that replaced its own between the write and the read', async () => {
    const { fake, serve, settings, context, recorded } = await setup()
    fake.replaceOnWrite({ TCPForward: '127.0.0.1:9999' })
    await expect(serve.apply(settings, context)).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/127\.0\.0\.1:9999/)
    })
    // Mousse forgot it, so Undo has nothing it could use to remove the other entry.
    expect(recorded()).toBeUndefined()
    expect(fake.entries()).toEqual({ [SERVE_PORT]: { TCPForward: '127.0.0.1:9999' } })
    expect(ran(fake).some((line) => line.includes(' off'))).toBe(false)
  })

  it('keeps a pending record when it cannot read the result, and Undo or a retry settles it', async () => {
    const { fake, serve, settings, context, recorded, entry, remember } = await setup()
    fake.failServeStatusAfterWrite()
    await expect(serve.apply(settings, context)).rejects.toMatchObject({
      code: 'route_unreachable',
      message: expect.stringMatching(/could not read the result/)
    })
    // The mapping is there, and so is the record that lets Undo find it.
    expect(fake.entries()).toEqual({ [SERVE_PORT]: entry })
    expect(recorded()).toMatchObject({ state: 'pending' })
    fake.stopFailingServeStatus()
    // A retry adopts what is there instead of refusing it as someone else's.
    const again = await serve.apply(settings, context)
    expect(again.record).toMatchObject({ state: 'applied' })
    expect(ran(fake).filter((line) => line.includes('--bg'))).toHaveLength(1)
    // Undo works from the pending record too.
    remember({ ...(again.record as object), state: 'pending' })
    await expect(serve.undo(recorded(), settings, context)).resolves.toMatchObject({
      outcome: 'removed'
    })
    expect(fake.entries()).toEqual({})
  })

  it('refuses a port that Funnel is on, in apply, describe and the running transport', async () => {
    const { fake, serve, settings, context, transport } = await setup()
    fake.setFunnel(`host.example.ts.net:${SERVE_PORT}`)
    await expect(serve.apply(settings, context)).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/Funnel is on/)
    })
    await expect(serve.describe(settings, context)).rejects.toMatchObject({ code: 'conflict' })
    const status = await started(transport())
    expect(status).toMatchObject({ state: 'failed', detail: expect.stringMatching(/Funnel is on/) })
    expect(writes(fake)).toEqual([])
  })

  describe('after a restart', () => {
    it('finishes a change that never completed, once, and says so', async () => {
      const { fake, applied, entry, settings, saved, remember, transport } = await setup()
      remember(applied('pending'))
      const status = await started(transport())
      expect(fake.entries()).toEqual({ [SERVE_PORT]: entry })
      expect(ran(fake).filter((line) => line.includes('--bg'))).toEqual([
        `serve --bg --tcp=${SERVE_PORT} tcp://127.0.0.1:${settings.port}`
      ])
      expect(status).toMatchObject({ state: 'ready', detail: 'Serve mapping restored' })
      expect(saved.map((row) => row.state)).toEqual(['pending', 'applied'])
    })

    it('does not finish it a second time for the same approval', async () => {
      const { fake, applied, remember, transport } = await setup()
      remember(applied('pending', { completionTried: true }))
      const status = await started(transport())
      expect(writes(fake)).toEqual([])
      expect(status).toMatchObject({
        state: 'degraded',
        routes: [],
        detail: expect.stringMatching(/Turn Serve on again/)
      })
    })

    it('asks again when an applied mapping is gone, and when it disappears a second time', async () => {
      const { fake, applied, entry, remember, transport } = await setup()
      // Removed by the user, or Tailscale was reset: never put back silently.
      remember(applied('applied'))
      const first = transport()
      const lost = await started(first)
      await first.teardown()
      expect(writes(fake)).toEqual([])
      expect(lost).toMatchObject({ state: 'degraded', detail: expect.stringMatching(/is gone/) })
      // A mapping that is there, then disappears again, is also left alone.
      fake.setEntry(SERVE_PORT, entry)
      const active = transport()
      const ready = await started(active)
      expect(ready.state).toBe('ready')
      fake.clearEntries()
      await active.refresh()
      expect(active.status()).toMatchObject({ state: 'degraded', routes: [] })
      expect(writes(fake)).toEqual([])
    })

    it('does not finish a change on another tailnet, and leaves its record alone', async () => {
      const { fake, applied, remember, transport } = await setup()
      remember(applied('pending'))
      fake.setTailnet('other.ts.net')
      const status = await started(transport())
      expect(writes(fake)).toEqual([])
      expect(status).toMatchObject({
        state: 'degraded',
        routes: [],
        detail: expect.stringContaining('other.ts.net')
      })
    })

    it('does not finish a change with a Tailscale older than 1.52', async () => {
      const { fake, applied, remember, transport } = await setup()
      remember(applied('pending'))
      fake.setVersion('1.50.2')
      const status = await started(transport())
      expect(status).toMatchObject({ state: 'failed', lastError: { code: 'unsupported_version' } })
      expect(writes(fake)).toEqual([])
    })

    it('reports a port that forwards elsewhere as failed and never overwrites it', async () => {
      const { fake, applied, remember, transport } = await setup()
      remember(applied('applied'))
      fake.setEntry(SERVE_PORT, { TCPForward: '127.0.0.1:9999' })
      const status = await started(transport())
      expect(status).toMatchObject({
        state: 'failed',
        detail: expect.stringContaining('127.0.0.1:9999')
      })
      expect(writes(fake)).toEqual([])
    })

    it('reports a Serve status it cannot read as failed and writes nothing', async () => {
      const { fake, applied, remember, transport } = await setup()
      remember(applied('pending'))
      fake.setServeOutput('[]')
      const status = await started(transport())
      expect(status).toMatchObject({ state: 'failed', lastError: { code: 'unsupported_version' } })
      expect(writes(fake)).toEqual([])
    })
  })

  describe('another tailnet', () => {
    it('refuses to apply or describe over a record made on another tailnet', async () => {
      const { fake, serve, settings, context, applied, remember } = await setup()
      remember(applied('applied'))
      fake.setTailnet('other.ts.net')
      await expect(serve.apply(settings, context)).rejects.toMatchObject({
        code: 'conflict',
        message: expect.stringContaining('other.ts.net')
      })
      await expect(serve.describe(settings, context)).rejects.toMatchObject({ code: 'conflict' })
      expect(writes(fake)).toEqual([])
    })

    it('undoes nothing on a different tailnet and says where the mapping is', async () => {
      const { fake, serve, settings, context, applied, entry } = await setup()
      fake.setEntry(SERVE_PORT, entry)
      fake.setTailnet('other.ts.net')
      const result = await serve.undo(applied('applied'), settings, context)
      expect(result).toMatchObject({
        outcome: 'left',
        message: expect.stringContaining('example.ts.net')
      })
      expect(fake.entries()).toEqual({ [SERVE_PORT]: entry })
      expect(writes(fake)).toEqual([])
    })
  })

  describe('undo', () => {
    it('matches the entry by what it forwards to, not by its exact shape', async () => {
      const { fake, serve, settings, context, applied, saved } = await setup()
      fake.setEntry(SERVE_PORT, { TCPForward: `localhost:${settings.port}`, Added: 'later' })
      await expect(serve.undo(applied('applied'), settings, context)).resolves.toMatchObject({
        outcome: 'removed'
      })
      expect(fake.entries()).toEqual({})
      expect(saved.map((row) => row.state)).toEqual(['removing'])
    })

    it('leaves an entry that now forwards elsewhere alone and says so', async () => {
      const { fake, serve, settings, context, applied } = await setup()
      fake.setEntry(SERVE_PORT, { TCPForward: '127.0.0.1:9999' })
      const result = await serve.undo(applied('applied'), settings, context)
      expect(result).toMatchObject({
        outcome: 'left',
        message: expect.stringContaining('127.0.0.1:9999')
      })
      expect(fake.entries()).toEqual({ [SERVE_PORT]: { TCPForward: '127.0.0.1:9999' } })
      expect(writes(fake)).toEqual([])
    })

    it('does not treat an HTTPS handler on the port as its own', async () => {
      const { fake, serve, settings, context, applied } = await setup()
      fake.setEntry(SERVE_PORT, { HTTPS: true, TCPForward: `127.0.0.1:${settings.port}` })
      await expect(serve.undo(applied('applied'), settings, context)).resolves.toMatchObject({
        outcome: 'left'
      })
      expect(writes(fake)).toEqual([])
    })

    it('reports an entry that vanished as already removed and runs nothing', async () => {
      const { fake, serve, settings, context, applied } = await setup()
      await expect(serve.undo(applied('applied'), settings, context)).resolves.toMatchObject({
        outcome: 'already-removed'
      })
      expect(writes(fake)).toEqual([])
    })

    it.each(['[]', '{"TCP":[]}', '{"TCP":{"47890":"x"}}', '{"AllowFunnel":[]}', '', 'not json'])(
      'keeps the record and removes nothing when the status reads %j',
      async (raw) => {
        const { fake, serve, settings, context, applied, entry, saved } = await setup()
        fake.setEntry(SERVE_PORT, entry)
        fake.setServeOutput(raw)
        await expect(serve.undo(applied('applied'), settings, context)).rejects.toMatchObject({
          code: 'unsupported_version'
        })
        await expect(
          serve.apply(settings, { ...context, record: () => undefined })
        ).rejects.toMatchObject({
          code: 'unsupported_version'
        })
        expect(writes(fake)).toEqual([])
        expect(saved).toEqual([])
        expect(fake.entries()).toEqual({ [SERVE_PORT]: entry })
      }
    )

    it('reads an empty configuration as nothing mapped', () => {
      expect(parseServeStatus('{}')).toEqual({ tcp: {}, funnel: [] })
      expect(
        parseServeStatus('{"TCP":{"1":{"TCPForward":"a:1"}},"AllowFunnel":{"h:443":true}}')
      ).toEqual({
        tcp: { '1': { TCPForward: 'a:1' } },
        funnel: ['h:443']
      })
    })
  })

  it('shows a command with its binary quoted for the platform', () => {
    expect(commandText('tailscale', ['serve', 'status'], 'linux')).toBe('tailscale serve status')
    expect(commandText('/opt/Tailscale App/tailscale', ['status'], 'linux')).toBe(
      "'/opt/Tailscale App/tailscale' status"
    )
    expect(commandText("/opt/it's/tailscale", ['status'], 'darwin')).toBe(
      "'/opt/it'\\''s/tailscale' status"
    )
    expect(commandText('C:\\Program Files\\Tailscale\\tailscale.exe', ['status'], 'win32')).toBe(
      '"C:\\Program Files\\Tailscale\\tailscale.exe" status'
    )
  })

  it('suggests the operator setting on Linux only', () => {
    const refused = {
      stderr: 'serve config denied: use --operator',
      timedOut: false,
      overflow: false,
      missing: false
    }
    expect(serveFailure(refused, 'linux')).toMatchObject({
      code: 'forbidden',
      details: { remedy: 'sudo tailscale set --operator=$USER' }
    })
    for (const platform of ['win32', 'darwin'] as const) {
      const error = serveFailure(refused, platform)
      expect(error.code).toBe('forbidden')
      expect(error.details).toBeUndefined()
      expect(error.message).not.toMatch(/operator|sudo/)
    }
    expect(
      serveFailure({ stderr: '', timedOut: false, overflow: true, missing: false }).message
    ).toMatch(/more output/)
    expect(
      serveFailure({ stderr: '', timedOut: true, overflow: false, missing: false }).message
    ).toMatch(/did not answer/)
  })

  it('shows the operator remedy as text where it applies, and runs nothing more', async () => {
    const { fake, serve, settings, context, recorded } = await setup()
    fake.failServeWith(
      'Access denied: serve config denied. Use `sudo tailscale set --operator=$USER`'
    )
    await expect(serve.apply(settings, context)).rejects.toMatchObject({
      code: 'forbidden',
      ...(process.platform === 'linux'
        ? { details: { remedy: 'sudo tailscale set --operator=$USER' } }
        : {})
    })
    const commands = ran(fake)
    expect(commands.filter((line) => line.includes('--bg'))).toHaveLength(1)
    expect(commands.some((line) => /\bset\b/.test(line))).toBe(false)
    // Nothing was made, so nothing stays recorded.
    expect(recorded()).toBeUndefined()
  })

  it('reports output it cannot read as too large, not as a timeout', async () => {
    const { fake, serve, settings, context } = await setup()
    fake.floodServeStatus()
    await expect(serve.describe(settings, context)).rejects.toMatchObject({
      code: 'too_large',
      message: expect.stringMatching(/more output/)
    })
  })

  it('gives up on a Serve status that never answers', async () => {
    const { fake, serve, settings, context } = await setup()
    fake.hangServeStatus()
    const started = Date.now()
    await expect(serve.apply(settings, context)).rejects.toMatchObject({
      code: 'route_unreachable',
      message: expect.stringMatching(/did not answer/)
    })
    expect(Date.now() - started).toBeGreaterThanOrEqual(3400)
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 20_000)

  it('keeps the reason visible through the registry when Tailscale is unavailable', async () => {
    const registry = new TransportRegistry({ clock: systemClock, profileDir: tmpdir() })
    cleanup.push(() => registry.teardown())
    registry.register(tailscaleAddon)
    await expect(
      registry.configure({
        id: 'tailscale',
        enabled: true,
        settings: { binary: join(tmpdir(), 'mousse-no-such-tailscale') }
      })
    ).rejects.toMatchObject({ code: 'route_unreachable' })
    expect(registry.statuses()).toEqual([
      {
        id: 'tailscale',
        status: expect.objectContaining({
          state: 'failed',
          detail: expect.stringMatching(/Install Tailscale/)
        })
      }
    ])
  })
})

describe('cloudflared child supervision', () => {
  it('uses isolated config and origin, advertises only after URL plus registration, and cleans up its child', async () => {
    const where = await directory(),
      log = join(where, 'args.json'),
      fake = await binary(
        where,
        'cloudflared',
        `if(process.argv.includes('--version')){console.log('cloudflared version test');process.exit(0)}require('fs').writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));console.error('https://fixture.trycloudflare.com');setTimeout(()=>console.error('Registered tunnel connection'),15);setInterval(()=>{},1000)`
      )
    const transport = new CloudflaredTransport({ mode: 'quick', binary: fake }, where)
    cleanup.push(() => transport.teardown())
    await transport.provision()
    const states: string[] = []
    transport.onStatus((status) => states.push(status.state))
    await transport.listen((raw) => raw.destroy())
    expect(transport.status().routes).toEqual([
      {
        transport: 'cloudflared',
        address: 'wss://fixture.trycloudflare.com/mousse-net',
        priority: 30
      }
    ])
    const argumentsUsed = JSON.parse(await readFile(log, 'utf8')) as string[]
    expect(argumentsUsed).toContain('--no-autoupdate')
    expect(argumentsUsed).toContain('127.0.0.1:0')
    expect(argumentsUsed).toContain('http2')
    const config = argumentsUsed[argumentsUsed.indexOf('--config') + 1]
    expect(config.startsWith(where)).toBe(true)
    expect(await readFile(config, 'utf8')).toBe('{}\n')
    expect(states).toContain('provisioning')
    await transport.teardown()
    expect(transport.status()).toEqual({ state: 'disabled', routes: [] })
    expect((await readdir(where)).some((name) => name.startsWith('net-cloudflared-'))).toBe(false)
  })
  it('withdraws routes after crash and restarts with bounded backoff', async () => {
    const where = await directory(),
      counter = join(where, 'counter'),
      fake = await binary(
        where,
        'cloudflared',
        `if(process.argv.includes('--version')){console.log('test');process.exit(0)}const fs=require('fs');const n=fs.existsSync(${JSON.stringify(counter)})?Number(fs.readFileSync(${JSON.stringify(counter)})):0;fs.writeFileSync(${JSON.stringify(counter)},String(n+1));console.error('https://run'+n+'.trycloudflare.com');console.error('Registered tunnel connection');if(!n)setTimeout(()=>process.exit(2),40);else setInterval(()=>{},1000)`
      )
    const clock = new FakeClock(),
      transport = new CloudflaredTransport({ mode: 'quick', binary: fake }, where, clock)
    cleanup.push(() => transport.teardown())
    await transport.provision()
    await transport.listen((raw) => raw.destroy())
    await until(() => transport.status().state === 'degraded')
    expect(transport.status().routes).toEqual([])
    clock.advance(1000)
    await until(() => transport.status().state === 'ready')
    expect(transport.status().routes[0].address).toBe('wss://run1.trycloudflare.com/mousse-net')
  })
  it('rejects named credentials with unsafe permissions and creates only a task-owned config', async () => {
    const where = await directory(),
      credentials = join(where, 'credentials.json'),
      log = join(where, 'named-args.json'),
      fake = await binary(
        where,
        'cloudflared',
        `if(process.argv.includes('--version')){console.log('test');process.exit(0)}require('fs').writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));console.error('Registered tunnel connection');setInterval(()=>{},1000)`
      )
    await writeFile(credentials, '{"TunnelSecret":"not-printed"}', { mode: 0o644 })
    const settings = {
      mode: 'named' as const,
      binary: fake,
      tunnelId: '12345678-1234-1234-1234-123456789012',
      hostname: 'isolated.example.com',
      credentialsFile: credentials
    }
    const denied = new CloudflaredTransport(settings, where)
    cleanup.push(() => denied.teardown())
    if (process.platform !== 'win32')
      await expect(denied.provision()).rejects.toMatchObject({ code: 'route_unreachable' })
    await chmod(credentials, 0o600)
    const transport = new CloudflaredTransport(settings, where)
    cleanup.push(() => transport.teardown())
    await transport.provision()
    await transport.listen((raw) => raw.destroy())
    expect(transport.status().routes[0].address).toBe('wss://isolated.example.com/mousse-net')
    const args = JSON.parse(await readFile(log, 'utf8')) as string[]
    const config = await readFile(args[args.indexOf('--config') + 1], 'utf8')
    const origin = JSON.parse(/^    service: (.+)$/m.exec(config)![1]) as string
    expect(origin).toBe(new URL(origin).origin) // cloudflared rejects any origin path, including '/'

    expect(JSON.stringify(transport.status())).not.toContain('not-printed')
    expect(await readFile(credentials, 'utf8')).toBe('{"TunnelSecret":"not-printed"}')
  })
})
