import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileKeyStore, NetIdentityService } from '../../../src/mms/net/identity'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { newId } from '../../../src/shared/net/ids'
import { NetError } from '../../../src/shared/net/errors'
import type { Clock } from '../../../src/mms/net/contracts'
import type { Roster } from '../../../src/shared/net'

const directories: string[] = [], databases: DatabaseSync[] = []
const clock: Clock = { now: () => 1700000000000, monotonic: () => 1000, setTimeout: () => ({ cancel() {} }) }
const passphrase = 'explicit protected root handoff passphrase'
function dir(): string { const path = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-transfer-'))); directories.push(path); return path }
function db(path: string): DatabaseSync { const database = new DatabaseSync(join(path, 'net', 'net.db')); database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL'); databases.push(database); return database }
afterEach(() => { for (const database of databases.splice(0)) { try { database.close() } catch { /* Already closed by restart scenario. */ } } for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
async function pair(coordinated = false) {
  const sourceDir = dir(), sourceKeys = new FileKeyStore(sourceDir); await sourceKeys.initialize({ asAuthority: true })
  const coordinator = coordinated ? new NetDatabase({ profileDir: sourceDir, clock }) : undefined
  const sourceDb = coordinator?.database ?? db(sourceDir); if (coordinator) databases.push(sourceDb)
  const source = new NetIdentityService({ database: sourceDb, keys: sourceKeys, clock, coordinator })
  await source.bootstrapAuthority('Source')
  const self = source.self()!, targetDir = dir(), targetKeys = new FileKeyStore(targetDir); await targetKeys.initialize({ asAuthority: false })
  const targetNode = newId('node')
  source.issueNodeDelegation({ node: targetNode, keys: targetKeys.nodeKeys(), name: 'Target', caps: ['read', 'chat', 'write'] })
  const targetDb = db(targetDir), target = new NetIdentityService({ database: targetDb, keys: targetKeys, clock, self: { user: self.user, node: targetNode } })
  const root = sourceKeys.rootKey()!
  target.pinUser(self.user, root); target.acceptRoster(source.roster()!, root)
  return { sourceDir, sourceKeys, sourceDb, source, targetDir, targetKeys, targetDb, target, targetNode, root, coordinator }
}

describe('recoverable local authority transfer journal', () => {
  it('freezes across preparation restart, requires ack and retirement, and resumes activated/retired state', async () => {
    const p = await pair()
    expect(() => p.source.transferAuthority(p.targetNode)).toThrow(expect.objectContaining({ code: 'forbidden' }))
    p.source.prepareTransfer(p.targetNode)
    expect(p.source.self()?.isAuthority).toBe(false)
    expect(() => p.source.issueNodeDelegation({ node: newId('node'), keys: p.sourceKeys.nodeKeys(), name: 'Frozen', caps: ['read'] })).toThrow(expect.objectContaining({ code: 'forbidden' }))
    p.sourceDb.close()
    let sourceDb = db(p.sourceDir), sourceKeys = new FileKeyStore(p.sourceDir), source = new NetIdentityService({ database: sourceDb, keys: sourceKeys, clock })
    expect(source.self()?.isAuthority).toBe(false)
    const exported = await source.exportTransfer(passphrase)
    expect(() => source.transferAuthority(p.targetNode)).toThrow(expect.objectContaining({ code: 'forbidden' }))
    const ack = await p.target.importTransfer(exported, passphrase)
    expect(p.targetKeys.rootKey()).toBe(p.root); expect(p.target.self()?.isAuthority).toBe(false)
    expect(await p.target.importTransfer(exported, passphrase)).toEqual(ack)
    // The offered successor can be distributed early. It still cannot activate the target.
    p.target.acceptRoster(exported.successor, p.root)
    expect(p.target.self()?.isAuthority).toBe(false)
    expect(() => p.target.activateTransfer(exported.successor, exported.offer)).toThrow()
    p.targetDb.close()
    sourceDb.close()
    sourceDb = db(p.sourceDir); sourceKeys = new FileKeyStore(p.sourceDir); source = new NetIdentityService({ database: sourceDb, keys: sourceKeys, clock })
    const resumedExport = await source.exportTransfer('Retries preserve the first passphrase')
    expect(resumedExport).toEqual(exported)
    const targetDb = db(p.targetDir), targetKeys = new FileKeyStore(p.targetDir), target = new NetIdentityService({ database: targetDb, keys: targetKeys, clock })
    expect(target.transferAcknowledgment()).toEqual(ack)
    expect(await target.importTransfer(resumedExport, passphrase)).toEqual(ack)
    source.acceptTransferAck(ack)
    sourceDb.close()
    sourceDb = db(p.sourceDir); sourceKeys = new FileKeyStore(p.sourceDir); source = new NetIdentityService({ database: sourceDb, keys: sourceKeys, clock })
    const successor = source.transferAuthority(p.targetNode), retirement = source.transferRetirement()
    expect(sourceKeys.rootKey()).toBeUndefined(); expect(source.self()?.isAuthority).toBe(false)
    expect((sourceDb.prepare('SELECT value FROM net_identity_state WHERE singleton=1').get()!.value as string)).not.toContain(Buffer.from(exported.recovery).toString('base64url'))
    target.activateTransfer(successor, retirement); expect(target.self()?.isAuthority).toBe(true)
    expect(target.verifySigned<Roster>(successor, p.root)).toMatchObject({ authorityNode: p.targetNode, version: 3, recoveryEpoch: 0 })
    expect(source.transferAuthority(p.targetNode)).toEqual(successor)
    sourceDb.close(); targetDb.close()
    const sourceRestart = new NetIdentityService({ database: db(p.sourceDir), keys: new FileKeyStore(p.sourceDir), clock })
    const targetRestart = new NetIdentityService({ database: db(p.targetDir), keys: new FileKeyStore(p.targetDir), clock })
    expect(sourceRestart.self()?.isAuthority).toBe(false); expect(targetRestart.self()?.isAuthority).toBe(true)
    expect(sourceRestart.transferRetirement()).toEqual(retirement)
    targetRestart.activateTransfer(successor, retirement)
    expect(targetRestart.issueNodeDelegation({ node: newId('node'), keys: targetKeys.nodeKeys(), name: 'New authority can write', caps: ['read'] })).toBeDefined()
  })

  it('rejects substituted encrypted blob and forged/misbound ack without retiring source', async () => {
    const p = await pair(); p.source.prepareTransfer(p.targetNode)
    const exported = await p.source.exportTransfer(passphrase)
    const recovery = Uint8Array.from(exported.recovery); recovery[recovery.length - 1] ^= 1
    await expect(p.target.importTransfer({ ...exported, recovery }, passphrase)).rejects.toMatchObject({ code: 'bad_delegation' })
    expect(p.targetKeys.rootKey()).toBeUndefined()
    const ack = await p.target.importTransfer(exported, passphrase)
    const proof = p.target.verifySigned<Record<string, unknown>>(ack, p.targetKeys.nodeKeys().sign)
    const wrongBlob = p.target.signAsNode({ ...proof, blobHash: Buffer.alloc(32).toString('base64url') })
    expect(() => p.source.acceptTransferAck(wrongBlob)).toThrow(expect.objectContaining({ code: 'bad_delegation' }))
    const forged = p.source.signAsNode(proof)
    expect(() => p.source.acceptTransferAck(forged)).toThrow(expect.objectContaining({ code: 'bad_signature' }))
    expect(() => p.source.transferAuthority(p.targetNode)).toThrow(expect.objectContaining({ code: 'forbidden' }))
    expect(p.sourceKeys.rootKey()).toBe(p.root); expect(p.source.self()?.isAuthority).toBe(false)
    p.source.acceptTransferAck(ack)
    expect(p.source.transferAuthority(p.targetNode)).toEqual(exported.successor)
  })

  it('persists retirement before root deletion and repairs a crash during key cleanup on restart', async () => {
    const p = await pair(); p.source.prepareTransfer(p.targetNode)
    const exported = await p.source.exportTransfer(passphrase), ack = await p.target.importTransfer(exported, passphrase)
    p.source.acceptTransferAck(ack)
    p.sourceKeys.dropRootKey = () => { throw new NetError('storage_full', 'Injected crash after durable retirement.') }
    expect(() => p.source.transferAuthority(p.targetNode)).toThrow(expect.objectContaining({ code: 'storage_full' }))
    expect(p.source.self()?.isAuthority).toBe(false); expect(p.sourceKeys.rootKey()).toBe(p.root)
    const retirement = p.source.transferRetirement()
    p.sourceDb.close()
    const keys = new FileKeyStore(p.sourceDir), source = new NetIdentityService({ database: db(p.sourceDir), keys, clock })
    expect(source.self()?.isAuthority).toBe(false); expect(keys.rootKey()).toBeUndefined()
    expect(source.transferAuthority(p.targetNode)).toEqual(exported.successor)
    p.target.activateTransfer(exported.successor, retirement); expect(p.target.self()?.isAuthority).toBe(true)
  })

  it('defers observers, retirement proof publication, and root deletion until outer commit', async () => {
    const p = await pair(true); p.source.prepareTransfer(p.targetNode)
    const exported = await p.source.exportTransfer(passphrase), ack = await p.target.importTransfer(exported, passphrase)
    p.source.acceptTransferAck(ack)
    let observations = 0; p.source.onRosterChanged(() => { observations++ })
    expect(() => p.coordinator!.transaction(() => {
      p.source.transferAuthority(p.targetNode)
      expect(p.sourceKeys.rootKey()).toBe(p.root); expect(observations).toBe(0)
      expect(() => p.source.transferRetirement()).toThrow(expect.objectContaining({ code: 'forbidden' }))
      throw new Error('Outer enrollment/storage rollback')
    })).toThrow('Outer enrollment/storage rollback')
    expect(p.sourceKeys.rootKey()).toBe(p.root); expect(observations).toBe(0)
    expect(() => p.source.transferRetirement()).toThrow(expect.objectContaining({ code: 'forbidden' }))
    p.coordinator!.transaction(() => { p.source.transferAuthority(p.targetNode); expect(p.sourceKeys.rootKey()).toBe(p.root) })
    expect(p.sourceKeys.rootKey()).toBeUndefined(); expect(observations).toBe(1)
    p.target.activateTransfer(exported.successor, p.source.transferRetirement()); expect(p.target.self()?.isAuthority).toBe(true)
  })
})
