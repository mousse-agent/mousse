import { create } from 'zustand'
import { normalizeErrorReportSettings, splitReference, type BugReportOutcome, type ErrorReportSettings, type PendingBugReport } from '../../shared/bugReports'
import { bugReportsClient, type ErrorReportInput } from '../services/bugReportsClient'

/** What the report dialog shows: an error a person pressed Report on, or an agent's draft waiting for them. */
export type OpenBugReport =
  | { kind: 'error'; key: string; source: ErrorReportInput }
  | { kind: 'agent'; pending: PendingBugReport }

interface BugReportState {
  /** Settings → General → Error reports, kept in step with the profile's settings. */
  settings: ErrorReportSettings
  open: OpenBugReport | null
  /** Agent drafts waiting for the person, oldest first. */
  pending: PendingBugReport[]
  /** Agent drafts the person closed without answering, so they are not opened again on their own. */
  dismissed: ReadonlySet<string>
  /** What filing did, by the error's key, so its Report button reads "Reported · #N". */
  reported: Readonly<Record<string, BugReportOutcome>>
  setSettings(raw: Partial<ErrorReportSettings> | undefined | null): void
  openReport(source: ErrorReportInput): void
  openPending(pending: PendingBugReport): void
  close(): void
  setPending(pending: PendingBugReport[]): void
  markReported(key: string, outcome: BugReportOutcome): void
}

/** One error's key: its reference when it has one, else its words. */
export function errorReportKey(source: ErrorReportInput): string {
  const reference = source.reference ?? splitReference(source.message ?? '').reference
  return reference ? `ref:${reference}` : `msg:${source.title}\u0000${source.message}`.slice(0, 600)
}

export const useBugReportStore = create<BugReportState>((set, get) => ({
  settings: normalizeErrorReportSettings(),
  open: null,
  pending: [],
  dismissed: new Set(),
  reported: {},
  setSettings: (raw) => {
    const next = normalizeErrorReportSettings(raw)
    const current = get().settings
    if (current.enabled !== next.enabled || current.anonymous !== next.anonymous) set({ settings: next })
  },
  openReport: (source) => set({ open: { kind: 'error', key: errorReportKey(source), source } }),
  openPending: (pending) => set({ open: { kind: 'agent', pending } }),
  close: () => {
    const open = get().open
    set({
      open: null,
      ...(open?.kind === 'agent' ? { dismissed: new Set([...get().dismissed, open.pending.id]) } : {})
    })
  },
  setPending: (pending) => {
    const state = get()
    const ids = new Set(pending.map((entry) => entry.id))
    // A draft answered elsewhere (another window, or it lapsed) closes here too.
    const open = state.open?.kind === 'agent' && !ids.has(state.open.pending.id) ? null : state.open
    set({ pending, open })
    // A new draft opens on its own when nothing else is open.
    if (!open) {
      const next = pending.find((entry) => !state.dismissed.has(entry.id))
      if (next) set({ open: { kind: 'agent', pending: next } })
    }
  },
  markReported: (key, outcome) => set({ reported: { ...get().reported, [key]: outcome } })
}))

/** Opens the report dialog for an error on screen. */
export function reportError(source: ErrorReportInput): void {
  useBugReportStore.getState().openReport(source)
}

/** Whether errors show a Report button now. */
export function useReportEnabled(): boolean {
  return useBugReportStore((state) => state.settings.enabled)
}

/** How often a window asks for agent drafts while reports are on. */
const PENDING_POLL_MS = 5_000

/** Keeps the agent drafts current while reports are on; returns a stop. */
export function watchPendingBugReports(): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    if (stopped) return
    if (useBugReportStore.getState().settings.enabled && document.visibilityState !== 'hidden') {
      try {
        useBugReportStore.getState().setPending(await bugReportsClient().pending())
      } catch {
        // The service may be starting; the next tick asks again.
      }
    }
    if (!stopped) timer = setTimeout(() => void tick(), PENDING_POLL_MS)
  }
  void tick()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
