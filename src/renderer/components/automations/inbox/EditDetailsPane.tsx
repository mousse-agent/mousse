// Edit details: the full form (AutomationDetail), the fallback for everything the inbox does not show, in the pane.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listingServes } from '../../../../shared/providerInstances'
import { normalizePermissionMode } from '../../../../shared/permissionMode'
import type { LlmProviderOption, MousseSettings } from '../../../../shared/settings'
import type { AutomationItem } from '../../../../shared/automations'
import type { ScheduledJob, ThreadEventKind } from '../../../../shared/types'
import { createAutomationsClient } from '../../../services/automationsClient'
import { createPersonalBotsClient } from '../../../services/personalBotsClient'
import { openThread } from '../../../lib/openThread'
import { closeRailPages } from '../../../lib/railPages'
import { useAppStore } from '../../../stores/appStore'
import { useChatsStore } from '../../../stores/chatsStore'
import { draftFromJob, EMPTY_CATALOG, isUnchanged, modelGroups, patchOf, type ScheduledCatalog } from '../../scheduled/jobDraft'
import { errorText } from '../../scheduled/scheduledLabels'
import { AutomationDetail } from '../AutomationDetail'
import { PausePicker } from '../AutomationDialogs'
import { KeyDialog } from '../KeyDialog'
import type { RequestApi } from '../RequestTrigger'
import { viewerTimeZone } from '../automationTime'
import { computerChoicesOf } from '../computerChoice'
import { moveBlocked, moveSummary } from '../automationList'
import { useAutomationLibrary } from '../WhoDoPickers'
import { closePane, refreshInbox, useInboxStore } from './inboxStore'

function browserRequestApi(): RequestApi {
  const webhook = window.mousse.scheduled.webhook
  return {
    enable: (id) => webhook.enable(id),
    rotate: (id) => webhook.rotate(id),
    disable: (id) => webhook.disable(id),
    copy: (text) => navigator.clipboard.writeText(text)
  }
}

/** The name the page gives an agent: the provider instance's label (Claude, Codex), else the model. */
function agentNameOf(providers: LlmProviderOption[], selection: { instanceId?: string; llmProvider?: string; model?: string } | undefined): string | undefined {
  if (!selection) return undefined
  return providers.find((provider) => listingServes(provider, selection))?.label
}

