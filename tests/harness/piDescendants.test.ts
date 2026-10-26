import { describe, expect, it } from 'vitest'
import { DescendantTracker, OwnedGroups, UnverifiedGroupError, killOwned, type ProcessEntry } from '../../src/mms/harness/pi/descendants'

// POSIX: Pi's shells run in groups of their own and are reparented when Pi dies. The tracker
// records them while Pi runs and kills what is still running with the same start time.

describe('Pi descendant tracker', () => {
  it('kills recorded descendants and their groups after Pi died, never a reused pid', async () => {
    let table: ProcessEntry[] = [
      { pid: 100, ppid: 1, pgid: 100, start: 'pi' },
      { pid: 200, ppid: 100, pgid: 200, start: 'shell' },
      { pid: 201, ppid: 200, pgid: 200, start: 'tool' },
      { pid: 300, ppid: 100, pgid: 100, start: 'helper' },
      { pid: 999, ppid: 1, pgid: 999, start: 'other' }
    ]
    const killed: string[] = []
    const tracker = new DescendantTracker(100, { list: async () => table, kill: (id, group) => void killed.push(group ? `group ${id}` : `pid ${id}`) })
    await tracker.snapshot()
    expect(tracker.recorded.map((entry) => entry.pid).sort()).toEqual([200, 201, 300])
    // Pi died: its children were reparented, and pid 300 was reused by another program.
    table = [
      { pid: 200, ppid: 1, pgid: 200, start: 'shell' },
      { pid: 201, ppid: 200, pgid: 200, start: 'tool' },
      { pid: 300, ppid: 1, pgid: 300, start: 'reused' },
      { pid: 999, ppid: 1, pgid: 999, start: 'other' }
    ]
    await tracker.killRecorded()
    expect(killed.sort()).toEqual(['group 200', 'pid 200', 'pid 201'])
  })

  it('does nothing when nothing was recorded or the listing fails', async () => {
    const killed: number[] = []
    const empty = new DescendantTracker(1, { list: async () => undefined, kill: (id) => void killed.push(id) })
    await empty.snapshot()
    await empty.killRecorded()
    expect(killed).toEqual([])
  })

  it('never signals a reused group of a shell that already ended (only live recorded members count)', async () => {
    let table: ProcessEntry[] = [{ pid: 100, ppid: 1, pgid: 100, start: 'pi' }, { pid: 200, ppid: 100, pgid: 200, start: 'shell' }]
    const killed: string[] = []
    const tracker = new DescendantTracker(100, { list: async () => table, kill: (id, group) => void killed.push(group ? `group ${id}` : `pid ${id}`) })
    await tracker.snapshot()
    // The shell ended (a later pass drops it) ...
    table = [{ pid: 100, ppid: 1, pgid: 100, start: 'pi' }]
    await tracker.snapshot()
    expect(tracker.recorded).toEqual([])
    // ... and Pi died with group 200 now another program's (only its pid 777 left).
    table = [{ pid: 777, ppid: 1, pgid: 200, start: 'unrelated' }]
    await tracker.killRecorded()
    expect(killed).toEqual([])
  })

  it('without a later pass, a recorded leader that is gone still does not make its reused group signalled', async () => {
    let table: ProcessEntry[] = [{ pid: 100, ppid: 1, pgid: 100, start: 'pi' }, { pid: 200, ppid: 100, pgid: 200, start: 'shell' }]
    const killed: string[] = []
    const tracker = new DescendantTracker(100, { list: async () => table, kill: (id, group) => void killed.push(group ? `group ${id}` : `pid ${id}`) })
    await tracker.snapshot()
    table = [{ pid: 777, ppid: 1, pgid: 200, start: 'unrelated' }]
    await tracker.killRecorded()
    expect(killed).toEqual([])
  })

  it('waits for a listing still running when Pi died', async () => {
    let finish!: (table: ProcessEntry[]) => void
    const first = new Promise<ProcessEntry[]>((resolve) => { finish = resolve })
    let calls = 0
    const killed: string[] = []
    const shell = { pid: 200, ppid: 100, pgid: 200, start: 'shell' }
    const tracker = new DescendantTracker(100, { list: async () => (calls++ === 0 ? first : [{ ...shell, ppid: 1 }]), kill: (id, group) => void killed.push(group ? `group ${id}` : `pid ${id}`) })
    void tracker.snapshot()
    const cleanup = tracker.killRecorded()
    finish([{ pid: 100, ppid: 1, pgid: 100, start: 'pi' }, shell])
    await cleanup
    expect(killed.sort()).toEqual(['group 200', 'pid 200'])
  })

  it('kills a recorded leader’s group when only an unrecorded member is left', async () => {
    const killed: string[] = []
    await killOwned([{ pid: 205, ppid: 1, pgid: 200, start: 'member' }], [{ pid: 200, start: 'shell' }], (id, group) => void killed.push(group ? `group ${id}` : `pid ${id}`))
    expect(killed).toEqual(['group 200'])
    // A leader pid now running with another start time is another program's group.
    killed.length = 0
    await killOwned([{ pid: 200, ppid: 1, pgid: 200, start: 'reused' }], [{ pid: 200, start: 'shell' }], (id, group) => void killed.push(group ? `group ${id}` : `pid ${id}`))
    expect(killed).toEqual([])
  })

  it('never signals a group whose ownership cannot be verified', async () => {
    const killed: string[] = []
    const record = (id: number, group: boolean) => void killed.push(group ? `group ${id}` : `pid ${id}`)
    // No listing: nothing is signalled by number.
    await killOwned(undefined, [{ pid: 200, start: 'shell' }], record)
    // No recorded start time: not verifiable either.
    await killOwned([{ pid: 300, ppid: 1, pgid: 300, start: 'x' }], [{ pid: 300, start: '' }], record)
    expect(killed).toEqual([])
  })
})

