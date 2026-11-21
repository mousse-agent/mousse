import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Keep real filesystem calls in flight long enough to observe overlapping scans.
const reads = vi.hoisted(() => ({ active: 0, max: 0, syncRealpaths: 0, asyncRealpaths: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const counted = (fn: typeof actual.realpathSync) => (...args: Parameters<typeof fn>) => {
    reads.syncRealpaths++
    return fn(...args)
  }
  return { ...actual, realpathSync: Object.assign(counted(actual.realpathSync), { native: counted(actual.realpathSync.native) }) }
})
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const counted = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    reads.active++
    reads.max = Math.max(reads.max, reads.active)
    try {
      await new Promise((resolve) => setTimeout(resolve, 2))
      return await fn(...args)
    } finally {
      reads.active--
    }
  }
  return {
    ...actual,
    readdir: counted(actual.readdir as never),
    readFile: counted(actual.readFile as never),
    stat: counted(actual.stat as never),
    lstat: counted(actual.lstat as never),
    readlink: counted(actual.readlink),
    realpath: counted((...args: Parameters<typeof actual.realpath>) => {
      reads.asyncRealpaths++
      return actual.realpath(...args)
    })
  }
})

const { SKILL_SCAN_CONCURRENCY, SkillsRegistry } = await import('../src/mms/integrations/skills/SkillsRegistry')
const { createLegacySingleProfileContext } = await import('../src/mms/integrations/profileContext')
const { getProjectIdentity } = await import('../src/mms/integrations/nativePaths')

let root: string
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
const SKILLS = 120

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mousse-skills-limit-'))
  const home = join(root, 'home')
  process.env.HOME = home
  process.env.USERPROFILE = home
  // Many Skills, each with nested folders, like a large shared Skills folder.
  for (let index = 0; index < SKILLS; index++) {
    const dir = join(home, '.claude', 'skills', `group-${index % 6}`, `skill-${index}`)
    await mkdir(join(dir, 'references', 'deep'), { recursive: true })
    await mkdir(join(dir, 'assets'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: skill-${index}\ndescription: Skill ${index} for the limit test\n---\nBody.\n`, 'utf-8')
  }
})

afterAll(async () => {
  process.env.HOME = savedEnv.HOME
  process.env.USERPROFILE = savedEnv.USERPROFILE
  await rm(root, { recursive: true, force: true })
})

describe('Skills scan concurrency', () => {
  it('keeps all scan disk operations, including root probes, within the limit', async () => {
    const registry = new SkillsRegistry(createLegacySingleProfileContext({ profileRoot: join(root, 'profile') }))
    reads.max = 0
    const snapshots = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      registry.discover({ projectPath: join(root, `p${index}`) })
    ))
    expect(reads.max).toBeLessThanOrEqual(SKILL_SCAN_CONCURRENCY)
    // Still read in parallel, not one at a time.
    expect(reads.max).toBeGreaterThan(1)
    for (const snapshot of snapshots) {
      expect(snapshot.skills.filter((skill) => skill.name.startsWith('skill-'))).toHaveLength(SKILLS)
    }
  })

  it('resolves project aliases asynchronously and refuses a linked Skills root outside the project', async () => {
    const project = join(root, 'project')
    const alias = join(root, 'alias')
    const local = join(project, '.mousse', 'skills', 'local-skill')
    await mkdir(local, { recursive: true })
    await writeFile(join(local, 'SKILL.md'), '---\nname: local-skill\ndescription: A local skill\n---\nBody.\n')
    await symlink(project, alias, 'junction')
    const registry = new SkillsRegistry(createLegacySingleProfileContext({ profileRoot: join(root, 'profile') }))
    const projectId = getProjectIdentity(project)
    reads.syncRealpaths = 0
    reads.asyncRealpaths = 0
    const found = (await registry.discover({ projectPath: alias })).skills.find((skill) => skill.name === 'local-skill')
    expect(found?.projectId).toBe(projectId)
    expect(reads.asyncRealpaths).toBeGreaterThan(0)
    expect(reads.syncRealpaths).toBe(0)

    await rm(join(project, '.mousse'), { recursive: true })
    for (const target of ['home', 'missing-target']) {
      const escaped = join(project, '.mousse')
      await symlink(join(root, target), escaped, 'junction')
      await expect(registry.refresh({ projectPath: alias })).rejects.toThrow('outside the owned root')
      await rm(escaped, { recursive: true })
    }
    expect(reads.syncRealpaths).toBe(0)
  })
})
