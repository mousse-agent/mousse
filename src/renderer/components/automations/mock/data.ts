// UI mock-up of the Automations inbox (fable-layout.md, option A + project dot). STATIC DATA ONLY: nothing here
// reaches the daemon. Wiring it up later means replacing this file with selectors over real runs and automations.
import type { ChatMessage } from '../../../../shared/types'

/** How much a run's report asks of the person. `none`: the run ended without a report (never counted as quiet). */
export type RunLevel = 'needs_you' | 'look' | 'fyi' | 'quiet' | 'none'
/** What the run is doing, apart from its report. */
export type RunState = 'running' | 'waiting_computer' | 'paused_usage' | 'failed' | 'done'
export type TriggerKind = 'schedule' | 'event' | 'request' | 'manual'

export interface MockTuningNote {
  id: string
  kind: 'noisy' | 'missed'
  date: string
  run: number
  text: string
}

export interface MockAutomation {
  id: string
  name: string
  project: string
  trigger: { kind: TriggerKind; text: string }
  who: { kind: 'agent' | 'bot'; name: string }
  /** The next run, short. */
  next: string
  /** Known API-key cost this month. */
  costMonth: string
  on: boolean
  tuning: MockTuningNote[]
}

export interface MockPullRequest {
  number: number
  checks: 'pass' | 'fail' | 'pending' | 'merged'
}

export interface MockRun {
  id: string
  automationId: string
  /** Run number of its automation, as tuning notes cite it. */
  number: number
  time: string
  level: RunLevel
  state: RunState
  summary: string
  computer: string
  pr?: MockPullRequest
  /** A Needs you item another bot resolves. */
  assignee?: string
}

/** The person's computers. A run shows its computer only when there is more than one. */
export const MOCK_COMPUTERS = ['Desk', 'Laptop']

/** The month the costs cover, and what they cover. */
export const MOCK_COST_LABEL = 'API keys · Nov'

export const MOCK_AUTOMATIONS: MockAutomation[] = [
  {
    id: 'nightly', name: 'Nightly review', project: 'mousse', trigger: { kind: 'schedule', text: 'Daily 09:00' },
    who: { kind: 'agent', name: 'Default agent' }, next: 'Tomorrow 09:00', costMonth: '$3.40', on: true,
    tuning: [
      { id: 't1', kind: 'noisy', date: '3 Nov', run: 14, text: 'Skip FYI reports about draft PRs' },
      { id: 't2', kind: 'missed', date: '6 Nov', run: 17, text: 'Always tell me about migrations' }
    ]
  },
  {
    id: 'deps', name: 'Deps bump', project: 'mousse', trigger: { kind: 'schedule', text: 'Mondays 03:00' },
    who: { kind: 'agent', name: 'Default agent' }, next: 'Mon 03:00', costMonth: '$1.12', on: true, tuning: []
  },
  {
    id: 'flaky', name: 'Flaky test watch', project: 'mousse', trigger: { kind: 'schedule', text: 'Every 6 h' },
    who: { kind: 'agent', name: 'Default agent' }, next: '15:00', costMonth: '$0.86', on: true,
    tuning: [{ id: 't3', kind: 'noisy', date: '8 Nov', run: 22, text: 'One flaky run in 20 is fine' }]
  },
  {
    id: 'ci', name: 'CI health', project: 'mousse', trigger: { kind: 'schedule', text: 'Every 2 h' },
    who: { kind: 'agent', name: 'Default agent' }, next: '11:00', costMonth: '$0.22', on: true, tuning: []
  },
  {
    id: 'morning', name: 'Morning summary', project: 'mousse-plus', trigger: { kind: 'schedule', text: 'Daily 08:00' },
    who: { kind: 'bot', name: 'Pip' }, next: 'Tomorrow 08:00', costMonth: '$0.40', on: true, tuning: []
  },
  {
    id: 'release', name: 'Release notes', project: 'mousse-plus', trigger: { kind: 'event', text: 'On PR merge' },
    who: { kind: 'agent', name: 'Default agent' }, next: 'Next merge', costMonth: '$2.05', on: true, tuning: []
  },
  {
    id: 'changelog', name: 'Changelog', project: 'mousse-plus', trigger: { kind: 'schedule', text: 'Fridays 17:00' },
    who: { kind: 'agent', name: 'Default agent' }, next: 'Fri 17:00', costMonth: '$0.65', on: true, tuning: []
  },
  {
    id: 'deploy', name: 'Deploy preview', project: 'mousse', trigger: { kind: 'request', text: 'On request' },
    who: { kind: 'agent', name: 'Default agent' }, next: 'On request', costMonth: '$0.00', on: false, tuning: []
  }
]

