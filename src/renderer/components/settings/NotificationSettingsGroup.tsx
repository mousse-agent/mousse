import {
  THREAD_NOTIFICATION_EVENTS,
  threadNotificationChannels,
  threadNotificationChannelPatch,
  type MousseSettings,
  type MousseSettingsUpdate,
  type NotificationChannels,
  type ThreadNotificationEvent
} from '../../../shared/settings'
import { AppNotification, Bell, Monitor, VolumeHigh, type IconComponent } from '../../lib/icons'
import { showToast } from '../ui/Toast'
import { threadToastInput } from '../../lib/threadToasts'
import { SettingsGroup, SettingsRow, Switch } from './SettingsRow'

const EVENTS: Record<ThreadNotificationEvent, { title: string; description: string }> = {
  completed: { title: 'Finished', description: 'Done, with nothing waiting on you.' },
  question: { title: 'Needs you', description: 'A question or an approval is waiting.' },
  idle: { title: 'Stopped', description: 'Interrupted, failed or paused by a usage limit.' }
}

const CHANNELS: readonly { key: keyof NotificationChannels; label: string; hint: string; icon: IconComponent }[] = [
  { key: 'toast', label: 'In app', icon: AppNotification, hint: 'A toast in the corner of the Mousse window, for threads you are not looking at.' },
  { key: 'system', label: 'System', icon: Monitor, hint: "Your computer's notification, while Mousse is in the background." },
  { key: 'sound', label: 'Sound', icon: VolumeHigh, hint: 'A short chime.' }
]

/** Notifications: for each thread event, whether it shows a toast, a system notification and plays a sound. */
export function NotificationSettingsGroup({
  notifications,
  onUpdate
}: {
  notifications: MousseSettings['notifications']
  onUpdate: (partial: MousseSettingsUpdate) => Promise<void> | void
}) {
  const preview = (event: ThreadNotificationEvent) => {
    const channels = threadNotificationChannels(notifications, event)
    if (channels.toast) {
      showToast(threadToastInput({ threadId: `preview-${event}`, kind: event, threadName: 'Example thread', projectName: 'mousse' }, () => {}))
    }
    if (channels.system || channels.sound) {
      void window.mousse.app.previewNotification({ kind: event, system: channels.system, sound: channels.sound })
    }
  }
  return (
    <SettingsGroup
      title="Notifications"
      icon={Bell}
      className="notification-settings"
      action={
        <span className="notification-channels notification-channel-labels" aria-hidden="true">
          {CHANNELS.map((channel) => <span key={channel.key} className="notification-channel-label">{channel.label}</span>)}
        </span>
      }
    >
      {THREAD_NOTIFICATION_EVENTS.map((event) => {
        const channels = threadNotificationChannels(notifications, event)
        const silent = !channels.toast && !channels.system && !channels.sound
        return (
          <SettingsRow
            key={event}
            title={EVENTS[event].title}
            titleAction={
              <button
                type="button"
                className="settings-title-icon-btn notification-try"
                title="Send a test"
                aria-label={`Send a test ${EVENTS[event].title} notification`}
                disabled={silent}
                onClick={() => preview(event)}
              >
                <Bell size={14} aria-hidden="true" />
              </button>
            }
            description={EVENTS[event].description}
            control={
              <span className="notification-row-controls">
                <span className="notification-channels" role="group" aria-label={`${EVENTS[event].title} notifications`}>
                  {CHANNELS.map(({ key, label, hint, icon: Icon }) => (
                    <button
                      key={key}
                      type="button"
                      role="switch"
                      aria-checked={channels[key]}
                      title={`${label}: ${hint}`}
                      aria-label={`${label} when a thread ${EVENTS[event].title.toLowerCase()}`}
                      className={`notification-channel${channels[key] ? ' on' : ''}`}
                      onClick={() => void onUpdate(threadNotificationChannelPatch(event, key, !channels[key]))}
                    >
                      <Icon size={15} strokeWidth={1.7} aria-hidden="true" />
                    </button>
                  ))}
                </span>
              </span>
            }
          />
        )
      })}
      <SettingsRow
        title="All threads on my other computers"
        description={<span title="Off: only threads you started or sent a message in from this computer, or opened here in the last 7 days.">Off: only threads you started or opened here lately.</span>}
        control={
          <Switch
            label="Notify for all threads on my other computers"
            checked={notifications.allRemoteThreads === true}
            onChange={(allRemoteThreads) => void onUpdate({ notifications: { ...notifications, allRemoteThreads } })}
          />
        }
      />
    </SettingsGroup>
  )
}
