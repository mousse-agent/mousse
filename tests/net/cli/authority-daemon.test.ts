import { fork, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { NetStatus } from '../../../src/shared/net/local'

import { buildTestCli } from '../helpers/build'

let buildFixture: Awaited<ReturnType<typeof buildTestCli>> | undefined
let entry: string, responseEntry: string
beforeAll(async () => {
  buildFixture = await buildTestCli()
  entry = buildFixture.entry
  responseEntry = await buildFixture.buildEntry('tests/net/cli/authority-response-child.ts', 'cli/authority-response.js')
}, 60_000)
afterAll(() => buildFixture?.cleanup())
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
it.skipIf(process.platform === 'win32')('recovers a lost CLI authority-transfer response through original daemon receipts after both restarts and imports the encrypted recovery file', async () => {
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
  const profile = (home: string) => join(home, 'profiles', JSON.parse(readFileSync(join(home, 'installation.json'), 'utf8')).defaultProfileId)
  const read = <T>(home: string, work: (db: DatabaseSync) => T): T => { const db = new DatabaseSync(join(profile(home), 'net', 'net.db'), { readOnly: true }); try { return work(db) } finally { db.close() } }
  const state = (home: string) => read(home, db => JSON.parse(String(db.prepare('SELECT value FROM net_identity_state WHERE singleton=1').get()!.value)))
  const delivery = () => read(homes[0], db => db.prepare('SELECT transfer,recipient,import_rpc,activation_rpc FROM net_authority_delivery').all())
  const mutations = () => read(homes[1], db => db.prepare("SELECT a.id,a.method,a.execution,e.state FROM net_rpc_aliases a JOIN net_executions e ON e.id=a.execution WHERE a.method IN ('authority.transfer.import','authority.transfer.activate') ORDER BY a.method").all())
  try {
    let a = await launch(homes[0]), b = await launch(homes[1])
    await cli(homes[0], ['net','init','--listen','--port','0','--name','authority'])
    await cli(homes[0], ['net','protect'], 'test-authority-protection')
    const invitation = await cli(homes[0], ['bridge','invite']), joined = await cli(homes[1], ['bridge','join','--name','follower'], invitation.invite + '\n')
    await cli(homes[1], ['net','protect'], 'test-follower-protection')
    const open = (node: string) => (s: NetStatus) => s.peers.some(p => p.node === node && p.state === 'open')
    await until(() => cli(homes[0], ['net','status']), open(joined.node))
    const backup = join(root, 'private-recovery.json'), original = state(homes[0]), ownUser = original.self.user
    const roster = (value: any) => JSON.parse(Buffer.from(value.users[ownUser].current.payload, 'base64url').toString())
    const before = roster(original)
    expect(await cli(homes[0], ['net','recovery','export','--output',backup], 'offline-recovery-passphrase')).toEqual({ file: backup })
    expect(statSync(backup).mode & 0o777).toBe(0o600)
    const file = readFileSync(backup, 'utf8'); expect(Object.keys(JSON.parse(file)).sort()).toEqual(['ct','nonce','salt','v']); expect(file).not.toContain('PRIVATE KEY'); expect(file).not.toContain('offline-recovery-passphrase')
    // Stop the requesting CLI after its actual socket write, before it can handle the daemon response.
    const caller = fork(responseEntry, ['--home', homes[0], '--json', 'net', 'authority', 'transfer', joined.node], {
      execPath: process.execPath, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, MOUSSE_HOME: homes[0], NO_COLOR: '1' }
    })
    children.push(caller); let visible = ''; caller.stdout!.on('data', bytes => { visible += bytes.toString() }); caller.stderr!.on('data', () => {})
    const requestHeld = new Promise<void>((resolve, reject) => {
      caller.once('message', message => {
        if ((message as { requestHeld?: boolean }).requestHeld) resolve()
        else reject(new Error('Unexpected authority requester checkpoint'))
      })
      caller.once('exit', () => reject(new Error('Authority requester exited before holding its pending request')))
    })
    await Promise.all([until(() => delivery().length, Boolean, 20_000), requestHeld])
    expect(caller.exitCode).toBeNull(); expect(caller.kill('SIGSTOP')).toBe(true)
    await until(() => state(homes[1]).transfer?.phase, value => value === 'activated')
    await stop(caller); expect(visible).toBe('')
    const ids = delivery(), records = mutations(); expect(ids).toHaveLength(1); expect(ids[0].import_rpc).toMatch(/^rpc_/); expect(ids[0].activation_rpc).toMatch(/^rpc_/)
    expect(records).toHaveLength(2); expect(records.every(row => row.state === 'completed')).toBe(true)
    expect(records.map(row => row.id).sort()).toEqual([ids[0].import_rpc, ids[0].activation_rpc].sort())
    expect((await cli(homes[0], ['net','status'])).self.isAuthority).toBe(false); expect((await cli(homes[1], ['net','status'])).self.isAuthority).toBe(true)
    await stop(a); await stop(b); a = await launch(homes[0]); b = await launch(homes[1])
    expect((await cli(homes[0], ['net','status'])).keystore).toBe('locked'); expect((await cli(homes[1], ['net','status'])).keystore).toBe('locked')
    await cli(homes[0], ['net','unlock'], 'test-authority-protection'); await cli(homes[1], ['net','unlock'], 'test-follower-protection')
    await until(() => cli(homes[0], ['net','status']), open(joined.node))
    expect(await cli(homes[0], ['net','authority','transfer',joined.node])).toMatchObject({ phase: 'activated', authority: joined.node })
    expect(delivery()).toEqual(ids); expect(mutations()).toEqual(records)
    expect(await cli(homes[0], ['net','authority','status'])).toMatchObject({ phase: 'finalized', transfer: ids[0].transfer })
    await stop(b)
    expect(await cli(homes[0], ['net','recovery','import','--file',backup,'--become-authority'], 'offline-recovery-passphrase')).toMatchObject({ self: { isAuthority: true, user: ownUser } })
    const recovered = roster(state(homes[0])); expect(recovered.rootKey).toBe(before.rootKey); expect(recovered.recoveryEpoch).toBeGreaterThan(before.recoveryEpoch)
    expect(delivery()).toEqual(ids)
  } finally { await Promise.all(children.map(stop)); rmSync(root,{ recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}, 120000)
