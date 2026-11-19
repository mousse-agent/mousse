import type { PlatformRequestApi } from '../../shared/platform'
import type { BugReportDiagnostics, BugReportDraft, BugReportOutcome, BugReportSource, FiledBugReport, FiledBugReportView, PendingBugReport } from '../../shared/bugReports'

/** What a window reports of an error on screen. */
export type ErrorReportInput = Pick<BugReportSource, 'title' | 'message' | 'reference' | 'code' | 'stack' | 'surface'>

/** The bug report methods a window calls (this computer only). */
export interface BugReportsClient {
  draft(source: ErrorReportInput, where?: { app?: string; view?: string }): Promise<{ draft: BugReportDraft; diagnostics: BugReportDiagnostics }>
  file(draft: BugReportDraft): Promise<BugReportOutcome>
  list(): Promise<FiledBugReportView[]>
  revoke(number: number): Promise<FiledBugReport>
  pending(): Promise<PendingBugReport[]>
  answer(id: string, draft: BugReportDraft | null): Promise<BugReportOutcome | null>
}

export function createBugReportsClient(transport: PlatformRequestApi): BugReportsClient {
  return {
    draft: (source, where) => transport.request('bugReports.draft', { source, ...(where?.app ? { app: where.app } : {}), ...(where?.view ? { view: where.view } : {}) }),
    file: async (draft) => (await transport.request<{ outcome: BugReportOutcome }>('bugReports.file', { draft })).outcome,
    list: async () => (await transport.request<{ reports: FiledBugReportView[] }>('bugReports.list', {})).reports,
    revoke: async (number) => (await transport.request<{ report: FiledBugReport }>('bugReports.revoke', { number })).report,
    pending: async () => (await transport.request<{ pending: PendingBugReport[] }>('bugReports.pending', {})).pending,
    answer: async (id, draft) => (await transport.request<{ outcome: BugReportOutcome | null }>('bugReports.answer', draft ? { id, file: true, draft } : { id, file: false })).outcome
  }
}

let shared: BugReportsClient | undefined
/** The window's client, made on first use. */
export function bugReportsClient(): BugReportsClient {
  shared ??= createBugReportsClient(window.mousse?.platformRequest as PlatformRequestApi)
  return shared
}
