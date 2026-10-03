import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { NetStatus } from '../../src/shared/net/local'

import { buildTestCli } from './helpers/build'

let fixture: Awaited<ReturnType<typeof buildTestCli>> | undefined
let entry: string

beforeAll(async () => {
  fixture = await buildTestCli()
  entry = fixture.entry
}, 60000)
afterAll(() => fixture?.cleanup())
async function until<T>(probe: () => Promise<T> | T, ready: (value: T) => boolean, timeout = 20000): Promise<T> {
  const deadline = Date.now() + timeout
  do { const value = await probe(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 40)) } while (Date.now() < deadline)
  throw new Error('Network daemon fixture timed out')
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const done = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGKILL'); await done
}
it('enrolls using pasted CLI stdin between actual daemon processes, restarts each side and propagates revoke', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'net-daemon-'))), homes = [join(root, 'a'), join(root, 'b')], children: ChildProcess[] = []
  const launch = async (home: string): Promise<ChildProcess> => {
    let output = ''
    const child = spawn(process.execPath, [entry, '--home', home, 'service', 'run'], { cwd: process.cwd(), stdio: ['ignore','pipe','pipe'], env: { ...process.env, MOUSSE_HOME: home, MOUSSE_REPO_ROOT: root, NO_COLOR: '1' } })
    children.push(child)
    child.stdout!.on('data', b => { output = (output + String(b)).slice(-8000) }); child.stderr!.on('data', b => { output = (output + String(b)).slice(-8000) })
    await until(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Daemon exited before readiness: ' + output)
      try { return JSON.parse(readFileSync(join(home, 'mms.runtime.json'),'utf8')).pid === child.pid && JSON.parse(readFileSync(join(home, 'mms.owner.json'),'utf8')).pid === child.pid } catch { return false }
    }, Boolean, 40000)
    return child
  }
  const cli = (home: string, args: string[], input?: string): Promise<any> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, '--home', home, '--json', ...args], { stdio: ['pipe','pipe','pipe'], env: { ...process.env, MOUSSE_HOME: home, NO_COLOR: '1' } })
    children.push(child); let out = '', error = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Network CLI timed out')) }, 20000)
    child.stdout!.on('data', b => { out += String(b) }); child.stderr!.on('data', b => { error += String(b) })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('exit', code => { clearTimeout(timer); if (code !== 0) { reject(new Error('Network CLI failed: ' + error.slice(-4000))); return }; try { resolve(JSON.parse(out)) } catch { reject(new Error('Network CLI returned invalid JSON')) } })
    child.stdin!.end(input)
  })
  try {
    let a = await launch(homes[0]), b = await launch(homes[1])
    expect(await cli(homes[1], ['net','status'])).toMatchObject({ enabled: false, keystore: 'missing' })
    const initial = await cli(homes[0], ['net','init','--listen','--port','0','--name','authority']) as NetStatus
    expect((await cli(homes[0], ['net','protect'], 'test-authority-protection')).protected).toBe(true)
    const invitation = await cli(homes[0], ['bridge','invite'])
    const joined = await cli(homes[1], ['bridge','join','--name','follower'], invitation.invite + '\n')
    await cli(homes[1], ['net','protect'], 'test-follower-protection')
    const open = (node: string) => (s: NetStatus) => s.peers.some(p => p.node === node && p.state === 'open')
    await until(() => cli(homes[0], ['net','status']), open(joined.node))
    await stop(a); a = await launch(homes[0])
    expect((await cli(homes[0], ['net','status'])).keystore).toBe('locked')
    await cli(homes[0], ['net','unlock'], 'test-authority-protection')
    await until(() => cli(homes[1], ['net','status']), open(joined.authority))
    expect((await cli(homes[0], ['net','status'])).routes).toEqual(initial.routes)
    await stop(b); b = await launch(homes[1])
    await cli(homes[1], ['net','unlock'], 'test-follower-protection')
    await until(() => cli(homes[1], ['net','status']), open(joined.authority))
    await cli(homes[0], ['bridge','rename', joined.node, 'renamed follower'])
    await until(() => cli(homes[1], ['bridge','nodes']), rows => rows.nodes.some((n: any) => n.node === joined.node && n.name === 'renamed follower'))
    const doctor = await cli(homes[0], ['net','doctor'])
    expect(doctor.ok, JSON.stringify(doctor)).toBe(true)
    await cli(homes[0], ['bridge','revoke', joined.node])
    await until(() => cli(homes[1], ['bridge','nodes']), rows => rows.nodes.some((n: any) => n.node === joined.node && n.revoked))
    expect((await cli(homes[1], ['net','status'])).peers.every((p: any) => p.state !== 'open')).toBe(true)
    expect((await cli(homes[0], ['net','status'])).peers.every((p: any) => p.state !== 'open')).toBe(true)
  } finally { await Promise.all(children.map(stop)); rmSync(root,{ recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}, 120000)
