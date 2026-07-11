import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Bot, Cpu, Loader2, Palette, Plug, Plus, Server, Sparkles, Trash2, User } from 'lucide-react'
import type {
  AgentTypeId,
  MousseSettings,
  MousseSettingsUpdate,
  SettingsOptions,
  ThemeId
} from '../../shared/settings'
import type {
  ConfiguredProvider,
  ProviderLoginOption
} from '../../shared/providerAuth'
import type { McpServerConfig, SkillsRegistrySnapshot } from '../../shared/integrations'
import { useAppStore } from '../stores/appStore'
import { useWindowDrag } from '../hooks/useWindowDrag'
import { ProviderLoginModal } from './ProviderLoginModal'
import { ModelFamilySettingsFields } from './ModelFamilySettingsFields'
import { ProfileSection } from './ProfileSection'
import '../styles/settings.css'

function themePreviewClass(themeId: ThemeId): string {
  if (themeId.includes('light')) return 'light-acrylic'
  if (themeId.includes('dark') || themeId === 'system-acrylic') return 'dark-acrylic'
  if (themeId === 'light') return 'light'
  return 'dark'
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

type AddProviderStep = 'auth_type' | 'provider' | 'credentials'

type IconType = typeof Palette

function SectionHeading({
  icon: Icon,
  title,
  description,
  trailing
}: {
  icon: IconType
  title: string
  description?: string
  trailing?: ReactNode
}) {
  return (
    <div className="settings-section-heading">
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
  { id: 'providers', label: 'Providers', icon: Plug },
  { id: 'orchestrator', label: 'Orchestrator', icon: Cpu },
  { id: 'mcp', label: 'MCP Servers', icon: Server },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'agents', label: 'Agents', icon: Bot }
] as const

export function SettingsPage() {
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const windowDrag = useWindowDrag()

  const [settings, setSettings] = useState<MousseSettings | null>(null)
  const [options, setOptions] = useState<SettingsOptions | null>(null)
  const [configuredProviders, setConfiguredProviders] = useState<ConfiguredProvider[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([])
  const [skillsSnapshot, setSkillsSnapshot] = useState<SkillsRegistrySnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [addStep, setAddStep] = useState<AddProviderStep>('auth_type')
  const [authType, setAuthType] = useState<'api_key' | 'oauth'>('api_key')
  const [loginOptions, setLoginOptions] = useState<ProviderLoginOption[]>([])
  const [selectedProvider, setSelectedProvider] = useState<ProviderLoginOption | null>(null)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [ambientInstructions, setAmbientInstructions] = useState<string[]>([])
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [loginActive, setLoginActive] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)

  const [activeSection, setActiveSection] = useState<string>('profile')
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({})

  const registerSection = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      sectionRefs.current[id] = el
    },
    []
  )

  const scrollToSection = useCallback((id: string) => {
    const el = sectionRefs.current[id]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setActiveSection(id)
    }
  }, [])

  useEffect(() => {
    if (!settingsOpen || !settings || !options) return
    const root = scrollContainerRef.current
    if (!root) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id)
          }
        }
      },
      { root, rootMargin: '-15% 0px -75% 0px', threshold: 0 }
    )

    const els = Object.values(sectionRefs.current).filter(
      (el): el is HTMLElement => el != null
    )
    els.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [settingsOpen, settings, options])

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
      const prevTheme = settings?.appearance.theme
      const prevMaterial = options?.themes.find((t) => t.id === prevTheme)?.material

      const updated = await window.mousse.settings.set(partial)
      setSettings(updated)

      const nextTheme = partial.appearance?.theme
      if (!nextTheme || !options) return

      const nextMaterial = options.themes.find((t) => t.id === nextTheme)?.material
      if (nextMaterial === undefined) return

      if (prevMaterial === nextMaterial) {
        setRestartRequired(false)
        return
      }

      const applied = await window.mousse.window.syncBackground()
      const { platform } = await window.mousse.app.getInfo()
      setRestartRequired(platform === 'win32' && !applied)
    },
    [settings, options]
  )

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
    setAddStep('auth_type')
    setAuthType('api_key')
    setLoginOptions([])
    setSelectedProvider(null)
    setApiKeyInput('')
    setAmbientInstructions([])
    setConnectError(null)
    setConnecting(false)
    setLoginActive(false)
  }

  const openAddProvider = async () => {
    setAddOpen(true)
    setAddStep('auth_type')
    setConnectError(null)
    const oauthOptions = await window.mousse.providers.getLoginOptions('oauth')
    const apiKeyOptions = await window.mousse.providers.getLoginOptions('api_key')
    const hasOauth = oauthOptions.some((option) => !option.configured)
    const hasApiKey = apiKeyOptions.some((option) => !option.configured)

    if (hasOauth && !hasApiKey) {
      setAuthType('oauth')
      setLoginOptions(oauthOptions.filter((option) => !option.configured))
      setAddStep('provider')
      return
    }
    if (hasApiKey && !hasOauth) {
      setAuthType('api_key')
      setLoginOptions(apiKeyOptions.filter((option) => !option.configured))
      setAddStep('provider')
    }
  }

  const chooseAuthType = async (nextAuthType: 'api_key' | 'oauth') => {
    setAuthType(nextAuthType)
    const optionsForType = await window.mousse.providers.getLoginOptions(nextAuthType)
    setLoginOptions(optionsForType.filter((option) => !option.configured))
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

    if (provider.authType === 'oauth') {
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

      if (apiKeyInput.trim()) {
        await window.mousse.providers.setApiKey(selectedProvider.id, apiKeyInput.trim())
        await finishProviderAdd(selectedProvider.id)
        return
      }

      setLoginActive(true)
      const result = await window.mousse.providers.loginApiKey(selectedProvider.id)
      setLoginActive(false)
      if (!result.success) {
        setConnectError(result.error ?? 'API key login failed.')
        return
      }
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
    <header className="settings-header overlay-page-drag-header" {...windowDrag}>
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
  const hasConfiguredProviders = options.llmProviders.length > 0

  return (
    <div className="settings-page overlay-page" hidden={!settingsOpen}>
      {settingsHeader}
      <ProviderLoginModal active={loginActive} onClose={() => setLoginActive(false)} />

      <div className="settings-body">
        <nav className="settings-nav">
          {SETTINGS_SECTIONS.map((section) => {
            const Icon = section.icon
            const active = activeSection === section.id
            return (
              <button
                key={section.id}
                type="button"
                className={`settings-nav-item${active ? ' active' : ''}`}
                onClick={() => scrollToSection(section.id)}
                aria-current={active ? 'true' : undefined}
              >
                <span className="settings-nav-item-icon">
                  <Icon size={15} />
                </span>
                {section.label}
              </button>
            )
          })}
        </nav>

        <div className="settings-content" ref={scrollContainerRef}>
          <section
            id="profile"
            ref={registerSection('profile')}
            className="settings-section"
          >
            <SectionHeading
              icon={User}
              title="Profile"
              description="Your display name and editing activity in Mousse."
            />
            <ProfileSection settings={settings} onUpdate={updateSettings} />
          </section>

          <section
            id="appearance"
            ref={registerSection('appearance')}
            className="settings-section"
          >
            <SectionHeading
              icon={Palette}
              title="Appearance"
              description="Choose a theme and accent color for Mousse."
            />

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
                  {selected && restartRequired && (
                    <button
                      type="button"
                      className="theme-restart-link"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleRestart()
                      }}
                    >
                      Restart Required
                    </button>
                  )}
                </div>
              )
            })}
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

        <section
          id="providers"
          ref={registerSection('providers')}
          className="settings-section"
        >
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
              {addStep === 'auth_type' && (
                <>
                  <p className="settings-section-desc">How do you want to authenticate?</p>
                  <div className="provider-auth-type-grid">
                    <button type="button" onClick={() => void chooseAuthType('oauth')}>
                      Use a subscription
                      <small>ChatGPT, Claude Pro/Max, GitHub Copilot</small>
                    </button>
                    <button type="button" onClick={() => void chooseAuthType('api_key')}>
                      Use an API key
                      <small>Anthropic, OpenAI, OpenRouter, and more</small>
                    </button>
                  </div>
                  <button type="button" className="provider-add-cancel" onClick={resetAddFlow}>
                    Cancel
                  </button>
                </>
              )}

              {addStep === 'provider' && (
                <>
                  <p className="settings-section-desc">Choose a provider to connect.</p>
                  <div className="provider-picker-list">
                    {loginOptions.map((provider) => (
                      <button
                        key={provider.id}
                        type="button"
                        className="provider-picker-item"
                        onClick={() => void chooseProvider(provider)}
                      >
                        <span>{provider.label}</span>
                        {provider.ambient && <small>Environment credentials</small>}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="provider-add-cancel"
                    onClick={() => setAddStep('auth_type')}
                  >
                    Back
                  </button>
                </>
              )}

              {addStep === 'credentials' && selectedProvider && (
                <>
                  <p className="settings-section-desc">
                    Connect <strong>{selectedProvider.label}</strong>
                  </p>

                  {selectedProvider.ambient && (
                    <ul className="provider-ambient-instructions">
                      {ambientInstructions.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}

                  {selectedProvider.authType === 'api_key' && !selectedProvider.ambient && (
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
                        Leave blank to use guided setup if this provider needs extra configuration.
                      </p>
                    </>
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

        <section
          id="orchestrator"
          ref={registerSection('orchestrator')}
          className="settings-section"
        >
          <SectionHeading
            icon={Cpu}
            title="Orchestrator"
            description="Choose which connected provider and model power the orchestrator chat."
          />

          {!hasConfiguredProviders ? (
            <p className="provider-empty-hint">Add a provider above to select a model.</p>
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
            </>
          )}
        </section>

        <section
          id="mcp"
          ref={registerSection('mcp')}
          className="settings-section"
        >
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

        <section
          id="skills"
          ref={registerSection('skills')}
          className="settings-section"
        >
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

        <section
          id="agents"
          ref={registerSection('agents')}
          className="settings-section"
        >
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
                        In-app subagent with the orchestrator chat experience. Uses your main
                        orchestrator provider and model settings.
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
                            {modelOptions.map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.label}
                              </option>
                            ))}
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
        </div>
      </div>
    </div>
  )
}
