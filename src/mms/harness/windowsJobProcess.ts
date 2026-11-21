import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk'

const requireNative = createRequire(import.meta.url)
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100

function loadJobApi() {
  const ffi: typeof import('koffi') = requireNative('koffi')
  const kernel = ffi.load(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'kernel32.dll'))
  const basicLimits = ffi.struct({
    PerProcessUserTimeLimit: 'int64_t', PerJobUserTimeLimit: 'int64_t', LimitFlags: 'uint32_t',
    MinimumWorkingSetSize: 'size_t', MaximumWorkingSetSize: 'size_t', ActiveProcessLimit: 'uint32_t',
    Affinity: 'uintptr_t', PriorityClass: 'uint32_t', SchedulingClass: 'uint32_t'
  })
  const limits = ffi.struct({
    BasicLimitInformation: basicLimits,
    IoInfo: ffi.array('uint64_t', 6),
    ProcessMemoryLimit: 'size_t', JobMemoryLimit: 'size_t', PeakProcessMemoryUsed: 'size_t', PeakJobMemoryUsed: 'size_t'
  })
  const accounting = ffi.struct({
    TotalUserTime: 'int64_t', TotalKernelTime: 'int64_t', ThisPeriodTotalUserTime: 'int64_t',
    ThisPeriodTotalKernelTime: 'int64_t', TotalPageFaultCount: 'uint32_t', TotalProcesses: 'uint32_t',
    ActiveProcesses: 'uint32_t', TotalTerminatedProcesses: 'uint32_t'
  })
  return {
    create: kernel.func('__stdcall', 'CreateJobObjectW', 'void *', ['void *', 'void *']),
    setLimits: kernel.func('__stdcall', 'SetInformationJobObject', 'int', ['void *', 'int', ffi.pointer(limits), 'uint32_t']),
    openProcess: kernel.func('__stdcall', 'OpenProcess', 'void *', ['uint32_t', 'int', 'uint32_t']),
    assign: kernel.func('__stdcall', 'AssignProcessToJobObject', 'int', ['void *', 'void *']),
    terminate: kernel.func('__stdcall', 'TerminateJobObject', 'int', ['void *', 'uint32_t']),
    query: kernel.func('__stdcall', 'QueryInformationJobObject', 'int', ['void *', 'int', ffi.out(ffi.pointer(accounting)), 'uint32_t', 'void *']),
    close: kernel.func('__stdcall', 'CloseHandle', 'int', ['void *']),
    lastError: kernel.func('__stdcall', 'GetLastError', 'uint32_t', []),
    limitsSize: ffi.sizeof(limits),
    accountingSize: ffi.sizeof(accounting)
  }
}
let jobApi: ReturnType<typeof loadJobApi> | undefined

// The bootstrap cannot run the target before the daemon assigns it to the job and sends its launch over IPC.
// The target inherits the three SDK streams directly. The bootstrap itself uses only the IPC channel.
const bootstrap = `
  const { spawn } = require('node:child_process')
  process.once('disconnect', () => process.exit(1))
  process.once('message', ({ command, args, cwd, env }) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: 'inherit' })
    child.once('spawn', () => process.send(child.pid))
    child.once('error', (error) => { console.error(error.message); process.exit(1) })
    child.once('exit', (code) => process.exit(code ?? 1))
  })
`

export interface WindowsJobProcess {
  child: ChildProcessWithoutNullStreams
  stop(): Promise<void>
}

/** Runs a Windows process and its descendants in a kill-on-close job owned exclusively by this daemon. */
export function spawnWindowsJobProcess({ command, args, cwd, env, signal }: SpawnOptions): WindowsJobProcess {
  signal.throwIfAborted()
  const api = jobApi ??= loadJobApi()
  const failed = (operation: string): Error => new Error(`${operation} failed (Win32 error ${api.lastError()})`)
  const job = api.create(null, null)
  if (!job) throw failed('CreateJobObject')
  let child: ChildProcessWithoutNullStreams | undefined
  try {
    if (!api.setLimits(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, {
      BasicLimitInformation: { LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE }
    }, api.limitsSize)) throw failed('SetInformationJobObject')
    const started = child = spawn(process.execPath, ['-e', bootstrap], {
      env: { SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    }) as ChildProcessWithoutNullStreams
    let resolveExit: () => void
    const exited = new Promise<void>((resolve) => { resolveExit = resolve })
    started.once('exit', () => resolveExit())
    started.once('error', () => { if (!started.pid) resolveExit() })
    if (!started.pid) throw new Error('Windows job bootstrap did not start')
    const target = api.openProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, started.pid)
    if (!target) throw failed('OpenProcess')
    try {
      if (!api.assign(job, target)) throw failed('AssignProcessToJobObject')
    } finally {
      api.close(target)
    }

    let stopping: Promise<void> | undefined
    const stop = (): Promise<void> => stopping ??= (async () => {
      try {
        if (!api.terminate(job, 1)) throw failed('TerminateJobObject')
        for (;;) {
          const counts = { ActiveProcesses: 0 }
          if (!api.query(job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, counts, api.accountingSize, null)) throw failed('QueryInformationJobObject')
          if (counts.ActiveProcesses === 0) break
          await setTimeout(10)
        }
        await exited
      } finally {
        api.close(job)
      }
    })()
    started.send({ command, args, cwd, env }, (error) => {
      if (error && !stopping) started.emit('error', error)
    })
    return { child: started, stop }
  } catch (error) {
    if (child?.connected) child.disconnect()
    child?.kill()
    api.close(job)
    throw error
  }
}
