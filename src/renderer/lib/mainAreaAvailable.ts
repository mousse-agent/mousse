import { inboxShowsThread, useInboxShowsThread, useInboxStore } from '../components/automations/inbox/inboxStore'
import { useAppStore } from '../stores/appStore'

/**
 * Whether the app panel (files, browser, terminal…) has a place on screen. App.tsx lays it out beside a thread's
 * conversation only: the Chats workspace (direct chats and bots) has none, except while the Automations page
 * shows a run's thread there.
 */
export function mainAreaAvailable(): boolean {
  const app = useAppStore.getState()
  return app.sidebarMode !== 'chats' || (app.scheduledOpen && inboxShowsThread(useInboxStore.getState()))
}

export function useMainAreaAvailable(): boolean {
  const inboxThread = useInboxShowsThread()
  return useAppStore((s) => s.sidebarMode !== 'chats' || (s.scheduledOpen && inboxThread))
}
