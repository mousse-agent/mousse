#!/usr/bin/env node
// Writes docs/providers/setup-matrix.md from docs/providers/setup-matrix.json.
// Usage: node scripts/gen-setup-matrix.mjs [--check]   (--check: exit 1 when the file is out of date)
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SETUP_MATRIX_JSON = join(root, 'docs', 'providers', 'setup-matrix.json')
export const SETUP_MATRIX_MD = join(root, 'docs', 'providers', 'setup-matrix.md')

export const OS_LABELS = {
  'windows-x64': 'Windows x64',
  'windows-arm64': 'Windows arm64',
  'macos-arm64': 'macOS arm64',
  'linux-x64': 'Linux x64',
  'linux-arm64': 'Linux arm64'
}
export const SOURCE_LABELS = {
  path: 'On PATH',
  managed: 'Installed by Mousse',
  custom: 'Custom command or executable',
  bundled: 'Ships with Mousse'
}
export const SIGN_IN_LABELS = {
  agent_home: "Account in the agent's home",
  mousse: 'Sign-in in Mousse',
  api_key: 'API key',
  ambient: 'Cloud credentials from the environment'
}
const STATUS_LABELS = { tested: 'Tested', untested: 'Untested', unsupported: 'Not supported' }

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** The Markdown of the matrix `data` (the parsed JSON). */
export function renderSetupMatrix(data) {
  const lines = [
    '# Agent setup matrix',
    '',
    '<!-- Generated from setup-matrix.json by scripts/gen-setup-matrix.mjs. Edit the JSON, then run the script. -->',
    '',
    'Which agent setups Mousse has been tested with, for each operating system, where the agent comes from',
    'and how it signs in. "Tested" names the pull request whose description records the run; every other',
    'cell says why it is untested or not supported. See [agent-setup.md](agent-setup.md) for how each setup',
    'works and [compatibility.md](compatibility.md) for the agent versions.',
    '',
    '- **Source:** ' + Object.values(SOURCE_LABELS).join(', ') + '.',
    '- **Sign-in:** ' + Object.values(SIGN_IN_LABELS).join(', ') + '.',
    ''
  ]
  for (const agent of data.agents) {
    lines.push(`## ${agent.label}`, '', '| Source | Sign-in | OS | State |', '|---|---|---|---|')
    for (const row of agent.rows) {
      const state = row.status === 'tested'
        ? `${STATUS_LABELS.tested} (${row.evidence.join(', ')})${row.reason ? `: ${row.reason}` : ''}`
        : `${STATUS_LABELS[row.status]}: ${row.reason}`
      lines.push(`| ${SOURCE_LABELS[row.source]} | ${SIGN_IN_LABELS[row.signIn]} | ${row.os.map((os) => OS_LABELS[os]).join(', ')} | ${cell(state)} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function readSetupMatrix() {
  return JSON.parse(readFileSync(SETUP_MATRIX_JSON, 'utf8'))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = renderSetupMatrix(readSetupMatrix())
  if (process.argv.includes('--check')) {
    const current = readFileSync(SETUP_MATRIX_MD, 'utf8').replace(/\r\n/g, '\n')
    if (current !== text) {
      console.error('docs/providers/setup-matrix.md is out of date: run node scripts/gen-setup-matrix.mjs')
      process.exit(1)
    }
  } else {
    writeFileSync(SETUP_MATRIX_MD, text)
    console.log('wrote docs/providers/setup-matrix.md')
  }
}
