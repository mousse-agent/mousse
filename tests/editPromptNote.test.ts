/**
 * Editing a prompt changes the conversation only. The edit is made and switched to in one step; the files stay as
 * they are; the edited prompt's send names its branch, and a thread on another branch refuses it; and the model is
 * told, with that prompt only, that the files were not rewound and which ones differ.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { testHarness } from '../src/mms/run/testkit/harness'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import type { ConversationBranch } from '../src/shared/threadActions'
import { piAdapter } from './run/phase6Fixture'
import { gitFoundationFixture } from './fixtures/gitFoundation'

let f: ReturnType<typeof gitFoundationFixture>
let mms: MousseMainService
beforeEach(async () => {
  f = gitFoundationFixture()
  mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
  await mms.start()
})
afterEach(async () => { vi.restoreAllMocks(); await mms.stop(); f.dispose() })

/** A project thread on a scripted agent: a prompt "Write <name>" writes `<name>.txt` in the turn's folder. */
async function thread() {
  const provider = mms.providerAuth.models.getProviders().find((item) => mms.providerAuth.models.getModels(item.id).length)!
  const model = mms.providerAuth.models.getModels(provider.id)[0]
  vi.spyOn(mms.providerAuth, 'has').mockReturnValue(true)
  vi.spyOn(mms.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'synthetic' } as never)
  const settings = mms.settings.get()
  mms.settings.set({ provider: { llmProvider: provider.id, model: model.id }, integrations: {
    ...settings.integrations, tools: { enabled: false, enabledTools: [] },
    skills: { ...settings.integrations.skills, enabled: false }, mcp: { ...settings.integrations.mcp, enabled: false }
  } })
  const pi = piAdapter((input) => {
    const name = /Write (\w+)/.exec(String(input.messages.at(-1)?.content ?? input.prompt))?.[1]
    if (name && input.cwd) writeFileSync(join(input.cwd, `${name}.txt`), `${name}\n`)
    return `done: ${name ?? 'nothing'}`
  })
  mms.orchestrator.setHarness(testHarness({ adapters: [pi], profileHome: mms.getProfileHomeDir() }))
  const created = mms.threads.createThread('Edit', mms.projects.openProject(f.repo).id)
  const call = (method: string, params: Record<string, unknown> = {}) => dispatchMethod({ mms, globalSequence: () => 0 }, method, { threadId: created.id, ...params })
  const send = (content: string, extra: Record<string, unknown> = {}) => call('orchestrator.send', { content, mode: 'agent', ...extra })
  const directory = mms.threads.getThreadDir(created.id)
  const cwd = () => new ThreadWorkspaceManager(directory).load()!.worktreePath
  const actionOf = (content: string) => {
    const prompt = mms.orchestrator.getMessages(created.id).find((message) => message.role === 'user' && message.content === content)!
    return new ThreadActionService(directory).list().find((action) => action.turnId === prompt.turnId)!
  }
  return { pi, threadId: created.id, directory, call, send, cwd, actionOf }
}

