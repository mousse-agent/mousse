import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Bell, Bot, Cpu, Loader2, Palette, Plug, Plus, Server, Smartphone, Sparkles, Trash2, User } from 'lucide-react'
import type {
  AgentTypeId,
  MousseSettings,
  MousseSettingsUpdate,
  SettingsOptions,
  ThemeId
} from '../../shared/settings'
import { resolveTitleModel, groupAgentModelOptions } from '../../shared/settings'
import type {
  ConfiguredProvider,
  ProviderLoginOption
} from '../../shared/providerAuth'
import type { McpServerConfig, SkillsRegistrySnapshot } from '../../shared/integrations'
import { useAppStore } from '../stores/appStore'
import { ProviderLoginModal } from './ProviderLoginModal'
import { ModelFamilySettingsFields } from './ModelFamilySettingsFields'
import { ProfileSection } from './ProfileSection'
import '../styles/settings.css'
import '../styles/connections.css'
import type { ConnectionQrView } from '../../mms/http/connectionQr'

function themePreviewClass(themeId: ThemeId): string {
  switch (themeId) {
    case 'light':
      return 'preview-light'
    case 'system':
      return 'preview-system'
    case 'cursor-dark':
      return 'preview-cursor-dark'
    case 'dark-modern':
      return 'preview-dark-modern'
    case 'one-dark':
      return 'preview-one-dark'
    case 'monokai':
      return 'preview-monokai'
    case 'solarized-dark':
      return 'preview-solarized-dark'
    case 'github-dark':
      return 'preview-github-dark'
    case 'high-contrast':
      return 'preview-high-contrast'
    case 'dark':
    default:
      return 'preview-dark'
  }
}

function ThemePreview({ themeId }: { themeId: ThemeId }) {
  const cls = themePreviewClass(themeId)
  const isLightMain = themeId === 'light' || themeId === 'system'
  return (
    <div className={`theme-preview ${cls}${isLightMain ? ' main-light' : ''}`}>
      <div className="theme-preview-titlebar" />
      <div className="theme-preview-body">
        <div className="theme-preview-sidebar" />
        <div className="theme-preview-main" />
      </div>
    </div>
  )
}

type AddProviderStep = 'provider' | 'credentials'

type IconType = typeof Palette

function SectionHeading({
  icon: Icon,
  title,
  description,
  trailing,
  className
}: {
  icon: IconType
  title: string
  description?: string
  trailing?: ReactNode
  className?: string
}) {
  return (
    <div className={`settings-section-heading${className ? ` ${className}` : ''}`}>
      <span className="settings-section-icon">
        <Icon size={15} />
      </span>
      <div className="settings-section-heading-text">
        <h2>{title}</h2>
        {description && <p className="settings-section-desc">{description}</p>}
      </div>
      {trailing}
    </div>
  )
}

const SETTINGS_SECTIONS = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'providers', label: 'Providers', icon: Plug },
  { id: 'orchestrator', label: 'Models', icon: Cpu },
  { id: 'mcp', label: 'MCP Servers', icon: Server },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'mobile', label: 'Mobile', icon: Smartphone },
  { id: 'agents', label: 'Agents', icon: Bot }
] as const

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

