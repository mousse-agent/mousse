import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'

it('renders the bound profile footer and its two-column popover: stale replies, switching, row actions, account states and narrow layout', async () => {
  const temporaryRoot = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(temporaryRoot, 'mousse-profile-footer-')))
  let child: ChildProcess | undefined, exited: Promise<number | null> | undefined
  try {
    await build({ entryPoints: [resolve('tests/fixtures/profile-footer/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.svg': 'dataurl', '.woff2': 'file' }, define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/profile-footer/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'] })
    writeFileSync(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><style>:root{--text-primary:#eee;--text-secondary:#aaa;--accent:#a99;--border:#333;--bg-secondary:#222;--titlebar-height:40px}body{margin:0;background:#111}#root{width:260px}.app{height:600px}</style><link rel="stylesheet" href="entry.css"><div id="root"></div><script src="entry.js"></script>')
    const env = { ...process.env, MOUSSE_PROFILE_FOOTER_DIRECTORY: directory }; delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-10000) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-10000) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const report = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8'))
    expect(report.loading).toMatchObject({ loading: true, profile: 'prf_alpha', errors: [] })
    expect(report.first).toMatchObject({ name: 'Adithya', profile: 'prf_alpha', errors: [] })
    expect(report.afterLate).toMatchObject({ name: 'Studio', profile: 'prf_beta', errors: [] })
    expect(report.switched).toMatchObject({ name: 'Studio', profile: 'prf_beta', errors: [] })
    expect(report.switched.avatar).toMatch(/^data:image\/svg\+xml/)
    expect(report.binds).toEqual(['prf_beta'])
    // Rename from the row menu targets the displayed profile, and the default profile cannot be archived.
    expect(report.defaultActions).toEqual(['Rename', 'Colour'])
    expect(report.renameDialog).toMatchObject({ title: 'Edit profile', value: 'Adithya', maxLength: 64, submit: 'Save profile name', submitDisabled: true, archive: false, focus: 'Profile name' })
    expect(report.updates).toEqual([{ id: 'prf_alpha', displayName: 'Adithya local' }])
    expect(report.headings.map((heading: any) => heading.text)).toEqual(['Roster', 'Groups', 'Recent'])
    for (const heading of report.headings) expect(heading).toMatchObject({ transform: 'none', spacing: 'normal' })
    expect(report.fonts.ui).toMatch(/^Geist,/)
    expect(report.fonts.code).toMatch(/^"Geist Mono",/)
    expect(report.fonts.terminal).toMatch(/^"Geist Mono",/)
    expect(report.fonts.faces).toHaveLength(4)
    for (const face of report.fonts.faces) expect(face).toMatchObject({ status: 'loaded', weight: '100 900' })

    // A build without MOUSSE_ID_ORIGIN shows only the profiles column and never asks for account state.
    expect(report.noAccountRequests).toEqual([])
    expect(report.single.requests).toEqual([])
    expect(report.single.menu).toMatchObject({ role: 'menu', label: 'Profiles', wide: false, heading: 'Profiles', identity: null, rows: ['New profile'], kebabs: ['Adithya profile actions'] })
    expect(report.single.menu.box.width).toBe(330)
    expect(report.single.menu.columns.map((column: any) => column.label)).toEqual(['Profiles'])
    expect(report.single.menu.profiles).toEqual([expect.objectContaining({ name: 'Adithya', checked: 'true', check: true, dotSize: 12 })])
    expect(report.single.actions).toEqual(['Rename', 'Colour'])

    // Signed in: account on the left, profiles on the right, device count read when the menu opens.
    const { menu } = report.signedIn
    expect(menu).toMatchObject({ role: 'menu', label: 'Account and profiles', wide: true, heading: 'Profiles', rows: ['Account settings', 'Sign out', 'New profile'] })
    expect(menu.box.width).toBe(460)
    expect(menu.columns.map((column: any) => column.label)).toEqual(['Account', 'Profiles'])
    expect(menu.columns[0].box.left).toBeLessThan(menu.columns[1].box.left)
    expect(menu.columns[0].box.top).toBe(menu.columns[1].box.top)
    expect(menu.identity).toEqual({ name: 'ada.lovelace', email: 'ada.lovelace@example.com', devices: '3 of 5 devices', avatar: 52, emptyAvatar: false })
    expect(menu.profiles.map((row: any) => [row.name, row.checked, row.check])).toEqual([['Adithya', 'true', true], ['Studio', 'false', false], ['Design', 'false', false]])
    expect(menu.kebabs).toEqual(['Adithya profile actions', 'Studio profile actions', 'Design profile actions'])
    expect(new Set(menu.profiles.map((row: any) => row.dot)).size).toBe(3)
    expect(report.signedIn.requests).toEqual(['net.status', 'net.plus.status', 'net.plus.inventory'])
    expect(report.signedIn.trigger).toBe('Mousse ID: ada.lovelace, Mousse profile: Adithya')

    // Arrow keys run column by column and wrap, Right Arrow opens a row's actions, Esc closes one layer at a time.
    expect(report.keyboard.walk).toEqual(['Account settings', 'Sign out', 'Adithya', 'Studio', 'Design', 'New profile', 'Account settings', 'New profile', 'Account settings', 'New profile'])
    expect(report.keyboard.submenu).toEqual(['Rename', 'Colour', 'Archive', 'Rename', 'Archive', 'Rename'])
    expect(report.keyboard.afterFirstEscape).toEqual({ menuOpen: true, focus: 'Studio profile actions' })
    expect(report.keyboard.afterSecondEscape).toEqual({ menuOpen: false, trigger: true })
    expect(report.keyboard.kebabTabbable).toBe(true)

    // Row menu actions: Colour, validation, Archive (with confirmation), New profile, archiving the current profile.
    const actions = report.actions
    expect(actions.studioActions).toEqual(['Rename', 'Colour', 'Archive'])
    expect(actions.colourDialog).toMatchObject({ value: 'Studio', swatches: 8, selected: 'Violet', focus: 'Violet', archive: true, submitDisabled: true })
    expect(actions.colourUpdates).toEqual([{ id: 'prf_beta', displayName: 'Studio', color: '#2f7a6a' }])
    expect(actions.recoloured).toEqual(['rgb(77, 96, 136)', 'rgb(47, 122, 106)', 'rgb(47, 122, 106)'])
    for (const blocked of [actions.designDialog, actions.emptyDialog, actions.longDialog, actions.blankDialog, actions.unchangedDialog]) expect(blocked.submitDisabled).toBe(true)
    expect(actions.afterDialogArchive).toEqual({ archives: ['prf_gamma'], confirms: ['Archive Design?'] })
    expect(actions.afterRowArchive).toMatchObject({ archives: ['prf_gamma', 'prf_beta'], confirms: ['Archive Design?', 'Archive Studio?'], rows: ['Adithya'] })
    expect(actions.createDialog).toMatchObject({ title: 'New profile', value: '', submit: 'Create profile', submitDisabled: true, archive: false, selected: 'Violet' })
    expect(actions.created).toEqual({ creates: [{ displayName: 'Docs', color: '#604880' }], binds: ['prf_new1'] })
    expect(actions.docsActions).toEqual(['Rename', 'Colour', 'Archive'])
    expect(actions.archivedCurrent).toEqual({ binds: ['prf_new1', 'prf_alpha'], archives: ['prf_gamma', 'prf_beta', 'prf_new1'] })
    expect(actions.errors).toEqual([])

    // Signed out: a sign-in row and the empty avatar, no Sign out.
    expect(report.signedOut.menu).toMatchObject({ wide: true, rows: ['Sign in with Mousse ID', 'Account settings', 'New profile'] })
    expect(report.signedOut.menu.identity).toEqual({ avatar: 52, emptyAvatar: true })
    expect(report.signedOut.requests).not.toContain('net.plus.inventory')
    expect(report.signedOut.trigger).toBe('Sign in, Mousse profile: Adithya')

    // Under 560px the columns stack, account first, at the single-column width.
    const narrow = report.narrow
    expect(narrow.viewport).toBe(500)
    expect(narrow.menu.box.width).toBe(330)
    expect(narrow.menu.columns[0].box.left).toBe(narrow.menu.columns[1].box.left)
    expect(narrow.menu.columns[0].box.top).toBeLessThan(narrow.menu.columns[1].box.top)
    expect(narrow.menu.columns.map((column: any) => column.label)).toEqual(['Account', 'Profiles'])
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited?.catch(() => undefined) }
    if (dirname(directory) !== temporaryRoot || !basename(directory).startsWith('mousse-profile-footer-')) throw new Error('Refusing cleanup outside the owned profile footer fixture directory')
    rmSync(directory, { recursive: true, force: true })
  }
}, 60000)
