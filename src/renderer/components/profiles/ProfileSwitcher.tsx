import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Pencil, Plus, UserCircle, Users } from 'lucide-react'
import type { ProfilePublicDto } from '../../../shared/profiles/types'
import { confirmNavigation } from '../../services/navigationGuards'
import { migrateLegacyProfilePreferences } from '../../lib/profilePreferences'
import { FloatingPortal, useFloatingPosition } from '../../lib/floatingLayer'

interface ProfileSwitcherProps {
  variant?: 'titlebar' | 'rail'
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
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const rail = variant === 'rail'
  const menuStyle = useFloatingPosition({
    open: open && rail, anchorRef: triggerRef, contentRef: menuRef, placement: 'right-start',
    deps: [editing, showCreate, profiles.length, error]
  })

  const reload = async () => {
    const result = await window.mousse.profiles.list()
    setProfiles(result.profiles)
    const status = await window.mousse.profiles.status()
    const bound = status.binding?.profileId ?? result.defaultProfileId
    setCurrent(bound)
    const selected = result.profiles.find((profile) => profile.id === bound)
    if (selected) {
      migrateLegacyProfilePreferences(selected)
      onSwitched?.(selected)
    }
  }

  useEffect(() => {
    void reload().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus() }
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', escape)
    }
  }, [open])

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
    const profile = profiles.find((item) => item.id === current)
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
      await switchProfile(result.profile.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  const archiveCurrent = async () => {
    const profile = profiles.find((item) => item.id === current)
    if (!profile || profile.isDefault || profiles.filter((item) => item.status === 'active').length <= 1) return
    if (!await confirmNavigation('profile')) return
    if (!window.confirm(`Archive ${profile.displayName}?`)) return
    setBusy(true)
    setError(null)
    try {
      await window.mousse.profiles.archive(profile.id, profile.revision)
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const active = profiles.filter((item) => item.status === 'active')
  const selected = profiles.find((item) => item.id === current) ?? active[0]
  if (!selected) return null

  const avatar = (profile: ProfilePublicDto, large = false) => (
    <span className={`profile-avatar${large ? ' profile-avatar-large' : ''}`} style={{ background: profile.color || undefined }} aria-hidden="true">
      {profile.avatar ? <img src={profile.avatar} alt="" /> : profile.displayName.slice(0, 1).toUpperCase()}
    </span>
  )

  const menu = open && <div ref={menuRef} className={`profile-menu${rail ? ' profile-menu-rail' : ''}`}
    style={rail ? menuStyle : undefined} role="menu" aria-label="Profiles">
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
            <Plus size={17} /><span>Add Mousse profile</span>
          </button>
          {showCreate && <form className="profile-inline-form" onSubmit={(event) => { event.preventDefault(); void createProfile() }}>
            <input aria-label="New profile name" autoFocus value={newName} maxLength={64} onChange={(event) => setNewName(event.target.value)} placeholder="Profile name" />
            <button type="submit" disabled={busy || !newName.trim()}>Add</button>
          </form>}
          <button className="profile-menu-row" type="button" role="menuitem" disabled={selected.isDefault || active.length <= 1 || busy} onClick={() => void archiveCurrent()}>
            <Users size={17} /><span>Manage Mousse profiles</span>
          </button>
        </div>
        {error && <div className="profile-switcher-error" role="alert">{error}</div>}
      </div>

  return (
    <div ref={rootRef} className={`profile-switcher${rail ? ' profile-switcher-rail' : ''}`} data-profile-id={selected.id}>
      <button ref={triggerRef} className={rail ? `navigation-rail-button${open ? ' active' : ''}` : 'profile-menu-trigger'}
        type="button" aria-label="Profiles" title="Profiles" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}>
        <UserCircle size={rail ? 25 : undefined} strokeWidth={rail ? 1.8 : undefined} aria-hidden="true" />
      </button>
      {rail ? <FloatingPortal>{menu}</FloatingPortal> : menu}
    </div>
  )
}