/** Newest first. Quiet runs are counted, not listed one by one (see MOCK_QUIET). */
export const MOCK_RUNS: MockRun[] = [
  { id: 'r-ci-now', automationId: 'ci', number: 41, time: 'now', level: 'none', state: 'running', summary: 'Checking the last 5 runs on main', computer: 'Desk' },
  { id: 'r-release-wait', automationId: 'release', number: 9, time: '09:10', level: 'none', state: 'waiting_computer', summary: 'Waiting for Laptop to come online', computer: 'Laptop' },
  { id: 'r-changelog-paused', automationId: 'changelog', number: 6, time: '09:05', level: 'none', state: 'paused_usage', summary: 'Paused for usage · resumes 14:00', computer: 'Desk' },
  { id: 'r-nightly', automationId: 'nightly', number: 18, time: '09:02', level: 'needs_you', state: 'done', summary: 'One risky migration in #412 needs your call', computer: 'Desk', pr: { number: 412, checks: 'pass' } },
  { id: 'r-deps', automationId: 'deps', number: 7, time: '08:40', level: 'needs_you', state: 'done', summary: 'lodash 5 breaks 2 tests: pin or patch?', computer: 'Laptop', pr: { number: 415, checks: 'fail' } },
  { id: 'r-release-failed', automationId: 'release', number: 8, time: '07:55', level: 'needs_you', state: 'failed', summary: 'Failed: no access to mousse-plus', computer: 'Laptop' },
  { id: 'r-morning-bot', automationId: 'morning', number: 30, time: '08:00', level: 'needs_you', state: 'done', summary: 'Calendar clash at 10:00', computer: 'Desk', assignee: 'Pip' },
  { id: 'r-nightly-bot', automationId: 'nightly', number: 17, time: 'Yesterday', level: 'needs_you', state: 'done', summary: 'Reply to the reviewer on #409', computer: 'Desk', pr: { number: 409, checks: 'pending' }, assignee: 'Pip' },
  { id: 'r-flaky', automationId: 'flaky', number: 23, time: '06:00', level: 'look', state: 'done', summary: 'checkout.spec failed 3 of 20 reruns', computer: 'Desk' },
  { id: 'r-morning-none', automationId: 'morning', number: 29, time: 'Yesterday', level: 'none', state: 'done', summary: 'No report', computer: 'Desk' },
  { id: 'r-ci-green', automationId: 'ci', number: 40, time: '09:00', level: 'fyi', state: 'done', summary: 'Main is green again', computer: 'Desk' },
  { id: 'r-release-notes', automationId: 'release', number: 7, time: 'Yesterday', level: 'fyi', state: 'done', summary: 'Drafted notes for 0.42', computer: 'Laptop', pr: { number: 410, checks: 'merged' } },
  { id: 'r-deps-mon', automationId: 'deps', number: 6, time: 'Mon', level: 'fyi', state: 'done', summary: '3 patch updates merged', computer: 'Laptop' }
]

/** The quiet runs behind the collapsed row: [automation id, time]. */
export const MOCK_QUIET: Array<[string, string]> = [
  ['ci', '07:00'], ['ci', '05:00'], ['flaky', '00:00'], ['ci', '03:00'], ['ci', '01:00'], ['nightly', 'Yesterday'],
  ['ci', 'Yesterday'], ['ci', 'Yesterday'], ['flaky', 'Yesterday'], ['morning', 'Sat'], ['ci', 'Sat'], ['flaky', 'Sat'],
  ['changelog', 'Fri'], ['ci', 'Fri']
]

/** The empty state: one automation, no runs yet. */
export const MOCK_EMPTY_AUTOMATION: MockAutomation = { ...MOCK_AUTOMATIONS[0]!, tuning: [] }

/** The prompt each automation's runs start with. */
const PROMPTS: Record<string, string> = {
  nightly: 'Review the PRs opened today. Flag risky changes; never merge.',
  deps: 'Bump dependencies with safe updates and open a PR. Ask before major versions.',
  flaky: 'Rerun checkout.spec 20 times on main. Report only if it fails.',
  ci: 'Look at the last CI runs on main and tell me only if something broke.',
  morning: 'Tell me what is on my calendar today and anything that clashes.',
  release: 'Draft release notes from the PRs merged since the last tag.',
  changelog: 'Draft this week\'s changelog from merged PRs.'
}

