/** Manual full-app smoke setup: bundle with esbuild and run before launching the
 * built Electron app. Seeds only temporary state; no provider/network calls. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { ThreadActionService } from '../../src/mms/actions/ThreadActionService'
import { WorkspaceResolver } from '../../src/mms/workspace/WorkspaceResolver'
import { actionOptions, gitFoundationFixture } from './gitFoundation'

export async function seedFullShellFixture(evidence?: string) {
const fixture = gitFoundationFixture()
const main = await MousseMainService.create({ homeDir: fixture.home, headless: true, ownerKind: 'test' })
try {
  await main.start()
  const provider = main.providerAuth.models.getProviders().find((item) => main.providerAuth.models.getModels(item.id).length > 0)!
  main.settings.set({ provider: { llmProvider: provider.id, model: main.providerAuth.models.getModels(provider.id)[0].id } })
  const project = main.projects.openProject(fixture.repo)
  const thread = main.threads.createThread('Full application Git smoke', project.id)
  const directory = main.threads.getThreadDir(thread.id)
  const workspace = (await new WorkspaceResolver(directory, thread.id, fixture.repo).resolve('agent')).workspacePath!
  main.orchestrator.replaceConversationState(thread.id, [
    { id: 'smoke-user', turnId: 'turn', role: 'user', content: 'Seeded task change for full application undo qualification.', timestamp: Date.now() },
    { id: 'smoke-assistant', turnId: 'turn', role: 'assistant', content: 'Task value changed to full application bytes.', timestamp: Date.now() }
  ], { version: 2, fidelity: 'native', activeStartIndex: 0, messages: [
    { role: 'user', content: 'Seed task change', timestamp: Date.now() },
    { role: 'user', content: 'Task change complete', timestamp: Date.now() }
  ] })
  await new ThreadActionService(directory).runCheckpointedAction({ ...actionOptions(workspace), threadId: thread.id }, () => {
    writeFileSync(join(workspace, 'value.txt'), 'full application bytes\n')
  })
  const proof = { root: fixture.root, home: fixture.home, repo: fixture.repo, baseSha: fixture.baseSha,
    workspace, threadId: thread.id, profileId: main.profileId }
  if (evidence) writeFileSync(evidence, JSON.stringify(proof, null, 2))
  return { ...proof, dispose: fixture.dispose }
} finally {
  await main.stop()
  // Deliberately retain the temporary fixture for the actual app. The smoke
  // runner owns daemon shutdown and cleanup after collecting its evidence.
}
}

if (process.env.MOUSSE_SMOKE_EVIDENCE) await seedFullShellFixture(process.env.MOUSSE_SMOKE_EVIDENCE)