export function EditDetailsPane({ item, onDelete }: { item: AutomationItem; onDelete: (item: AutomationItem) => void }) {
  const index = useInboxStore((s) => s.index)
  const profileId = useAppStore((s) => s.profileId)
  const client = useMemo(() => createAutomationsClient(window.mousse.platformRequest), [])
  const [jobs, setJobs] = useState<ScheduledJob[]>([])
  const [catalog, setCatalog] = useState<ScheduledCatalog>(EMPTY_CATALOG)
  const [providers, setProviders] = useState<LlmProviderOption[]>([])
  const [settings, setSettings] = useState<MousseSettings | null>(null)
  const [pausing, setPausing] = useState(false)
  const [addingKey, setAddingKey] = useState<{ name?: string } | null>(null)
  const [storedKeys, setStoredKeys] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const { library } = useAutomationLibrary(profileId)
  const requestApi = useMemo(browserRequestApi, [])
  const viewerZone = useMemo(viewerTimeZone, [])

  const load = useCallback(async () => {
    try {
      const [options, projects, threads, current, list] = await Promise.all([
        window.mousse.settings.getOptions(),
        window.mousse.projects.list(),
        window.mousse.threads.listAll(),
        window.mousse.settings.get(),
        window.mousse.scheduled.list()
      ])
      setProviders(options.llmProviders)
      setSettings(current)
      setJobs(list)
      setCatalog({
        models: modelGroups(options.llmProviders),
        projects,
        threads: threads.filter((thread) => !thread.lineage && !thread.settledAt),
        defaultPermissionMode: normalizePermissionMode(current.permissions?.defaultMode)
      })
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [])

  useEffect(() => {
    void load()
    return window.mousse.scheduled.onUpdated((next) => setJobs(next))
  }, [load])

  // Another computer's automation is edited from the record it sent with the list.
  const job = [...jobs, ...(index?.remoteJobs ?? [])].find((entry) => entry.id === item.id)
  const initial = useMemo(() => (job ? draftFromJob(job, catalog, providers) : null), [job, catalog, providers])
  if (!job || !initial) return <div className="inbox-edit" data-testid="inbox-edit">{error ? <p className="scheduled-action-error" role="alert">{error}</p> : null}</div>

  const act = async (work: () => Promise<unknown>) => {
    setError(null)
    try {
      await work()
    } catch (cause) {
      setError(errorText(cause))
    }
    void refreshInbox()
  }
  const defaultName = settings ? agentNameOf(providers, { instanceId: settings.provider.instanceId, llmProvider: settings.provider.llmProvider }) ?? 'Default agent' : 'Default agent'
  const computers = computerChoicesOf(index, viewerZone)
  const openBot = (botId: string) => {
    closeRailPages()
    void useChatsStore.getState().openBot(botId)
  }
  const resume = () => {
    if (item.pausedBy === 'bot' && item.link.kind === 'job' && item.link.botId) {
      const botId = item.link.botId
      return act(() => createPersonalBotsClient(window.mousse.platformRequest).resume(botId))
    }
    return act(() => window.mousse.scheduled.resume(job.id))
  }
  const move = async (node: string) => {
    const to = computers.find((computer) => computer.node === node)?.name ?? 'the other computer'
    const result = await client.move([job.id], node)
    setError(moveSummary(result, to))
    if (result.moved.length) closePane()
    void refreshInbox()
  }

  return (
    <div className="inbox-edit" data-testid="inbox-edit">
      <div className="automations-column">
        <AutomationDetail
          key={`${job.id}:${job.updatedAt}:${catalog.models.length}`}
          job={job}
          item={item}
          initial={initial}
          catalog={catalog}
          library={library}
          defaultName={defaultName}
          profileId={profileId}
          viewerZone={viewerZone}
          computers={computers}
          {...(item.computer.local && !moveBlocked([item]) ? { onMove: (node: string) => void move(node).catch((cause) => setError(errorText(cause))) } : {})}
          save={async (draft) => {
            const change = patchOf(initial, draft, catalog)
            if (!isUnchanged(change)) await window.mousse.scheduled.update(job.id, change)
            void refreshInbox()
          }}
          onBack={closePane}
          onRunNow={() => void act(() => window.mousse.scheduled.run(job.id))}
          onPause={() => setPausing(true)}
          onResume={() => void resume()}
          onDelete={() => onDelete(item)}
          requestApi={requestApi}
          onResend={(occurrenceId) => void act(() => client.resend(job.id, occurrenceId))}
          onKeep={() => void act(() => client.keep(job.id))}
          {...(item.computer.local ? {
            onKeys: (keys: string[]) => void act(() => window.mousse.scheduled.update(job.id, { keys: keys.length ? keys : null })),
            onAddKey: (name?: string) => {
              setAddingKey(name ? { name } : {})
              void client.listKeys().then(setStoredKeys, () => setStoredKeys([]))
            }
          } : {})}
          {...(job.trigger?.threadEvent && item.computer.local ? { onEvents: (events: ThreadEventKind[]) => void act(() => window.mousse.scheduled.update(job.id, { threadEvent: { events } })) } : {})}
          onOpenThread={(threadId) => { void openThread(threadId).then(closeRailPages) }}
          onOpenBot={openBot}
        />
        {error ? <p className="scheduled-action-error" role="alert">{error}</p> : null}
      </div>
      {pausing ? <PausePicker count={1} onCancel={() => setPausing(false)} onPause={async (until) => { await window.mousse.scheduled.pause(job.id, undefined, until); setPausing(false); void refreshInbox() }} /> : null}
      {addingKey ? (
        <KeyDialog
          {...(addingKey.name ? { name: addingKey.name } : {})}
          stored={storedKeys}
          onSave={async (name, value) => {
            await client.setKey(name, value)
            if (!(job.keys ?? []).includes(name)) await window.mousse.scheduled.update(job.id, { keys: [...(job.keys ?? []), name] })
            void refreshInbox()
          }}
          onClose={() => setAddingKey(null)}
        />
      ) : null}
    </div>
  )
}
