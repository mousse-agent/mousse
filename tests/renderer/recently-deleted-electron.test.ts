import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'

it('restores and permanently deletes recently deleted threads with the keyboard alone, in a real window', async () => {
  const temporaryRoot = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(temporaryRoot, 'mousse-recently-deleted-')))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    await Promise.all([
      build({ entryPoints: [resolve('tests/fixtures/recently-deleted/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' }),
      build({ entryPoints: [resolve('tests/fixtures/recently-deleted/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'silent' })
    ])
    writeFileSync(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><style>body{margin:0}*{box-sizing:border-box}</style><link rel="stylesheet" href="entry.css"><div id="root"></div><script src="entry.js"></script>')
    const env = { ...process.env, MOUSSE_RECENTLY_DELETED_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-6000) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-6000) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    const code = await exited
    const report = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8'))
    expect(code, output + JSON.stringify(report)).toBe(0)
    expect(report.ok, JSON.stringify(report)).toBe(true)
    // The only console error is the one deliberate refusal below, logged once with its diagnostic.
    expect(report.errors.map((message: string) => message.split(' [')[0])).toEqual(['Recently deleted request failed'])

    // Collapsed first; Enter on the heading opens the list, newest deletion first, each with its retention days.
    expect(report.collapsed).toEqual({ expanded: 'false', label: 'Expand recently deleted threads', rows: 0, count: '3' })
    expect(report.opened.expanded).toBe('true')
    expect(report.opened.rows.map((row: any) => row.task)).toEqual(['newest', 'middle', 'oldest'])
    expect(report.opened.rows.map((row: any) => row.meta)).toEqual([
      'Deleted yesterday · Permanently deleted in 29 days',
      'Deleted 3 days ago · Permanently deleted in 27 days',
      'Deleted 5 days ago · Permanently deleted in 25 days'
    ])

    // Tab and Shift+Tab walk the action buttons row by row.
    expect(report.tabs.map((entry: any) => [entry.task, entry.action])).toEqual([['newest', 'restore'], ['newest', 'delete'], ['middle', 'restore']])
    expect(report.back.map((entry: any) => [entry.task, entry.action])).toEqual([['newest', 'delete'], ['newest', 'restore']])

    // Space on Restore restores that thread; the list and count follow, and focus moves to the next row.
    expect(report.restore.calls).toEqual(['newest'])
    expect(report.restore.rows.map((row: any) => row.task)).toEqual(['middle', 'oldest'])
    expect(report.restore.count).toBe('2')
    expect(report.restore.active).toMatchObject({ task: 'middle', action: 'restore', tag: 'BUTTON' })

    // Enter on Delete permanently… opens the confirmation with focus inside it, not on the delete button.
    expect(report.beforeDelete).toMatchObject({ task: 'middle', action: 'delete' })
    expect(report.dialogOpened.active).toMatchObject({ inDialog: true, type: 'checkbox' })
    expect(report.dialogOpened.dialog).toMatchObject({ title: 'Delete “Middle thread” permanently', confirmDisabled: true, checkbox: false, detailsOpen: false })
    expect(report.dialogOpened.dialog.text).toContain('Permanently deletes the transcript and worktree of “Middle thread”. This can’t be undone.')
    expect(report.dialogOpened.dialog.text).toContain('Frees 3.0 MB.')
    expect(report.dialogOpened.dialog.text).toContain('Unpublished work will be lost: 1 worktree has unpublished work.')

    // Escape cancels: nothing was deleted and focus is back on the button that opened it.
    expect(report.escaped.purges).toEqual([])
    expect(report.escaped.active).toMatchObject({ task: 'middle', action: 'delete' })
    expect(report.escaped.rows.map((row: any) => row.task)).toEqual(['middle', 'oldest'])

    // Space accepts the unpublished work; Tab reaches Delete permanently inside the dialog.
    expect(report.accepted).toMatchObject({ checkbox: true, confirmDisabled: false })
    expect(report.dialogTabs.every((entry: any) => entry.inDialog)).toBe(true)
    expect(report.dialogTabs.at(-1)).toMatchObject({ tag: 'BUTTON', label: 'Delete permanently' })

    // A refusal shows its reason, deletes nothing, and the thread stays listed and restorable.
    expect(report.refused.dialog.error).toContain('locked or permission-protected resource')
    expect(report.refused.purges).toEqual([{ taskId: 'middle', operationId: expect.any(String), expectedGeneration: 4, previewDigest: 'digest-middle', discard: true }])
    expect(report.refused.rows.map((row: any) => row.task)).toEqual(['middle', 'oldest'])
    expect(report.afterRefusal.active).toMatchObject({ task: 'middle', action: 'delete' })
    expect(report.afterRefusal.rows.map((row: any) => row.task)).toEqual(['middle', 'oldest'])

    // A fresh confirmation starts unaccepted; once the lock is gone the same keys delete it and focus moves on.
    expect(report.reopened).toMatchObject({ checkbox: false, confirmDisabled: true, error: null })
    expect(report.purged.purges).toHaveLength(2)
    expect(report.purged.purges[1]).toMatchObject({ taskId: 'middle', discard: true })
    expect(report.purged.rows.map((row: any) => row.task)).toEqual(['oldest'])
    expect(report.purged.count).toBe('1')
    expect(report.purged.active).toMatchObject({ task: 'oldest', tag: 'BUTTON' })
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited?.catch(() => undefined) }
    if (dirname(directory) !== temporaryRoot || !basename(directory).startsWith('mousse-recently-deleted-')) throw new Error('Refusing cleanup outside owned recently-deleted fixture directory')
    rmSync(directory, { recursive: true, force: true })
  }
}, 40000)