export function SettingsPage() {
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)

  const [settings, setSettings] = useState<MousseSettings | null>(null)
  const [options, setOptions] = useState<SettingsOptions | null>(null)
  const [configuredProviders, setConfiguredProviders] = useState<ConfiguredProvider[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([])
  const [skillsSnapshot, setSkillsSnapshot] = useState<SkillsRegistrySnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [addStep, setAddStep] = useState<AddProviderStep>('provider')
  const [authType, setAuthType] = useState<'api_key' | 'oauth' | 'all'>('all')
  const [loginOptions, setLoginOptions] = useState<ProviderLoginOption[]>([])
  const [providerFilter, setProviderFilter] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<ProviderLoginOption | null>(null)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [ambientInstructions, setAmbientInstructions] = useState<string[]>([])
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [loginActive, setLoginActive] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)
  const [connectionQr, setConnectionQr] = useState<ConnectionQrView | null>(null)
  const [connectionQrError, setConnectionQrError] = useState<string | null>(null)

  const [activeSection, setActiveSection] = useState<SettingsSectionId>('profile')

  const refreshProviderData = useCallback(async () => {
    const [configured, opts] = await Promise.all([
      window.mousse.providers.listConfigured(),
      window.mousse.settings.getOptions()
    ])
    setConfiguredProviders(configured)
    setOptions(opts)
    return { configured, opts }
  }, [])

  const loadSettings = useCallback(() => {
    setLoadError(null)
    setSettings(null)
    setOptions(null)
    Promise.all([
      window.mousse.settings.get(),
      refreshProviderData(),
      window.mousse.mcp.listServers(),
      window.mousse.skills.list()
    ])
      .then(([s, _providerData, servers, skills]) => {
        setMcpServers(servers)
        setSkillsSnapshot(skills)
        setSettings(s)
      })
      .catch(() => {
        setLoadError('Could not load settings. Try restarting the app.')
      })
  }, [refreshProviderData])

  useEffect(() => {
    if (!settingsOpen) return
    setRestartRequired(false)
    loadSettings()
  }, [settingsOpen, loadSettings])

  useEffect(() => {
    if (!settingsOpen) return
    const unsub = window.mousse.providers.onChanged((providers) => {
      setConfiguredProviders(providers)
      void refreshProviderData()
    })
    return unsub
  }, [settingsOpen, refreshProviderData])

  useEffect(() => {
    if (!settingsOpen || activeSection !== 'mobile') return
    setConnectionQrError(null)
    void window.mousse.connections
      .getQr()
      .then(setConnectionQr)
      .catch((error) => {
        setConnectionQr(null)
        setConnectionQrError(error instanceof Error ? error.message : 'Could not create the QR code.')
      })
  }, [settingsOpen, activeSection])

  useEffect(() => {
    if (!settingsOpen) return
    const unsubscribeMcp = window.mousse.mcp.onChanged(() => {
      void window.mousse.mcp.listServers().then(setMcpServers)
    })
    const unsubscribeSkills = window.mousse.skills.onChanged(setSkillsSnapshot)
    return () => {
      unsubscribeMcp()
      unsubscribeSkills()
    }
  }, [settingsOpen])

  const updateSettings = useCallback(
    async (partial: MousseSettingsUpdate) => {
      const prevAcrylic = settings?.appearance.acrylic

      const updated = await window.mousse.settings.set(partial)
      setSettings(updated)

      const nextAcrylic = partial.appearance?.acrylic
      // Intensity / theme color changes apply live; only acrylic on/off may need a restart
      // when Windows refuses live material changes.
      if (nextAcrylic === undefined || nextAcrylic === prevAcrylic) {
        if (partial.appearance) {
          void window.mousse.window.syncBackground()
        }
        return
      }

      const applied = await window.mousse.window.syncBackground()
      const { platform } = await window.mousse.app.getInfo()
      setRestartRequired(platform === 'win32' && !applied)
    },
    [settings]
  )

  /** React maps range onChange to continuous input; debounce IPC so the thumb does not snap. */
  const intensityCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intensityCommitGen = useRef(0)
  useEffect(
    () => () => {
      if (intensityCommitTimer.current) clearTimeout(intensityCommitTimer.current)
    },
    []
  )

  const previewAcrylicIntensity = useCallback((acrylicIntensity: number) => {
    setSettings((prev) =>
      prev
        ? {
            ...prev,
            appearance: { ...prev.appearance, acrylicIntensity }
          }
        : prev
    )
  }, [])

  const commitAcrylicIntensity = useCallback((acrylicIntensity: number) => {
    if (intensityCommitTimer.current) clearTimeout(intensityCommitTimer.current)
    const gen = ++intensityCommitGen.current
    intensityCommitTimer.current = setTimeout(() => {
      intensityCommitTimer.current = null
      void window.mousse.settings
        .set({ appearance: { ...settings!.appearance, acrylicIntensity } })
        .then((updated) => {
          // Drop stale responses if the user kept dragging.
          if (gen !== intensityCommitGen.current) return
          setSettings(updated)
          void window.mousse.window.syncBackground()
        })
    }, 120)
  }, [])

  const ensureValidProviderSelection = useCallback(
    async (nextSettings: MousseSettings, providers = options?.llmProviders ?? []) => {
      const current = nextSettings.provider
      const selectedProvider = providers.find((p) => p.id === current.llmProvider)
      const modelExists = selectedProvider?.models.some((m) => m.id === current.model)

      if (selectedProvider && modelExists) return nextSettings

      const first = providers[0]
      if (!first) {
        if (!current.llmProvider && !current.model) return nextSettings
        return {
          ...nextSettings,
          provider: { llmProvider: '', model: '' }
        }
      }

      return {
        ...nextSettings,
        provider: {
          llmProvider: first.id,
          model: first.models[0]?.id ?? ''
        }
      }
    },
    [options?.llmProviders]
  )

  const handleProviderChange = (llmProvider: MousseSettings['provider']['llmProvider']) => {
    const provider = options?.llmProviders.find((p) => p.id === llmProvider)
    const model = provider?.models[0]?.id ?? ''
    void updateSettings({ provider: { llmProvider, model } })
  }

  const resetAddFlow = () => {
    setAddOpen(false)
    setAddStep('provider')
    setAuthType('all')
    setLoginOptions([])
    setProviderFilter('')
    setSelectedProvider(null)
    setApiKeyInput('')
    setAmbientInstructions([])
    setConnectError(null)
    setConnecting(false)
    setLoginActive(false)
  }

  const loadLoginOptions = useCallback(async (filter: 'api_key' | 'oauth' | 'all') => {
    const options =
      filter === 'all'
        ? await window.mousse.providers.getLoginOptions()
        : await window.mousse.providers.getLoginOptions(filter)
    return options.filter((option) => !option.configured)
  }, [])

  const openAddProvider = async () => {
    setAddOpen(true)
    setAddStep('provider')
    setAuthType('all')
    setProviderFilter('')
    setConnectError(null)
    setLoginOptions(await loadLoginOptions('all'))
  }

  const chooseAuthType = async (nextAuthType: 'api_key' | 'oauth' | 'all') => {
    setAuthType(nextAuthType)
    setProviderFilter('')
    setLoginOptions(await loadLoginOptions(nextAuthType))
    setAddStep('provider')
  }

  const chooseProvider = async (provider: ProviderLoginOption) => {
    setSelectedProvider(provider)
    setConnectError(null)
    setApiKeyInput('')

    if (provider.ambient) {
      const info = await window.mousse.providers.getAmbientInfo(provider.id)
      setAmbientInstructions(info?.instructions ?? [])
      setAddStep('credentials')
      return
    }

    setAddStep('credentials')
  }

  const finishProviderAdd = async (providerId: string) => {
    const refreshed = await refreshProviderData()
    if (!settings) return
    const provider = refreshed.opts.llmProviders.find((p) => p.id === providerId)
    const nextSettings = await ensureValidProviderSelection({
      ...settings,
      provider: {
        llmProvider: providerId,
        model: provider?.models[0]?.id ?? ''
      }
    }, refreshed.opts.llmProviders)
    const updated = await window.mousse.settings.set({ provider: nextSettings.provider })
    setSettings(updated)
    resetAddFlow()
  }

  const connectSelectedProvider = async () => {
    if (!selectedProvider) return
    setConnecting(true)
    setConnectError(null)

    try {
      if (selectedProvider.ambient) {
        const result = await window.mousse.providers.verifyAmbient(selectedProvider.id)
        if (!result.success) {
          setConnectError(result.error ?? 'Could not verify provider credentials.')
          return
        }
        await finishProviderAdd(selectedProvider.id)
        return
      }

      if (selectedProvider.authType === 'oauth') {
        setLoginActive(true)
        const result = await window.mousse.providers.loginOAuth(selectedProvider.id)
        setLoginActive(false)
        if (!result.success) {
          setConnectError(result.error ?? 'OAuth login failed.')
          return
        }
        await finishProviderAdd(selectedProvider.id)
        return
      }

      // Multi-step api-key providers (e.g. Cloudflare account/gateway IDs).
      if (selectedProvider.guidedLogin || !apiKeyInput.trim()) {
        setLoginActive(true)
        const result = await window.mousse.providers.loginApiKey(selectedProvider.id)
        setLoginActive(false)
        if (!result.success) {
          setConnectError(result.error ?? 'API key login failed.')
          return
        }
        await finishProviderAdd(selectedProvider.id)
        return
      }

      await window.mousse.providers.setApiKey(selectedProvider.id, apiKeyInput.trim())
      await finishProviderAdd(selectedProvider.id)
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : String(error))
    } finally {
      setConnecting(false)
      setLoginActive(false)
    }
  }

  const handleLogout = async (providerId: string) => {
    await window.mousse.providers.logout(providerId)
    const { configured, opts } = await refreshProviderData()
    if (!settings) return
    if (settings.provider.llmProvider !== providerId) return

    const nextSettings = await ensureValidProviderSelection(
      {
        ...settings,
        provider: { llmProvider: '', model: '' }
      },
      opts.llmProviders
    )
    const updated = await window.mousse.settings.set({ provider: nextSettings.provider })
    setSettings(updated)
    if (configured.length === 0) {
      setOptions(opts)
    }
  }

  const handleRestart = () => {
    void window.mousse.app.restart()
  }

  const toggleMcpServer = (server: McpServerConfig) => {
    const enabled = new Set(settings?.integrations.mcp.enabledServers ?? [])
    if (enabled.has(server.id)) {
      enabled.delete(server.id)
    } else {
      enabled.add(server.id)
    }
    void updateSettings({
      integrations: {
        ...settings!.integrations,
        mcp: { ...settings!.integrations.mcp, enabledServers: Array.from(enabled) }
      }
    })
  }

  const handleMcpConnect = async (serverId: string) => {
    const result = await window.mousse.mcp.authenticate(serverId)
    if (!result.success) {
      window.alert(result.error ?? 'MCP authentication failed.')
      return
    }
    const servers = await window.mousse.mcp.listServers()
    setMcpServers(servers)
  }

  const toggleSkill = (skillId: string) => {
    const enabled = new Set(settings?.integrations.skills.enabledSkills ?? [])
    if (enabled.has(skillId)) {
      enabled.delete(skillId)
    } else {
      enabled.add(skillId)
    }
    void updateSettings({
      integrations: {
        ...settings!.integrations,
        skills: { ...settings!.integrations.skills, enabledSkills: Array.from(enabled) }
      }
    })
  }

  const closeSettings = useCallback(() => {
    resetAddFlow()
    setSettingsOpen(false)
  }, [setSettingsOpen])

  const settingsHeader = (
    <header className="settings-header overlay-page-drag-header">
      <button
        type="button"
        className="settings-back-btn"
        onClick={closeSettings}
      >
        <ArrowLeft size={16} />
        Back
      </button>
      <h1>Settings</h1>
    </header>
  )

  if (!settings || !options) {
    return (
      <div className="settings-page overlay-page" hidden={!settingsOpen}>
        {settingsHeader}
        <div className="settings-body">
          <div className="settings-status">
            {loadError ? (
              <>
                <p className="settings-error">{loadError}</p>
                <button type="button" className="settings-retry-btn" onClick={loadSettings}>
                  Retry
                </button>
              </>
            ) : (
              <div className="settings-loading">Loading settings…</div>
            )}
          </div>
        </div>
      </div>
    )
  }

  const providerModels =
    options.llmProviders.find((p) => p.id === settings.provider.llmProvider)?.models ?? []
  const currentModels =
    settings.provider.model &&
    !providerModels.some((model) => model.id === settings.provider.model)
      ? [...providerModels, { id: settings.provider.model, label: settings.provider.model }]
      : providerModels
  const resolvedTitle = resolveTitleModel(settings, options.llmProviders)
  const titleProviderModels =
    options.llmProviders.find((p) => p.id === resolvedTitle.llmProvider)?.models ?? []
  const titleModels =
    resolvedTitle.model &&
    !titleProviderModels.some((model) => model.id === resolvedTitle.model)
      ? [...titleProviderModels, { id: resolvedTitle.model, label: resolvedTitle.model }]
      : titleProviderModels
  const hasConfiguredProviders = options.llmProviders.length > 0
  const mousseProviderId = settings.agents.llmProvider.mousse ?? ''
  const mousseProvider = options.llmProviders.find((provider) => provider.id === mousseProviderId)
  const mousseModelId = settings.agents.model.mousse ?? ''
  const mousseModels =
    mousseModelId &&
    mousseProvider &&
    !mousseProvider.models.some((model) => model.id === mousseModelId)
      ? [...mousseProvider.models, { id: mousseModelId, label: mousseModelId }]
      : (mousseProvider?.models ?? [])

  return (
    <div className="settings-page overlay-page" hidden={!settingsOpen}>
      {settingsHeader}
      <ProviderLoginModal active={loginActive} onClose={() => setLoginActive(false)} />

      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((section) => {
            const Icon = section.icon
            const active = activeSection === section.id
            return (
              <button
                key={section.id}
                type="button"
                className={`settings-nav-item${active ? ' active' : ''}`}
                onClick={() => setActiveSection(section.id)}
                aria-current={active ? 'page' : undefined}
              >
                <span className="settings-nav-item-icon">
                  <Icon size={15} />
                </span>
                {section.label}
              </button>
            )
          })}
        </nav>

        <div className="settings-content" key={activeSection}>
          {activeSection === 'profile' && (
          <section id="profile" className="settings-section">
            <SectionHeading
              icon={User}
              title="Profile"
              description="Your display name and editing activity in Mousse."
            />
            <ProfileSection settings={settings} onUpdate={updateSettings} />
          </section>
          )}

          {activeSection === 'appearance' && (
          <section id="appearance" className="settings-section">
            <SectionHeading
              icon={Palette}
              title="Appearance"
              description="Pick a color theme, then optionally enable acrylic glass over any of them."
            />

          <p className="settings-section-desc" style={{ marginBottom: 10 }}>
            Color theme
          </p>
          <div className="theme-carousel">
            {options.themes.map((theme) => {
              const selected = settings.appearance.theme === theme.id
              return (
                <div
                  key={theme.id}
                  className={`theme-card${selected ? ' selected' : ''}`}
                  onClick={() =>
                    void updateSettings({ appearance: { ...settings.appearance, theme: theme.id } })
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      void updateSettings({
                        appearance: { ...settings.appearance, theme: theme.id }
                      })
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <ThemePreview themeId={theme.id} />
                  <span className="theme-card-label">{theme.label}</span>
                </div>
              )
            })}
          </div>

          <div className="acrylic-controls">
            <div className="registry-control-row acrylic-toggle-row">
              <div className="registry-control-text">
                <span className="registry-control-label">Acrylic glass</span>
                <span className="registry-control-hint">
                  Translucent window material across every theme (Windows). Intensity dials blur and
                  opacity of the glass layers.
                </span>
              </div>
              <button
                type="button"
                className={`toggle-switch${settings.appearance.acrylic ? ' on' : ''}`}
                role="switch"
                aria-checked={settings.appearance.acrylic}
                aria-label="Acrylic glass"
                onClick={() =>
                  void updateSettings({
                    appearance: {
                      ...settings.appearance,
                      acrylic: !settings.appearance.acrylic
                    }
                  })
                }
              />
            </div>

            <div
              className={`acrylic-intensity-row${settings.appearance.acrylic ? '' : ' disabled'}`}
            >
              <div className="acrylic-intensity-header">
                <label htmlFor="acrylic-intensity">Intensity</label>
                <span className="acrylic-intensity-value">
                  {settings.appearance.acrylicIntensity}
                </span>
              </div>
              <input
                id="acrylic-intensity"
                type="range"
                className="acrylic-intensity-dial"
                min={0}
                max={100}
                step={1}
                disabled={!settings.appearance.acrylic}
                value={settings.appearance.acrylicIntensity}
                onInput={(e) => {
                  // React maps range onChange → continuous input; use only onInput so we
                  // do not double-fire IPC and snap the controlled thumb backward.
                  const acrylicIntensity = Number(e.currentTarget.value)
                  previewAcrylicIntensity(acrylicIntensity)
                  commitAcrylicIntensity(acrylicIntensity)
                }}
              />
              <div className="acrylic-intensity-ticks">
                <span>Solid</span>
                <span>Glassy</span>
              </div>
            </div>

            {restartRequired && (
              <button type="button" className="theme-restart-link acrylic-restart" onClick={handleRestart}>
                Restart required to apply acrylic material
              </button>
            )}
          </div>

          <div style={{ marginTop: 20 }}>
            <p className="settings-section-desc">Accent color</p>
            <div className="accent-grid">
              {options.accentColors.map((color) => (
                <button
                  key={color.id}
                  type="button"
                  className={`accent-swatch${settings.appearance.accentColor === color.value ? ' selected' : ''}`}
                  style={{ backgroundColor: color.value }}
                  title={color.label}
                  aria-label={color.label}
                  onClick={() =>
                    void updateSettings({
                      appearance: { ...settings.appearance, accentColor: color.value }
                    })
                  }
                />
              ))}
            </div>
          </div>
        </section>
          )}

          {activeSection === 'notifications' && (
        <section id="notifications" className="settings-section">
          <SectionHeading
            icon={Bell}
            title="Notifications"
            description="Choose how Mousse alerts you when background work needs your attention."
          />

          <div className="registry-controls">
            <div className="registry-control-row">
              <div className="registry-control-text">
                <span className="registry-control-label">Agent completion sound</span>
                <span className="registry-control-hint">
                  Play the operating system notification sound when Mousse shows an agent completion alert.
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.notifications.threadCompletionSound}
                aria-label="Agent completion sound"
                className={`toggle-switch${settings.notifications.threadCompletionSound ? ' on' : ''}`}
                onClick={() =>
                  void updateSettings({
                    notifications: {
                      threadCompletionSound: !settings.notifications.threadCompletionSound
                    }
                  })
                }
              />
            </div>
          </div>
        </section>
          )}

          {activeSection === 'providers' && (
        <section id="providers" className="settings-section">
          <SectionHeading
            icon={Plug}
            title="Providers"
            description="Authenticate LLM providers. Connected providers appear in model pickers across the app."
            trailing={
              <button type="button" className="settings-add-btn" onClick={() => void openAddProvider()}>
                <Plus size={14} />
                Add provider
              </button>
            }
          />

          {configuredProviders.length === 0 ? (
            <div className="provider-empty-state">
              <p>No providers connected yet.</p>
              <button type="button" className="settings-add-btn" onClick={() => void openAddProvider()}>
                <Plus size={14} />
                Add your first provider
              </button>
            </div>
          ) : (
            <div className="provider-list">
              {configuredProviders.map((provider) => (
                <div key={provider.id} className="provider-list-item">
                  <div>
                    <strong>{provider.label}</strong>
                    <span className="provider-list-meta">
                      {provider.authType === 'oauth' ? 'Subscription' : 'API key'}
                      {provider.source ? ` · ${provider.source}` : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="provider-remove-btn"
                    onClick={() => void handleLogout(provider.id)}
                    aria-label={`Remove ${provider.label}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {addOpen && (
            <div className="provider-add-panel">
              {addStep === 'provider' && (
                <>
                  <p className="settings-section-desc">
                    Choose a provider. All pi-ai built-in providers are listed — API keys and
                    subscription logins where supported.
                  </p>
                  <div className="provider-filter-row">
                    <input
                      className="settings-input provider-filter-input"
                      type="search"
                      value={providerFilter}
                      onChange={(e) => setProviderFilter(e.target.value)}
                      placeholder="Search providers…"
                      aria-label="Search providers"
                    />
                    <div className="provider-auth-filter" role="group" aria-label="Auth type filter">
                      {(
                        [
                          { id: 'all', label: 'All' },
                          { id: 'api_key', label: 'API key' },
                          { id: 'oauth', label: 'Subscription' }
                        ] as const
                      ).map((filter) => (
                        <button
                          key={filter.id}
                          type="button"
                          className={`provider-auth-filter-btn${authType === filter.id ? ' active' : ''}`}
                          onClick={() => void chooseAuthType(filter.id)}
                        >
                          {filter.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="provider-picker-list">
                    {loginOptions
                      .filter((provider) => {
                        const q = providerFilter.trim().toLowerCase()
                        if (!q) return true
                        return (
                          provider.label.toLowerCase().includes(q) ||
                          provider.id.toLowerCase().includes(q) ||
                          (provider.description?.toLowerCase().includes(q) ?? false)
                        )
                      })
                      .map((provider) => (
                        <button
                          key={`${provider.id}:${provider.authType}`}
                          type="button"
                          className="provider-picker-item"
                          onClick={() => void chooseProvider(provider)}
                        >
                          <span>{provider.label}</span>
                          <small>
                            {provider.description ??
                              (provider.authType === 'oauth' ? 'Subscription / OAuth' : 'API key')}
                          </small>
                        </button>
                      ))}
                    {loginOptions.length === 0 && (
                      <p className="provider-empty-hint">All known providers are already connected.</p>
                    )}
                  </div>
                  <button type="button" className="provider-add-cancel" onClick={resetAddFlow}>
                    Cancel
                  </button>
                </>
              )}

              {addStep === 'credentials' && selectedProvider && (
                <>
                  <p className="settings-section-desc">
                    Connect <strong>{selectedProvider.label}</strong>
                    {selectedProvider.description ? (
                      <>
                        {' '}
                        <span className="provider-list-meta">({selectedProvider.description})</span>
                      </>
                    ) : null}
                  </p>

                  {selectedProvider.ambient && (
                    <ul className="provider-ambient-instructions">
                      {ambientInstructions.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}

                  {selectedProvider.authType === 'api_key' &&
                    !selectedProvider.ambient &&
                    !selectedProvider.guidedLogin && (
                      <>
                        <label className="settings-row" htmlFor="provider-api-key">
                          API key
                        </label>
                        <input
                          id="provider-api-key"
                          className="settings-input"
                          type="password"
                          value={apiKeyInput}
                          onChange={(e) => setApiKeyInput(e.target.value)}
                          placeholder={`Enter ${selectedProvider.label} API key`}
                        />
                        <p className="provider-login-hint">
                          Paste your key, or leave blank to use the guided prompt.
                        </p>
                      </>
                    )}

                  {selectedProvider.authType === 'api_key' && selectedProvider.guidedLogin && (
                    <p className="provider-login-hint">
                      This provider needs a short guided setup (API key plus account details).
                    </p>
                  )}

                  {selectedProvider.authType === 'oauth' && (
                    <p className="provider-login-hint">
                      You will be redirected to sign in with your subscription account.
                    </p>
                  )}

                  {connectError && <p className="settings-error">{connectError}</p>}

                  <div className="provider-add-actions">
                    <button
                      type="button"
                      className="provider-add-cancel"
                      onClick={() => setAddStep('provider')}
                      disabled={connecting}
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      className="provider-connect-btn"
                      onClick={() => void connectSelectedProvider()}
                      disabled={connecting}
                    >
                      {connecting ? (
                        <>
                          <Loader2 size={14} className="icon-spin" />
                          Connecting…
                        </>
                      ) : (
                        'Connect'
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>
          )}

          {activeSection === 'orchestrator' && (
        <section id="orchestrator" className="settings-section">
          <SectionHeading
            icon={Cpu}
            title="Orchestrator model"
            description="Choose which connected provider and model power the orchestrator chat."
          />

          {!hasConfiguredProviders ? (
            <p className="provider-empty-hint">Add a provider under Providers to select a model.</p>
          ) : (
            <>
              <div className="settings-row">
                <label htmlFor="llm-provider">Provider</label>
                <select
                  id="llm-provider"
                  className="settings-select"
                  value={settings.provider.llmProvider}
                  onChange={(e) =>
                    handleProviderChange(
                      e.target.value as MousseSettings['provider']['llmProvider']
                    )
                  }
                >
                  {options.llmProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              <ModelFamilySettingsFields
                key={`${settings.provider.llmProvider}:${settings.provider.model}`}
                providerId={settings.provider.llmProvider}
                modelId={settings.provider.model}
                models={currentModels}
                familySelectId="llm-model-family"
                contextSelectId="llm-model-context"
                effortSelectId="llm-model-effort"
                speedSelectId="llm-model-speed"
                onChange={(model) =>
                  void updateSettings({
                    provider: { ...settings.provider, model }
                  })
                }
              />

              <SectionHeading
                icon={Bot}
                title="Mousse subagents"
                className="settings-subsection-heading"
                description="Choose a default model for in-app subagents, or inherit the orchestrator model."
              />
              <div className="settings-row">
                <label htmlFor="agent-provider-mousse">Default provider</label>
                <select
                  id="agent-provider-mousse"
                  className="settings-select"
                  value={mousseProviderId}
                  onChange={(event) => {
                    const llmProvider = event.target.value
                    const provider = options.llmProviders.find((item) => item.id === llmProvider)
                    void updateSettings({
                      agents: {
                        llmProvider: { ...settings.agents.llmProvider, mousse: llmProvider },
                        model: {
                          ...settings.agents.model,
                          mousse: provider?.models[0]?.id ?? ''
                        }
                      }
                    })
                  }}
                >
                  <option value="">Inherit orchestrator model</option>
                  {options.llmProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.label}</option>
                  ))}
                </select>
              </div>
              {mousseProvider && (
                <ModelFamilySettingsFields
                  key={`mousse:${mousseProviderId}:${mousseModelId}`}
                  providerId={mousseProviderId}
                  modelId={mousseModelId}
                  models={mousseModels}
                  familySelectId="agent-model-mousse"
                  contextSelectId="agent-model-mousse-context"
                  effortSelectId="agent-model-mousse-effort"
                  speedSelectId="agent-model-mousse-speed"
                  onChange={(model) =>
                    void updateSettings({
                      agents: { model: { ...settings.agents.model, mousse: model } }
                    })
                  }
                />
              )}

              <SectionHeading
                icon={Cpu}
                title="Chat titles"
                className="settings-subsection-heading"
                description="A lightweight model names each chat after its first response. OpenAI Luna Low is preferred when available."
              />
              <div className="settings-row">
                <label htmlFor="title-provider">Title provider</label>
                <select
                  id="title-provider"
                  className="settings-select"
                  value={resolvedTitle.llmProvider}
                  onChange={(event) => {
                    const llmProvider = event.target.value
                    const provider = options.llmProviders.find((item) => item.id === llmProvider)
                    const next = resolveTitleModel(
                      { ...settings, title: { llmProvider, model: '' } },
                      provider ? [provider] : []
                    )
                    void updateSettings({ title: next })
                  }}
                >
                  {options.llmProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.label}</option>
                  ))}
                </select>
              </div>
              <ModelFamilySettingsFields
                key={`title:${resolvedTitle.llmProvider}:${resolvedTitle.model}`}
                providerId={resolvedTitle.llmProvider}
                modelId={resolvedTitle.model}
                models={titleModels}
                familySelectId="title-model-family"
                contextSelectId="title-model-context"
                effortSelectId="title-model-effort"
                speedSelectId="title-model-speed"
                onChange={(model) =>
                  void updateSettings({ title: { llmProvider: resolvedTitle.llmProvider, model } })
                }
              />
            </>
          )}
        </section>
          )}

          {activeSection === 'mcp' && (
        <section id="mcp" className="settings-section">
          <SectionHeading
            icon={Server}
            title="MCP Servers"
            description="Standard MCP config files, with secrets redacted. Selected servers are exposed to the orchestrator or spawned CLIs."
          />

          <div className="registry-controls">
            <div className="registry-control-row">
              <div className="registry-control-text">
                <span className="registry-control-label">MCP registry</span>
                <span className="registry-control-hint">Scan config files for servers</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.integrations.mcp.enabled}
                className={`toggle-switch${settings.integrations.mcp.enabled ? ' on' : ''}`}
                onClick={() =>
                  void updateSettings({
                    integrations: {
                      ...settings.integrations,
                      mcp: {
                        ...settings.integrations.mcp,
                        enabled: !settings.integrations.mcp.enabled
                      }
                    }
                  })
                }
              />
            </div>
            <div className="registry-control-row">
              <div className="registry-control-text">
                <span className="registry-control-label">Expose to orchestrator</span>
                <span className="registry-control-hint">Share selected servers with the main agent</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.integrations.mcp.enableForMainAgent}
                className={`toggle-switch${settings.integrations.mcp.enableForMainAgent ? ' on' : ''}`}
                onClick={() =>
                  void updateSettings({
                    integrations: {
                      ...settings.integrations,
                      mcp: {
                        ...settings.integrations.mcp,
                        enableForMainAgent: !settings.integrations.mcp.enableForMainAgent
                      }
                    }
                  })
                }
              />
            </div>
          </div>

          <div className="integration-list">
            {mcpServers.length === 0 ? (
              <p className="provider-empty-hint">No MCP servers discovered yet.</p>
            ) : (
              mcpServers.map((server) => {
                const enabled = settings.integrations.mcp.enabledServers.includes(server.id)
                return (
                  <div key={server.id} className="integration-card">
                    <div className="integration-card-info">
                      <div className="integration-card-head">
                        <span className={`integration-status-dot status-${server.status}`} />
                        <strong>{server.name}</strong>
                      </div>
                      <div className="integration-badges">
                        <span className="integration-badge">{server.source}</span>
                        <span className="integration-badge">{server.transport}</span>
                        <span className={`integration-badge status-badge-${server.status}`}>
                          {server.status}
                        </span>
                        {server.missingEnvVars && server.missingEnvVars.length > 0 && (
                          <span className="integration-badge integration-badge-warn">
                            Missing: {server.missingEnvVars.join(', ')}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="integration-card-actions">
                      {(server.transport === 'http' || server.transport === 'sse') && (
                        <button
                          type="button"
                          className="settings-inline-btn"
                          onClick={() => void handleMcpConnect(server.id)}
                        >
                          Connect
                        </button>
                      )}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        className={`toggle-switch${enabled ? ' on' : ''}`}
                        onClick={() => toggleMcpServer(server)}
                      />
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>
          )}

          {activeSection === 'skills' && (
        <section id="skills" className="settings-section">
          <SectionHeading
            icon={Sparkles}
            title="Skills"
            description="Discovered Skills stay as standard folders. Selected Skills can be listed or loaded by the orchestrator and materialized for spawned CLIs."
          />

          <div className="registry-controls">
            <div className="registry-control-row">
              <div className="registry-control-text">
                <span className="registry-control-label">Skills registry</span>
                <span className="registry-control-hint">Scan folders for Skills</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.integrations.skills.enabled}
                className={`toggle-switch${settings.integrations.skills.enabled ? ' on' : ''}`}
                onClick={() =>
                  void updateSettings({
                    integrations: {
                      ...settings.integrations,
                      skills: {
                        ...settings.integrations.skills,
                        enabled: !settings.integrations.skills.enabled
                      }
                    }
                  })
                }
              />
            </div>
            <div className="registry-control-row">
              <div className="registry-control-text">
                <span className="registry-control-label">Expose to orchestrator</span>
                <span className="registry-control-hint">Share selected Skills with the main agent</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.integrations.skills.enableForMainAgent}
                className={`toggle-switch${settings.integrations.skills.enableForMainAgent ? ' on' : ''}`}
                onClick={() =>
                  void updateSettings({
                    integrations: {
                      ...settings.integrations,
                      skills: {
                        ...settings.integrations.skills,
                        enableForMainAgent: !settings.integrations.skills.enableForMainAgent
                      }
                    }
                  })
                }
              />
            </div>
          </div>

          <div className="integration-list">
            {!skillsSnapshot || skillsSnapshot.skills.length === 0 ? (
              <p className="provider-empty-hint">No Skills discovered yet.</p>
            ) : (
              skillsSnapshot.skills.map((skill) => {
                const enabled = settings.integrations.skills.enabledSkills.includes(skill.id)
                const duplicate = skill.isActive === false
                const skillModel = settings.integrations.skills.model[skill.id]
                const skillProviderId = skillModel?.llmProvider ?? settings.provider.llmProvider
                const skillModelId = skillModel?.model ?? settings.provider.model
                const skillProvider = options.llmProviders.find((p) => p.id === skillProviderId)
                const skillModelOptions =
                  skillModelId &&
                  skillProvider &&
                  !skillProvider.models.some((model) => model.id === skillModelId)
                    ? [...skillProvider.models, { id: skillModelId, label: skillModelId }]
                    : (skillProvider?.models ?? [])
                return (
                  <div key={skill.id} className="integration-card">
                    <div className="integration-card-info">
                      <div className="integration-card-head">
                        <span
                          className={`integration-status-dot ${duplicate ? 'status-duplicate' : 'status-ready'}`}
                        />
                        <strong>{skill.name}</strong>
                      </div>
                      <span className="integration-description">{skill.description}</span>
                      <div className="integration-badges">
                        <span className="integration-badge">{skill.source}</span>
                        <span className="integration-badge">{skill.scope}</span>
                        {duplicate && (
                          <span className="integration-badge integration-badge-warn">duplicate</span>
                        )}
                      </div>
                      {enabled && !duplicate && hasConfiguredProviders && (
                        <div className="skill-model-settings">
                          <label className="skill-model-label" htmlFor={`skill-provider-${skill.id}`}>
                            Default model
                          </label>
                          <div className="skill-model-row">
                            <select
                              id={`skill-provider-${skill.id}`}
                              className="settings-select"
                              value={skillProviderId}
                              onChange={(e) => {
                                const nextProviderId = e.target.value
                                const nextProvider = options.llmProviders.find(
                                  (p) => p.id === nextProviderId
                                )
                                void updateSettings({
                                  integrations: {
                                    ...settings.integrations,
                                    skills: {
                                      ...settings.integrations.skills,
                                      model: {
                                        ...settings.integrations.skills.model,
                                        [skill.id]: {
                                          llmProvider: nextProviderId,
                                          model: nextProvider?.models[0]?.id ?? ''
                                        }
                                      }
                                    }
                                  }
                                })
                              }}
                            >
                              {options.llmProviders.map((provider) => (
                                <option key={provider.id} value={provider.id}>
                                  {provider.label}
                                </option>
                              ))}
                            </select>
                            <ModelFamilySettingsFields
                              key={`${skill.id}:${skillProviderId}:${skillModelId}`}
                              providerId={skillProviderId}
                              modelId={skillModelId}
                              models={skillModelOptions}
                              familySelectId={`skill-model-family-${skill.id}`}
                              contextSelectId={`skill-model-context-${skill.id}`}
                              effortSelectId={`skill-model-effort-${skill.id}`}
                              speedSelectId={`skill-model-speed-${skill.id}`}
                              onChange={(model) =>
                                void updateSettings({
                                  integrations: {
                                    ...settings.integrations,
                                    skills: {
                                      ...settings.integrations.skills,
                                      model: {
                                        ...settings.integrations.skills.model,
                                        [skill.id]: {
                                          llmProvider: skillProviderId,
                                          model
                                        }
                                      }
                                    }
                                  }
                                })
                              }
                            />
                          </div>
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      className={`toggle-switch${enabled ? ' on' : ''}`}
                      onClick={() => toggleSkill(skill.id)}
                      disabled={duplicate}
                    />
                  </div>
                )
              })
            )}
          </div>
        </section>
          )}

          {activeSection === 'mobile' && (
          <section id="mobile" className="settings-section">
            <SectionHeading
              icon={Smartphone}
              title="Mousse Mobile"
              description="Scan a configuration-only QR, then approve access through OAuth and PKCE."
            />
            <div className="mobile-connection-card">
              {connectionQr?.qrDataUrl ? (
                <>
                  <img src={connectionQr.qrDataUrl} alt="Mousse Mobile connection QR code" />
                  <div className="mobile-connection-copy">
                    <strong>Scan with Mousse Mobile</strong>
                    <code>{connectionQr.baseUrl}</code>
                    <p>
                      The QR contains no token or approval code. Your phone will still ask you to
                      authorize its requested scopes.
                    </p>
                  </div>
                </>
              ) : (
                <div className="mobile-connection-copy">
                  <strong>QR pairing is not ready</strong>
                  <p>{connectionQrError ?? connectionQr?.reason ?? 'Loading connection details…'}</p>
                  <code>mousse-cli connections qr</code>
                  <p>
                    Enable <code>mms.http</code> and configure an HTTPS{' '}
                    <code>mms.http.publicBaseUrl</code> reachable by your phone, then restart MMS.
                  </p>
                </div>
              )}
            </div>
          </section>
          )}

          {activeSection === 'agents' && (
        <section id="agents" className="settings-section">
          <SectionHeading
            icon={Bot}
            title="Agents"
            description="Enable agent types and choose which model each CLI uses when spawned."
          />

          <div className="agent-config-list">
            {options.agentTypes.map((agent) => {
              const agentId = agent.id as AgentTypeId
              const isMousse = agentId === 'mousse'
              const enabled = isMousse ? true : (settings.agents.enabled[agentId] ?? false)
              const selectedModel = settings.agents.model[agentId] ?? ''
              const modelOptions =
                selectedModel && !agent.models.some((model) => model.id === selectedModel)
                  ? [...agent.models, { id: selectedModel, label: selectedModel }]
                  : agent.models
              const mcpOn = settings.integrations.mcp.enableForAgents[agentId] ?? true
              const skillsOn = settings.integrations.skills.enableForAgents[agentId] ?? true
              const headlessOn = settings.agents.headless[agentId] ?? true

              if (isMousse) {
                return (
                  <div key={agent.id} className="agent-config-row enabled agent-config-row-mousse">
                    <div className="agent-config-head">
                      <div className="agent-config-id">
                        <span className="agent-config-label">{agent.label}</span>
                        <span className="agent-config-state on">Always on</span>
                      </div>
                    </div>
                    <div className="agent-config-body">
                      <p className="agent-config-mousse-hint">
                        In-app subagent with the orchestrator chat experience. Its default model
                        is configured under Models.
                      </p>
                      <div className="agent-config-exposure">
                        <span className="agent-config-exposure-label">Expose</span>
                        <button
                          type="button"
                          className={`exposure-pill${mcpOn ? ' on' : ''}`}
                          onClick={() =>
                            void updateSettings({
                              integrations: {
                                ...settings.integrations,
                                mcp: {
                                  ...settings.integrations.mcp,
                                  enableForAgents: {
                                    ...settings.integrations.mcp.enableForAgents,
                                    [agentId]: !mcpOn
                                  }
                                }
                              }
                            })
                          }
                        >
                          <Server size={12} />
                          MCP
                        </button>
                        <button
                          type="button"
                          className={`exposure-pill${skillsOn ? ' on' : ''}`}
                          onClick={() =>
                            void updateSettings({
                              integrations: {
                                ...settings.integrations,
                                skills: {
                                  ...settings.integrations.skills,
                                  enableForAgents: {
                                    ...settings.integrations.skills.enableForAgents,
                                    [agentId]: !skillsOn
                                  }
                                }
                              }
                            })
                          }
                        >
                          <Sparkles size={12} />
                          Skills
                        </button>
                      </div>
                    </div>
                  </div>
                )
              }

              return (
                <div
                  key={agent.id}
                  className={`agent-config-row${enabled ? ' enabled' : ''}`}
                >
                  <div className="agent-config-head">
                    <div className="agent-config-id">
                      <span className="agent-config-label">{agent.label}</span>
                      <span className={`agent-config-state${enabled ? ' on' : ''}`}>
                        {enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      className={`toggle-switch${enabled ? ' on' : ''}`}
                      onClick={() =>
                        void updateSettings({
                          agents: {
                            enabled: {
                              ...settings.agents.enabled,
                              [agentId]: !enabled
                            }
                          }
                        })
                      }
                    />
                  </div>

                  {enabled && (
                    <div className="agent-config-body">
                      {agent.models.length > 0 && (
                        <div className="agent-config-field">
                          <label htmlFor={`agent-model-${agent.id}`}>Model</label>
                          <select
                            id={`agent-model-${agent.id}`}
                            className="settings-select agent-model-select"
                            value={selectedModel}
                            aria-label={`${agent.label} model`}
                            onChange={(e) =>
                              void updateSettings({
                                agents: {
                                  model: {
                                    ...settings.agents.model,
                                    [agentId]: e.target.value
                                  }
                                }
                              })
                            }
                          >
                            <option value="">Default (CLI)</option>
                            {groupAgentModelOptions(modelOptions).map(({ group, models: groupModels }) =>
                              group ? (
                                <optgroup key={group} label={group}>
                                  {groupModels.map((model) => (
                                    <option key={model.id} value={model.id}>
                                      {model.label}
                                    </option>
                                  ))}
                                </optgroup>
                              ) : (
                                groupModels.map((model) => (
                                  <option key={model.id} value={model.id}>
                                    {model.label}
                                  </option>
                                ))
                              )
                            )}
                          </select>
                        </div>
                      )}

                      <div className="agent-config-field">
                        <label htmlFor={`agent-headless-${agent.id}`}>Headless subagent</label>
                        <div className="agent-config-headless-row">
                          <span className="agent-config-headless-hint">
                            Run in background with programmatic CLI flags instead of an interactive terminal
                          </span>
                          <button
                            id={`agent-headless-${agent.id}`}
                            type="button"
                            role="switch"
                            aria-checked={headlessOn}
                            aria-label={`${agent.label} headless subagent`}
                            className={`toggle-switch${headlessOn ? ' on' : ''}`}
                            onClick={() =>
                              void updateSettings({
                                agents: {
                                  headless: {
                                    ...settings.agents.headless,
                                    [agentId]: !headlessOn
                                  }
                                }
                              })
                            }
                          />
                        </div>
                      </div>

                      <div className="agent-config-exposure">
                        <span className="agent-config-exposure-label">Expose</span>
                        <button
                          type="button"
                          className={`exposure-pill${mcpOn ? ' on' : ''}`}
                          onClick={() =>
                            void updateSettings({
                              integrations: {
                                ...settings.integrations,
                                mcp: {
                                  ...settings.integrations.mcp,
                                  enableForAgents: {
                                    ...settings.integrations.mcp.enableForAgents,
                                    [agentId]: !mcpOn
                                  }
                                }
                              }
                            })
                          }
                        >
                          <Server size={12} />
                          MCP
                        </button>
                        <button
                          type="button"
                          className={`exposure-pill${skillsOn ? ' on' : ''}`}
                          onClick={() =>
                            void updateSettings({
                              integrations: {
                                ...settings.integrations,
                                skills: {
                                  ...settings.integrations.skills,
                                  enableForAgents: {
                                    ...settings.integrations.skills.enableForAgents,
                                    [agentId]: !skillsOn
                                  }
                                }
                              }
                            })
                          }
                        >
                          <Sparkles size={12} />
                          Skills
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
          )}
        </div>
      </div>
    </div>
  )
}
