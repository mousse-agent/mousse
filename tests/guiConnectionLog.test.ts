/**
 * Main's connection log (`logs/gui-connection.log`, #1042) holds ids, phases and an error's class and code: never an
 * error's text, which can carry the home folder or a line of the service's output, and never the home folder itself.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeLinkError, GuiConnectionLog } from '../src/main/mms/guiConnectionLog'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the connection log', () => {
  it('writes an error as its class and code, without its text', () => {
    const exited = Object.assign(new Error(`MMS daemon exited before readiness (code 1). Last startup output: Error at ${join(homedir(), '.mousse', 'service.js')}: secret line`), { code: 'service_exited' })
    expect(describeLinkError(exited)).toBe('Error:service_exited')
    expect(describeLinkError(Object.assign(new Error('connect ENOENT \\\\.\\pipe\\mousse'), { code: 'ENOENT' }))).toBe('Error:ENOENT')
    class MmsProtocolError extends Error { code = 'thread_not_found' }
    const notFound = new MmsProtocolError('Thread not found')
    notFound.name = 'MmsProtocolError'
    expect(describeLinkError(notFound)).toBe('MmsProtocolError:thread_not_found')
    // A code that is a sentence is not a code.
    expect(describeLinkError(Object.assign(new Error('x'), { code: 'could not read /home/someone/file' }))).toBe('Error')
    expect(describeLinkError('a string thrown with text')).toBe('string')
  })

  it('replaces the home folder in any text it is given with a placeholder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-gui-log-'))
    dirs.push(dir)
    const log = new GuiConnectionLog(dir)
    const home = homedir()
    log.write('service.failed', { where: join(home, '.mousse', 'mms-startup.log'), upper: home.toUpperCase(), list: [join(home, 'a')] })
    await log.flush()
    const written = readFileSync(log.path, 'utf8')
    expect(written).toContain('<home>')
    expect(written).not.toContain(JSON.stringify(home).slice(1, -1))
    if (process.platform === 'win32') expect(written.toLowerCase()).not.toContain(JSON.stringify(home.toLowerCase()).slice(1, -1))
  })
})
