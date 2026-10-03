import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm, readFile, readdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TransportRegistry } from '../../../src/mms/net/transports/registry'
import { tailscaleAddon, TailscaleTransport } from '../../../src/mms/net/transports/tailscale'
import { cloudflaredAddon, CloudflaredTransport } from '../../../src/mms/net/transports/cloudflared'
import { systemClock } from '../../../src/mms/net/clock'
import { FakeClock } from '../harness/FakeClock'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function directory() { const value = await mkdtemp(join(tmpdir(), 'mousse-addon-')); cleanup.push(() => rm(value, { recursive: true, force: true })); return value }
async function binary(where: string, name: string, code: string) { const file = join(where, name); await writeFile(file, `#!${process.execPath}\n${code}`, { mode: 0o700 }); return file }
async function until(predicate: () => boolean) { for (let index = 0; index < 100 && !predicate(); index++) await new Promise(resolve => setTimeout(resolve, 5)); expect(predicate()).toBe(true) }

describe('transport registry', () => {
  it('accepts only registered in-tree add-ons and validates exact settings without coercion', async () => {
    const registry = new TransportRegistry({ clock: systemClock, profileDir: await directory() }); cleanup.push(() => registry.teardown())
    registry.register(tailscaleAddon); registry.register(cloudflaredAddon)
    expect(registry.manifests().map(value => value.id)).toEqual(['tailscale', 'cloudflared'])
    expect(() => registry.register(tailscaleAddon)).toThrow(/duplicate/)
    for (const config of [{ id: 'unknown', enabled: true, settings: {} }, { id: 'tailscale', enabled: true, settings: { port: '1' } }, { id: 'cloudflared', enabled: true, settings: { mode: 'quick', token: 'secret' } }, { id: 'cloudflared', enabled: true, settings: { mode: 'named' } }]) expect(() => registry.validate(config)).toThrow(/settings/)
    await registry.configure({ id: 'cloudflared', enabled: false, settings: { mode: 'quick' } })
    expect(registry.statuses()).toEqual([{ id: 'cloudflared', status: { state: 'disabled', routes: [] } }])
  })
  it('provisions selected settings through the real fake-binary process, then disables cleanly', async () => {
    const where = await directory(), fake = await binary(where, 'tailscale', "console.log(JSON.stringify({BackendState:'Running',Self:{TailscaleIPs:['127.0.0.1']}}))")
    const registry = new TransportRegistry({ clock: systemClock, profileDir: where }); cleanup.push(() => registry.teardown()); registry.register(tailscaleAddon)
    const active = await registry.configure({ id: 'tailscale', enabled: true, settings: { binary: fake, port: 0 } })
    await active!.listen(raw => raw.destroy())
    expect(active!.status().routes[0]).toMatchObject({ transport: 'direct', address: expect.stringMatching(/127\.0\.0\.1/), priority: 10 })
    await registry.configure({ id: 'tailscale', enabled: false, settings: { binary: fake } })
    expect(registry.transports()).toEqual([])
    expect(active!.status().state).toBe('disabled')
  })
})

describe('Tailscale process detection', () => {
  it('fails with guided setup when missing or logged out, without executing account-changing commands', async () => {
    const where = await directory(), log = join(where, 'args.json'), fake = await binary(where, 'tailscale', `require('fs').writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({BackendState:'NeedsLogin'}))`)
    const transport = new TailscaleTransport({ binary: fake }); cleanup.push(() => transport.teardown())
    await expect(transport.provision()).rejects.toMatchObject({ code: 'route_unreachable' })
    expect(JSON.parse(await readFile(log, 'utf8'))).toEqual(['status', '--json'])
    expect(transport.status()).toMatchObject({ state: 'failed', detail: expect.stringMatching(/sign into/) })
    const missing = new TailscaleTransport({ binary: join(where, 'absent') }); cleanup.push(() => missing.teardown()); await expect(missing.provision()).rejects.toMatchObject({ code: 'route_unreachable' })
  })
})

