import { describe, expect, it } from 'vitest'
import { nameUsageProjects } from '../src/mms/usageHistory/usageProjects'
import type { Project } from '../src/shared/types'
import type { UsageHistoryResponse } from '../src/shared/usageHistory'

const project = (id: string, name: string, path: string): Project => ({ id, name, path, createdAt: '', order: 0 } as Project)
const projects = [project('prj_web', 'Web', '/code/web'), project('prj_api', 'API', '/code/api')]
const row = (name: string, costUsd: number) => ({ name, tokens: costUsd * 1000, costUsd, sessions: 1 })
const session = (id: string, folder: string) => ({ agent: 'claude-code' as const, session: id, model: 'm', project: folder, tokens: 1, costUsd: 1, firstAt: 0, lastAt: 0 })

const history = {
  projects: [
    row('/code/web', 5),
    // A Mousse worktree of the Web project, and a folder inside it: both count as Web.
    row('/home/me/.mousse/repositories/prj_web/worktrees/threads/t1/main', 3),
    row('/code/web/packages/ui', 1),
    row('/home/me/.mousse/profiles/prf_1/bots/files/bot-1', 2),
    row('/home/me/.mousse/profiles/prf_1/bots/files/bot-2', 2),
    row('/tmp/scratch', 0.5),
    row('', 0.25)
  ],
  topSessions: [session('s1', '/code/api/src'), session('s2', '/tmp/scratch'), session('s3', '/code/web')]
} as unknown as UsageHistoryResponse

describe('usage by project', () => {
  it('names each folder by its project, a bot\'s by Bots, else by its own name, and adds up a project\'s folders', () => {
    const named = nameUsageProjects(history, projects, () => new Map(), () => undefined)
    expect(named.projects.map((entry) => [entry.name, entry.costUsd, entry.sessions])).toEqual([
      ['Web', 9, 3], ['Bots', 4, 2], ['scratch', 0.5, 1], ['Unknown folder', 0.25, 1]
    ])
    expect(named.topSessions.map((entry) => entry.project)).toEqual(['API', 'scratch', 'Web'])
  })

  it('links a priciest session to the thread that ran it, only when this profile has that thread', () => {
    const threads = new Map([['s1', 'thr_1'], ['s3', 'thr_other_profile']])
    const named = nameUsageProjects(history, projects, () => threads, (id) => (id === 'thr_1' ? 'Fix login' : undefined))
    expect(named.topSessions.map((entry) => [entry.threadId, entry.title])).toEqual([['thr_1', 'Fix login'], [undefined, undefined], [undefined, undefined]])
    // Without the run records, the sessions are listed unlinked.
    const unlinked = nameUsageProjects(history, projects, () => { throw new Error('closed') }, () => 'x')
    expect(unlinked.topSessions.every((entry) => !entry.threadId)).toBe(true)
  })
})
