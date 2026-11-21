import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ProfilePublicDto } from '../../../shared/profiles/types'
import { openSettingsSection } from '../../lib/settingsNavigation'
import { beginProfileSwitch } from '../../lib/providerSnapshots'
import { migrateLegacyProfilePreferences } from '../../lib/profilePreferences'
import { confirmNavigation } from '../../services/navigationGuards'
import { useAppStore } from '../../stores/appStore'
import { Modal } from '../ui/Modal'
import './engine.css'

/** The `mousse://pair` link waiting for Settings → Devices to open Enter link with it. */
let offered: string | undefined
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

/** Hands a link to Enter link; Settings → Devices takes it once. */
export function offerPairLink(link: string): void {
  offered = link
  notify()
}
export function takeOfferedPairLink(): string | undefined {
  const link = offered
  offered = undefined
  if (link) notify()
  return link
}
/** The link waiting for Enter link, if any (for a component that opens the dialog). */
export function useOfferedPairLink(): string | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => offered
  )
}

/** Binds this window to `profileId`, as the profile menu does; true once bound. */
async function bindProfile(profileId: string): Promise<boolean> {
  if (useAppStore.getState().profileId === profileId) return true
  if (!(await confirmNavigation('profile'))) return false
  const end = beginProfileSwitch()
  let switched = false
  try {
    const result = await window.mousse.profiles.bind(profileId)
    switched = true
    migrateLegacyProfilePreferences(result.profile)
    useAppStore.getState().activateProfile(result.profile.id)
    return true
  } catch {
    return false
  } finally {
    end(switched)
  }
}

/**
 * A `mousse://pair` link that opened Mousse (design 1b §5.2): with more than one profile's networking on, the
 * window asks which profile joins; then Settings → Devices opens Enter link with it.
 */
export function PairLinkHost() {
  const [choice, setChoice] = useState<{ link: string; profiles: ProfilePublicDto[] }>()

  useEffect(() => {
    const bridge = window.mousse?.netEngine
    if (!bridge?.takePairLink) return
    let live = true
    const take = async () => {
      const link = await bridge.takePairLink().catch(() => null)
      if (!link || !live) return
      const listed = await window.mousse.profiles.list().catch(() => undefined)
      const networked = (listed?.profiles ?? []).filter(
        (profile) => profile.status === 'active' && profile.networked
      )
      if (!live) return
      if (networked.length > 1) setChoice({ link, profiles: networked })
      else await open(link, networked[0]?.id)
    }
    void take()
    const off = bridge.onPairLink?.(() => void take())
    return () => {
      live = false
      off?.()
    }
  }, [])

  const open = async (link: string, profileId?: string) => {
    if (profileId && !(await bindProfile(profileId))) return
    offerPairLink(link)
    openSettingsSection('connections', 'devices-list')
  }

  if (!choice) return null
  return (
    <Modal open title="Which profile joins?" onClose={() => setChoice(undefined)}>
      <div className="engine-profile-choice" role="group" aria-label="Profiles">
        {choice.profiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            className="settings-btn"
            onClick={() => {
              setChoice(undefined)
              void open(choice.link, profile.id)
            }}
          >
            {profile.displayName}
          </button>
        ))}
      </div>
    </Modal>
  )
}
