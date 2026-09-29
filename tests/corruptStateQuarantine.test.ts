import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { ProjectManager } from '../src/mms/data/ProjectManager'

const roots: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'mousse-corrupt-')); roots.push(dir); return dir }
afterEach(() => { vi.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe('corrupt state quarantine', () => {
  it('preserves an unparsable mousse.conf instead of overwriting it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const home = tmp(); const garbage = '{ not json é ]]'
    writeFileSync(join(home, 'mousse.conf'), garbage)
    const conf = MousseConfigStore.readOrMigrate(join(home, 'mousse.conf'))
    const quarantined = readdirSync(home).filter((name) => name.startsWith('mousse.conf.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]).not.toContain(':')
    expect(readFileSync(join(home, quarantined[0]!), 'utf8')).toBe(garbage)
    expect(() => JSON.parse(readFileSync(join(home, 'mousse.conf'), 'utf8'))).not.toThrow()
    expect(conf.version).toBeDefined()
  })

  it('does not quarantine a valid mousse.conf', () => {
    const home = tmp()
    MousseConfigStore.readOrMigrate(join(home, 'mousse.conf'))
    MousseConfigStore.readOrMigrate(join(home, 'mousse.conf'))
    expect(readdirSync(home).filter((name) => name.includes('.corrupt-'))).toEqual([])
  })

  it('preserves an unparsable projects.json before the next persist', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const home = tmp(); const garbage = '[{"id": "p1", '
    writeFileSync(join(home, 'projects.json'), garbage)
    const manager = new ProjectManager(home)
    expect(manager.listProjects()).toEqual([])
    manager.openProject(home)
    const quarantined = readdirSync(home).filter((name) => name.startsWith('projects.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(home, quarantined[0]!), 'utf8')).toBe(garbage)
    expect(existsSync(join(home, 'projects.json'))).toBe(true)
  })
})
