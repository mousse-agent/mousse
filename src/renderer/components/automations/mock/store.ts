// UI state of the Automations inbox mock-up. Turned on by the localStorage key `mousse.automationsMock`:
// `1` shows the inbox with runs, `empty` the inbox with one automation and no runs. Nothing here reaches the daemon.
import { create } from 'zustand'
import { useAppStore } from '../../../stores/appStore'
import { MOCK_AUTOMATIONS, MOCK_RUNS, type MockAutomation, type MockTuningNote } from './data'

export const AUTOMATIONS_MOCK_KEY = 'mousse.automationsMock'
export type MockMode = 'off' | 'runs' | 'empty'

function readMode(): MockMode {
  try {
    const value = globalThis.localStorage?.getItem(AUTOMATIONS_MOCK_KEY)
    return value === 'empty' ? 'empty' : value === '1' || value === 'runs' ? 'runs' : 'off'
  } catch {
    return 'off'
  }
}

export interface InboxFilter {
  automationId?: string
  project?: string
  text?: string
}

interface InboxMockState {
  mode: MockMode
  filter: InboxFilter
  /** The run open in the pane. */
  openRunId: string | null
  /** The Manage table is in the pane; `expanded` is the row showing its Tuning. */
  manage: { open: boolean; expanded: string | null }
  /** Needs you items the person resolved, newest last (u undoes the last). */
  resolved: string[]
  automations: MockAutomation[]
  /** Calibration given on a run: `${runId}:${kind}`. */
  calibrated: string[]
  /** The inline draft card in a chat was turned on. */
  draftOn: boolean
}

export const useInboxMock = create<InboxMockState>(() => ({
  mode: readMode(),
  filter: {},
  openRunId: MOCK_RUNS.find((run) => run.level === 'needs_you' && !run.assignee)?.id ?? null,
  manage: { open: false, expanded: null },
  resolved: [],
  automations: MOCK_AUTOMATIONS,
  calibrated: [],
  draftOn: false
}))

export const isMockOn = (mode: MockMode) => mode !== 'off'

export function setInboxFilter(filter: InboxFilter): void {
  useInboxMock.setState({ filter, manage: { open: false, expanded: null } })
}

export function openRun(id: string): void {
  useInboxMock.setState({ openRunId: id, manage: { open: false, expanded: null } })
}

export function resolveRun(id: string): void {
  useInboxMock.setState((state) => (state.resolved.includes(id) ? state : { resolved: [...state.resolved, id] }))
}

export function undoResolve(): void {
  useInboxMock.setState((state) => ({ resolved: state.resolved.slice(0, -1) }))
}

export function openManage(expanded: string | null = null): void {
  useInboxMock.setState({ manage: { open: true, expanded } })
}

export function closeManage(): void {
  useInboxMock.setState({ manage: { open: false, expanded: null } })
}

export function toggleTuning(id: string): void {
  useInboxMock.setState((state) => ({ manage: { open: true, expanded: state.manage.expanded === id ? null : id } }))
}

export function setAutomationOn(id: string, on: boolean): void {
  useInboxMock.setState((state) => ({ automations: state.automations.map((entry) => (entry.id === id ? { ...entry, on } : entry)) }))
}

export function removeTuning(automationId: string, noteId: string): void {
  useInboxMock.setState((state) => ({
    automations: state.automations.map((entry) => (entry.id === automationId ? { ...entry, tuning: entry.tuning.filter((note) => note.id !== noteId) } : entry))
  }))
}

/** Too noisy / Should have told me on a run: a dated note on its automation, shown under Tuning. Again takes it back. */
export function calibrate(runId: string, automationId: string, number: number, kind: MockTuningNote['kind']): void {
  const key = `${runId}:${kind}`
  useInboxMock.setState((state) => {
    if (state.calibrated.includes(key)) {
      return {
        calibrated: state.calibrated.filter((entry) => entry !== key),
        automations: state.automations.map((entry) => (entry.id === automationId ? { ...entry, tuning: entry.tuning.filter((note) => note.id !== key) } : entry))
      }
    }
    const note: MockTuningNote = { id: key, kind, date: '9 Nov', run: number, text: kind === 'noisy' ? 'Too noisy' : 'Should have told me' }
    return {
      calibrated: [...state.calibrated, key],
      automations: state.automations.map((entry) => (entry.id === automationId ? { ...entry, tuning: [...entry.tuning, note] } : entry))
    }
  })
}

/** The Chats sidebar's project dot: the Runs list, filtered to the project. */
export function openProjectRuns(project: string): void {
  setInboxFilter({ project })
  useAppStore.getState().setScheduledOpen(true)
}

export function setDraftOn(on: boolean): void {
  useInboxMock.setState({ draftOn: on })
}
