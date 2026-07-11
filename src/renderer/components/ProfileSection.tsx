import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { MousseSettings, MousseSettingsUpdate } from '../../shared/settings'
import type { LineEditStatsSnapshot } from '../../shared/lineEditStats'
import { generateRandomUsername } from '../../shared/randomUsername'
import { LineEditHeatmap } from './LineEditHeatmap'

interface ProfileSectionProps {
  settings: MousseSettings
  onUpdate: (partial: MousseSettingsUpdate) => Promise<void>
}

export function ProfileSection({ settings, onUpdate }: ProfileSectionProps) {
  const [stats, setStats] = useState<LineEditStatsSnapshot | null>(null)
  const [usernameDraft, setUsernameDraft] = useState(settings.profile.username)

  useEffect(() => {
    setUsernameDraft(settings.profile.username)
  }, [settings.profile.username])

  useEffect(() => {
    void window.mousse.lineEdits.getStats().then(setStats)
    return window.mousse.lineEdits.onUpdated(setStats)
  }, [])

  const saveUsername = useCallback(() => {
    const trimmed = usernameDraft.trim()
    if (!trimmed || trimmed === settings.profile.username) return
    void onUpdate({ profile: { username: trimmed } })
  }, [onUpdate, settings.profile.username, usernameDraft])

  const regenerateUsername = useCallback(() => {
    const next = generateRandomUsername()
    setUsernameDraft(next)
    void onUpdate({ profile: { username: next } })
  }, [onUpdate])

  return (
    <div className="profile-section">
      <div className="profile-username-block">
        <label className="profile-username-label" htmlFor="profile-username">
          Username
        </label>
        <div className="profile-username-row">
          <input
            id="profile-username"
            className="profile-username-input"
            value={usernameDraft}
            onChange={(e) => setUsernameDraft(e.target.value)}
            onBlur={() => saveUsername()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur()
              }
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className="profile-username-shuffle"
            onClick={regenerateUsername}
            title="Generate a new random username"
            aria-label="Generate a new random username"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {stats ? (
        <LineEditHeatmap stats={stats} />
      ) : (
        <div className="line-edit-card line-edit-card-loading">Loading activity…</div>
      )}
    </div>
  )
}