describe('owned shell groups', () => {
  it('refuses to record a group it cannot verify, so the shell runs nothing', async () => {
    await expect(new OwnedGroups(async () => undefined).record(200)).rejects.toBeInstanceOf(UnverifiedGroupError)
    await expect(new OwnedGroups(async () => [{ pid: 1, ppid: 0, pgid: 1, start: 'init' }]).record(200)).rejects.toBeInstanceOf(UnverifiedGroupError)
    // A pid that does not lead its own group is not a shell group.
    await expect(new OwnedGroups(async () => [{ pid: 200, ppid: 100, pgid: 100, start: 's' }]).record(200)).rejects.toBeInstanceOf(UnverifiedGroupError)
  })

  it('keeps a group while a recorded member is in it, retires it when none is, and never signals a reused number', async () => {
    let table: ProcessEntry[] | undefined = [{ pid: 200, ppid: 100, pgid: 200, start: 'shell' }]
    const groups = new OwnedGroups(async () => table)
    await groups.record(200)
    // The shell started a background job, seen while the group was verified: a recorded member.
    table = [{ pid: 200, ppid: 100, pgid: 200, start: 'shell' }, { pid: 201, ppid: 200, pgid: 200, start: 'job' }]
    await groups.refresh()
    // The command ended with the job still running: kept, and killed through the job.
    table = [{ pid: 201, ppid: 1, pgid: 200, start: 'job' }]
    await groups.ended()
    const killed: number[] = []
    await groups.kill((id) => void killed.push(id))
    expect(killed).toEqual([200])
    // The job exited later; the number 200 went to another program, whose leader exited too.
    table = [{ pid: 777, ppid: 1, pgid: 200, start: 'unrelated' }]
    killed.length = 0
    await groups.kill((id) => void killed.push(id))
    expect(killed).toEqual([])
    // The next pass retires it, and its members are never adopted.
    await groups.refresh()
    expect(groups.size).toBe(0)
  })

  it('does not adopt the members of a group whose number was reused before any pass saw it', async () => {
    let table: ProcessEntry[] | undefined = [{ pid: 300, ppid: 100, pgid: 300, start: 'shell' }]
    const groups = new OwnedGroups(async () => table)
    await groups.record(300)
    table = [{ pid: 300, ppid: 1, pgid: 300, start: 'reused leader' }, { pid: 301, ppid: 300, pgid: 300, start: 'other' }]
    await groups.refresh()
    expect(groups.size).toBe(0)
    const killed: number[] = []
    await groups.kill((id) => void killed.push(id))
    expect(killed).toEqual([])
  })
})
