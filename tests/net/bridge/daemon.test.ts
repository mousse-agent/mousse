import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, it } from 'vitest'
import { connectDaemonClient } from '../../../src/cli/daemonClient'
import { newId } from '../../../src/shared/net'
import { ThreadDataStore } from '../../../src/mms/data/ThreadDataStore'
import { ProjectManager } from '../../../src/mms/data/ProjectManager'

import { stop } from '../helpers/process'
import { productBuild } from '../../support/build'
import { runCli, startDaemon, until, type Daemon } from '../../support/daemon'
import { ownedTemp } from '../../support/tmp'

let entry: string

beforeAll(async () => {
  entry = (await productBuild()).entry
}, 120000)

it.skipIf(process.platform === 'win32')(
  'runs the actual Bridge CLI across two daemon processes with chunked attach, target-local rename and durable result recovery after both restarts',
  async () => {
    const temp = ownedTemp('bridge-daemons-'),
      root = temp.path,
      homes = [join(root, 'a'), join(root, 'b')],
      daemons: Daemon[] = [],
      children: ChildProcess[] = []
    const launch = async (home: string) => {
      const daemon = await startDaemon({
        entry,
        home,
        repoRoot: root,
        readiness: 'runtime',
        label: 'Bridge daemon'
      })
      daemons.push(daemon)
      return daemon
    }
    const cli = async (home: string, args: string[], input?: string): Promise<any> => {
      const result = await runCli({
        entry,
        home,
        args: ['--json', ...args],
        input,
        label: 'Actual Bridge CLI'
      })
      if (result.code !== 0) throw new Error('Bridge CLI failed: ' + result.stderr.slice(-4000))
      try {
        return args[0] === 'bridge' && args[1] === 'requests'
          ? result.stdout
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : JSON.parse(result.stdout)
      } catch {
        throw new Error(
          `Bridge CLI ${args.slice(0, 2).join(' ')} returned invalid JSON (${Buffer.byteLength(result.stdout)} output bytes)`
        )
      }
    }
    const mutations = () => {
      const id = JSON.parse(
        readFileSync(join(homes[0], 'installation.json'), 'utf8')
      ).defaultProfileId
      const db = new DatabaseSync(join(homes[0], 'profiles', id, 'net/net.db'), { readOnly: true })
      try {
        return db
          .prepare(
            "SELECT a.id,a.execution,e.state FROM net_rpc_aliases a JOIN net_executions e ON e.id=a.execution WHERE a.method='threads.create' ORDER BY a.id"
          )
          .all()
      } finally {
        db.close()
      }
    }
    try {
      let a = await launch(homes[0]),
        b = await launch(homes[1])
      const initialized = await cli(homes[0], ['net', 'init', '--listen'])
      await cli(homes[0], ['net', 'protect'], 'target-protection')
      const invite = await cli(homes[0], ['bridge', 'invite'])
      await cli(homes[1], ['bridge', 'join'], invite.invite + '\n')
      await cli(homes[1], ['net', 'protect'], 'caller-protection')
      const target = initialized.self.node
      await until(
        () => cli(homes[1], ['net', 'status']),
        (state) => state.peers.some((peer: any) => peer.node === target && peer.state === 'open')
      )
      const id = newId('rpc'),
        created = await cli(homes[1], ['bridge', 'create', target, 'process thread', '--id', id])
      expect(created.id).toBe(id)
      const thread = created.result.thread.id
      expect(
        (await cli(homes[1], ['bridge', 'threads', target])).threads.some(
          (row: any) => row.id === thread
        )
      ).toBe(true)
      expect((await cli(homes[1], ['bridge', 'get', target, thread])).thread.name).toBe(
        'process thread'
      )
      const local = await connectDaemonClient({ homeDir: homes[0] })
      try {
        const status = await local.request<{ defaultProfileId: string }>('profiles.status')
        await local.request('profiles.bind', { profile: status.defaultProfileId })
        // Actual durable source data forces the display codec and local IPC to
        // deliver a multipart snapshot; no model is invoked for this fixture.
        const installation = JSON.parse(readFileSync(join(homes[0], 'installation.json'), 'utf8'))
        const profileDir = join(homes[0], 'profiles', installation.defaultProfileId)
        // Trusted fixture setup uses the actual store and inventory before the
        // daemon hydrates this idle thread. Remote ingress never accepts a path.
        const store = new ThreadDataStore(new ProjectManager(profileDir), profileDir, {
          profileId: installation.defaultProfileId,
          allowLegacyProjectData: false
        })
        store.saveThreadData(thread, {
          messages: [
            {
              id: 'fixture-message',
              role: 'assistant',
              content: 'multipart-fixture-'.repeat(140000),
              timestamp: new Date().toISOString()
            }
          ],
          agents: [],
          tasks: []
        })
        const actual = await local.request<any>('threads.get', { threadId: thread })
        expect(actual.thread.id).toBe(thread)
        const attached = spawn(
          process.execPath,
          [entry, '--home', homes[1], '--json', 'bridge', 'attach', target, thread],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, MOUSSE_HOME: homes[1], NO_COLOR: '1' }
          }
        )
        children.push(attached)
        let output = '',
          errors = ''
        attached.stdout!.on('data', (bytes) => {
          output += bytes
        })
        attached.stderr!.on('data', (bytes) => {
          errors += bytes
        })
        await until(
          () => {
            if (attached.exitCode !== null || attached.signalCode !== null)
              throw new Error('Attach exited: ' + errors)
            return output
          },
          (value) => value.includes('process thread')
        )
        expect(output).toContain('multipart-fixture-')
        await local.request('threads.rename', { threadId: thread, name: 'target-local rename' })
        await until(
          () => output,
          (value) => value.includes('target-local rename')
        )
        attached.kill('SIGINT')
        await until(() => attached.exitCode !== null || attached.signalCode !== null, Boolean)
        expect(errors).not.toContain('PRIVATE KEY')
        expect(output).not.toContain('target-protection')
      } finally {
        await local.close()
      }
      const before = mutations()
      expect(before).toHaveLength(1)
      expect(before[0].state).toBe('completed')
      await a.kill()
      await b.kill()
      a = await launch(homes[0])
      b = await launch(homes[1])
      await cli(homes[0], ['net', 'unlock'], 'target-protection')
      await cli(homes[1], ['net', 'unlock'], 'caller-protection')
      await until(
        () => cli(homes[1], ['net', 'status']),
        (state) => state.peers.some((peer: any) => peer.node === target && peer.state === 'open')
      )
      expect(await cli(homes[1], ['bridge', 'result', id])).toEqual(created.result)
      expect(
        (await cli(homes[1], ['bridge', 'requests', target])).some(
          (row: any) => row.id === id && row.state === 'completed'
        )
      ).toBe(true)
      expect(mutations()).toEqual(before)
    } finally {
      await Promise.all([...daemons.map((daemon) => daemon.kill()), ...children.map(stop)])
      await temp.close()
    }
  },
  120000
)
