import { useEffect, useRef, useState } from 'react'
import { Archive, Check, ChevronUp, Logout, MoreHorizontal, Palette, Pencil, Plus, Settings, UserCircle } from '../../lib/icons'
import type { ProfilePublicDto } from '../../../shared/profiles/types'
import { confirmNavigation } from '../../services/navigationGuards'
import { migrateLegacyProfilePreferences } from '../../lib/profilePreferences'
import { nextProfileColor, profileColor } from '../../lib/profilePalette'
import { beginProfileSwitch } from '../../lib/providerSnapshots'
import { FloatingPortal, useFloatingPosition } from '../../lib/floatingLayer'
import { useAppStore } from '../../stores/appStore'
import { devicesLine, mousseIdName, useMousseId, useMousseIdAvailable, useMousseIdStore } from '../../stores/mousseIdStore'
import { openSettingsSection } from '../../lib/settingsNavigation'
import { MousseIdAvatar } from '../MousseIdAvatar'
import { ProfileEditDialog, type ProfileEditMode, type ProfileEditValues } from './ProfileEditDialog'
import { ProfileRowMenu } from './ProfileRowMenu'
import './profile-switcher.css'

interface ProfileSwitcherProps {
  onSwitched?: (profile: ProfilePublicDto) => void
}

const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

/**
 * The sidebar footer: a trigger showing the account and current profile, and a two-column popover.
 * Account on the left (only when this build has Mousse ID), profiles on the right.
 */
