import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, ChevronUp, Pencil, Plus, UserCircle, Users } from '../../lib/icons'
import type { ProfilePublicDto } from '../../../shared/profiles/types'
import { confirmNavigation } from '../../services/navigationGuards'
import { migrateLegacyProfilePreferences } from '../../lib/profilePreferences'
import { FloatingPortal, useFloatingPosition } from '../../lib/floatingLayer'
import { useAppStore } from '../../stores/appStore'
import './profile-sidebar-footer.css'

interface ProfileSwitcherProps {
  variant?: 'titlebar' | 'rail' | 'sidebar'
  onSwitched?: (profile: ProfilePublicDto) => void
}

/** Compact profile control used by the app chrome and the hidden Electron fixture. */
export function ProfileSwitcher({ onSwitched, variant = 'titlebar' }: ProfileSwitcherProps) {
  const [profiles, setProfiles] = useState<ProfilePublicDto[]>([])
  const [current, setCurrent] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const requestEpoch = useRef(0)
  const reloadEpoch = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const rail = variant === 'rail'
  const sidebar = variant === 'sidebar'
  const floating = rail || sidebar
  const profileId = useAppStore((state) => state.profileId)
  const observedProfileId = sidebar ? profileId : undefined
  const menuStyle = useFloatingPosition({
    open: open && floating, anchorRef: triggerRef, contentRef: menuRef, placement: sidebar ? 'above-start' : 'right-start',
    deps: [editing, showCreate, profiles.length, error]
  })

  const reload = async () => {
    const epoch = ++reloadEpoch.current
    let result: Awaited<ReturnType<typeof window.mousse.profiles.list>>
    let status: Awaited<ReturnType<typeof window.mousse.profiles.status>>
    try {
      [result, status] = await Promise.all([
      window.mousse.profiles.list(),
      window.mousse.profiles.status()
      ])
    } catch (cause) {
      if (epoch !== reloadEpoch.current) return
      throw cause
    }
    if (epoch !== reloadEpoch.current) return
    const bound = status.binding?.profileId ?? result.defaultProfileId
    // A footer always belongs to the active window profile, including while
    // replies for a previous profile or an unmounted sidebar are still pending.
    if (sidebar && bound !== useAppStore.getState().profileId) return
    setProfiles(result.profiles)
    setCurrent(bound)
    setError(null)
    const selected = result.profiles.find((profile) => profile.id === bound)
    if (selected) {
      migrateLegacyProfilePreferences(selected)
      onSwitched?.(selected)
    }
  }

  useEffect(() => {
    setOpen(false)
    void reload().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    const refresh = () => { void reload().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))) }
    window.addEventListener('mousse:profiles-changed', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      reloadEpoch.current += 1
      window.removeEventListener('mousse:profiles-changed', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [observedProfileId])

  useEffect(() => {
    if (!open || !floating || menuStyle.visibility !== 'visible') return
    if (!menuRef.current?.contains(document.activeElement)) {
      menuRef.current?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)')?.focus()
    }
  }, [open, floating, menuStyle.visibility])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
        return
      }
      if (!floating || !menuRef.current?.contains(document.activeElement)) return
      const buttons = [...menuRef.current.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      // Inline profile forms keep normal text editing and Tab navigation.
      if (index < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', escape)
    }
  }, [open, floating])

  const switchProfile = async (ref: string) => {
    if (!await confirmNavigation('profile')) return
    const epoch = ++requestEpoch.current
    setBusy(true)
    setError(null)
    try {
      const result = await window.mousse.profiles.bind(ref)
      if (epoch !== requestEpoch.current) return
      setCurrent(result.profile.id)
      setOpen(false)
      migrateLegacyProfilePreferences(result.profile)
      onSwitched?.(result.profile)
    } catch (cause) {
      if (epoch === requestEpoch.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (epoch === requestEpoch.current) setBusy(false)
    }
  }

  const updateCurrent = async () => {
    const displayName = editName.trim()
    const profile = profiles.find((item) => item.id === (sidebar ? profileId : current))
    if (!profile || !displayName || displayName === profile.displayName) {
      setEditing(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await window.mousse.profiles.update(profile.id, profile.revision, { displayName })
      setProfiles((items) => items.map((item) => item.id === result.profile.id ? result.profile : item))
      setEditing(false)
      window.dispatchEvent(new Event('mousse:profiles-changed'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const createProfile = async () => {
    const displayName = newName.trim()
    if (!displayName) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.mousse.profiles.create({ displayName })
      setProfiles((items) => [...items, result.profile])
      setNewName('')
      setShowCreate(false)
      window.dispatchEvent(new Event('mousse:profiles-changed'))
      await switchProfile(result.profile.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  const archiveCurrent = async () => {
    const profile = profiles.find((item) => item.id === (sidebar ? profileId : current))
    if (!profile || profile.isDefault || profiles.filter((item) => item.status === 'active').length <= 1) return
    if (!await confirmNavigation('profile')) return
    if (!window.confirm(`Archive ${profile.displayName}?`)) return
    setBusy(true)
    setError(null)
    try {
      await window.mousse.profiles.archive(profile.id, profile.revision)
      window.dispatchEvent(new Event('mousse:profiles-changed'))
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const active = profiles.filter((item) => item.status === 'active')
  const selected = sidebar
    ? profiles.find((item) => item.id === profileId)
    : profiles.find((item) => item.id === current) ?? active[0]
  if (!selected) return error ? <div className={`profile-switcher${sidebar ? ' profile-switcher-sidebar' : ''}`} role="alert">
    <button type="button" title={error} onClick={() => {
      setError(null)
      void reload().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    }}>Retry profiles</button>
  </div> : sidebar ? <div className="profile-switcher profile-switcher-sidebar profile-sidebar-loading" role="status">Loading profile…</div> : null

  const avatar = (profile: ProfilePublicDto, large = false) => (
    <span className={`profile-avatar${large ? ' profile-avatar-large' : ''}`} style={{ background: profile.color || undefined }} aria-hidden="true">
      {profile.avatar ? <img src={profile.avatar} alt="" /> : profile.displayName.slice(0, 1).toUpperCase()}
    </span>
  )

  const menu = open && <div ref={menuRef} className={`profile-menu${floating ? ' profile-menu-rail' : ''}`}
    style={floating ? menuStyle : undefined} role="menu" aria-label="Profiles">
        <div className="profile-current-card">
          {avatar(selected, true)}
          <strong>{selected.displayName}</strong>
          {selected.isDefault && <span>Default profile</span>}
        </div>

        {editing ? (
          <form className="profile-inline-form" onSubmit={(event) => { event.preventDefault(); void updateCurrent() }}>
            <input aria-label="Profile name" autoFocus maxLength={64} value={editName} onChange={(event) => setEditName(event.target.value)} />
            <button type="submit" aria-label="Save profile name" disabled={busy || !editName.trim()}><Check size={16} /></button>
          </form>
        ) : (
          <button className="profile-menu-row" type="button" role="menuitem" onClick={() => { setEditName(selected.displayName); setEditing(true); setShowCreate(false) }}>
            <Pencil size={16} /><span>Customize profile</span>
          </button>
        )}

        {active.length > 1 && <div className="profile-menu-section">
          <div className="profile-menu-heading">Other Mousse profiles</div>
          {active.filter((profile) => profile.id !== selected.id).map((profile) => (
            <button className="profile-menu-row profile-menu-profile" type="button" role="menuitemradio" aria-checked="false" key={profile.id} disabled={busy} onClick={() => void switchProfile(profile.id)}>
              {avatar(profile)}<span>{profile.displayName}</span><ChevronRight size={15} />
            </button>
          ))}
        </div>}

        <div className="profile-menu-section profile-menu-actions">
          <button className="profile-menu-row" type="button" role="menuitem" onClick={() => { setShowCreate((value) => !value); setEditing(false) }} disabled={busy}>
            <Plus size={16} /><span>Add Mousse profile</span>
          </button>
          {showCreate && <form className="profile-inline-form" onSubmit={(event) => { event.preventDefault(); void createProfile() }}>
            <input aria-label="New profile name" autoFocus value={newName} maxLength={64} onChange={(event) => setNewName(event.target.value)} placeholder="Profile name" />
            <button type="submit" disabled={busy || !newName.trim()}>Add</button>
          </form>}
          <button className="profile-menu-row" type="button" role="menuitem" disabled={selected.isDefault || active.length <= 1 || busy} onClick={() => void archiveCurrent()}>
            <Users size={16} /><span>Manage Mousse profiles</span>
          </button>
        </div>
        {error && <div className="profile-switcher-error" role="alert">{error}</div>}
      </div>

  return (
    <div ref={rootRef} className={`profile-switcher${rail ? ' profile-switcher-rail' : ''}${sidebar ? ' profile-switcher-sidebar' : ''}`} data-profile-id={selected.id}>
      <button ref={triggerRef} className={sidebar ? 'profile-sidebar-trigger' : rail ? `navigation-rail-button${open ? ' active' : ''}` : 'profile-menu-trigger'}
        type="button" aria-label={sidebar ? `Mousse profile: ${selected.displayName}` : 'Profiles'} title={sidebar ? selected.displayName : 'Profiles'} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}>
        {sidebar ? <>
          {avatar(selected)}
          <span className="profile-sidebar-text"><strong>{selected.displayName}</strong><span>Mousse profile</span></span>
          <ChevronUp size={16} aria-hidden="true" />
        </> : <UserCircle size={rail ? 18 : 16} strokeWidth={rail ? 1.8 : undefined} aria-hidden="true" />}
      </button>
      {floating ? <FloatingPortal>{menu}</FloatingPortal> : menu}
    </div>
  )
}
