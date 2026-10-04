import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectManager } from '../../../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../../../src/mms/data/ThreadDataStore'
import { MmsBotMaterializer } from '../../../../src/mms/bots/execution'
import { newId } from '../../../../src/shared/net'
import type { ActiveBot } from '../../../../src/mms/bots/registry'
import type { AuthorizedMention } from '../../../../src/mms/bots/admission'
import type { ExecutionRecord } from '../../../../src/mms/net/contracts'
const dispose: Array<() => void> = []
afterEach(() => {
  for (const f of dispose.splice(0).reverse()) f()
})
function setup() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'bot-materialize-')))
  dispose.push(() => rmSync(path, { recursive: true, force: true }))
  const projects = new ProjectManager(path),
    threads = new ThreadDataStore(projects, path, {
      profileId: 'test',
      allowLegacyProjectData: false
    })
  projects.setThreadStore(threads)
  let failing = ''
  const materializer = new MmsBotMaterializer({
      profileId: 'test',
      profileHome: path,
      threads,
      projects,
      fault: (point) => {
        if (point === failing) throw Error('Injected materialization crash')
      }
    }),
    bot = {
      space: newId('space'),
      bot: newId('bot'),
      profile: 'chat',
      definitionRevision: 'v1',
      profileDigest: Buffer.alloc(32, 1).toString('base64url')
    } as ActiveBot,
    mention = { bot, envelope: { id: newId('event') } } as AuthorizedMention,
    plan = materializer.plannedIds(mention),
    record = {
      id: newId('execution'),
      scope: bot.space,
      target: bot.bot,
      trigger: mention.envelope.id,
      state: 'accepted',
      startedAt: 1,
      updatedAt: 1,
      payloadHash: 'a'.repeat(64),
      binding: {
        profileId: 'test',
        space: bot.space,
        bot: bot.bot,
        ...plan,
        stream: newId('stream'),
        compartment: `cmp1/public/${bot.bot}/${bot.space}`,
        definitionRevision: 'v1',
        profileDigest: bot.profileDigest
      }
    } as ExecutionRecord
  return {
    path,
    projects,
    threads,
    materializer,
    bot,
    record,
    setFault(value: string) {
      failing = value
    }
  }
}
describe('actual MMS standalone bot threads and preplanned owned workspace', () => {
  it.each([
    'bots.materialize.afterThread',
    'bots.materialize.afterDirectory',
    'bots.materialize.afterMarker'
  ])(
    'reconciles the actual crash boundary %s without replacing work or allocating another thread',
    (point) => {
      const f = setup()
      f.setFault(point)
      expect(() => f.materializer.materialize(f.record, f.bot)).toThrow(
        'Injected materialization crash'
      )
      f.setFault('')
      const workspace = f.materializer.materialize(f.record, f.bot),
        marker = JSON.parse(
          readFileSync(join(workspace.scratchRoot, '.net-bot-workspace.json'), 'utf8')
        )
      expect(marker.execution).toBe(f.record.id)
      expect(marker.workspaceId).toBe(f.record.binding!.workspaceId)
      expect(f.threads.listThreads()).toHaveLength(1)
      expect(
        JSON.parse(
          readFileSync(join(f.threads.getThreadDir(workspace.threadId), 'messages.json'), 'utf8')
        )
      ).toEqual([])
      expect(f.materializer.materialize(f.record, f.bot)).toEqual(workspace)
      expect(readdirSync(workspace.scratchRoot)).toEqual(['.net-bot-workspace.json'])
    }
  )
  it('takes reader roots only from owner-local projects and refuses changed identity, terminal rows and scratch symlinks', () => {
    const f = setup(),
      projectPath = realpathSync(mkdtempSync(join(tmpdir(), 'bot-owner-project-')))
    dispose.push(() => rmSync(projectPath, { recursive: true, force: true }))
    const project = f.projects.openProject(projectPath),
      reader = { ...f.bot, profile: 'reader' as const, projectId: project.id },
      workspace = f.materializer.materialize(f.record, reader)
    expect(workspace.projectRoot).toBe(projectPath)
    expect(() => f.materializer.materialize({ ...f.record, state: 'uncertain' }, reader)).toThrow()
    expect(() =>
      f.materializer.materialize(
        { ...f.record, binding: { ...f.record.binding!, workspaceId: '../../escape' } },
        reader
      )
    ).toThrow()
    rmSync(workspace.scratchRoot, { recursive: true })
    symlinkSync(projectPath, workspace.scratchRoot)
    expect(() => f.materializer.materialize(f.record, reader)).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
  })
})