const REPLIES: Record<string, string> = {
  'r-nightly': [
    'Reviewed **3 PRs** opened today.',
    '',
    '- **#412 Move sessions to SQLite** needs your call. Migration `0042` drops `sessions.legacy_token` with no backfill, so anyone on 0.41 is signed out on update. Checks pass.',
    '- #413 Sidebar flicker fix: looks safe, one nit left as a comment.',
    '- #414 Docs typo: approved.',
    '',
    'Options for #412: add a backfill step (about 20 lines), or ship it and note the sign-out in the release notes.'
  ].join('\n'),
  'r-deps': [
    'Opened **#415** with 6 updates. `lodash` 4 → 5 breaks 2 tests in `utils/merge.test.ts` (`_.merge` no longer deep-copies arrays).',
    '',
    'Pin lodash at 4.17 for now, or patch the two call sites? I have not merged anything.'
  ].join('\n'),
  'r-flaky': 'Reran `checkout.spec` 20 times on `main` at `a41c9e2`. **3 failures**, all `Timeout waiting for #pay-button` under load. Seeds 7, 12 and 19 reproduce it.',
  'r-release-failed': 'The run could not clone `mousse-plus`: this computer has no access to the repository.',
  'r-ci-green': 'The last 5 runs on `main` passed. The failure at 05:00 was a runner timeout and has not come back.',
  'r-release-notes': 'Drafted the notes for **0.42** and merged them as #410.',
  'r-deps-mon': 'Merged 3 patch updates (#401, #402, #403). All checks passed.',
  'r-morning-bot': 'Your 10:00 stand-up overlaps the dentist. Pip is moving the stand-up.',
  'r-nightly-bot': 'A reviewer asked for a test on #409. Pip is replying.'
}

/** The run's thread as ordinary messages: the scheduled prompt, then the agent's report. */
export function mockRunMessages(run: MockRun): ChatMessage[] {
  const automation = MOCK_AUTOMATIONS.find((entry) => entry.id === run.automationId)
  const at = '2026-11-09T09:00:00.000Z'
  const messages: ChatMessage[] = [{
    id: `${run.id}-prompt`, role: 'user', content: PROMPTS[run.automationId] ?? automation?.name ?? '', timestamp: at,
    scheduled: { jobId: run.automationId, jobName: automation?.name }
  }]
  const reply = REPLIES[run.id] ?? (run.state === 'running' ? '' : run.summary)
  if (reply) messages.push({ id: `${run.id}-reply`, role: 'assistant', content: reply, timestamp: '2026-11-09T09:02:14.000Z' })
  return messages
}

// ── Creating from an ordinary chat: the inline draft card ──

/** The seeded thread the inline draft shows in. */
export const MOCK_DRAFT_THREAD_TITLE = 'Fix flaky checkout test'

export const MOCK_CHAT_DRAFT = {
  name: 'Flaky checkout check',
  /** What "this" meant in the conversation, captured for every future run. */
  context: 'Rerun checkout.spec 20× on main; report only failures, with the failing seed and log.',
  when: 'daily-0900',
  who: 'default',
  project: 'mousse',
  next: '09:00'
}

export const MOCK_CHAT_DRAFT_OPTIONS = {
  when: [
    { value: 'daily-0900', label: 'Daily 09:00' },
    { value: 'weekdays-0900', label: 'Weekdays 09:00' },
    { value: 'every-6h', label: 'Every 6 h' }
  ],
  who: [
    { value: 'default', label: 'Default agent' },
    { value: 'bot:pip', label: 'Pip' }
  ],
  project: [
    { value: 'mousse', label: 'mousse' },
    { value: 'mousse-plus', label: 'mousse-plus' }
  ]
}

/** The two messages the draft follows, after the seeded exchange. */
export function mockDraftMessages(): ChatMessage[] {
  const at = '2026-11-09T09:20:00.000Z'
  return [
    { id: 'mock-draft-ask', role: 'user', content: 'Make that a daily check: rerun it every morning and only tell me if it fails.', timestamp: at },
    { id: 'mock-draft-reply', role: 'assistant', content: 'Here is a draft. Nothing runs until you turn it on.', timestamp: '2026-11-09T09:20:09.000Z' }
  ]
}