it('edits the conversation only: the files stay, the model is told which differ, and the original is a version', async () => {
  const t = await thread()
  await t.send('Write alpha')
  await t.send('Write beta')
  await t.send('Write gamma')
  const before = { beta: readFileSync(join(t.cwd(), 'beta.txt'), 'utf8'), gamma: readFileSync(join(t.cwd(), 'gamma.txt'), 'utf8') }

  const beta = t.actionOf('Write beta')
  const { branch } = await t.call('actions.fork', { actionId: beta.id, at: 'start', activate: true, name: 'Edited' }) as { branch: ConversationBranch }
  expect(branch).toMatchObject({ at: 'start', files: 'shared', parentTurnId: beta.turnId })
  // Made and switched to at once: the conversation ends before "Write beta", and no file changed.
  expect(mms.orchestrator.getMessages(t.threadId).filter((message) => !message.hidden).map((message) => message.content)).toEqual(['Write alpha', 'done: alpha'])
  expect(readFileSync(join(t.cwd(), 'beta.txt'), 'utf8')).toBe(before.beta)
  expect(readFileSync(join(t.cwd(), 'gamma.txt'), 'utf8')).toBe(before.gamma)

  await t.send('Write delta', { conversationBranchId: branch.id })
  const prompt = t.pi.turns.at(-1)!.prompt
  expect(prompt).toMatch(/^\[Mousse\] This message replaces an earlier one\./)
  expect(prompt).toContain('2 turns from the replaced one on')
  expect(prompt).toContain('beta.txt (added)')
  expect(prompt).toContain('gamma.txt (added)')
  expect(prompt.endsWith('Write delta')).toBe(true)
  // The transcript and Mousse's record of the conversation keep the person's text only.
  expect(mms.orchestrator.getMessages(t.threadId).filter((message) => message.role === 'user' && !message.hidden).map((message) => message.content)).toEqual(['Write alpha', 'Write delta'])
  expect(JSON.stringify(mms.orchestrator.getNativeContext(t.threadId).messages)).not.toContain('[Mousse] This message replaces')

  // The next turn on the branch is told nothing.
  await t.send('Write epsilon')
  expect(t.pi.turns.at(-1)!.prompt).not.toContain('[Mousse]')

  // The original is a version; switching to it shows its conversation, and the files stay as they are.
  const versions = (await t.call('actions.list') as { promptVersions: unknown }).promptVersions
  expect(versions).toEqual([{ turnId: t.actionOf('Write delta').turnId, versions: ['main', branch.id], current: 1 }])
  await t.call('actions.activateBranch', { conversationBranchId: 'main' })
  expect(mms.orchestrator.getMessages(t.threadId).filter((message) => message.role === 'user' && !message.hidden).map((message) => message.content)).toEqual(['Write alpha', 'Write beta', 'Write gamma'])
  for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) expect(existsSync(join(t.cwd(), `${name}.txt`))).toBe(true)
  // The ref a rebuilt worktree comes back from still holds the files as they are, the edited version's turns included.
  const metadata = new ThreadWorkspaceManager(t.directory).load()!
  expect(execFileSync('git', ['ls-tree', '-r', '--name-only', metadata.retainedRef], { cwd: t.cwd(), encoding: 'utf8' })).toContain('epsilon.txt')
}, 60_000)

it('refuses a send that names a branch the thread is not on, and runs nothing', async () => {
  const t = await thread()
  await t.send('Write alpha')
  const turns = t.pi.turns.length
  await expect(t.send('Write beta', { conversationBranchId: 'not-this-one' })).rejects.toMatchObject({ code: 'conversation_branch_changed' })
  expect(t.pi.turns).toHaveLength(turns)
  expect(mms.orchestrator.getMessages(t.threadId).some((message) => message.content === 'Write beta')).toBe(false)
  // Naming the branch the thread is on sends as usual.
  await t.send('Write beta', { conversationBranchId: 'main' })
  expect(t.pi.turns).toHaveLength(turns + 1)
}, 60_000)

it('refuses an edit, or a switch, while a turn or queued work is busy, before anything changes', async () => {
  const t = await thread()
  await t.send('Write alpha')
  vi.spyOn(mms.orchestrator, 'isConversationHistoryBusy').mockReturnValue(true)
  await expect(t.call('actions.fork', { actionId: t.actionOf('Write alpha').id, at: 'start', activate: true })).rejects.toMatchObject({ code: 'thread_busy' })
  await expect(t.call('actions.fork', { actionId: t.actionOf('Write alpha').id, at: 'end', activate: true })).rejects.toMatchObject({ code: 'invalid_params' })
  expect(mms.orchestrator.getMessages(t.threadId).filter((message) => !message.hidden)).toHaveLength(2)
}, 60_000)
