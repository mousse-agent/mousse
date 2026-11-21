import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { win32 } from 'node:path'

// The supervisor owns the job handle and stays outside it. The kernel assigns the provider to the
// job in CreateProcessW, before it can run, including when the supervisor itself is interrupted.
// Provider stdout/stderr are inherited directly. The supervisor relays stdin so EOF also tells
// it when Mousse closes its side or dies.
const SUPERVISOR = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $launch = ConvertFrom-Json $env:MOUSSE_WINDOWS_PROVIDER_LAUNCH
  Remove-Item Env:MOUSSE_WINDOWS_PROVIDER_LAUNCH
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class MousseProviderJob {
  [StructLayout(LayoutKind.Sequential)]
  struct StartupInfo {
    public int Size;
    public IntPtr Reserved, Desktop, Title;
    public int X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
    public short Show, ReservedCount;
    public IntPtr ReservedData, Input, Output, Error;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct StartupInfoEx {
    public StartupInfo Startup;
    public IntPtr Attributes;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JobLimits {
    public BasicLimits Basic;
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JobAccounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }

  [DllImport("kernel32", SetLastError = true)]
  static extern IntPtr CreateJobObjectW(IntPtr security, IntPtr name);
  [DllImport("kernel32", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimits limits, int size);
  [DllImport("kernel32", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, out JobAccounting accounting, int size, IntPtr returned);
  [DllImport("kernel32", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32")]
  static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity,
    bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
  [DllImport("kernel32", SetLastError = true)]
  static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr security, uint size);
  [DllImport("kernel32")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32")]
  static extern IntPtr GetStdHandle(int stream);
  [DllImport("kernel32", SetLastError = true)]
  static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target,
    uint access, bool inherit, uint options);
  [DllImport("kernel32", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32", SetLastError = true)]
  static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint milliseconds);
  [DllImport("kernel32", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32")]
  static extern bool CloseHandle(IntPtr handle);

  static void Check(bool ok) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
  }

  static IntPtr Inheritable(IntPtr handle) {
    IntPtr result;
    IntPtr self = GetCurrentProcess();
    Check(DuplicateHandle(self, handle, self, out result, 0, true, 2)); // DUPLICATE_SAME_ACCESS
    return result;
  }

  static ProcessInfo Start(string command, IntPtr job, IntPtr reader) {
    var startup = new StartupInfoEx();
    startup.Startup.Size = Marshal.SizeOf(typeof(StartupInfoEx));
    startup.Startup.Flags = 0x100; // STARTF_USESTDHANDLES
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
    startup.Attributes = Marshal.AllocHGlobal(size);
    IntPtr jobList = Marshal.AllocHGlobal(IntPtr.Size);
    IntPtr handleList = Marshal.AllocHGlobal(3 * IntPtr.Size);
    bool initialized = false;
    try {
      Check(InitializeProcThreadAttributeList(startup.Attributes, 2, 0, ref size));
      initialized = true;
      startup.Startup.Input = Inheritable(reader);
      startup.Startup.Output = Inheritable(GetStdHandle(-11));
      startup.Startup.Error = Inheritable(GetStdHandle(-12));
      Marshal.WriteIntPtr(jobList, job);
      Marshal.WriteIntPtr(handleList, 0, startup.Startup.Input);
      Marshal.WriteIntPtr(handleList, IntPtr.Size, startup.Startup.Output);
      Marshal.WriteIntPtr(handleList, 2 * IntPtr.Size, startup.Startup.Error);
      Check(UpdateProcThreadAttribute(startup.Attributes, 0, new IntPtr(0x2000d), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      Check(UpdateProcThreadAttribute(startup.Attributes, 0, new IntPtr(0x20002), handleList, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      ProcessInfo child;
      // EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW. Job is installed before user code executes.
      Check(CreateProcessW(null, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x08080000,
        IntPtr.Zero, null, ref startup, out child));
      CloseHandle(child.Thread);
      return child;
    } finally {
      if (initialized) DeleteProcThreadAttributeList(startup.Attributes);
      Marshal.FreeHGlobal(startup.Attributes);
      Marshal.FreeHGlobal(jobList);
      Marshal.FreeHGlobal(handleList);
      if (startup.Startup.Input != IntPtr.Zero) CloseHandle(startup.Startup.Input);
      if (startup.Startup.Output != IntPtr.Zero) CloseHandle(startup.Startup.Output);
      if (startup.Startup.Error != IntPtr.Zero) CloseHandle(startup.Startup.Error);
    }
  }

  public static int Run(string command) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    Check(job != IntPtr.Zero);
    try {
      var limits = new JobLimits();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Breakaway stays disabled.
      Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(JobLimits))));
      IntPtr reader, writer;
      Check(CreatePipe(out reader, out writer, IntPtr.Zero, 0));
      using (var providerInput = new SafeFileHandle(writer, true)) {
        ProcessInfo child;
        try {
          child = Start(command, job, reader);
        } finally {
          CloseHandle(reader);
        }
        try {
          var eof = new ManualResetEvent(false);
          var input = new Thread(() => {
            try {
              using (var pipe = new FileStream(providerInput, FileAccess.Write, 1, false))
                Console.OpenStandardInput().CopyTo(pipe);
            } catch (IOException) {
              // The provider closed its input.
            } catch (ObjectDisposedException) {
              // The supervisor is draining the job.
            } finally {
              providerInput.Dispose();
              eof.Set();
            }
          });
          input.IsBackground = true;
          input.Start();
          uint ended = WaitForMultipleObjects(2, new[] { child.Process, eof.SafeWaitHandle.DangerousGetHandle() }, false, 0xffffffff);
          if (ended == 1) ended = WaitForSingleObject(child.Process, 1500);
          uint exitCode = 1;
          if (ended == 0) Check(GetExitCodeProcess(child.Process, out exitCode));
          if (!Drain(job, child.ProcessId)) return 254;
          return exitCode < 253 ? (int)exitCode : 1;
        } catch (Exception error) {
          Console.Error.WriteLine(error.Message);
          return Drain(job, child.ProcessId) ? 1 : 254;
        } finally {
          CloseHandle(child.Process);
        }
      }
    } finally {
      CloseHandle(job);
    }
  }

  static bool Drain(IntPtr job, uint root) {
    try {
      var timer = System.Diagnostics.Stopwatch.StartNew();
      var size = Marshal.SizeOf(typeof(JobAccounting));
      JobAccounting accounting;
      Check(QueryInformationJobObject(job, 1, out accounting, size, IntPtr.Zero));
      if (accounting.ActiveProcesses != 0) {
        Check(TerminateJobObject(job, 1));
        do {
          Check(QueryInformationJobObject(job, 1, out accounting, size, IntPtr.Zero));
          if (accounting.ActiveProcesses == 0) return true;
          Thread.Sleep(20);
        } while (timer.ElapsedMilliseconds < 4000);
        throw new TimeoutException(accounting.ActiveProcesses + " process(es) still in the job");
      }
      return true;
    } catch (Exception error) {
      Console.Error.WriteLine("Could not drain the Windows provider job (root " + root + "): " + error.Message);
      return false;
    }
  }
}
'@
  exit [MousseProviderJob]::Run($launch.command)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 253
}
`

function quoteWindowsArgument(argument: string): string {
  return '"' + argument.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"'
}

export interface WindowsProviderTree {
  /** Resolves only when the job reports that every process in it has exited. */
  exited: Promise<void>
  stop(): Promise<void>
}

const jobs = new WeakMap<object, WindowsProviderTree>()

export function windowsProviderTree(child: object): WindowsProviderTree | undefined {
  return jobs.get(child)
}

/** On Windows this returns a supervised child. On other systems the provider is spawned directly. */
export function spawnProviderProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }
): ChildProcessWithoutNullStreams {
  if (process.platform !== 'win32')
    return spawn(command, args, { ...options, windowsHide: true, stdio: 'pipe' })
  options.signal?.throwIfAborted()
  const root = process.env.SystemRoot || 'C:\\Windows'
  const powershell = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const launch = JSON.stringify({ command: [command, ...args].map(quoteWindowsArgument).join(' ') })
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SUPERVISOR, 'utf16le').toString('base64')], {
    cwd: options.cwd,
    env: { ...(options.env ?? process.env), MOUSSE_WINDOWS_PROVIDER_LAUNCH: launch },
    windowsHide: true,
    stdio: 'pipe'
  })
  let stopping: Promise<void> | undefined
  const stop = () => {
    child.stdin.destroy()
    let timer: ReturnType<typeof setTimeout> | undefined
    stopping ??= Promise.race([
      exited,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The Windows provider job did not drain (supervisor PID ' + child.pid + ').')), 8_000)
      })
    ]).finally(() => clearTimeout(timer))
    return stopping
  }
  const abort = () => { void stop().catch(() => undefined) }
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal || code === 253 || code === 254) reject(new Error('The Windows provider supervisor could not confirm job drain.'))
      else resolve()
    })
  })
  const removeAbort = () => options.signal?.removeEventListener('abort', abort)
  void exited.then(removeAbort, removeAbort)
  options.signal?.addEventListener('abort', abort, { once: true })
  child.kill = () => {
    abort()
    return true
  }
  jobs.set(child, { exited, stop })
  return child
}
