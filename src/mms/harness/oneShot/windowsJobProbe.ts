import { execFile } from 'node:child_process'
import { win32 } from 'node:path'

/**
 * What the sweep of places (`places.ts`) learns about a named Windows job: `missing` (no such object: its last handle
 * closed, and the job is KILL_ON_JOB_CLOSE, so the kernel ended its processes), `empty` (it opens and has no active
 * process), `active`, or `unknown` (any other answer, including a probe that failed). Only `missing` and `empty` are
 * proof that the tree drained.
 */
export type WindowsJobState = 'missing' | 'empty' | 'active' | 'unknown'

const PROBE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$names = @(ConvertFrom-Json $env:MOUSSE_JOB_PROBE_NAMES)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MousseJobProbe {
  [StructLayout(LayoutKind.Sequential)]
  struct JobAccounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }

  [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, out JobAccounting accounting, int size, IntPtr returned);
  [DllImport("kernel32")]
  static extern bool CloseHandle(IntPtr handle);

  public static string Probe(string name) {
    IntPtr job = OpenJobObjectW(0x0004, false, name); // JOB_OBJECT_QUERY
    if (job == IntPtr.Zero) return Marshal.GetLastWin32Error() == 2 ? "missing" : "unknown"; // ERROR_FILE_NOT_FOUND
    try {
      JobAccounting accounting;
      if (!QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(JobAccounting)), IntPtr.Zero)) return "unknown";
      return accounting.ActiveProcesses == 0 ? "empty" : "active";
    } finally {
      CloseHandle(job);
    }
  }
}
'@
foreach ($name in $names) { [Console]::Out.WriteLine([MousseJobProbe]::Probe([string]$name)) }
`

/**
 * Opens each named job and reports its state, in one short PowerShell run. Only for the sweep: never on a start path.
 * Names must be ones Mousse gave; the answer for each is `unknown` when the probe fails.
 */
export function probeWindowsJobs(names: readonly string[], timeoutMs = 30_000): Promise<WindowsJobState[]> {
  if (!names.length) return Promise.resolve([])
  const unknown = names.map((): WindowsJobState => 'unknown')
  if (process.platform !== 'win32') return Promise.resolve(unknown)
  const powershell = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PROBE, 'utf16le').toString('base64')], {
      env: { ...process.env, MOUSSE_JOB_PROBE_NAMES: JSON.stringify(names) },
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    }, (error, stdout) => {
      const lines = String(stdout).split(/\r?\n/).filter(Boolean)
      if (error || lines.length !== names.length) return resolve(unknown)
      resolve(lines.map((line): WindowsJobState => line === 'missing' || line === 'empty' || line === 'active' ? line : 'unknown'))
    })
  })
}
