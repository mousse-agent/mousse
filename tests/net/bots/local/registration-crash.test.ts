import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { FileKeyStore } from '../../../../src/mms/net/identity/FileKeyStore'
import { verifyBytes, verifyDocument } from '../../../../src/mms/net/identity/crypto'
import type { BotDelegation, Roster } from '../../../../src/shared/net'
// Use the same real daemon bundle configuration, including its raw-TS SDK plugin.
import { getCliBuildOptions } from '../../../../scripts/build-cli.mjs'

it.skipIf(process.platform === 'win32')(
  'survives actual SIGKILL after protected key commit and after host commit without inventing another key, lease or original',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bot-add-kill-'))),
      executable = join(root, 'registration.mjs')
    try {
      symlinkSync(resolve('node_modules'), join(root, 'node_modules'))
      await build({
        ...getCliBuildOptions(resolve('.')),
        entryPoints: [resolve('tests/net/bots/local/registration-child.ts')],
        outfile: executable,
        sourcemap: false,
        logLevel: 'silent'
      })
      for (const mode of ['key-kill', 'ack-kill']) {
        const dir = join(root, mode)
        const killed = spawnSync(process.execPath, [executable, dir, mode], {
          encoding: 'utf8',
          timeout: 20000
        })
        expect(killed.signal, killed.stderr).toBe('SIGKILL')
        const before = JSON.parse(readFileSync(join(dir, 'killed.json'), 'utf8')),
          keysFile = join(before.profileDir, 'net', 'keys.json'),
          ciphertext = readFileSync(keysFile, 'utf8')
        expect(ciphertext).not.toContain('PRIVATE KEY')
        expect(ciphertext).not.toContain('task-owned-registration-crash-protection')
        const keys = new FileKeyStore(before.profileDir, {
          codec: { canEncrypt: () => false, encrypt: () => null, decrypt: () => null }
        })
        expect(keys.state()).toBe('locked')
        expect(() => keys.ensureBotKey(before.journal.bot)).toThrow(
          expect.objectContaining({ code: 'keystore_locked' })
        )
        await keys.unlock('task-owned-registration-crash-protection')
        expect(keys.ensureBotKey(before.journal.bot)).toBe(before.publicKey)
        verifyBytes(
          Buffer.from('actual persisted bot key'),
          keys.signAsBot(before.journal.bot, Buffer.from('actual persisted bot key')),
          before.publicKey
        )
        const completed = spawnSync(process.execPath, [executable, dir, 'retry'], {
          encoding: 'utf8',
          timeout: 20000
        })
        expect(completed.status, completed.stderr).toBe(0)
        const after = JSON.parse(readFileSync(join(dir, 'completed.json'), 'utf8'))
        expect(after.result).toMatchObject({
          bot: before.journal.bot,
          state: 'registered',
          delivery: { id: before.journal.event, state: 'sent', attempts: 1 }
        })
        expect(after.publicKey).toBe(before.publicKey)
        expect(after.rootKey).toBe(before.rootKey)
        expect(after.rows).toBe(1)
        expect(after.executions).toBe(0)
        const roster = verifyDocument<Roster>(after.roster, after.rootKey, 'roster')
        expect(roster.bots).toHaveLength(1)
        const lease = verifyDocument<BotDelegation>(
          after.journal.delegation,
          after.rootKey,
          'botDelegation'
        )
        expect(lease.keys.sign).toBe(before.publicKey)
        if (mode === 'ack-kill') {
          expect(after.journal.delegation).toEqual(before.journal.delegation)
          expect(after.envelope).toBe(before.envelope)
          expect(after.signature).toBe(before.signature)
        }
        const observed = spawnSync(process.execPath, [executable, dir, 'retry'], {
          encoding: 'utf8',
          timeout: 20000
        })
        expect(observed.status, observed.stderr).toBe(0)
        expect(JSON.parse(readFileSync(join(dir, 'completed.json'), 'utf8'))).toEqual(after)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  90000
)
