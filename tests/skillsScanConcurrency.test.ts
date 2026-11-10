import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Counts the folder listings and file reads in flight; each takes a moment, so a scan without a
// limit would have them all open at once.
const reads = vi.hoisted(() => ({ active: 0, max: 0 }))
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
  return { ...actual, readdir: counted(actual.readdir as never), readFile: counted(actual.readFile as never) }
})

const { SKILL_SCAN_CONCURRENCY, SkillsRegistry } = await import('../src/mms/integrations/skills/SkillsRegistry')
const { createLegacySingleProfileContext } = await import('../src/mms/integrations/profileContext')

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
  it('keeps folder listings and SKILL.md reads in flight at or under the limit', async () => {
    const registry = new SkillsRegistry(createLegacySingleProfileContext({ profileRoot: join(root, 'profile') }))
    reads.max = 0
    // Two projects discovered together also share the limit.
    const [first, second] = await Promise.all([
      registry.discover({ projectPath: join(root, 'p1') }),
      registry.discover({ projectPath: join(root, 'p2') })
    ])
    expect(reads.max).toBeLessThanOrEqual(SKILL_SCAN_CONCURRENCY)
    // Still read in parallel, not one at a time.
    expect(reads.max).toBeGreaterThan(1)
    for (const snapshot of [first, second]) {
      expect(snapshot.skills.filter((skill) => skill.name.startsWith('skill-'))).toHaveLength(SKILLS)
    }
  })
})
