import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron'

export interface PickExecutableRequest {
  title?: string
  defaultPath?: string
}

const MAX_TEXT = 4096

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= MAX_TEXT && !value.includes('\0') ? value : undefined
}

/**
 * Open-file dialog options for choosing a CLI executable. The request comes from the renderer, so
 * only a string title and default path are taken from it. Windows lists programs (`.exe`) and
 * package-manager shims (`.cmd`/`.bat`, such as npm's `codex.cmd`), which resolve to the program
 * they run (see `resolveWindowsShim`).
 */
export function executableDialogOptions(request: unknown, platform: NodeJS.Platform = process.platform): OpenDialogOptions {
  const input = request && typeof request === 'object' ? (request as Record<string, unknown>) : {}
  const title = text(input.title)
  const defaultPath = text(input.defaultPath)
  return {
    title: title ?? 'Choose the executable',
    buttonLabel: 'Choose',
    ...(defaultPath ? { defaultPath } : {}),
    properties: ['openFile', 'dontAddToRecent'],
    ...(platform === 'win32'
      ? { filters: [{ name: 'Programs', extensions: ['exe', 'cmd', 'bat'] }, { name: 'All files', extensions: ['*'] }] }
      : {})
  }
}

/** The chosen file's absolute path, or null when cancelled. `open` shows the dialog. */
export async function pickExecutable(
  open: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
  request: unknown,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  const result = await open(executableDialogOptions(request, platform))
  return result.canceled ? null : (result.filePaths[0] ?? null)
}
