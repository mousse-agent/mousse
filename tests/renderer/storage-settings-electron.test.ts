import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'
import { formatBytes } from '../../src/shared/storage'

const MB = 1024 * 1024

it('edits policies, shows usage across machines, and cleans up only after the plan is confirmed, in the real page', async () => {
  const temporaryRoot = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(temporaryRoot, 'mousse-storage-settings-')))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    await Promise.all([
      build({ entryPoints: [resolve('tests/fixtures/storage-settings/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'silent' }),
      build({ entryPoints: [resolve('tests/fixtures/storage-settings/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'silent' })
    ])
    writeFileSync(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><style>body{margin:0}*{box-sizing:border-box}</style><link rel="stylesheet" href="entry.css"><div id="root"></div><script src="entry.js"></script>')
    const env = { ...process.env, MOUSSE_STORAGE_SETTINGS_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', (bytes) => { output = (output + bytes.toString()).slice(-6000) })
    child.stderr!.on('data', (bytes) => { output = (output + bytes.toString()).slice(-6000) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    const code = await exited
    const report = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8'))
    expect(report.ok, `${report.error ?? ''}\n${output}`).toBe(true)
    expect(code, output).toBe(0)
    expect(report.errors).toEqual([])
    expect(report.failures).toEqual([])

    // A profile that was already in use keeps its own rules and sees a notice; nothing new is on until it says so.
    const review = report.review
    expect(review.legacy).toMatchObject({ inactive: 'off', captures: 'off', merged: 'false', deleted: 'true', configureCalls: 0 })
    expect(review.legacy.notice).toContain('Recommended cleanup rules are available')
    expect(review.legacy.notice).toContain('Nothing has changed: only the worktrees of deleted threads are removed automatically.')
    // The notice comes first; then disk usage and cleanup, before the rules.
    expect(review.legacy.order).toEqual(['storage-review-notice', 'storage-usage', 'storage-cleanup', 'storage-trash', 'storage-worktrees', 'storage-browser'])
    for (const text of ['Remove worktrees inactive for 30 days', 'Remove worktrees whose work is merged into the default branch', 'Delete saved browser captures after 30 days', 'Never deletes', 'A download saved by an older version with a .png name']) expect(review.dialog, text).toContain(text)
    expect(review.notNow).toEqual({ configureCalls: 0, notice: true })
    expect(review.turnedOn).toEqual({ saved: { schemaVersion: 1, worktrees: { removeWithDeletedThreads: true, inactiveDays: 30, removeMerged: true }, browser: { captureDays: 30 } }, noticeGone: true })
    expect(review.dismissed).toEqual({ dismissCalls: 1, configureCallsAdded: 0, inactive: '30' })

    // The saved values reach the controls, and every rule is a title and one short line.
    expect(report.initial).toMatchObject({ trash: 'never', inactive: '30', captures: '30', deleted: 'true', merged: 'true', groups: [true, true, true, true, true], machineSelect: true, measuredAt: 'Measured 5m ago', order: ['storage-usage', 'storage-cleanup', 'storage-trash', 'storage-worktrees', 'storage-browser'] })
    for (const row of report.initial.ruleRows) {
      expect(row.text, row.id).not.toContain('Never deletes')
    }
    expect(report.initial.worktreesNote).toContain('always kept')
    expect(report.initial.projectRows.map((row: any) => [row.label, row.bytes])).toEqual([['Mousse', 700 * MB], ['Website', 280 * MB], ['Other', 100 * MB]])

    // The worktree folder: Mousse's own until one is chosen; choosing and going back each reach the daemon and read back.
    expect(report.worktreeFolder.initial).toContain("New worktrees go in Mousse's own folder, /Users/you/.mousse/repositories.")
    expect(report.worktreeFolder.chosen).toContain('New worktrees go in /Volumes/T7/Mousse worktrees, one folder per project.')
    expect(report.worktreeFolder.reset).toContain('Worktrees made earlier stay where they are: /Volumes/T7/Mousse worktrees.')
    expect(report.worktreeFolder.refused).toEqual({ text: "This drive (exFAT) can't store file permissions, which Git worktrees need. Pick a folder on an APFS, HFS+, NTFS or ext4 drive.", pageError: '', unchanged: true })
    expect(report.worktreeFolder.refusalCleared).toBe(true)
    expect(report.worktreeFolder.calls).toEqual([2, 1])

    // Policy editing: each setting is sent, saved and read back; a bad number is never sent.
    const policy = report.policy
    // An empty Custom field, or Escape, goes back to the saved value instead of hiding it.
    expect(policy.emptyBlur).toEqual({ shown: '30', configureCalls: 0 })
    expect(policy.escape).toEqual({ shown: '30' })
    expect(policy.custom45).toMatchObject({ typed: '45', configureCalls: 1, saved: 45, shown: '45', inputGone: true, bound: '' })
    expect(policy.invalid.map((entry: any) => entry.typed)).toEqual(['0', '4000', 'abc', '4.5'])
    for (const entry of policy.invalid) {
      expect(entry.configureCalls, entry.typed).toBe(0)
      expect(entry.bound, entry.typed).toContain('whole number of days from 1 to 3650')
      expect(entry.ariaInvalid, entry.typed).toBe('true')
    }
    expect(policy.stillSaved).toEqual({ daemon: 45, configureCalls: 1 })
    expect(policy.recovered).toMatchObject({ configureCalls: 1, saved: 60, bound: '' })
    expect(policy.inactiveOff).toBeNull()
    expect(policy.inactive7).toBe(7)
    expect(policy.mergedOff).toBe(false)
    expect(policy.deletedOff).toBe(false)
    expect(policy.captures90).toBe(90)
    expect(policy.trash7).toMatchObject({ graceDays: 7, automaticPurge: true })
    expect(policy.trash12.saved).toMatchObject({ graceDays: 12, automaticPurge: true })
    expect(policy.otherRulesKept).toEqual({ schemaVersion: 1, worktrees: { removeWithDeletedThreads: false, inactiveDays: 7, removeMerged: false }, browser: { captureDays: 90 } })

    // Preview cleanup: the plan first, nothing removed until it is confirmed, then the report.
    const cleanup = report.cleanup
    expect(cleanup.beforeRun).toContain('Cleanup has not run yet.')
    expect(cleanup.enabled).toBe(true)
    // What the run is bounded by is exactly what the plan returned.
    expect(cleanup.plan).toMatchObject({ planCalls: 1, runCalls: 0, keptFolded: true, summary: 'Would remove 2 items, freeing about 250.0 MB. 1 will be kept.', confirm: 'Remove 2 items' })
    expect(cleanup.plan.text).toContain('Inactive for 41 days')
    expect(cleanup.plan.text).toContain('Has uncommitted changes (3 files)')
    expect(cleanup.runToken).toMatchObject({ policyDigest: 'digest', keys: ['worktree:t2', 'worktree:old'] })
    expect(cleanup.runToken.expiresAt - cleanup.runToken.issuedAt).toBe(600_000)
    expect(cleanup.afterCancel.runCalls).toBe(0)
    expect(cleanup.afterCancel.report).toContain('Cleanup has not run yet.')
    expect(cleanup.report.runCalls).toBe(1)
    expect(cleanup.report.sentence).toBe('Removed 2, kept 4, failed 1. About 250.0 MB recovered.')
    expect(cleanup.report.omitted).toBe('3 more results')
    expect(cleanup.report.items.map((item: any) => item.outcome)).toEqual(['failed', 'removed', 'removed', 'kept'])
    expect(cleanup.report.items[0].text).toContain('Repository is busy')
    expect(cleanup.report.items[1].text).toContain('Inactive for 41 days')
    expect(cleanup.report.items[3].text).toContain('Has ignored files (node_modules/)')
    expect(cleanup.usageReread).toBe(true)
    expect(cleanup.failure).toContain('Cleanup did not finish.')
    // A plan nobody confirmed in time has to be checked again, and the page says so before the daemon refuses it.
    expect(cleanup.expired).toEqual({ message: 'This check is out of date. Check again to see what would be removed now.', confirm: false, recheck: true })
    expect(cleanup.rechecked).toEqual({ planCallsAdded: 1 })
    // A timeout is not a failure: the daemon keeps going and the page says where the result will appear.
    expect(cleanup.timeout).toEqual({ notice: 'Cleanup is still running in the background. The result appears here when it finishes.', error: false, dialog: false })

    // Group by changes the table; each view shows its total once, as the sum of its rows, with no chart or legend.
    const { project, thread, kind } = report.usage.byGroup
    expect(project.rows.map((row: any) => row.label)).toEqual(['Mousse', 'Website', 'Other'])
    expect(thread.rows.map((row: any) => [row.label, row.bytes])).toEqual([['Fix storage', 500 * MB], ['Add search', 200 * MB], ['Landing page', 50 * MB], ['Gone thread', 30 * MB], ['Other', 300 * MB]])
    expect(kind.rows.map((row: any) => row.label)).toEqual(['Worktrees', 'Browser data', 'Logs', 'Threads'])
    expect([project.rows.length, thread.rows.length, kind.rows.length]).toEqual([3, 5, 4])
    for (const view of [project, thread, kind]) {
      const total = view.rows.reduce((sum: number, row: any) => sum + row.bytes, 0)
      expect(view.total).toBe(`${formatBytes(total)} in total`)
      expect(view.chart).toBe(0)
    }
    expect(report.usage.sortedByName).toEqual(['Browser data', 'Logs', 'Threads', 'Worktrees'])
    expect(report.usage.sortedByNameDesc).toEqual(['Worktrees', 'Threads', 'Logs', 'Browser data'])

    // Refresh measures again for this computer only; another machine is just read again.
    expect(report.usage.refreshLocal).toEqual({ options: { refresh: true }, measured: 'Measured just now' })
    expect(report.usage.machineOptions).toEqual(['self', 'nod_laptop', 'nod_server', 'nod_phone', 'all'])
    expect(report.usage.laptop.hubCalls).toEqual([{ target: 'nod_laptop' }])
    expect(report.usage.laptop.rows.map((row: any) => [row.label, row.bytes])).toEqual([['Laptop project', 300 * MB], ['Other', 20 * MB]])
    expect(report.usage.laptopRefresh).toEqual({ localCallsAdded: 0, hubCallsAdded: 1, hubParams: { target: 'nod_laptop' } })

    // A machine that refuses or is offline is Unavailable with the reason, never a zero.
    expect(report.usage.server.table).toBe(false)
    expect(report.usage.server.text).toBe('Server: Unavailable · Older version or no permission')
    expect(report.usage.server.none).toBe('No usage to show.')
    expect(report.usage.phone).toEqual({ text: 'Phone: Unavailable · Offline', asked: 0 })
    const all = report.usage.all
    expect(all.project.unavailable).toContain('Server: Unavailable · Older version or no permission')
    expect(all.project.unavailable).toContain('Phone: Unavailable · Offline')
    expect(all.project.total).toContain('in total')
    expect(all.project.rows.map((row: any) => row.key)).toEqual(expect.arrayContaining(['self:p1', 'nod_laptop:p9']))
    expect(all.project.machineColumn).toBe(true)
    expect(all.kind.machineColumn).toBe(false)
    expect(all.kind.rows.find((row: any) => row.label === 'Worktrees').bytes).toBe(980 * MB)

    // A reply that fails validation is refused before anything is drawn.
    expect(report.usage.malformed).toMatchObject({ table: false, rows: 0, none: 'No usage to show.' })
    expect(report.usage.malformed.text).toBe('This computer: Unavailable · Sent an unreadable reply')

    // Selecting a row goes somewhere.
    // A measured thread that is no longer in the thread list is a label, not a link.
    expect(report.links.goneThread).toEqual({ listed: true, linked: false })
    expect(report.links.localThread).toEqual({ select: 't1', settingsOpen: false })
    expect(report.links.project).toEqual({ select: 't2' })
    expect(report.links.kind).toEqual({ scrolledTo: 'storage-worktrees', logsIsLabel: true })
    expect(report.links.remoteThread).toEqual({ select: 'nod_laptop:r1', dialog: false })

    // Trash is reviewed from the sidebar: the row says so, and Settings has no trash dialog or other-threads list.
    expect(report.trash.row).toContain('1 thread in trash, listed under Recently deleted.')
    expect(report.trash.reviewButton).toBe(false)
    expect(report.trash.otherThreads).toBe(false)

    // With every rule off, Preview cleanup says why it is disabled and asks for nothing.
    expect(report.noRule.disabled).toBe(true)
    expect(report.noRule.text).toContain('Turn on a cleanup rule to use this.')
    expect(report.noRule.policy).toEqual({ schemaVersion: 1, worktrees: { removeWithDeletedThreads: false, inactiveDays: null, removeMerged: false }, browser: { captureDays: null } })
    expect(report.noRule.trash.automaticPurge).toBe(false)
    expect(report.noRule.planCallsAdded).toBe(0)
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited?.catch(() => undefined) }
    if (dirname(directory) !== temporaryRoot || !basename(directory).startsWith('mousse-storage-settings-')) throw new Error('Refusing cleanup outside owned storage settings fixture directory')
    rmSync(directory, { recursive: true, force: true })
  }
}, 90000)
