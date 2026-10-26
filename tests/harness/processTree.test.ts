import { describe, expect, it } from 'vitest'
import { descendantsOf, killProcessTree, readProcessTable, type ProcessEntry } from '../../src/mms/harness/processTree.mjs'

// The POSIX path with a recorded process table and signals; the real processes are exercised by
// piRuntimeProcess.test.ts and scripts/check-pi-runtime-install.mjs.

/** Mousse (100, its own group 100) started Pi (200, group 200); Pi's shell is detached (300, group 300). */
const TABLE: ProcessEntry[] = [
  { pid: 1, ppid: 0, pgid: 1 },
  { pid: 100, ppid: 1, pgid: 100 },
  { pid: 200, ppid: 100, pgid: 200 },
  { pid: 210, ppid: 200, pgid: 200 },
  { pid: 300, ppid: 200, pgid: 300 },
  { pid: 310, ppid: 300, pgid: 300 },
  { pid: 320, ppid: 310, pgid: 320 },
  // A child Pi left in Mousse's own group: killed by pid, the group never signalled.
  { pid: 400, ppid: 200, pgid: 100 },
  { pid: 500, ppid: 1, pgid: 500 }
]

function recorder(options: { gone?: number[] } = {}) {
  const signals: string[] = []
  const kill = (target: number, signal: NodeJS.Signals) => {
    if (options.gone?.includes(Math.abs(target))) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    signals.push(`${signal} ${target}`)
  }
  return { signals, kill }
}

describe('process tree kill', () => {
  it('finds every descendant, across process groups', () => {
    expect(descendantsOf(TABLE, 200).map((entry) => entry.pid)).toEqual([210, 300, 400, 310, 320])
  })

  it('freezes the tree, kills every descendant group and pid, then the child\'s group; never Mousse\'s group', () => {
    const { signals, kill } = recorder()
    killProcessTree(200, { platform: 'linux', kill, table: () => TABLE, self: 100 })
    expect(signals).toEqual([
      'SIGSTOP -200',
      'SIGSTOP 210', 'SIGSTOP -300', 'SIGSTOP 400', 'SIGSTOP 310', 'SIGSTOP -320',
      'SIGKILL -300', 'SIGKILL -320',
      'SIGKILL 210', 'SIGKILL 300', 'SIGKILL 400', 'SIGKILL 310', 'SIGKILL 320',
      'SIGKILL -200'
    ])
    expect(signals.some((entry) => entry.endsWith(' -100') || entry.endsWith(' 100') || entry.endsWith(' 500') || entry.endsWith(' -1'))).toBe(false)
  })

  it('reads the table again until no new descendant appears', () => {
    const later = [...TABLE, { pid: 600, ppid: 310, pgid: 600 }]
    const tables = [TABLE, later, later]
    const { signals, kill } = recorder()
    killProcessTree(200, { platform: 'darwin', kill, table: () => tables.shift(), self: 100 })
    expect(signals).toContain('SIGSTOP -600')
    expect(signals).toContain('SIGKILL -600')
    expect(signals.at(-1)).toBe('SIGKILL -200')
  })

  it('tolerates a child that is already gone, and a child that is not a group leader', () => {
    const gone = recorder({ gone: [200] })
    expect(() => killProcessTree(200, { platform: 'linux', kill: gone.kill, table: () => [], self: 100 })).not.toThrow()
    expect(gone.signals).toEqual([])

    const notLeader = recorder()
    const kill = (target: number, signal: NodeJS.Signals) => {
      if (target === -200) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      notLeader.kill(target, signal)
    }
    killProcessTree(200, { platform: 'linux', kill, table: () => undefined, self: 100 })
    expect(notLeader.signals).toEqual(['SIGSTOP 200', 'SIGKILL 200'])
  })

  it('kills the child\'s group when ps is unavailable', () => {
    const { signals, kill } = recorder()
    killProcessTree(200, { platform: 'linux', kill, table: () => undefined, self: 100 })
    expect(signals).toEqual(['SIGSTOP -200', 'SIGKILL -200'])
  })

  it('uses taskkill /T on Windows', () => {
    const calls: Array<[string, readonly string[]]> = []
    const run = ((command: string, args: readonly string[]) => (calls.push([command, args]), { status: 0 })) as never
    killProcessTree(200, { platform: 'win32', run })
    expect(calls).toEqual([['taskkill', ['/pid', '200', '/T', '/F']]])
  })

  it('parses ps output and gives up when ps fails', () => {
    const run = (() => ({ status: 0, stdout: '    1     0     1\n  200   100   200\n  bad line\n' })) as never
    expect(readProcessTable(run)).toEqual([{ pid: 1, ppid: 0, pgid: 1 }, { pid: 200, ppid: 100, pgid: 200 }])
    expect(readProcessTable((() => ({ status: 1, stdout: '' })) as never)).toBeUndefined()
    expect(readProcessTable((() => { throw new Error('ENOENT') }) as never)).toBeUndefined()
  })
})
