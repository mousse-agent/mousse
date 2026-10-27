import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { applyAcrylicIntensity, persistLinuxAcrylicIntensity } from '../lib/acrylicIntensity'
import { ArrowLeft, Bot, Keyboard, Laptop, Plug, Server, Settings, Sparkles, UserCircle, VolumeHigh } from '../lib/icons'
import { SettingsPageTitle } from './settings/SettingsRow'
import { SettingsSearch } from './settings/SettingsSearch'
import type {
  MousseSettings,
  MousseSettingsUpdate,
  SettingsOptions
} from '../../shared/settings'
import { listingServes, selectionFromListing } from '../../shared/providerInstances'
import { useAppStore } from '../stores/appStore'
import { ProvidersSettings } from './providers/ProvidersSettings'
import { SpeechSettings } from '../speech/SpeechSettings'
import { NetDevicesSection } from './NetDevicesSection'
import { AccountSection } from './AccountSection'
import { takePendingSettingsSection } from '../lib/settingsNavigation'
import { StorageSettings } from './StorageSettings'
import { AgentsSettings } from './settings/AgentsSettings'
import { GeneralSettings } from './settings/GeneralSettings'
import { DownloadsIndicator } from './downloads/DownloadsIndicator'
import { WindowCaptionButtons } from './WindowCaptionButtons'
import { SkillsMcpSettings } from './settings/SkillsMcpSettings'
import { ShortcutsSettings } from './settings/ShortcutsSettings'
import { createIntegrationPlatformClient } from '../services/integrationPlatformClient'
import { confirmNavigation } from '../services/navigationGuards'
import '../styles/settings.css'

function SettingsLoader() {
  return (
    <div className="settings-loader" role="status" aria-label="Loading settings">
      <span className="settings-loader-ring" />
      <span className="settings-loader-core" />
    </div>
  )
}

const SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', icon: Settings, hue: 0, group: 'Settings', keywords: ['appearance', 'theme', 'dark', 'light', 'acrylic', 'glass', 'accent', 'color', 'notification', 'sound', 'alert', 'completion', 'update', 'version', 'about'] },
  { id: 'account', label: 'Account', icon: UserCircle, hue: 5, group: 'Settings', keywords: ['mousse id', 'sign in', 'login', 'profile', 'name', 'avatar', 'environment', 'activity'] },
  { id: 'providers', label: 'Providers', icon: Plug, hue: 4, group: 'Settings', keywords: ['api key', 'subscription', 'claude', 'codex', 'openai', 'login'] },
  { id: 'agents', label: 'Agents', icon: Bot, hue: 1, group: 'Customize', keywords: ['main agent', 'orchestrator', 'model', 'title', 'subagent', 'cli', 'headless', 'claude code', 'codex', 'context', 'compaction', 'tokens', 'agent access', 'access level', 'lineage', 'read other threads', 'manage threads', 'projects', 'channel', 'bot'] },
  { id: 'integrations', label: 'Skills & MCP', icon: Sparkles, hue: 6, group: 'Customize', keywords: ['skills', 'mcp', 'integrations', 'tools', 'web search', 'exa', 'parallel', 'servers', 'skill defaults'] },
  { id: 'speech', label: 'Speech', icon: VolumeHigh, hue: 3, group: 'Customize', keywords: ['voice', 'read aloud', 'dictation', 'microphone', 'noise', 'speed'] },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard, hue: 2, group: 'Customize', keywords: ['keyboard', 'keys', 'keybindings', 'hotkeys', 'rebind', 'command palette', 'accelerator', 'reset'] },
  { id: 'connections', label: 'Devices', icon: Laptop, hue: 2, group: 'This computer', keywords: ['devices', 'network', 'pair', 'remote'] },
  { id: 'storage', label: 'Storage', icon: Server, hue: 0, group: 'This computer', keywords: ['trash', 'delete', 'purge', 'retention', 'disk'] }
] as const

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

const VISIBLE_SETTINGS_SECTIONS = SETTINGS_SECTIONS

/** Section ids from before the redesign, still sent by links and other surfaces. */
const LEGACY_SETTINGS_SECTIONS: Record<string, SettingsSectionId> = {
  profile: 'account',
  appearance: 'general',
  notifications: 'general',
  updates: 'general',
  context: 'agents',
  orchestrator: 'agents',
  tools: 'integrations',
  skills: 'integrations'
}

const settingsSectionId = (value: unknown): SettingsSectionId | undefined =>
  SETTINGS_SECTIONS.find((section) => section.id === value)?.id ??
  (typeof value === 'string' && Object.hasOwn(LEGACY_SETTINGS_SECTIONS, value) ? LEGACY_SETTINGS_SECTIONS[value] : undefined)

