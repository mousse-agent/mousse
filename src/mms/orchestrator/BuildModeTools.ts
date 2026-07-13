import { spawn } from 'child_process'
import { Type, type Tool } from '@earendil-works/pi-ai'
import type { FileService } from '../files/FileService'
import type { GitService } from '../git/GitService'
import type { LineEditStatsStore } from '../stats/LineEditStatsStore'

const COMMAND_TIMEOUT_MS = 120_000
const MAX_COMMAND_OUTPUT = 32_000

const BLOCKED_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bdel\s+\/s\b/i,
  /\bformat\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i
]

export class BuildModeTools {
  constructor(
    private fileService: FileService,
    private gitService: GitService,
    private lineEditStats?: LineEditStatsStore
  ) {}

  /** Git helpers kept alongside Pi SDK tools (read/bash/edit/write/grep/find/ls). */
  getGitToolDefinitions(): Tool[] {
    return [
      {
        name: 'git_status',
        description: 'Get git status for the project repository.',
        parameters: Type.Object({})
      },
      {
        name: 'git_diff',
        description: 'Get a git diff for one file.',
        parameters: Type.Object({
          path: Type.String({ description: 'Relative file path.' }),
          staged: Type.Optional(Type.Boolean({ description: 'Whether to diff staged changes.' }))
        })
      }
    ]
  }

  /** @deprecated Prefer Pi SDK tools via PiCodingTools; kept for tests/legacy. */
  getToolDefinitions(): Tool[] {
    return [
      {
        name: 'list_dir',
        description: 'List files and directories within the project root.',
        parameters: Type.Object({
          path: Type.Optional(Type.String({ description: 'Relative directory path. Defaults to project root.' }))
        })
      },
      {
        name: 'read_file',
        description: 'Read a text file from the project.',
        parameters: Type.Object({
          path: Type.String({ description: 'Relative file path within the project root.' })
        })
      },
      {
        name: 'write_file',
        description: 'Write text content to a file in the project.',
        parameters: Type.Object({
          path: Type.String({ description: 'Relative file path within the project root.' }),
          content: Type.String({ description: 'Full file contents to write.' })
        })
      },
      ...this.getGitToolDefinitions(),
      {
        name: 'run_command',
        description: 'Run a shell command in the project root for tests or builds.',
        parameters: Type.Object({
          command: Type.String({ description: 'Executable or script name, e.g. npm or node.' }),
          args: Type.Optional(
            Type.Array(Type.String(), { description: 'Command arguments.' })
          )
        })
      }
    ]
  }

  isGitTool(name: string): boolean {
    return this.getGitToolDefinitions().some((tool) => tool.name === name)
  }

  isBuildTool(name: string): boolean {
    return this.getToolDefinitions().some((tool) => tool.name === name)
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    projectRoot: string
  ): Promise<{ text: string; isError: boolean }> {
    try {
      switch (name) {
        case 'list_dir': {
          const path = typeof args.path === 'string' ? args.path : ''
          const entries = await this.fileService.listDir(projectRoot, path)
          return { text: JSON.stringify(entries, null, 2), isError: false }
        }
        case 'read_file': {
          const path = String(args.path ?? '')
          const content = await this.fileService.readFile(projectRoot, path)
          return { text: content, isError: false }
        }
        case 'write_file': {
          const path = String(args.path ?? '')
          const content = String(args.content ?? '')
          const lines = await this.fileService.writeFile(projectRoot, path, content)
          this.lineEditStats?.record('orchestrator', lines)
          return { text: `Wrote ${path}`, isError: false }
        }
        case 'git_status': {
          const status = await this.gitService.getStatus(projectRoot)
          return { text: JSON.stringify(status, null, 2), isError: false }
        }
        case 'git_diff': {
          const path = String(args.path ?? '')
          const staged = args.staged === true
          const diff = await this.gitService.getDiff(projectRoot, path, staged)
          return { text: diff || '(no diff)', isError: false }
        }
        case 'run_command': {
          const command = String(args.command ?? '').trim()
          const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : []
          return await this.runCommand(projectRoot, command, cmdArgs)
        }
        default:
          return { text: `Unknown build tool: ${name}`, isError: true }
      }
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true }
    }
  }

  async runCommand(
    projectRoot: string,
    command: string,
    args: string[] = []
  ): Promise<{ text: string; isError: boolean }> {
    if (!command) {
      return { text: 'Command is required.', isError: true }
    }

    const fullCommand = [command, ...args].join(' ')
    if (BLOCKED_COMMAND_PATTERNS.some((pattern) => pattern.test(fullCommand))) {
      return { text: `Blocked command: ${fullCommand}`, isError: true }
    }

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: projectRoot,
        shell: process.platform === 'win32',
        env: process.env
      })

      let stdout = ''
      let stderr = ''
      let settled = false

      const finish = (text: string, isError: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve({ text: truncateOutput(text), isError })
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (err) => finish(err.message, true))
      child.on('close', (code) => {
        const combined = [stdout, stderr].filter(Boolean).join('\n').trim()
        finish(combined || `(exit code ${code ?? 'unknown'})`, code !== 0)
      })

      const timeout = setTimeout(() => {
        child.kill()
        finish(`${stdout}\n${stderr}\nCommand timed out after ${COMMAND_TIMEOUT_MS}ms`.trim(), true)
      }, COMMAND_TIMEOUT_MS)
    })
  }
}

function truncateOutput(value: string): string {
  return value.length > MAX_COMMAND_OUTPUT
    ? `${value.slice(0, MAX_COMMAND_OUTPUT)}\n...[truncated]`
    : value
}
