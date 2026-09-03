import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { LlmProviderOption } from '../../shared/settings'
import type { ContextUsageSnapshot, PlanCardMetadata } from '../../shared/types'
import type { SkillDescriptor } from '../../shared/integrations'
import { DEFAULT_CHAT_MODE } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { ComposerFooter } from './ComposerFooter'
import '../styles/chat-markdown.css'

interface PlanCardProps {
  plan: PlanCardMetadata
  onImplementPlan?: (plan: PlanCardMetadata) => void
  loading?: boolean
}

export function PlanCard({ plan, onImplementPlan, loading = false }: PlanCardProps) {
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const chatMode = useAppStore((s) => s.chatMode)
  const setChatMode = useAppStore((s) => s.setChatMode)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const activeThreadModelOverride = useAppStore((s) =>
    s.threads.find((thread) => thread.id === s.activeThreadId)?.modelOverride
  )
  const [providers, setProviders] = useState<LlmProviderOption[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [selectedModelId, setSelectedModelId] = useState('')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [enabledSkills, setEnabledSkills] = useState<SkillDescriptor[]>([])
  const [contextOpen, setContextOpen] = useState(false)
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot>({
    percent: 0,
    used: 0,
    limit: 128_000,
    modelName: null,
    source: 'estimated',
    categories: []
  })

  const refreshSelection = useCallback(async () => {
    const [settings, options, skillsSnapshot] = await Promise.all([
      window.mousse.settings.get(),
      window.mousse.settings.getOptions(),
      window.mousse.skills.list()
    ])
    setProviders(options.llmProviders)
    const selectedModel = activeThreadModelOverride ?? settings.provider
    setSelectedProviderId(selectedModel.llmProvider)
    setSelectedModelId(selectedModel.model)

    const enabled = new Set(settings.integrations.skills.enabledSkills)
    setEnabledSkills(
      skillsSnapshot.skills.filter(
        (skill) =>
          skill.isActive !== false &&
          (enabled.size === 0 || enabled.has(skill.id) || enabled.has(skill.name))
      )
    )
    // activeThreadId: project-scoped skills follow the active thread, so a
    // snapshot fetched for another thread goes stale on switch.
  }, [activeThreadModelOverride, activeThreadId])

  useEffect(() => {
    void refreshSelection()
    const unsubSettings = window.mousse.settings.onChanged((settings) => {
      setSelectedProviderId(settings.provider.llmProvider)
      setSelectedModelId(settings.provider.model)
      void refreshSelection()
    })
    const unsubProviders = window.mousse.providers.onChanged(() => {
      void refreshSelection()
    })
    return () => {
      unsubSettings()
      unsubProviders()
    }
  }, [refreshSelection])

  useEffect(() => {
    let cancelled = false
    void window.mousse.orchestrator
      .getContextUsage({ draftInput: plan.planMarkdown, mode: DEFAULT_CHAT_MODE })
      .then((usage) => {
        if (!cancelled) setContextUsage(usage)
      })
    return () => {
      cancelled = true
    }
  }, [plan.planMarkdown])

  const handleModelSelect = async (providerId: string, modelId: string) => {
    setModelMenuOpen(false)
    setSelectedProviderId(providerId)
    setSelectedModelId(modelId)

    // Optimistically update the active thread's override before awaiting any IPC,
    // so the settings.onChanged -> refreshSelection path reads the new override.
    if (activeThreadId) {
      const current = useAppStore.getState().threads.find((t) => t.id === activeThreadId)
      if (current) {
        useAppStore.getState().upsertThread({
          ...current,
          modelOverride: { llmProvider: providerId, model: modelId },
          updatedAt: new Date().toISOString()
        })
      }
    }

    // Persist the selection as the global default too, so a new chat opens on the
    // last used model instead of the first connected provider/model fallback.
    await window.mousse.settings.set({
      provider: { llmProvider: providerId, model: modelId }
    })

    if (activeThreadId) {
      const updated = await window.mousse.threads.setModel(activeThreadId, {
        llmProvider: providerId,
        model: modelId
      })
      if (updated) useAppStore.getState().upsertThread(updated)
    }
  }

  return (
    <div className="plan-card">
      <div className="plan-card-body chat-markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            )
          }}
        >
          {plan.planMarkdown}
        </ReactMarkdown>
      </div>
      <div className="plan-card-footer">
        <ComposerFooter
          chatMode={chatMode}
          onChatModeChange={setChatMode}
          enabledSkills={enabledSkills}
          providers={providers}
          selectedProviderId={selectedProviderId}
          selectedModelId={selectedModelId}
          modelMenuOpen={modelMenuOpen}
          onModelMenuOpenChange={setModelMenuOpen}
          onModelSelect={(providerId, modelId) => void handleModelSelect(providerId, modelId)}
          onOpenSettings={() => setSettingsOpen(true)}
          contextUsage={contextUsage}
          contextOpen={contextOpen}
          onContextOpenChange={setContextOpen}
          onAttachClick={() => {}}
          loading={loading}
          disabled
          primaryAction="implement-plan"
          onImplementPlan={() => onImplementPlan?.(plan)}
          implementPlanDisabled={loading || !onImplementPlan}
        />
      </div>
    </div>
  )
}
