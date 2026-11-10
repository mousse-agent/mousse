import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getHeapSnapshot } from 'v8'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SkillsRegistry } from '../src/mms/integrations/skills/SkillsRegistry'
import { createLegacySingleProfileContext } from '../src/mms/integrations/profileContext'
import type { SkillsRegistrySnapshot } from '../src/shared/integrations'

let root: string
let userHome: string
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

async function writeSkill(dir: string, name: string, body = 'Use it.'): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill for this test run\n---\n${body}\n`, 'utf-8')
}

async function project(index: number): Promise<string> {
  const path = join(root, 'projects', `p${index}`)
  await writeSkill(join(path, '.claude', 'skills', `local-${index}`), `local-${index}`)
  return path
}

function registry(): SkillsRegistry {
  return new SkillsRegistry(createLegacySingleProfileContext({ profileRoot: join(root, 'profile') }))
}

function cacheOf(value: SkillsRegistry): Map<string, unknown> {
  return (value as unknown as { discoveryCache: Map<string, unknown> }).discoveryCache
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mousse-skills-cache-'))
  userHome = join(root, 'home')
  // Shared (user-wide) Skills come from the home folder.
  process.env.HOME = userHome
  process.env.USERPROFILE = userHome
  for (const name of ['alpha', 'beta', 'gamma']) await writeSkill(join(userHome, '.claude', 'skills', name), name)
})

afterAll(async () => {
  process.env.HOME = savedEnv.HOME
  process.env.USERPROFILE = savedEnv.USERPROFILE
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('Skills discovery cache', () => {
  it('drops expired snapshots and keeps at most the newest entries', async () => {
    const skills = registry()
    const start = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(start)
    try {
      for (let index = 0; index < 3; index++) await skills.discover({ projectPath: await project(index) })
      expect(cacheOf(skills).size).toBe(3)

      now.mockReturnValue(start + 31_000)
      await skills.discover({ projectPath: await project(3) })
      expect([...cacheOf(skills).keys()]).toEqual([`default:${join(root, 'projects', 'p3')}`])

      for (let index = 0; index < SkillsRegistry.MAX_DISCOVERY_ENTRIES + 5; index++) {
        await skills.discover({ projectPath: await project(index) })
      }
      expect(cacheOf(skills).size).toBe(SkillsRegistry.MAX_DISCOVERY_ENTRIES)
    } finally {
      now.mockRestore()
    }
  })

  it('reads shared Skills once for every project, and each snapshot marks its own copies', async () => {
    const skills = registry()
    const read = vi.spyOn(skills as unknown as { readSkillDescriptor: () => Promise<unknown> }, 'readSkillDescriptor')
    const snapshots: SkillsRegistrySnapshot[] = []
    for (let index = 0; index < 4; index++) snapshots.push(await skills.discover({ projectPath: await project(index) }))
    // 3 shared Skills once, plus one Skill per project.
    expect(read).toHaveBeenCalledTimes(3 + 4)
    for (const [index, snapshot] of snapshots.entries()) {
      expect(snapshot.skills.map((skill) => skill.name).sort()).toEqual(['alpha', 'beta', 'gamma', `local-${index}`])
    }
    const alpha = snapshots.map((snapshot) => snapshot.skills.find((skill) => skill.name === 'alpha'))
    expect(alpha[0]).not.toBe(alpha[1])
    expect(alpha[0]?.isActive).toBe(true)

    await skills.refresh({ projectPath: await project(0) })
    expect(read).toHaveBeenCalledTimes(3 + 4 + 4)
  })

  it('expires a project snapshot with the shared scan it reused', async () => {
    const skills = registry()
    const shared = join(userHome, '.claude', 'skills', 'alpha')
    const alphaOf = (snapshot: SkillsRegistrySnapshot) => snapshot.skills.find((skill) => skill.name === 'alpha')?.description
    const start = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(start)
    try {
      await skills.discover({ projectPath: await project(0) })
      now.mockReturnValue(start + 1_000)
      await writeFile(join(shared, 'SKILL.md'), ['---', 'name: alpha', 'description: Alpha after the change', '---', 'Changed.', ''].join('\n'), 'utf-8')
      // Within the shared scan's 30 s, a new project reuses it.
      now.mockReturnValue(start + 29_000)
      expect(alphaOf(await skills.discover({ projectPath: await project(1) }))).toBe('The alpha skill for this test run')
      // Once that scan is 30 s old, the project's snapshot goes with it.
      now.mockReturnValue(start + 31_000)
      expect(alphaOf(await skills.discover({ projectPath: await project(1) }))).toBe('Alpha after the change')
    } finally {
      now.mockRestore()
      await writeSkill(shared, 'alpha')
    }
  })

  it('keeps no SKILL.md text alive through parsed names and descriptions', async () => {
    const marker = 'skill-text-retention-probe'
    const dir = join(root, 'big-project')
    await writeSkill(join(dir, '.claude', 'skills', marker), marker, 'x'.repeat(2 * 1024 * 1024))
    const snapshot = await registry().discover({ projectPath: dir })
    const skill = snapshot.skills.find((entry) => entry.name === marker)
    expect(skill?.description).toBe(`The ${marker} skill for this test run`)

    // A sliced name keeps its whole parent string alive; the heap must hold no file-sized string
    // that starts with this Skill's frontmatter while the snapshot is still referenced.
    const retained = await fileSizedStringsStartingWith(`---\nname: ${marker}`, 1024 * 1024)
    expect(retained).toBe(0)
    expect(skill?.name.length).toBe(marker.length)
  }, 60_000)
})

async function fileSizedStringsStartingWith(prefix: string, minBytes: number): Promise<number> {
  const chunks: string[] = []
  for await (const chunk of getHeapSnapshot()) chunks.push(String(chunk))
  const heap = JSON.parse(chunks.join('')) as {
    snapshot: { meta: { node_fields: string[]; node_types: [string[]] } }
    nodes: number[]
    strings: string[]
  }
  const fields = heap.snapshot.meta.node_fields
  const width = fields.length
  const typeAt = fields.indexOf('type')
  const nameAt = fields.indexOf('name')
  const sizeAt = fields.indexOf('self_size')
  const types = heap.snapshot.meta.node_types[0]
  let count = 0
  for (let offset = 0; offset < heap.nodes.length; offset += width) {
    if (heap.nodes[offset + sizeAt] < minBytes) continue
    if (!types[heap.nodes[offset + typeAt]].includes('string')) continue
    if (heap.strings[heap.nodes[offset + nameAt]].startsWith(prefix)) count++
  }
  return count
}
