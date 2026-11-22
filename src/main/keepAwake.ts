import type { EventEmitter } from 'events'
import { powerSaveBlocker } from 'electron'
import { ACTIVE_RUNS_EVENT, activeRunsOf, electronSleepBlocker, SleepHold, type SleepBlocker } from '../shared/keepAwake'

/**
 * Keeps the computer from sleeping while the background service reports working runs (`power.activeRuns`), and for
 * the grace after the last one ends. Only installation events count: they come through the app's own connection
 * (`event` without a profile). When the connection drops, the service holds its own blocker, so this one lets go after
 * the grace. Returns a function that lets go at once.
 */
export function watchKeepAwake(
  guiMms: Pick<EventEmitter, 'on' | 'off'>,
  opts: { blocker?: SleepBlocker; graceMs?: number } = {}
): () => void {
  const hold = new SleepHold(opts.blocker ?? electronSleepBlocker(powerSaveBlocker), opts.graceMs)
  const onEvent = (event: { type?: string; data?: unknown; profileId?: string } | null): void => {
    if (!event || event.type !== ACTIVE_RUNS_EVENT || event.profileId) return
    const active = activeRunsOf(event.data)
    if (active !== undefined) hold.update(active > 0)
  }
  const onState = (state: string): void => {
    if (state !== 'ready') hold.update(false)
  }
  guiMms.on('event', onEvent)
  guiMms.on('state', onState)
  return () => {
    guiMms.off('event', onEvent)
    guiMms.off('state', onState)
    hold.release()
  }
}
