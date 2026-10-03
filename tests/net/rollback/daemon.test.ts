import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
const entry = resolve('out/cli/index.js')
async function until(probe: () => boolean, timeout = 20000): Promise<void> {
  const deadline = Date.now() + timeout
  do {
    if (probe()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  throw new Error('Owned rollback daemon did not become ready')
}
it.skipIf(process.platform === 'win32')(
  'routes emitted production CLI rollback and preserves original public history across actual daemon restart',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'net-rollback-daemon-'))),
      home = join(root, 'home'),
      children: ChildProcess[] = []
    const env = { ...process.env, MOUSSE_HOME: home, MOUSSE_REPO_ROOT: root, NO_COLOR: '1' }
    const cli = (args: string[], input?: string) =>
      new Promise<{ code: number | null; data: any }>((resolveResult, reject) => {
        const child = spawn(process.execPath, [entry, '--home', home, '--json', ...args], {
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        })
        children.push(child)
        let output = '',
          errors = ''
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('Owned rollback CLI deadline exceeded'))
        }, 20000)
        child.stdout!.on('data', (bytes) => {
          output += bytes
        })
        child.stderr!.on('data', (bytes) => {
          errors += bytes
        })
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('exit', (code) => {
          clearTimeout(timer)
          try {
            resolveResult({ code, data: JSON.parse(code === 0 ? output : errors) })
          } catch {
            reject(new Error('Rollback CLI did not return JSON: ' + errors.slice(-1000)))
          }
        })
        child.stdin!.end(input)
      })
    const ok = async (args: string[], input?: string) => {
      const result = await cli(args, input)
      expect(result.code).toBe(0)
      return result.data
    }
    const launch = async () => {
      const child = spawn(process.execPath, [entry, '--home', home, 'service', 'run'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      children.push(child)
      child.stdout!.on('data', () => {})
      child.stderr!.on('data', () => {})
      await until(() => {
        try {
          return JSON.parse(readFileSync(join(home, 'mms.runtime.json'), 'utf8')).pid === child.pid
        } catch {
          return false
        }
      })
      return child
    }
    const stop = async (child: ChildProcess) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const ended = new Promise<void>((resolveStop) => child.once('exit', () => resolveStop()))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      try {
        await ended
      } finally {
        clearTimeout(timer)
      }
    }
    const profile = () =>
      join(
        home,
        'profiles',
        JSON.parse(readFileSync(join(home, 'installation.json'), 'utf8')).defaultProfileId
      )
    const originals = () => {
      const db = new DatabaseSync(join(profile(), 'net', 'net.db'), { readOnly: true })
      try {
        return db
          .prepare(
            'SELECT id,stream,envelope,sig,state,attempts,epoch,seq FROM net_outbox ORDER BY rowid'
          )
          .all()
      } finally {
        db.close()
      }
    }
    try {
      expect(readFileSync(entry, 'utf8')).toContain('net.disable')
      const binaryHash = createHash('sha256').update(readFileSync(entry)).digest('hex')
      let daemon = await launch()
      expect(await ok(['net', 'status'])).toMatchObject({
        enabled: false,
        features: { netBridge: false, netSpaces: false }
      })
      expect(existsSync(join(profile(), 'net'))).toBe(false)
      for (const args of [
        ['bridge', 'nodes'],
        ['spaces', 'list'],
        ['bots', 'list'],
        ['net', 'transports']
      ]) {
        expect(await cli(args)).toMatchObject({ code: 1, data: { code: 'disabled' } })
        expect(existsSync(join(profile(), 'net'))).toBe(false)
      }
      await ok(['net', 'init', '--listen', '--port', '0'])
      await ok(['net', 'protect'], 'owned-rollback-daemon-passphrase')
      const created = await ok(['spaces', 'create', 'Original rollback Space']),
        sent = await ok(['spaces', 'post', created.channel, 'original CLI message'])
      expect(sent).toMatchObject({ state: 'sent', position: { epoch: 1, seq: 1 } })
      const before = originals()
      expect(await ok(['net', 'disable'])).toMatchObject({
        enabled: false,
        restartRequired: true,
        features: { netBridge: false, netSpaces: false },
        routes: []
      })
      expect(await cli(['spaces', 'create', 'denied'])).toMatchObject({
        code: 1,
        data: { code: 'disabled' }
      })
      expect(await cli(['net', 'init'])).toMatchObject({ code: 1, data: { code: 'disabled' } })
      expect(await ok(['net', 'status'])).toMatchObject({ enabled: false, restartRequired: true })
      expect(await cli(['net', 'doctor'])).toMatchObject({ code: 1, data: { code: 'disabled' } })
      expect(originals()).toEqual(before)
      await stop(daemon)
      daemon = await launch()
      expect(await ok(['net', 'status'])).toMatchObject({
        enabled: false,
        features: { netBridge: false, netSpaces: false },
        routes: []
      })
      expect(await cli(['net', 'unlock'], 'owned-rollback-daemon-passphrase')).toMatchObject({
        code: 1,
        data: { code: 'disabled' }
      })
      expect(await ok(['net', 'status'])).toMatchObject({ enabled: false, routes: [] })
      expect(await cli(['spaces', 'list'])).toMatchObject({ code: 1, data: { code: 'disabled' } })
      expect(originals()).toEqual(before)
      await ok(['net', 'init', '--unlock'], 'owned-rollback-daemon-passphrase')
      expect(await ok(['net', 'status'])).toMatchObject({
        enabled: true,
        features: { netBridge: true, netSpaces: true }
      })
      const tail = await ok(['spaces', 'tail', created.channel])
      expect(tail.records).toHaveLength(1)
      expect(tail.records[0].envelope.id).toBe(sent.id)
      expect(tail.records[0].envelope.body).toEqual({ text: 'original CLI message' })
      expect(originals()).toEqual(before)
      expect(createHash('sha256').update(readFileSync(entry)).digest('hex')).toBe(binaryHash)
    } finally {
      for (const child of children.reverse()) await stop(child)
      rmSync(root, { recursive: true, force: true })
    }
  },
  60000
)
