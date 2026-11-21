import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getHeapSnapshot } from 'v8'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SkillsRegistry } from '../src/mms/integrations/skills/SkillsRegistry'
import { createLegacySingleProfileContext } from '../src/mms/integrations/profileContext'
import { prepareSkills } from '../src/mms/run/mcp/appTools/assemble'
import { getDefaultSettings } from '../src/shared/settings'
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

  it('shares one running scan of the shared Skills between projects discovered together', async () => {
    const skills = registry()
    const read = vi.spyOn(skills as unknown as { readSkillDescriptor: () => Promise<unknown> }, 'readSkillDescriptor')
    // The first turns of threads started together, each in its own worktree, before any scan has finished.
    const paths = [await project(0), await project(1), await project(2)]
    const snapshots = await Promise.all(paths.map((projectPath) => skills.discover({ projectPath })))
    expect(read).toHaveBeenCalledTimes(3 + 3)
    for (const [index, snapshot] of snapshots.entries()) {
      expect(snapshot.skills.map((skill) => skill.name).sort()).toEqual(['alpha', 'beta', 'gamma', `local-${index}`])
    }
  })

  it('does not keep a shared scan that started before the cache was cleared', async () => {
    const skills = registry()
    const shared = join(userHome, '.claude', 'skills', 'beta')
    const betaOf = (snapshot: SkillsRegistrySnapshot) => snapshot.skills.find((skill) => skill.name === 'beta')?.description
    try {
      const early = skills.discover({ projectPath: await project(0) })
      skills.invalidateDiscoveryCache()
      await writeFile(join(shared, 'SKILL.md'), ['---', 'name: beta', 'description: Beta after the change', '---', 'Changed.', ''].join('\n'), 'utf-8')
      expect(betaOf(await skills.discover({ projectPath: await project(1) }))).toBe('Beta after the change')
      await early
      // Another project reads the shared scan made after the change, not the one that started before it.
      expect(betaOf(await skills.discover({ projectPath: await project(2) }))).toBe('Beta after the change')
    } finally {
      await writeSkill(shared, 'beta')
    }
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

  describe('a caller that takes the last scan (a bot\'s turn)', () => {
    const names = (snapshot: SkillsRegistrySnapshot) => snapshot.skills.map((skill) => skill.name)
    const lateFolder = () => join(userHome, '.claude', 'skills', 'late')
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

    it('past its time gets the last scan at once, and the next caller gets the scan made meanwhile', async () => {
      const skills = registry()
      const path = await project(0)
      const start = Date.now()
      const now = vi.spyOn(Date, 'now').mockReturnValue(start)
      try {
        await skills.discover({ projectPath: path })
        await writeSkill(lateFolder(), 'late')
        now.mockReturnValue(start + 31_000)
        expect(names(await skills.discover({ projectPath: path, stale: true }))).not.toContain('late')
        await settle()
        expect(names(await skills.discover({ projectPath: path, stale: true }))).toContain('late')
      } finally {
        now.mockRestore()
        await rm(lateFolder(), { recursive: true, force: true })
      }
    })

    it('after a change Mousse made, or with nothing scanned yet, scans first', async () => {
      const skills = registry()
      const path = await project(1)
      expect(names(await skills.discover({ projectPath: path, stale: true }))).toContain('local-1')
      await writeSkill(lateFolder(), 'late')
      try {
        skills.invalidateDiscoveryCache()
        expect(names(await skills.discover({ projectPath: path, stale: true }))).toContain('late')
      } finally {
        await rm(lateFolder(), { recursive: true, force: true })
      }
    })

    it('a message that names a skill the last scan lacks waits for a new scan and loads it', async () => {
      const skills = registry()
      const path = await project(2)
      const start = Date.now()
      const now = vi.spyOn(Date, 'now').mockReturnValue(start)
      // The actor is granted the new skill by its id, as read by a registry of its own.
      let lateId = ''
      const turn = (userContent: string) => prepareSkills({ registry: skills, settings: () => getDefaultSettings().integrations.skills, projectPath: path, mode: 'agent', userContent, actor: { kind: 'main', skillIds: [lateId] }, stale: true })
      try {
        await skills.discover({ projectPath: path })
        await writeSkill(lateFolder(), 'late', 'Late body.')
        const late = (await registry().discover({ projectPath: path })).skills.find((skill) => skill.name === 'late')!
        lateId = late.installationId ?? late.id
        now.mockReturnValue(start + 31_000)
        const loaded = await turn('please /late now')
        expect(loaded.loadedSkills.map((skill) => skill.name)).toEqual(['late'])
      } finally {
        now.mockRestore()
        await rm(lateFolder(), { recursive: true, force: true })
      }
    })

    it('a message that names a skill added since a scan still within its time scans the folders again and loads it', async () => {
      const skills = registry()
      const path = await project(3)
      let lateId = ''
      try {
        await skills.discover({ projectPath: path })
        await writeSkill(lateFolder(), 'late', 'Late body.')
        const late = (await registry().discover({ projectPath: path })).skills.find((skill) => skill.name === 'late')!
        lateId = late.installationId ?? late.id
        const loaded = await prepareSkills({ registry: skills, settings: () => getDefaultSettings().integrations.skills, projectPath: path, mode: 'agent', userContent: 'please /late now', actor: { kind: 'main', skillIds: [lateId] }, stale: true })
        expect(loaded.loadedSkills.map((skill) => skill.name)).toEqual(['late'])
      } finally {
        await rm(lateFolder(), { recursive: true, force: true })
      }
    })

    it('a background scan that started before a change Mousse made is not kept for later turns', async () => {
      const skills = registry()
      const path = await project(4)
      const start = Date.now()
      const now = vi.spyOn(Date, 'now').mockReturnValue(start)
      type Uncached = (options: object) => Promise<{ snapshot: SkillsRegistrySnapshot; scannedAt: number }>
      const uncached = vi.spyOn(skills as unknown as { discoverUncached: Uncached }, 'discoverUncached')
      try {
        const before = await skills.discover({ projectPath: path })
        now.mockReturnValue(start + 31_000)
        // The background scan reads the folders before the change and finishes after it.
        let finish = () => {}
        uncached.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ snapshot: before, scannedAt: Date.now() }) }))
        expect(names(await skills.discover({ projectPath: path, stale: true }))).not.toContain('late')
        await writeSkill(lateFolder(), 'late')
        skills.invalidateDiscoveryCache()
        finish()
        await settle()
        expect(names(await skills.discover({ projectPath: path }))).toContain('late')
        expect(names(await skills.discover({ projectPath: path, stale: true }))).toContain('late')
      } finally {
        uncached.mockRestore()
        now.mockRestore()
        await rm(lateFolder(), { recursive: true, force: true })
      }
    })
  })

  it('a background scan that ends after a newer one never replaces it', async () => {
    const skills = registry()
    const path = await project(40)
    const snapshotNamed = (name: string): SkillsRegistrySnapshot => ({ sources: [], diagnostics: [], skills: [{ id: name, name, description: name, rootPath: '', skillPath: '', scope: 'project', source: 'claude-project', managed: false } as never] })
    const finish: Array<(value: { snapshot: SkillsRegistrySnapshot; scannedAt: number }) => void> = []
    const uncached = vi.spyOn(skills as unknown as { discoverUncached: () => Promise<unknown> }, 'discoverUncached')
      .mockImplementation(() => new Promise((resolve) => { finish.push(resolve as never) }))
    try {
      const older = skills.discover({ projectPath: path, refresh: true })
      const newer = skills.discover({ projectPath: path, refresh: true })
      await vi.waitFor(() => expect(finish).toHaveLength(2))
      // The newer scan ends first; the older one after it.
      finish[1]!({ snapshot: snapshotNamed('newer'), scannedAt: Date.now() })
      await newer
      finish[0]!({ snapshot: snapshotNamed('older'), scannedAt: Date.now() })
      expect((await older).skills[0]!.name).toBe('older')
    } finally {
      uncached.mockRestore()
    }
    expect((await skills.discover({ projectPath: path, stale: true })).skills.map((skill) => skill.name)).toEqual(['newer'])
  })

  it('a skill is loaded with the policy and text its file has now: one denied since the scan is refused, one removed is left out', async () => {
    const path = join(root, 'projects', 'policy')
    const folder = (name: string) => join(path, '.claude', 'skills', name)
    for (const name of ['kept', 'denied', 'removed']) await writeSkill(folder(name), name, `Body of ${name}.`)
    const skills = registry()
    const snapshot = await skills.discover({ projectPath: path })
    // After the turn's scan: one skill is denied to the model, another is deleted.
    await writeFile(join(folder('denied'), 'SKILL.md'), '---\nname: denied\ndescription: The denied skill for this test run\ndisable-model-invocation: true\n---\nBody of denied.\n', 'utf-8')
    await rm(folder('removed'), { recursive: true, force: true })
    const id = (name: string) => snapshot.skills.find((skill) => skill.name === name)!.id
    expect((await skills.readSkill(id('denied'), { projectPath: path }, snapshot)).skill['disable-model-invocation']).toBe(true)
    await expect(skills.readSkill(id('removed'), { projectPath: path }, snapshot)).rejects.toThrow()
    // A turn naming both a removed skill and a kept one still loads the kept one.
    const loaded = await prepareSkills({ registry: skills, settings: () => getDefaultSettings().integrations.skills, projectPath: path, mode: 'agent', userContent: '/removed and /kept', actor: { kind: 'main', skillIds: snapshot.skills.map((skill) => skill.installationId ?? skill.id) } })
    expect(loaded.loadedSkills.map((skill) => skill.name)).toEqual(['kept'])
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