describe('cloudflared child supervision', () => {
  it('uses isolated config and origin, advertises only after URL plus registration, and cleans up its child', async () => {
    const where = await directory(), log = join(where, 'args.json'), fake = await binary(where, 'cloudflared', `if(process.argv.includes('--version')){console.log('cloudflared version test');process.exit(0)}require('fs').writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));console.error('https://fixture.trycloudflare.com');setTimeout(()=>console.error('Registered tunnel connection'),15);setInterval(()=>{},1000)`)
    const transport = new CloudflaredTransport({ mode: 'quick', binary: fake }, where); cleanup.push(() => transport.teardown()); await transport.provision()
    const states: string[] = []; transport.onStatus(status => states.push(status.state)); await transport.listen(raw => raw.destroy())
    expect(transport.status().routes).toEqual([{ transport: 'cloudflared', address: 'wss://fixture.trycloudflare.com/mousse-net', priority: 30 }])
    const argumentsUsed = JSON.parse(await readFile(log, 'utf8')) as string[]
    expect(argumentsUsed).toContain('--no-autoupdate'); expect(argumentsUsed).toContain('127.0.0.1:0'); expect(argumentsUsed).toContain('http2')
    const config = argumentsUsed[argumentsUsed.indexOf('--config') + 1]
    expect(config.startsWith(where)).toBe(true); expect(await readFile(config, 'utf8')).toBe('{}\n')
    expect(states).toContain('provisioning')
    await transport.teardown(); expect(transport.status()).toEqual({ state: 'disabled', routes: [] }); expect((await readdir(where)).some(name => name.startsWith('net-cloudflared-'))).toBe(false)
  })
  it('withdraws routes after crash and restarts with bounded backoff', async () => {
    const where = await directory(), counter = join(where, 'counter'), fake = await binary(where, 'cloudflared', `if(process.argv.includes('--version')){console.log('test');process.exit(0)}const fs=require('fs');const n=fs.existsSync(${JSON.stringify(counter)})?Number(fs.readFileSync(${JSON.stringify(counter)})):0;fs.writeFileSync(${JSON.stringify(counter)},String(n+1));console.error('https://run'+n+'.trycloudflare.com');console.error('Registered tunnel connection');if(!n)setTimeout(()=>process.exit(2),40);else setInterval(()=>{},1000)`)
    const clock = new FakeClock(), transport = new CloudflaredTransport({ mode: 'quick', binary: fake }, where, clock); cleanup.push(() => transport.teardown()); await transport.provision(); await transport.listen(raw => raw.destroy())
    await until(() => transport.status().state === 'degraded'); expect(transport.status().routes).toEqual([])
    clock.advance(1000); await until(() => transport.status().state === 'ready')
    expect(transport.status().routes[0].address).toBe('wss://run1.trycloudflare.com/mousse-net')
  })
  it('rejects named credentials with unsafe permissions and creates only a task-owned config', async () => {
    const where = await directory(), credentials = join(where, 'credentials.json'), fake = await binary(where, 'cloudflared', "if(process.argv.includes('--version')){console.log('test');process.exit(0)}console.error('Registered tunnel connection');setInterval(()=>{},1000)")
    await writeFile(credentials, '{"TunnelSecret":"not-printed"}', { mode: 0o644 })
    const settings = { mode: 'named' as const, binary: fake, tunnelId: '12345678-1234-1234-1234-123456789012', hostname: 'isolated.example.com', credentialsFile: credentials }
    const denied = new CloudflaredTransport(settings, where); cleanup.push(() => denied.teardown())
    if (process.platform !== 'win32') await expect(denied.provision()).rejects.toMatchObject({ code: 'route_unreachable' })
    await chmod(credentials, 0o600)
    const transport = new CloudflaredTransport(settings, where); cleanup.push(() => transport.teardown()); await transport.provision(); await transport.listen(raw => raw.destroy())
    expect(transport.status().routes[0].address).toBe('wss://isolated.example.com/mousse-net')
    expect(JSON.stringify(transport.status())).not.toContain('not-printed')
    expect(await readFile(credentials, 'utf8')).toBe('{"TunnelSecret":"not-printed"}')
  })
})
