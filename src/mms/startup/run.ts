import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class StartupCommandError extends Error {
  constructor(
    message: string,
    readonly manualCommand: string
  ) {
    super(message)
    this.name = 'StartupCommandError'
  }
}

export async function runCommand(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: 'utf8',
      windowsHide: true
    })
    return {
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      code: 0
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string | Buffer
      stderr?: string | Buffer
      code?: number | string
    }
    if (typeof err.code === 'number' || typeof err.code === 'string') {
      return {
        stdout: err.stdout?.toString() ?? '',
        stderr: err.stderr?.toString() ?? '',
        code: typeof err.code === 'number' ? err.code : 1
      }
    }
    throw error
  }
}

export function formatManualCommand(command: string, args: string[]): string {
  return [command, ...args]
    .map((part) => (/\s/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
    .join(' ')
}
