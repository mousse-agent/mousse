/**
 * The short forms read aloud says differently from how they are written. Add entries here; the
 * rules that use them are in `shortForms.ts`.
 *
 * Capital-letter initialisms without a vowel (PR, MCP, NPM, HTML) are spelled by rule and need no
 * entry. Initialisms that are said as a word (JSON, WASM, RAM, YAML, REST) and shouted words
 * (STOP, NOTE, TODO, OK) need none either: they are left alone.
 */

/** Capital-letter initialisms with a vowel that are spelled letter by letter. Plurals ("APIs") follow. */
export const SPELLED_INITIALISMS: readonly string[] = [
  'AI', 'API', 'AWS', 'CI', 'CLI', 'CPU', 'EOF', 'ETA', 'EU', 'FAQ', 'GPU', 'GUI', 'ID', 'IDE', 'IO', 'IP', 'IPC',
  'OCR', 'OS', 'OSS', 'PII', 'PID', 'PTY', 'QA', 'SEO', 'SSO', 'TTY', 'UI', 'URI', 'URL', 'USB', 'UTC', 'UTF', 'UUID',
  'UX'
]

/** Capital words without a vowel that are said as they are, not spelled. */
export const NOT_SPELLED: readonly string[] = ['BRR', 'GRR', 'HMM', 'HMMM', 'MMM', 'PFFT', 'PSST', 'SHH', 'SHHH', 'TSK', 'ZZZ']

/**
 * Short forms said as words. Keys match whole words in any letter case, except keys marked
 * `exactCase`, which match only as written (so "VS Code" and the `nvm` tool are left alone).
 */
export const SAID_AS: Readonly<Record<string, string | { say: string; exactCase: true }>> = {
  idk: "I don't know",
  imo: 'in my opinion',
  imho: 'in my humble opinion',
  tbh: 'to be honest',
  btw: 'by the way',
  fyi: 'for your information',
  afaik: 'as far as I know',
  asap: 'as soon as possible',
  lgtm: 'looks good to me',
  wip: 'work in progress',
  'tl;dr': 'T L D R',
  tldr: 'T L D R',
  NVM: { say: 'never mind', exactCase: true },
  'e.g.': 'for example',
  'i.e.': 'that is',
  'etc.': 'et cetera',
  vs: { say: 'versus', exactCase: true },
  'vs.': { say: 'versus', exactCase: true },
  'w/': { say: 'with', exactCase: true },
  'w/o': { say: 'without', exactCase: true },
  e2e: 'end to end',
  i18n: 'internationalization',
  l10n: 'localization',
  a11y: 'accessibility',
  k8s: 'Kubernetes',
  stdin: 'standard in',
  stdout: 'standard out',
  stderr: 'standard error'
}
