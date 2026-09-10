import { useEffect, useRef, useState } from 'react'
import type { ProfilePublicDto } from '../../../shared/profiles/types'

interface ProfileSwitcherProps {
  onSwitched?: (profile: ProfilePublicDto) => void
}

/** Compact profile control used by the app chrome and the hidden Electron fixture. */
export function ProfileSwitcher({ onSwitched }: ProfileSwitcherProps) {
  const [profiles, setProfiles] = useState<ProfilePublicDto[]>([])
  const [current, setCurrent] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const requestEpoch = useRef(0)

  const reload = async () => {
    const result = await window.mousse.profiles.list()
    setProfiles(result.profiles)
    const status = await window.mousse.profiles.status()
    const bound = status.binding?.profileId ?? result.defaultProfileId
    setCurrent(bound)
    const selected = result.profiles.find((profile) => profile.id === bound)
    if (selected) onSwitched?.(selected)
  }

  useEffect(() => {
    void reload().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  const switchProfile = async (ref: string) => {
    const epoch = ++requestEpoch.current
    setBusy(true)
    setError(null)
    try {
      const result = await window.mousse.profiles.bind(ref)
      if (epoch !== requestEpoch.current) return
      setCurrent(result.profile.id)
      onSwitched?.(result.profile)
    } catch (cause) {
      if (epoch === requestEpoch.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (epoch === requestEpoch.current) setBusy(false)
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

  return (
    <div className="profile-switcher" data-profile-id={selected.id}>
      <label className="profile-switcher-label" htmlFor="profile-switcher-select">Profile</label>
      <select
        id="profile-switcher-select"
        aria-label="Current profile"
        value={selected.id}
        disabled={busy}
        onChange={(event) => void switchProfile(event.target.value)}
      >
        {active.map((profile) => (
          <option key={profile.id} value={profile.id}>{profile.displayName}</option>
        ))}
      </select>
      <button type="button" aria-label="Create profile" onClick={() => setShowCreate((open) => !open)} disabled={busy}>+</button>
      {!selected.isDefault && (
        <button type="button" aria-label="Archive profile" onClick={() => void archiveCurrent()} disabled={busy}>Archive</button>
      )}
      {showCreate && (
        <form className="profile-create" onSubmit={(event) => { event.preventDefault(); void createProfile() }}>
          <input
            aria-label="New profile name"
            autoFocus
            value={newName}
            maxLength={64}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Profile name"
          />
          <button type="submit" disabled={busy || !newName.trim()}>Create</button>
        </form>
      )}
      {error && <span className="profile-switcher-error" role="alert">{error}</span>}
    </div>
  )
}
