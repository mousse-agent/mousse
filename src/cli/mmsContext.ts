import type { CliGlobals } from './parseArgs'
import { resolveMousseHome } from './paths'
import { createMms } from './serviceLocator'
import type { MousseMainService } from './contract'

export interface MmsContext {
  homeDir: string
  mms: MousseMainService
}

export async function openMms(globals: CliGlobals, start = false): Promise<MmsContext> {
  const homeDir = resolveMousseHome(globals.homeDir || undefined)
  const mms = await createMms({
    homeDir,
    repoRoot: process.cwd(),
    headless: true
  })

  await mms.providerAuth.init()
  applyRuntimeOverrides(mms, globals)

  if (start) {
    await mms.start()
  }

  return { homeDir, mms }
}

function applyRuntimeOverrides(mms: MousseMainService, globals: CliGlobals): void {
  const patch: Record<string, unknown> = {}

  if (globals.provider) {
    patch.provider = { llmProvider: globals.provider }
  }
  if (globals.model) {
    patch.provider = {
      ...(patch.provider as Record<string, unknown> | undefined),
      model: globals.model
    }
  }

  if (Object.keys(patch).length > 0) {
    mms.settings.set(patch as Parameters<typeof mms.settings.set>[0])
  }

  if (globals.apiKey && globals.provider) {
    void mms.providerAuth.setApiKey(globals.provider, globals.apiKey)
  }
}

export async function resolveThreadId(
  mms: MousseMainService,
  globals: CliGlobals
): Promise<string | null> {
  if (globals.sessionId) {
    return globals.sessionId
  }
  if (globals.continueSession) {
    return mms.threads.getActiveThreadId()
  }
  return null
}

export async function loadOrchestratorThread(
  mms: MousseMainService,
  threadId: string | null
): Promise<void> {
  if (!threadId) return
  const data = mms.threads.loadThreadData(threadId)
  mms.orchestrator.loadMessages(data.messages, data.llmContext)
  mms.threads.setActiveThreadId(threadId)
}
