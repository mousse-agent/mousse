import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { FileKeyStore, SqlPrivateStreamKeys } from '../../../../src/mms/net/identity'

it.skipIf(process.platform === 'win32')(
  'recovers the exact fresh protected key/control bundle after real SIGKILL before SQL preparation and uses a new nonce namespace',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'archive-private-key-'))),
      path = join(root, 'profile'),
      file = join(root, 'child.mjs')
    try {
      await build({
        entryPoints: [resolve('tests/net/spaces/archive/private-rotation-child.ts')],
        outfile: file,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        logLevel: 'silent'
      })
      const killed = spawnSync(process.execPath, [file, path, 'kill'], {
        encoding: 'utf8',
        timeout: 10000
      })
      expect(killed.signal, killed.stderr).toBe('SIGKILL')
      const before = JSON.parse(readFileSync(join(path, 'killed.json'), 'utf8')),
        seed = JSON.parse(readFileSync(join(path, 'input.json'), 'utf8')),
        ciphertext = readFileSync(join(path, 'net', 'keys.json'), 'utf8')
      expect(before.installed).toBe(false)
      expect(before.pending).toBeUndefined()
      expect(before.keyHash).not.toBe(before.oldKeyHash)
      expect(ciphertext).not.toContain('PRIVATE KEY')
      expect(ciphertext).not.toContain('task-owned-archive-rotation')
      const restarted = spawnSync(process.execPath, [file, path, 'retry'], {
        encoding: 'utf8',
        timeout: 10000
      })
      expect(restarted.status, restarted.stderr).toBe(0)
      const after = JSON.parse(readFileSync(join(path, 'completed.json'), 'utf8'))
      expect(after.body).toEqual(before.body)
      expect(after.original).toEqual(before.original)
      expect(after.keyHash).toBe(before.keyHash)
      expect(after.installed).toBe(true)
      expect(after.opened).toBe('Fresh encrypted private message')
      expect(after.body.keyEpoch).toBe(seed.before.keyEpoch + 1)
      for (const writer of after.body.writers)
        expect(seed.before.writers.map((w) => w.noncePrefix)).not.toContain(writer.noncePrefix)
      const nonce = Buffer.from(after.nonce, 'base64url')
      expect(nonce.subarray(0, 4).toString('base64url')).toBe(after.body.writers[0].noncePrefix)
      expect(nonce.readBigUInt64BE(4)).toBe(1n)
      const db = new NetDatabase({ profileDir: path }),
        keys = new FileKeyStore(path, {
          codec: { canEncrypt: () => false, encrypt: () => null, decrypt: () => null }
        })
      try {
        expect(keys.state()).toBe('locked')
        await keys.unlock('task-owned-archive-rotation')
        const crypto = new SqlPrivateStreamKeys({
          database: db.database,
          keys,
          node: seed.node,
          user: seed.user,
          spaceForStream: () => seed.space,
          transaction: (work) => db.transaction(work),
          charge: (rows, bytes) => db.charge(rows, bytes)
        })
        const bytes = readFileSync(join(path, 'net', 'keys.json'))
        expect(() =>
          crypto.prepareArchiveRotation(
            seed.stream,
            seed.before,
            [{ node: seed.node, agree: keys.nodeKeys().agree }],
            {
              operation: seed.operation,
              sourceHash: seed.sourceHash,
              binding: 'c'.repeat(64),
              forbiddenPrefixes: seed.before.writers.map((w) => w.noncePrefix)
            }
          )
        ).toThrow(expect.objectContaining({ code: 'conflict' }))
        expect(() =>
          crypto.prepareArchiveRotation(
            seed.stream,
            seed.before,
            [{ node: seed.node, agree: keys.nodeKeys().agree }],
            {
              operation: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
              sourceHash: seed.sourceHash,
              binding: seed.binding,
              forbiddenPrefixes: seed.before.writers.map((w) => w.noncePrefix)
            }
          )
        ).toThrow(expect.objectContaining({ code: 'conflict' }))
        expect(readFileSync(join(path, 'net', 'keys.json'))).toEqual(bytes)
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  30000
)
