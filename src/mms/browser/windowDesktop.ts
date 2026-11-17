import { execFile } from 'node:child_process'

/**
 * Whether the service runs on a desktop a browser window can appear on ("Open in a window"). The window opens on the
 * desktop of the session the service runs in, so it is offered only where that is the person's own:
 * - Windows: any session but 0 (the services' session, which nobody sees). Mousse starts its service at sign-in, in
 *   the person's session; one found in session 0 offers no window.
 * - macOS: a service started over SSH has no screen of the person's; one the app or the sign-in started has.
 * - Linux: the app names its own display with each window it asks for (`BrowserWindowDisplay`).
 * When the session cannot be read, the window is offered, and a window that does not come up says so.
 */
export async function serviceHasDesktop(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, sessionOf: () => Promise<number | undefined> = windowsSessionId): Promise<boolean> {
  if (platform === 'win32') return (await sessionOf()) !== 0
  if (platform === 'darwin') return !env.SSH_CONNECTION && !env.SSH_TTY
  return true
}

let windowsSession: Promise<number | undefined> | undefined

/** The Windows session this process runs in, read once (`tasklist`'s Session# column); undefined when it can't be read. */
export function windowsSessionId(): Promise<number | undefined> {
  windowsSession ??= new Promise((resolve) => {
    execFile('tasklist', ['/FI', `PID eq ${process.pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
      if (error) {
        resolve(undefined)
        return
      }
      resolve(sessionFromTasklist(stdout))
    })
  })
  return windowsSession
}

/** The Session# of `tasklist /FO CSV /NH`'s first row: `"node.exe","1234","Console","1","50,000 K"`. */
export function sessionFromTasklist(output: string): number | undefined {
  const fields = output.trim().split(/\r?\n/)[0]?.match(/"([^"]*)"/g)?.map((field) => field.slice(1, -1))
  const id = fields && fields.length >= 4 ? Number(fields[3]) : Number.NaN
  return Number.isInteger(id) && id >= 0 ? id : undefined
}
