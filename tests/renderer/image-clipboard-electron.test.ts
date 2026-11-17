/**
 * A picture shown in a thread or a bot's chat can be copied as the picture itself, so other apps paste it: a
 * right-click on any picture offers Copy image (src/main/contextMenu.ts), and a bot picture's own Copy image draws it
 * and hands the main process PNG bytes (src/renderer/lib/copyImage.ts). A real Electron window and the real system
 * clipboard, for every address a picture shows by (`data:`, `blob:`, the app's protocol) and PNG, GIF and WebP. The
 * person's clipboard (text, HTML, RTF, a picture) is put back after the test.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'

type Held = { width: number; height: number; red: number; green: number; blue: number } | null
type Evidence = {
  placed: Record<string, { width: number; height: number }>
  contextMenu: Record<string, { items: string[]; held: Held }>
  copyImage: Record<string, { result: string; held: Held }>
}

/** The picture on the clipboard is the one shown: its own size, and red in the middle. */
function expectPicture(held: Held, size: { width: number; height: number }, where: string) {
  expect(held, where).not.toBeNull()
  expect({ width: held!.width, height: held!.height }, where).toEqual({ width: size.width, height: size.height })
  expect(held!.red, where).toBeGreaterThan(200)
  expect(held!.green, where).toBeLessThan(60)
  expect(held!.blue, where).toBeLessThan(60)
}

it('copies a shown picture to the clipboard as an image, from the right-click menu and from a bot picture\'s Copy image', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-image-clipboard-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    await build({ entryPoints: [resolve('tests/fixtures/image-clipboard/entry.ts')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent' })
    // The app's own preload, so the bot picture's Copy image goes through its real bridge.
    await build({ entryPoints: [resolve('src/preload/index.ts')], outfile: join(directory, 'preload.js'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', external: ['electron'] })
    await build({ entryPoints: [resolve('tests/fixtures/image-clipboard/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    writeFileSync(join(directory, 'page.html'), '<!doctype html><meta charset="utf-8"><body style="margin:0"><script src="entry.js"></script>')
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_IMAGE_CLIPBOARD_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const result = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as Evidence
    expect(Object.keys(result.placed)).toEqual(['png data:', 'png blob:', 'png app protocol', 'gif data:', 'gif blob:', 'webp data:', 'png in a button'])

    for (const [name, size] of Object.entries(result.placed)) {
      // A right-click on the picture offers Copy image, and it puts the picture itself on the clipboard.
      const menu = result.contextMenu[name]
      expect(menu.items, name).toContain('Copy image')
      // A picture is not text: the menu offers nothing to cut or paste.
      expect(menu.items, name).not.toContain('Cut')
      expect(menu.items, name).not.toContain('Paste')
      expectPicture(menu.held, size, `right-click on ${name}`)
    }

    // A bot picture is shown by `data:` or `blob:`; its own Copy image draws it in any format.
    for (const name of ['png data:', 'png blob:', 'gif data:', 'gif blob:', 'webp data:']) {
      expect(result.copyImage[name].result, name).toBe('copied')
      expectPicture(result.copyImage[name].held, result.placed[name], `Copy image on ${name}`)
    }
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected image clipboard fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 60000)