const CONTEXT_COMPACTION_HASH = '#settings-context-compaction'

const matchesSettingsQuery = (section: (typeof SETTINGS_SECTIONS)[number], query: string): boolean => {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return section.label.toLowerCase().includes(q) || section.keywords.some((keyword) => keyword.includes(q))
}

export function SettingsPage() {
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const profileId = useAppStore((s) => s.profileId)
  // Unmount old personal state and event subscriptions at the profile boundary.
  return settingsOpen ? <ProfileSettingsPage key={profileId} profileId={profileId} /> : null
}

function ProfileSettingsPage({ profileId }: { profileId: string }) {
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const projects = useAppStore((s) => s.projects)
  const [integrationProject, setIntegrationProject] = useState('')
  const integrationClient = useMemo(() => createIntegrationPlatformClient(window.mousse.platformRequest), [])

  const [settings, setSettings] = useState<MousseSettings | null>(null)
  const [options, setOptions] = useState<SettingsOptions | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [restartRequired, setRestartRequired] = useState(false)

  // Opening at the old 'context' section, or with the compaction hash, focuses the compaction threshold on Agents.
  const focusCompaction = useRef(false)
  const [selectedSection, setActiveSection] = useState<SettingsSectionId>(() => {
    const requested = window.location.hash === CONTEXT_COMPACTION_HASH ? 'context' : takePendingSettingsSection()
    if (requested === 'context') focusCompaction.current = true
    return settingsSectionId(requested) ?? 'general'
  })
  // Account always exists: it shows Activity, plus Mousse ID when this build has the service.
  const activeSection: SettingsSectionId = selectedSection
  useEffect(() => {
    const openSection = (event: Event) => {
      const requested = (event as CustomEvent).detail
      const section = settingsSectionId(requested)
      if (section) {
        takePendingSettingsSection()
        if (requested === 'context' || window.location.hash === CONTEXT_COMPACTION_HASH) focusCompaction.current = true
        setActiveSection(section)
      }
    }
    window.addEventListener('mousse:settings-section', openSection)
    return () => window.removeEventListener('mousse:settings-section', openSection)
  }, [])
  useEffect(() => {
    if (activeSection !== 'agents' || !settings || !focusCompaction.current) return
    focusCompaction.current = false
    document.getElementById('agents-context-compaction')?.focus()
    if (window.location.hash === CONTEXT_COMPACTION_HASH) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [activeSection, settings])

  const refreshProviderData = useCallback(async () => {
    const opts = await window.mousse.settings.getOptions()
    setOptions(opts)
    return { opts }
  }, [])

  // Only settings and provider data gate the page; Skills & MCP loads its own data.
  const loadSettings = useCallback(() => {
    setLoadError(null)
    setSettings(null)
    setOptions(null)
    Promise.all([window.mousse.settings.get(), refreshProviderData()])
      .then(([s]) => {
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
    const unsub = window.mousse.providers.onChanged(() => {
      void refreshProviderData()
    })
    return unsub
  }, [settingsOpen, refreshProviderData])

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
    applyAcrylicIntensity(acrylicIntensity)
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
      const save = window.mousse.platform === 'linux'
        ? persistLinuxAcrylicIntensity(acrylicIntensity)
        : window.mousse.settings.set({ appearance: { ...settings!.appearance, acrylicIntensity } })
      void save
        .then((updated) => {
          // Drop stale responses if the user kept dragging.
          if (gen !== intensityCommitGen.current) return
          setSettings(updated)
          void window.mousse.window.syncBackground()
        })
    }, 120)
  }, [settings])

  const ensureValidProviderSelection = useCallback(
    async (nextSettings: MousseSettings, providers = options?.llmProviders ?? []) => {
      const current = nextSettings.provider
      // By instance first: two accounts of one provider are two listings.
      const selectedProvider = providers.find((p) => listingServes(p, current))
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
        provider: selectionFromListing(first, first.models[0]?.id ?? '')
      }
    },
    [options?.llmProviders]
  )

  const handleRestart = () => {
    void window.mousse.app.restart()
  }

  const closeSettings = useCallback(async () => {
    if (!await confirmNavigation('navigate', 'integrations')) return
    setSettingsOpen(false)
  }, [setSettingsOpen])

  const settingsHeader = (
    <header className="settings-header overlay-titlebar overlay-page-drag-header">
      <button
        type="button"
        className="overlay-titlebar-back"
        onClick={closeSettings}
        aria-label="Back"
      >
        <ArrowLeft size={14} strokeWidth={2} />
      </button>
      <h1>Settings</h1>
      {/* Settings covers the app title bar, so it carries the window buttons. */}
      <div className="titlebar-controls overlay-titlebar-controls">
        <WindowCaptionButtons />
      </div>
    </header>
  )

  const [navQuery, setNavQuery] = useState('')
  const goToSection = (id: SettingsSectionId) => {
    // Only the integrations editors hold unsaved drafts; ask before leaving that section.
    if (activeSection !== 'integrations' || id === 'integrations') {
      setActiveSection(id)
      return
    }
    void confirmNavigation('navigate', 'integrations').then((allowed) => { if (allowed) setActiveSection(id) })
  }
  const navSections = VISIBLE_SETTINGS_SECTIONS
    .filter((section) => matchesSettingsQuery(section, navQuery))
  const activeSectionLabel = SETTINGS_SECTIONS.find((section) => section.id === activeSection)?.label ?? 'Settings'

  const settingsNav = (
    <nav className="settings-nav" aria-label="Settings sections">
      <SettingsSearch
        className="settings-nav-search"
        value={navQuery}
        ariaLabel="Search settings"
        onChange={setNavQuery}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && navSections[0]) goToSection(navSections[0].id)
        }}
      />
      {navSections.map((section, index, visible) => {
        const Icon = section.icon
        const active = activeSection === section.id
        const startsGroup = index === 0 || visible[index - 1].group !== section.group
        return (
          <Fragment key={section.id}>
            {startsGroup && <p className="settings-nav-group">{section.group}</p>}
            <button
              type="button"
              className={`settings-nav-item${active ? ' active' : ''}`}
              onClick={() => goToSection(section.id)}
              aria-current={active ? 'page' : undefined}
            >
              <span className="settings-nav-item-icon" data-hue={section.hue}>
                <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
              </span>
              {section.label}
            </button>
          </Fragment>
        )
      })}
      {navSections.length === 0 && <p className="settings-nav-empty">No matching settings</p>}
      <DownloadsIndicator variant="nav" />
    </nav>
  )

  if (!settings || !options) {
    return (
      <div className="settings-page overlay-page" hidden={!settingsOpen}>
        {settingsHeader}
        <div className="settings-body">
          {settingsNav}
          <div className="settings-status">
            {loadError ? (
              <>
                <p className="settings-error">{loadError}</p>
                <button type="button" className="settings-retry-btn" onClick={loadSettings}>
                  Retry
                </button>
              </>
            ) : (
              <SettingsLoader />
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-page overlay-page" hidden={!settingsOpen}>
      {settingsHeader}

      <div className="settings-body">
        {settingsNav}

        <div className="settings-content" key={activeSection}>
          <SettingsPageTitle title={activeSectionLabel} />
          {activeSection === 'storage' && <StorageSettings />}
          {activeSection === 'general' && (
            <GeneralSettings
              settings={settings}
              options={options}
              onUpdate={updateSettings}
              restartRequired={restartRequired}
              onRestart={handleRestart}
              onPreviewAcrylicIntensity={previewAcrylicIntensity}
              onCommitAcrylicIntensity={commitAcrylicIntensity}
            />
          )}
          {activeSection === 'integrations' && (
            <SkillsMcpSettings
              client={integrationClient}
              profileId={profileId}
              projectId={integrationProject || undefined}
              projects={projects}
              onProjectChange={setIntegrationProject}
              settings={settings}
              options={options}
              onUpdate={updateSettings}
            />
          )}
          {activeSection === 'account' && (
          <section id="account" className="settings-section">
            <AccountSection />
          </section>
          )}

          {activeSection === 'providers' && (
            <section id="providers" className="settings-section">
              <ProvidersSettings
                settings={settings}
                refreshProviderData={refreshProviderData}
                updateSettings={updateSettings}
                ensureValidProviderSelection={ensureValidProviderSelection}
              />
            </section>
          )}

          {activeSection === 'speech' && (
        <section id="speech" className="settings-section">
          <SpeechSettings />
        </section>
          )}

          {activeSection === 'shortcuts' && <ShortcutsSettings settings={settings} onUpdate={updateSettings} />}

          {activeSection === 'agents' && <AgentsSettings settings={settings} options={options} projects={projects} updateSettings={updateSettings} />}

          {activeSection === 'connections' && (
          <section id="connections" className="settings-section">
            <NetDevicesSection />
          </section>
          )}
        </div>
      </div>
    </div>
  )
}
