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
    expect(report.errors).toEqual([])
    // Text, wording and the controller's calls are covered in recentlyDeleted.test.ts and trashInventory.test.ts;
    // this window checks only what jsdom cannot: real Tab order, key activation and where focus lands.
    expect(report.opened).toEqual(['newest', 'middle', 'oldest'])

    // Tab and Shift+Tab walk the action buttons row by row.
    expect(report.tabs.map((entry: any) => [entry.task, entry.action])).toEqual([['newest', 'restore'], ['newest', 'delete'], ['middle', 'restore']])
    expect(report.back.map((entry: any) => [entry.task, entry.action])).toEqual([['newest', 'delete'], ['newest', 'restore']])

    // Space on Restore restores that thread, and focus moves to the next row instead of falling to the page.
    expect(report.restore.calls).toEqual(['newest'])
    expect(report.restore.rows).toEqual(['middle', 'oldest'])
    expect(report.restore.active).toMatchObject({ task: 'middle', action: 'restore', tag: 'BUTTON' })

    // Enter on Delete permanently… opens the confirmation with focus inside it, on the checkbox, not the delete button.
    expect(report.beforeDelete).toMatchObject({ task: 'middle', action: 'delete' })
    expect(report.dialogOpened).toMatchObject({ inDialog: true, type: 'checkbox' })

    // Escape cancels: nothing was deleted and focus is back on the button that opened it.
    expect(report.escaped.purges).toEqual([])
    expect(report.escaped.active).toMatchObject({ task: 'middle', action: 'delete' })

    // Space ticks the checkbox; Tab stays inside the dialog and reaches Delete permanently; Enter deletes.
    expect(report.accepted).toMatchObject({ checkbox: true, confirmDisabled: false })
    expect(report.dialogTabs.every((entry: any) => entry.inDialog)).toBe(true)
    expect(report.dialogTabs.at(-1)).toMatchObject({ tag: 'BUTTON', label: 'Delete permanently' })
    expect(report.purged.purges).toEqual([expect.objectContaining({ taskId: 'middle', discard: true })])
    expect(report.purged.rows).toEqual(['oldest'])
    expect(report.purged.active).toMatchObject({ task: 'oldest', tag: 'BUTTON' })
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited?.catch(() => undefined) }
    if (dirname(directory) !== temporaryRoot || !basename(directory).startsWith('mousse-recently-deleted-')) throw new Error('Refusing cleanup outside owned recently-deleted fixture directory')
    rmSync(directory, { recursive: true, force: true })
  }
}, 40000)
