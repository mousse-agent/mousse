import { createRequire } from 'module'
import { electronSleepBlocker, SleepHold, type SleepBlocker } from '../../shared/keepAwake'

/** Run statuses that mean a run is working: a thread's, a subagent's or a bot's turn. */
const WORKING = new Set(['starting', 'running', 'finalizing'])

/** How often the counts are read again from each profile's database while any run is working. */
const RESYNC_MS = 60_000

/** A profile's runs: those working now, and their status changes. */
export interface ActiveRunSource {
  activeRunIds(): string[]
  onEvent(listener: (event: { runId: string | null; type: string; payload: unknown }) => void): () => void
}

interface ProfileRuns {
  runs: Set<string>
  /** The profile keeps the computer awake (Settings → General → Threads). */
  enabled: () => boolean
  on: boolean
  source: ActiveRunSource
}

/**
 * Counts the runs working in every profile that keeps the computer awake, and tells the app the count whenever it
 * changes (`emit`). The app holds the sleep blocker while it is attached; while no app is (its windows closed on
 * Windows or Linux, a computer that runs the service at login without the app, or a remote machine), the service holds
 * `blocker` itself, with the same grace.
 */
export class KeepAwakeService {
  private readonly profiles = new Map<string, ProfileRuns>()
  private readonly hold: SleepHold | null
  private appHolders = 0
  private sent = 0
  private resync: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly opts: {
      emit(active: number): void
      /** The service's own blocker, used while no app is attached. Absent: the service never holds one. */
      blocker?: SleepBlocker | null
      graceMs?: number
      resyncMs?: number
    }
  ) {
    this.hold = opts.blocker ? new SleepHold(opts.blocker, opts.graceMs) : null
  }

  /** Runs working now in profiles that keep the computer awake. */
  get active(): number {
    let total = 0
    for (const profile of this.profiles.values()) if (profile.on) total += profile.runs.size
    return total
  }

  /** The service holds its own blocker (no app is attached and runs work, or did within the grace). */
  get holding(): boolean {
    return this.hold?.holding ?? false
  }

  /** Follows a profile's runs until the returned function is called. */
  attach(profileId: string, source: ActiveRunSource, enabled: () => boolean): () => void {
    const profile: ProfileRuns = { runs: new Set(safeIds(source)), enabled, on: readEnabled(enabled), source }
    this.profiles.set(profileId, profile)
    const unsubscribe = source.onEvent((event) => {
      if (event.type !== 'run.status' && event.type !== 'run.created') return
      const runId = event.runId ?? (event.payload as { runId?: unknown } | null)?.runId
      const status = (event.payload as { status?: unknown } | null)?.status
      if (typeof runId !== 'string' || typeof status !== 'string') return
      const had = profile.runs.has(runId)
      if (WORKING.has(status)) profile.runs.add(runId)
      else profile.runs.delete(runId)
      if (had !== profile.runs.has(runId)) this.changed()
    })
    this.changed()
    return () => {
      unsubscribe()
      if (this.profiles.get(profileId) === profile) this.profiles.delete(profileId)
      this.changed()
    }
  }

  /** A profile's settings were saved: whether it keeps the computer awake may have changed. */
  settingsChanged(): void {
    for (const profile of this.profiles.values()) profile.on = readEnabled(profile.enabled)
    this.changed()
  }

  /**
   * How many attached app connections hold the blocker. While one does, the service lets go of its own at once (the
   * app holds it now); when the last one goes, the service takes over if runs are working.
   */
  setAppHolders(count: number): void {
    const before = this.appHolders > 0
    this.appHolders = count
    if (count > 0) this.hold?.release()
    else if (before) this.hold?.update(this.active > 0)
  }

  /** Sends the count again: an app attached and needs it. */
  announce(): void {
    this.sent = this.active
    this.opts.emit(this.sent)
  }

  dispose(): void {
    if (this.resync) clearInterval(this.resync)
    this.resync = null
    this.hold?.release()
  }

  private changed(): void {
    const active = this.active
    if (this.appHolders === 0) this.hold?.update(active > 0)
    this.keepResyncing(active > 0 || [...this.profiles.values()].some((profile) => profile.runs.size > 0))
    if (active === this.sent) return
    this.sent = active
    this.opts.emit(active)
  }

  /**
   * While runs work, reads the working runs again now and then, so a run that left its working status without an event
   * (its thread's rows were deleted with it) never keeps the computer awake for good.
   */
  private keepResyncing(on: boolean): void {
    if (!on) {
      if (this.resync) clearInterval(this.resync)
      this.resync = null
      return
    }
    if (this.resync) return
    this.resync = setInterval(() => {
      for (const profile of this.profiles.values()) profile.runs = new Set(safeIds(profile.source))
      this.changed()
    }, this.opts.resyncMs ?? RESYNC_MS)
    this.resync.unref?.()
  }
}

function safeIds(source: ActiveRunSource): string[] {
  try {
    return source.activeRunIds()
  } catch {
    return []
  }
}

function readEnabled(enabled: () => boolean): boolean {
  try {
    return enabled()
  } catch {
    return true
  }
}

/**
 * Electron's power save blocker when the service runs in Electron's main process (the packaged service does), or
 * null under plain Node, which has none.
 */
export function serviceSleepBlocker(): SleepBlocker | null {
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === '1') return null
  try {
    const requireFromHere = createRequire(import.meta.url)
    const electron = requireFromHere('electron') as { powerSaveBlocker?: Parameters<typeof electronSleepBlocker>[0] }
    return electron?.powerSaveBlocker ? electronSleepBlocker(electron.powerSaveBlocker) : null
  } catch {
    return null
  }
}
