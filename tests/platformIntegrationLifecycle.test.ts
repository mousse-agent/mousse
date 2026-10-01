import { mkdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { SkillsRegistry } from '../src/mms/integrations/skills/SkillsRegistry'
import { SkillLifecycleService } from '../src/mms/integrations/skills/SkillLifecycleService'
import { makeTempProfile } from './fixtures/agent-platform/integrations/helpers'

describe('I02 managed skill lifecycle', () => {
  it('creates a valid SKILL.md template and preserves the body on read', async () => {
    const { root, context } = await makeTempProfile()
    try {
      const registry = new SkillsRegistry(context)
      const lifecycle = new SkillLifecycleService(registry, context)
      const created = await lifecycle.create({
        name: 'review-notes',
        description: 'Capture review notes when inspecting a diff.',
        scope: 'global',
        instructions: '# review-notes\n\nKeep the original wording.'
      })
      expect(created.skill.name).toBe('review-notes')
      expect(created.enabled).toBe(true)
      const editor = await lifecycle.read(created.installationId)
      expect(editor.content).toContain('name: review-notes')
      expect(editor.body).toContain('Keep the original wording.')
      expect(editor.source).toBe(editor.content)
      expect(editor.previewMarkdown).toContain('Keep the original wording.')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('imports a single SKILL.md file and a zip, and rejects traversal/ADS/device paths', async () => {
    const { root, context } = await makeTempProfile()
    try {
      const registry = new SkillsRegistry(context)
      const lifecycle = new SkillLifecycleService(registry, context)
      const file = join(root, 'upload-SKILL.md')
      await writeFile(
        file,
        `---
name: uploaded-file
description: Single-file skill import fixture.
---
Hello.
`,
        'utf-8'
      )
      const single = await lifecycle.importPackage({ scope: 'global', sourcePath: file })
      expect(single.skill.name).toBe('uploaded-file')

      const zip = zipSync({
        'pack/SKILL.md': strToU8(`---
name: uploaded-zip
description: Zip skill import fixture with a script asset.
---
Zip body.
`),
        'pack/scripts/run.sh': strToU8('#!/bin/sh\necho hi\n')
      })
      const imported = await lifecycle.importPackage({ scope: 'global', zipBytes: zip, zipName: 'pack.zip' })
      expect(imported.skill.name).toBe('uploaded-zip')
      expect(imported.skill.hasScripts).toBe(true)
      expect(imported.skill.executableAssets?.some((path) => path.includes('run.sh'))).toBe(true)

      const traversal = zipSync({ '../escape/SKILL.md': strToU8('---\nname: x\ndescription: y\n---\n') })
      await expect(
        lifecycle.importPackage({ scope: 'global', zipBytes: traversal, zipName: 'trav.zip' })
      ).rejects.toThrow(/traversal|Absolute|Rejected/i)

      const ads = zipSync({ 'SKILL.md:hidden': strToU8('---\nname: x\ndescription: yyyyyyyyy\n---\n') })
      await expect(lifecycle.importPackage({ scope: 'global', zipBytes: ads, zipName: 'ads.zip' })).rejects.toThrow()

      const device = zipSync({ 'NUL/SKILL.md': strToU8('---\nname: x\ndescription: yyyyyyyyy\n---\n') })
      await expect(
        lifecycle.importPackage({ scope: 'global', zipBytes: device, zipName: 'nul.zip' })
      ).rejects.toThrow(/device/i)

      const caseCollision = zipSync({
        'SKILL.md': strToU8('---\nname: x\ndescription: yyyyyyyyy\n---\n'),
        'skill.md': strToU8('collision')
      })
      await expect(lifecycle.importPackage({ scope: 'global', zipBytes: caseCollision, zipName: 'case.zip' })).rejects.toThrow(/case-colliding|duplicate/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('pins previous bytes when a skill is edited so a run can keep the old revision', async () => {
    const { root, context } = await makeTempProfile()
    try {
      const registry = new SkillsRegistry(context)
      const lifecycle = new SkillLifecycleService(registry, context)
      const created = await lifecycle.create({
        name: 'pinned-skill',
        description: 'Revision pinning fixture for in-flight runs.',
        scope: 'global',
        instructions: 'First revision body.'
      })
      const firstRevision = created.revision
      await lifecycle.update({
        installationId: created.installationId,
        content: `---
name: pinned-skill
description: Revision pinning fixture for in-flight runs.
---
Second revision body.
`
      })
      const pinned = await lifecycle.read(created.installationId, undefined, firstRevision)
      expect(pinned.content).toContain('First revision body.')
      const current = await lifecycle.read(created.installationId)
      expect(current.content).toContain('Second revision body.')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('hides disabled managed skills from unauthorized discovery overlays', async () => {
    const { root, context } = await makeTempProfile()
    try {
      const registry = new SkillsRegistry(context)
      const lifecycle = new SkillLifecycleService(registry, context)
      const created = await lifecycle.create({
        name: 'gated-skill',
        description: 'Disabled skills must not be offered to unauthorized actors.',
        scope: 'global'
      })
      await lifecycle.enable(created.installationId, false)
      const snapshot = await registry.refresh()
      const skill = snapshot.skills.find((entry) => entry.name === 'gated-skill')
      expect(skill?.enabled).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('imports a nested directory package and archives on delete', async () => {
    const { root, context } = await makeTempProfile()
    try {
      const folder = join(root, 'incoming', 'folder-skill')
      await mkdir(join(folder, 'references'), { recursive: true })
      await writeFile(
        join(folder, 'SKILL.md'),
        `---
name: folder-skill
description: Directory import fixture with a reference file.
---
Folder body.
`,
        'utf-8'
      )
      await writeFile(join(folder, 'references', 'notes.md'), '# notes\n', 'utf-8')
      const registry = new SkillsRegistry(context)
      const lifecycle = new SkillLifecycleService(registry, context)
      const imported = await lifecycle.importPackage({ scope: 'global', sourcePath: folder })
      expect(imported.skill.hasReferences).toBe(true)
      await lifecycle.archive(imported.installationId)
      const snapshot = await registry.refresh()
      expect(snapshot.skills.find((skill) => skill.name === 'folder-skill')).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a project skill root symlink that escapes the project', async () => {
    const { root, project, context } = await makeTempProfile()
    try {
      const outside = join(root, 'outside-skills')
      await mkdir(outside, { recursive: true })
      await symlink(outside, join(project, '.mousse'), process.platform === 'win32' ? 'junction' : 'dir')
      const lifecycle = new SkillLifecycleService(new SkillsRegistry(context), context)
      await expect(lifecycle.create({
        name: 'escaped-skill',
        description: 'This package must remain inside its owning project.',
        scope: 'project',
        projectPath: project
      })).rejects.toThrow(/outside the owned root|symlink/i)
      await expect(readFile(join(outside, 'skills', 'escaped-skill', 'SKILL.md'), 'utf8')).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
