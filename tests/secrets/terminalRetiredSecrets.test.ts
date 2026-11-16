// #595: a terminal's scrollback may still show a secret that was removed or changed while the thread's turn ran. Its
// read masks the store's current secrets and the thread's retired ones with one masker, before the output is cut into
// pages, so a cut cannot split the old value past the mask.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeProfileSecret } from '../../src/mms/profiles/secrets'
import { readTerminals } from '../../src/mms/run/mcp/appTools/terminals'
import type { TerminalReadHost } from '../../src/mms/run/mcp/appTools/host'
import { SecretRequests } from '../../src/mms/secrets/SecretRequests'
import { SecretVault } from '../../src/mms/secrets/SecretVault'

const OLD = 'tok_live_9f8e7d6c5b4a3210'

describe("a thread's terminal read after a secret changed mid-run", () => {
  let home: string
  let busy: Set<string>
  let vault: SecretVault
  let requests: SecretRequests
  let scrollback: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-terminal-retired-'))
    busy = new Set()
    vault = new SecretVault({ profileRoot: home, threadAlive: () => true, threadBusy: (id) => busy.has(id) })
    requests = new SecretRequests(vault)
    scrollback = ''
  })
  afterEach(() => {
    requests.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  /** The terminal host as the daemon wires it: the vault's store masker for the thread being read. */
  const host = (): TerminalReadHost => ({
    list: (threadId) => (threadId === 't1' ? [{ ptyId: 'p1', threadId: 't1', status: 'running', shell: 'bash', cwd: home, startedAt: 1 } as never] : []),
    output: () => ({ scrollback, droppedLines: 0 }),
    mask: (text, threadId) => vault.maskerForStore(threadId)?.(text) ?? text
  })
  const read = (args: Record<string, unknown> = {}) => readTerminals(host(), 't1', args).text

  const giveToThread = async () => {
    const asked = requests.request('t1', { label: 'API token', reason: 'x', name: 'API_TOKEN' })
    requests.answer('t1', requests.list('t1')[0].requestId, OLD, 'day')
    await asked
    // The run masks the thread's text while it goes.
    vault.maskerFor('t1')
  }
  const saveKey = () => {
    // A key saved in Settings, never given to the thread; the terminal showed it, and its read hid it.
    writeProfileSecret(home, 'DEPLOY_TOKEN', OLD)
    vault.refresh()
    scrollback = `deploy ${OLD}\n`
    expect(read()).not.toContain(OLD)
  }

  // [the secret, how it got there, what happens to it mid-run]
  const CHANGES: Array<[string, () => Promise<void> | void, () => void]> = [
    ['a secret given to the thread is removed', giveToThread, () => vault.delete('API_TOKEN')],
    ['a secret given to the thread is changed', giveToThread, () => { writeProfileSecret(home, 'API_TOKEN', 'tok_rotated_value_1234'); vault.refresh() }],
    ['a saved key is removed', saveKey, () => vault.delete('DEPLOY_TOKEN')],
    ['a saved key is changed', saveKey, () => { writeProfileSecret(home, 'DEPLOY_TOKEN', 'tok_rotated_value_1234'); vault.refresh() }]
  ]

  it.each(CHANGES)('hides the old value when %s, where a long line is cut and on a page of its own', async (_what, before, change) => {
    busy.add('t1')
    await before()
    change()
    // The old value starts 6 characters before a long line is cut at 1,000, then sits on the last page alone.
    scrollback = `${'0'.repeat(994)}${OLD}\nbuild ok\nold token ${OLD}\n`
    const whole = read()
    expect(whole).not.toContain(OLD.slice(0, 6))
    expect(whole).toMatch(/\[secret [A-Z_]+ hidden\]/)
    const lastLine = read({ lines: 1 })
    expect(lastLine).not.toContain(OLD)
    expect(lastLine).toMatch(/old token \[secret [A-Z_]+ hidden\]/)
  })

  it('shows a value removed while no turn of the thread ran: it is no longer a secret', async () => {
    await giveToThread()
    vault.delete('API_TOKEN')
    scrollback = `old token ${OLD}\n`
    expect(read()).toContain(OLD)
  })
})
