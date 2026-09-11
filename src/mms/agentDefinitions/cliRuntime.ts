import { spawn, type ChildProcess } from 'node:child_process'
import type { CliAgentRuntimePort, AgentRuntimeInput, AgentRuntimeResult } from '../../shared/agents/execution'

export interface CliProcessInvocation {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface CliProcessRuntimeOptions {
  /** Resolve an installed CLI and its supported system-instruction/config flags. */
  resolveInvocation(input: AgentRuntimeInput): CliProcessInvocation | Promise<CliProcessInvocation>
  spawn?: typeof spawn
}

function abortError(): DOMException {
  return new DOMException('Agent process was aborted.', 'AbortError')
}

/**
 * Process adapter for external runtimes. It never concatenates system instructions
 * into the user prompt. The invocation resolver may map the separate systemPrompt
 * to a runtime-supported config file/flag; the default envelope variables are also
 * available to controlled wrappers and fixture executables.
 */
export function createCliProcessRuntime(options: CliProcessRuntimeOptions): CliAgentRuntimePort {
  const spawnProcess = options.spawn ?? spawn
  return {
    async run(input): Promise<AgentRuntimeResult> {
      if (input.signal.aborted) throw abortError()
      const invocation = await options.resolveInvocation(input)
      if (!invocation.command.trim()) throw new Error('CLI invocation command is empty.')
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...invocation.env,
        MOUSSE_AGENT_SYSTEM_PROMPT: input.systemPrompt,
        MOUSSE_AGENT_PROFILE_ID: input.profileId,
        MOUSSE_AGENT_THREAD_ID: input.threadId,
        MOUSSE_AGENT_RUN_ID: input.runId,
        MOUSSE_AGENT_MODEL_PROVIDER: input.model.primary.ref.providerId,
        MOUSSE_AGENT_MODEL_ID: input.model.primary.ref.modelId,
        MOUSSE_AGENT_GRANTS_JSON: JSON.stringify(input.grants)
      }
      const child = spawnProcess(invocation.command, invocation.args, {
        cwd: invocation.cwd ?? input.projectPath,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { stdout += chunk })
      child.stderr?.on('data', (chunk: string) => { stderr += chunk })

      let aborted = false
      const onAbort = (): void => {
        aborted = true
        child.kill()
      }
      input.signal.addEventListener('abort', onAbort, { once: true })
      try {
        child.stdin?.end(input.userMessage)
        const [code, signal] = await waitForExit(child)
        if (aborted || input.signal.aborted) throw abortError()
        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim() || `signal ${signal ?? 'unknown'}`
          throw new Error(`CLI agent exited with code ${String(code)}: ${detail}`)
        }
        return { text: stdout }
      } finally {
        input.signal.removeEventListener('abort', onAbort)
        if (!child.killed && input.signal.aborted) child.kill()
      }
    }
  }
}

function waitForExit(child: ChildProcess): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve([code, signal]))
  })
}
