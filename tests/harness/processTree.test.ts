import { describe, expect, it } from 'vitest'
import { descendantsOf, killProcessTree, readProcessTable, readStartTime, type ProcessEntry } from '../../src/mms/harness/processTree.mjs'

// The POSIX path with a recorded process table and signals; the real processes are exercised by
// piRuntimeProcess.test.ts and scripts/check-pi-runtime-install.mjs (Linux under WSL).

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
  const kill = (target: number, signal: NodeJS.Signals | 0) => {
    if (options.gone?.includes(Math.abs(target))) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    if (signal !== 0) signals.push(`${signal} ${target}`)
  }
  return { signals, kill }
}

const startTime = (pid: number) => `t${pid}`

describe('process tree kill', () => {
  it('finds every descendant, across process groups', () => {
    expect(descendantsOf(TABLE, 200).map((entry) => entry.pid)).toEqual([210, 300, 400, 310, 320])
  })

  it('freezes the tree, kills descendant groups then the child\'s group, and signals by pid only what no group covers', () => {
    const { signals, kill } = recorder()
    killProcessTree(200, { platform: 'linux', kill, table: () => TABLE, startTime, self: 100 })
    expect(signals).toEqual([
      'SIGSTOP -200',
      'SIGSTOP -300', 'SIGSTOP 400', 'SIGSTOP -320',
      'SIGKILL -300', 'SIGKILL -320',
      'SIGKILL -200',
      'SIGKILL 400'
    ])
    // Never Mousse's group (100), an unrelated process (500) or init's group.
    expect(signals.some((entry) => / -?(100|500|1)$/.test(entry))).toBe(false)
  })

  it('does not kill a pid that was reused after it was found', () => {
    const { signals, kill } = recorder()
    let reads = 0
    const reused = (pid: number) => (pid === 400 && ++reads > 1 ? 'someone else' : `t${pid}`)
    killProcessTree(200, { platform: 'linux', kill, table: () => TABLE, startTime: reused, self: 100 })
    expect(signals).toContain('SIGSTOP 400')
    expect(signals).not.toContain('SIGKILL 400')
  })

  it('reads the table again until no new descendant appears', () => {
    const later = [...TABLE, { pid: 600, ppid: 310, pgid: 600 }]
    const tables = [TABLE, later, later]
    const { signals, kill } = recorder()
    killProcessTree(200, { platform: 'darwin', kill, table: () => tables.shift(), startTime, self: 100 })
    expect(signals).toContain('SIGSTOP -600')
    expect(signals).toContain('SIGKILL -600')
    expect(signals.indexOf('SIGKILL -600')).toBeLessThan(signals.indexOf('SIGKILL -200'))
  })

  it('finds a shell the child started between the first read and the freeze', () => {
    // Pi has no children at the first read; by the time it is stopped, its detached shell exists.
    const childless = TABLE.filter((entry) => ![210, 300, 310, 320, 400].includes(entry.pid))
    const tables = [childless, TABLE, TABLE]
    const { signals, kill } = recorder()
    killProcessTree(200, { platform: 'linux', kill, table: () => tables.shift(), startTime, self: 100 })
    expect(signals[0]).toBe('SIGSTOP -200')
    expect(signals).toEqual(expect.arrayContaining(['SIGSTOP -300', 'SIGSTOP -320', 'SIGKILL -300', 'SIGKILL -320']))
    expect(signals.at(-2)).toBe('SIGKILL -200')
  })

  it('returns at once, without reading the table, when the child and its group are gone', () => {
    const { signals, kill } = recorder({ gone: [200] })
    let reads = 0
    killProcessTree(200, { platform: 'linux', kill, table: () => (reads++, TABLE), startTime, self: 100 })
    expect(reads).toBe(0)
    expect(signals).toEqual([])
  })

  it('signals a child that leads no group by pid, and never Mousse\'s own group', () => {
    // Pi left in Mousse's group 100, with a child 210 there too.
    const table = TABLE.map((entry) => (entry.pid === 200 || entry.pid === 210 ? { ...entry, pgid: 100 } : entry))
    const { signals, kill } = recorder()
    killProcessTree(200, { platform: 'linux', kill, table: () => table, startTime, self: 100 })
    expect(signals[0]).toBe('SIGSTOP 200')
    expect(signals).toContain('SIGKILL 200')
    expect(signals).toContain('SIGKILL 210')
    expect(signals.some((entry) => entry.endsWith(' -100') || entry.endsWith(' -200'))).toBe(false)
    // A child whose pid is Mousse's own group id (only possible through pid reuse) is never a group target.
    const odd = recorder()
    const selfInChildGroup = TABLE.map((entry) => (entry.pid === 100 ? { ...entry, pgid: 200 } : entry))
    killProcessTree(200, { platform: 'linux', kill: odd.kill, table: () => selfInChildGroup, startTime, self: 100 })
    expect(odd.signals.some((entry) => entry.endsWith(' -200'))).toBe(false)
    expect(odd.signals).toContain('SIGKILL 200')
  })

  it('kills the child\'s group when ps is unavailable', () => {
    const { signals, kill } = recorder()
    killProcessTree(200, { platform: 'linux', kill, table: () => undefined, startTime, self: 100 })
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

  it.skipIf(process.platform === 'linux')('reads a start time from ps where there is no procfs', () => {
    const run = ((command: string, args: readonly string[]) => ({ status: 0, stdout: args.includes('999') ? 'Mon Oct 26 14:30:00 2026\n' : '' })) as never
    expect(readStartTime(999, run)).toBe('ps:Mon Oct 26 14:30:00 2026')
    expect(readStartTime(998, (() => ({ status: 1, stdout: '' })) as never)).toBeUndefined()
  })
})
