// What a draft card does, wherever it shows (the inbox's drafts, or inline in the chat whose agent wrote it): the
// same daemon methods the page always used. Each read the inbox again afterwards.
import { managerMessage, type AutomationItem } from '../../../../shared/automations'
import type { JobSchedule } from '../../../../shared/types'
import { createAutomationsClient, type AutomationWhoPick } from '../../../services/automationsClient'
import { createPersonalBotsClient } from '../../../services/personalBotsClient'
import { useAppStore } from '../../../stores/appStore'
import { errorText, openEdit, refreshInbox, settleRequest, useInboxStore, type ManagerRequest } from './inboxStore'

const api = () => createAutomationsClient(window.mousse.platformRequest)

/** The Who chip's value as the daemon reads it. */
export function pickOf(key: string): AutomationWhoPick {
  return key.startsWith('bot:') ? { kind: 'bot', botId: key.slice('bot:'.length) } : { kind: 'default' }
}

async function andRefresh<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } finally {
    void refreshInbox()
  }
}

export const turnOnDraft = (draftId: string) => andRefresh(api().turnOn(draftId)).then(() => undefined)
export const discardDraft = (draftId: string) => andRefresh(api().discard(draftId))
export const setDraftWho = (draftId: string, key: string) => andRefresh(api().setWho(draftId, pickOf(key)))
export const setDraftWhen = (draftId: string, schedule: JobSchedule) => andRefresh(window.mousse.scheduled.update(draftId, { schedule })).then(() => undefined)
export const setDraftProject = (draftId: string, projectId: string) => andRefresh(window.mousse.scheduled.update(draftId, { projectId })).then(() => undefined)

/** Edit details: the full form, in the Automations page. */
export function editDetails(jobId: string): void {
  openEdit(jobId)
  useAppStore.getState().setScheduledOpen(true)
}

/**
 * The person's words to a manager (the Automation manager, or the bot that wrote the draft), with the project, the
 * draft or the automation they are about. The manager's next drafts take the Who the person picked.
 *
 * Returns once the words are sent, not when the manager's turn ends: that turn can take minutes, and the Drafts pane
 * shows it (`composing`) until it ends with a draft, an error or a Stop.
 */
export async function sendToManager(input: { text: string; projectId?: string; projectName?: string; who?: string; botId?: string; draftId?: string; automationId?: string }): Promise<void> {
  const message = managerMessage({
    text: input.text,
    ...(input.projectId ? { project: { id: input.projectId, name: input.projectName ?? input.projectId } } : {}),
    ...(input.draftId ? { draftId: input.draftId } : {}),
    ...(input.automationId ? { automationId: input.automationId } : {})
  })
  const client = api()
  const known = (useInboxStore.getState().index?.items ?? []).filter((item) => item.kind === 'job' && item.draft).map((item) => item.id)
  const request: ManagerRequest = {
    at: Date.now(),
    text: input.text,
    ...(input.projectId ? { projectId: input.projectId, projectName: input.projectName ?? input.projectId } : {}),
    ...(input.who !== undefined ? { who: input.who } : {}),
    ...(input.draftId ? { draftId: input.draftId } : {}),
    status: 'working',
    known
  }
  if (input.who !== undefined) await client.nextWho(input.botId, pickOf(input.who))
  if (input.botId) {
    await createPersonalBotsClient(window.mousse.platformRequest).send(input.botId, message, crypto.randomUUID())
    useInboxStore.setState({ composing: { ...request, botId: input.botId } })
    return
  }
  // Asked on every send: it also tells the daemon which project the manager's turn works in.
  const threadId = await client.managerThread(input.projectId)
  useInboxStore.setState({ composing: { ...request, threadId } })
  // The window's send answers when the turn ends; an error comes back in the answer, not as a throw.
  void window.mousse.orchestrator.sendToThread(threadId, message).then(
    (result) => settleRequest(request.at, result?.error ? errorText(result.error) : undefined),
    (cause) => settleRequest(request.at, errorText(cause))
  )
}

/** Retry: the failed or stopped words go to the manager again, with the same project and Who. */
export function retryRequest(request: ManagerRequest): Promise<void> {
  return sendToManager({
    text: request.text,
    ...(request.projectId ? { projectId: request.projectId, projectName: request.projectName } : {}),
    ...(request.who !== undefined ? { who: request.who } : {}),
    ...(request.botId ? { botId: request.botId } : {}),
    ...(request.draftId ? { draftId: request.draftId } : {})
  })
}

/** A quick answer to the manager's question under a draft: the question closes, the answer goes to its manager. */
export async function answerDraft(item: AutomationItem, answer: string): Promise<void> {
  await api().answered(item.id)
  await sendToManager({ text: answer, ...(item.where ? { projectId: item.where.projectId, projectName: item.where.name } : {}), ...(item.draft?.botId ? { botId: item.draft.botId } : {}), draftId: item.id })
  void refreshInbox()
}