export function ProfileSwitcher({ onSwitched }: ProfileSwitcherProps) {
  const [profiles, setProfiles] = useState<ProfilePublicDto[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [rowMenu, setRowMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  const [dialog, setDialog] = useState<ProfileEditMode | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const requestEpoch = useRef(0)
  const reloadEpoch = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const rowMenuRef = useRef(rowMenu)
  rowMenuRef.current = rowMenu
  const profileId = useAppStore((state) => state.profileId)
  // With a Mousse ID service the sidebar footer doubles as the account control.
  const withAccount = useMousseIdAvailable()
  const account = useMousseId(withAccount)
  const signedIn = withAccount && !!account.plus?.connected
  const menuStyle = useFloatingPosition({
    open, anchorRef: triggerRef, contentRef: menuRef, placement: 'above-start',
    deps: [profiles.length, error, withAccount, signedIn]
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
    if (bound !== useAppStore.getState().profileId) return
    setProfiles(result.profiles)
    setError(null)
    const selected = result.profiles.find((profile) => profile.id === bound)
    if (selected) {
      migrateLegacyProfilePreferences(selected)
      onSwitched?.(selected)
    }
  }

  useEffect(() => {
    setOpen(false)
    void reload().catch((cause) => setError(messageOf(cause)))
    const refresh = () => { void reload().catch((cause) => setError(messageOf(cause))) }
    window.addEventListener('mousse:profiles-changed', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      reloadEpoch.current += 1
      window.removeEventListener('mousse:profiles-changed', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [profileId])

  // The device count is not part of the local status; ask Mousse ID each time the popover opens.
  useEffect(() => {
    if (open && signedIn) void useMousseIdStore.getState().loadDevices()
  }, [open, signedIn])

  useEffect(() => {
    if (!open) setRowMenu(null)
  }, [open])

  // Keyboard focus returns to the trigger once the edit dialog is gone.
  const dialogOpen = !!dialog
  const dialogWasOpen = useRef(false)
  useEffect(() => {
    if (dialogWasOpen.current && !dialogOpen) triggerRef.current?.focus()
    dialogWasOpen.current = dialogOpen
  }, [dialogOpen])

  useEffect(() => {
    if (!open || menuStyle.visibility !== 'visible') return
    if (!menuRef.current?.contains(document.activeElement)) {
      menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus()
    }
  }, [open, menuStyle.visibility])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      const target = event.target as Element
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target) && !target.closest?.('[data-profile-row-menu]')) setOpen(false)
    }
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        // One layer at a time: an open actions menu goes first.
        const actions = rowMenuRef.current
        if (actions) {
          setRowMenu(null)
          actions.anchor.focus()
          return
        }
        setOpen(false)
        triggerRef.current?.focus()
        return
      }
      const menu = menuRef.current
      const focused = document.activeElement as HTMLElement | null
      if (!menu || !focused || !menu.contains(focused)) return
      // From a profile row or its kebab, Right Arrow opens the row's actions.
      const entry = focused.closest<HTMLElement>('.profile-menu-item')
      if (event.key === 'ArrowRight' && entry) {
        event.preventDefault()
        entry.querySelector<HTMLElement>('.profile-menu-kebab')?.click()
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      // Rows run column by column in document order: the account column first, then the profiles.
      const rows = [...menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')]
      const index = rows.indexOf((entry?.querySelector('[role^="menuitem"]') ?? focused) as HTMLButtonElement)
      if (index < 0) return
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
      rows[next]?.focus()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', keys)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', keys)
    }
  }, [open])

  /** Binds the window to a profile; true once it is bound. */
  const switchProfile = async (ref: string): Promise<boolean> => {
    if (!await confirmNavigation('profile')) return false
    const epoch = ++requestEpoch.current
    setBusy(true)
    setError(null)
    // Provider requests of the profile being left must not reach the one being bound.
    const endSwitch = beginProfileSwitch()
    let switched = false
    try {
      const result = await window.mousse.profiles.bind(ref)
      switched = true
      if (epoch !== requestEpoch.current) return false
      setOpen(false)
      migrateLegacyProfilePreferences(result.profile)
      onSwitched?.(result.profile)
      return true
    } catch (cause) {
      if (epoch === requestEpoch.current) setError(messageOf(cause))
      return false
    } finally {
      endSwitch(switched)
      if (epoch === requestEpoch.current) setBusy(false)
    }
  }

  const active = profiles.filter((item) => item.status === 'active')
  const selected = profiles.find((item) => item.id === profileId)

  const showDialog = (mode: ProfileEditMode) => {
    setDialogError(null)
    setOpen(false)
    setDialog(mode)
  }

  const closeDialog = () => {
    setDialog(null)
    setDialogError(null)
  }

  const saveProfile = async (values: ProfileEditValues) => {
    if (!dialog) return
    setBusy(true)
    setDialogError(null)
    try {
      if (dialog.kind === 'create') {
        const result = await window.mousse.profiles.create(values)
        setProfiles((items) => [...items, result.profile])
        setDialog(null)
        window.dispatchEvent(new Event('mousse:profiles-changed'))
        setBusy(false)
        // A new profile is made to be used; if the switch is declined or fails, show why in the popover.
        if (!await switchProfile(result.profile.id)) setOpen(true)
        return
      }
      const profile = profiles.find((item) => item.id === dialog.profile.id) ?? dialog.profile
      const result = await window.mousse.profiles.update(profile.id, profile.revision, values)
      setProfiles((items) => items.map((item) => item.id === result.profile.id ? result.profile : item))
      setDialog(null)
      window.dispatchEvent(new Event('mousse:profiles-changed'))
    } catch (cause) {
      setDialogError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const archiveProfile = async (profile: ProfilePublicDto) => {
    if (profile.isDefault || active.length <= 1) return
    if (!window.confirm(`Archive ${profile.displayName}?`)) return
    setBusy(true)
    setError(null)
    setDialogError(null)
    try {
      if (profile.id === profileId) {
        // The window cannot stay on an archived profile; move to the default one first.
        const fallback = active.find((item) => item.isDefault) ?? active.find((item) => item.id !== profile.id)
        if (!fallback || !await switchProfile(fallback.id)) return
      }
      await window.mousse.profiles.archive(profile.id, profile.revision)
      setDialog(null)
      window.dispatchEvent(new Event('mousse:profiles-changed'))
      await reload()
    } catch (cause) {
      if (dialog) setDialogError(messageOf(cause))
      else setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const dialogElement = dialog && (
    <ProfileEditDialog
      mode={dialog}
      busy={busy}
      error={dialogError}
      canArchive={dialog.kind === 'edit' && !dialog.profile.isDefault && active.length > 1}
      onSubmit={(values) => void saveProfile(values)}
      onArchive={dialog.kind === 'edit' ? () => void archiveProfile(dialog.profile) : undefined}
      onClose={closeDialog}
    />
  )

  if (!selected) return error ? <div className="profile-switcher profile-switcher-sidebar" role="alert">
    <button type="button" title={error} onClick={() => {
      setError(null)
      void reload().catch((cause) => setError(messageOf(cause)))
    }}>Retry profiles</button>
  </div> : <div className="profile-switcher profile-switcher-sidebar profile-sidebar-loading" role="status">Loading profile…</div>

  const avatar = (profile: ProfilePublicDto) => (
    <span className="profile-avatar" style={{ background: profileColor(profile) }} aria-hidden="true">
      {profile.avatar ? <img src={profile.avatar} alt="" /> : profile.displayName.slice(0, 1).toUpperCase()}
    </span>
  )

  const openAccount = () => {
    setOpen(false)
    openSettingsSection('account')
  }

  const signIn = async () => {
    setOpen(false)
    // Account settings shows the sign-in code, progress and any error.
    openSettingsSection('account')
    const result = await account.signIn()
    if (result === 'needs-setup') openSettingsSection('connections')
  }

  const toggleRowMenu = (profile: ProfilePublicDto, anchor: HTMLElement) =>
    setRowMenu((current) => current?.id === profile.id ? null : { id: profile.id, anchor })

  const rowMenuProfile = rowMenu && profiles.find((item) => item.id === rowMenu.id)

  const devices = devicesLine(account.plus)
  const accountColumn = withAccount && <div className="profile-menu-col profile-menu-account" role="group" aria-label="Account">
    <div className="profile-account-identity">
      <MousseIdAvatar plus={account.plus} large />
      {signedIn && <>
        <strong>{mousseIdName(account.plus)}</strong>
        {account.plus?.email && <span>{account.plus.email}</span>}
        {devices && <span className="profile-account-devices">{devices}</span>}
      </>}
    </div>
    {!signedIn && (
      <button className="profile-menu-row" type="button" role="menuitem" disabled={account.busy && !account.pending} onClick={() => account.pending ? openAccount() : void signIn()}>
        <UserCircle size={16} /><span>{account.pending ? 'Signing in…' : 'Sign in with Mousse ID'}</span>
      </button>
    )}
    <button className="profile-menu-row" type="button" role="menuitem" onClick={openAccount}>
      <Settings size={16} /><span>Account settings</span>
    </button>
    {account.plus?.configured && (
      <button className="profile-menu-row" type="button" role="menuitem" disabled={account.busy} onClick={() => { setOpen(false); void account.signOut() }}>
        <Logout size={16} /><span>Sign out</span>
      </button>
    )}
  </div>

  const profileColumn = <div className="profile-menu-col profile-menu-profiles" role="group" aria-label="Profiles">
    <div className="profile-menu-heading">Profiles</div>
    {active.map((profile) => {
      const current = profile.id === selected.id
      return (
        <div className="profile-menu-item" key={profile.id}>
          <button className="profile-menu-row profile-menu-profile" type="button" role="menuitemradio" aria-checked={current}
            disabled={busy} onClick={() => current ? setOpen(false) : void switchProfile(profile.id)}>
            <span className="profile-dot" style={{ background: profileColor(profile) }} aria-hidden="true" />
            <span className="profile-menu-name">{profile.displayName}</span>
            {current && <Check size={14} aria-hidden="true" />}
          </button>
          <button className="profile-menu-kebab" type="button" aria-label={`${profile.displayName} profile actions`}
            aria-haspopup="menu" aria-expanded={rowMenu?.id === profile.id} disabled={busy}
            onClick={(event) => toggleRowMenu(profile, event.currentTarget)}>
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
        </div>
      )
    })}
    <button className="profile-menu-row" type="button" role="menuitem" disabled={busy}
      onClick={() => showDialog({ kind: 'create', color: nextProfileColor(active) })}>
      <Plus size={16} /><span>New profile</span>
    </button>
  </div>

  const menu = open && <div ref={menuRef} className={`profile-menu${withAccount ? ' profile-menu-wide' : ''}`}
    style={menuStyle} role="menu" aria-label={withAccount ? 'Account and profiles' : 'Profiles'}>
    <div className="profile-menu-columns">
      {accountColumn}
      {profileColumn}
    </div>
    {error && <div className="profile-switcher-error" role="alert">{error}</div>}
  </div>

  return (
    <div ref={rootRef} className="profile-switcher profile-switcher-sidebar" data-profile-id={selected.id}>
      <button ref={triggerRef} className="profile-sidebar-trigger"
        type="button" aria-label={withAccount ? `${signedIn ? `Mousse ID: ${mousseIdName(account.plus)}` : 'Sign in'}, Mousse profile: ${selected.displayName}` : `Mousse profile: ${selected.displayName}`}
        title={withAccount ? (signedIn ? account.plus?.email ?? mousseIdName(account.plus) : selected.displayName) : selected.displayName} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}>
        {withAccount ? <>
          {signedIn ? <MousseIdAvatar plus={account.plus} /> : avatar(selected)}
          <span className="profile-sidebar-text">
            <strong>{signedIn ? mousseIdName(account.plus) : account.pending ? 'Signing in…' : 'Sign in'}</strong>
            <span className="profile-sidebar-profile">{selected.displayName}</span>
          </span>
        </> : <>
          {avatar(selected)}
          <span className="profile-sidebar-text"><strong className="profile-sidebar-profile">{selected.displayName}</strong><span>Mousse profile</span></span>
        </>}
        <ChevronUp size={16} aria-hidden="true" />
      </button>
      <FloatingPortal>
        {menu}
        {open && rowMenu && rowMenuProfile && (
          <ProfileRowMenu
            anchor={rowMenu.anchor}
            label={`${rowMenuProfile.displayName} profile actions`}
            onClose={() => setRowMenu(null)}
            items={[
              { id: 'rename', label: 'Rename', icon: <Pencil size={16} />, onSelect: () => showDialog({ kind: 'edit', profile: rowMenuProfile, focus: 'name' }) },
              { id: 'colour', label: 'Colour', icon: <Palette size={16} />, onSelect: () => showDialog({ kind: 'edit', profile: rowMenuProfile, focus: 'color' }) },
              ...(!rowMenuProfile.isDefault && active.length > 1
                ? [{ id: 'archive', label: 'Archive', icon: <Archive size={16} />, danger: true, onSelect: () => { setRowMenu(null); void archiveProfile(rowMenuProfile) } }]
                : [])
            ]}
          />
        )}
        {dialogElement}
      </FloatingPortal>
    </div>
  )
}
