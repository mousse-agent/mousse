import type { ChildProcess } from 'node:child_process'

/**
 * Shared by the daemon and its plain Node Git helpers. Keep all runtime dependencies inside this function so
 * the helper can use the same adapter. Node's Windows spawn job allows descendants to break away silently.
 */
export function windowsGitRuntime(load: NodeJS.Require, koffiPath: string) {
  const ffi = load(koffiPath) as typeof import('koffi')
  const { ChildProcess } = load('node:child_process') as typeof import('node:child_process')
  const { Socket } = load('node:net') as typeof import('node:net')
  const { randomUUID } = load('node:crypto') as typeof import('node:crypto')
  const { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } = load('node:fs') as typeof import('node:fs')
  const { tmpdir } = load('node:os') as typeof import('node:os')
  const { win32: path } = load('node:path') as typeof import('node:path')
  const { getSystemErrorName } = load('node:util') as typeof import('node:util')
  const kernel = ffi.load('kernel32.dll')
  const handle = 'void *'
  const pointerSize = ffi.sizeof(handle)
  const basicLimit = ffi.struct({
    processTime: 'int64_t', jobTime: 'int64_t', flags: 'uint32_t', minWorkingSet: 'size_t', maxWorkingSet: 'size_t',
    activeLimit: 'uint32_t', affinity: 'size_t', priority: 'uint32_t', scheduling: 'uint32_t'
  })
  const extendedLimit = ffi.struct({
    basic: basicLimit, io: ffi.array('uint64_t', 6), processMemory: 'size_t', jobMemory: 'size_t',
    peakProcess: 'size_t', peakJob: 'size_t'
  })
  const accounting = ffi.struct({
    userTime: 'int64_t', kernelTime: 'int64_t', periodUserTime: 'int64_t', periodKernelTime: 'int64_t',
    pageFaults: 'uint32_t', total: 'uint32_t', active: 'uint32_t', terminated: 'uint32_t'
  })
  const startup = ffi.struct({
    cb: 'uint32_t', reserved: handle, desktop: handle, title: handle,
    x: 'uint32_t', y: 'uint32_t', xSize: 'uint32_t', ySize: 'uint32_t', xChars: 'uint32_t', yChars: 'uint32_t',
    fill: 'uint32_t', flags: 'uint32_t', show: 'uint16_t', reservedSize: 'uint16_t', reserved2: handle,
    stdin: handle, stdout: handle, stderr: handle, attributes: handle
  })
  const processInfo = ffi.struct({ process: handle, thread: handle, pid: 'uint32_t', tid: 'uint32_t' })

  const lastError = kernel.func('uint32_t __stdcall GetLastError()')
  const close = kernel.func('int32_t __stdcall CloseHandle(void *)')
  const searchWorkingDirectory = kernel.func('int32_t __stdcall NeedCurrentDirectoryForExePathW(str16)')
  const setHandle = kernel.func('int32_t __stdcall SetHandleInformation(void *, uint32_t, uint32_t)')
  const module = kernel.func('void * __stdcall GetModuleHandleW(str16)')(null)
  const address = kernel.func('void * __stdcall GetProcAddress(void *, str)')
  // Use the host's libuv so descriptors belong to the same Windows CRT as Node's streams.
  const pipeAddress = address(module, 'uv_pipe')
  const osHandleAddress = address(module, 'uv_get_osfhandle')
  const translateAddress = address(module, 'uv_translate_sys_error')
  if (!pipeAddress || !osHandleAddress || !translateAddress) throw failure('Loading the runtime pipe functions')
  // Unnamed, so a second runtime in the same process does not redefine a koffi type name.
  const pipeType = ffi.proto('int', [ffi.out(ffi.pointer('int')), 'int', 'int']) // uv_pipe
  const osHandleType = ffi.proto('void *', ['int']) // uv_get_osfhandle
  const translateType = ffi.proto('int', ['int']) // uv_translate_sys_error
  const createJob = kernel.func('void * __stdcall CreateJobObjectW(void *, str16)')
  const openJob = kernel.func('void * __stdcall OpenJobObjectW(uint32_t, int32_t, str16)')
  const setJob = kernel.func('__stdcall', 'SetInformationJobObject', 'int32_t', [handle, 'int32_t', ffi.pointer(extendedLimit), 'uint32_t'])
  const queryJob = kernel.func('__stdcall', 'QueryInformationJobObject', 'int32_t', [handle, 'int32_t', ffi.out(ffi.pointer(accounting)), 'uint32_t', handle])
  const terminateJob = kernel.func('int32_t __stdcall TerminateJobObject(void *, uint32_t)')
  const initAttributes = kernel.func('int32_t __stdcall InitializeProcThreadAttributeList(void *, uint32_t, uint32_t, _Inout_ size_t *)')
  const updateAttribute = kernel.func('int32_t __stdcall UpdateProcThreadAttribute(void *, uint32_t, size_t, void *, size_t, void *, void *)')
  const deleteAttributes = kernel.func('void __stdcall DeleteProcThreadAttributeList(void *)')
  const createProcess = kernel.func('__stdcall', 'CreateProcessW', 'int32_t', [
    'str16', handle, handle, handle, 'int32_t', 'uint32_t', handle, 'str16', ffi.pointer(startup), ffi.out(ffi.pointer(processInfo))
  ])
  const resume = kernel.func('uint32_t __stdcall ResumeThread(void *)')
  const terminateProcess = kernel.func('int32_t __stdcall TerminateProcess(void *, uint32_t)')
  const wait = kernel.func('uint32_t __stdcall WaitForSingleObject(void *, uint32_t)')
  const exitCode = kernel.func('int32_t __stdcall GetExitCodeProcess(void *, _Out_ uint32_t *)')
  const createFile = kernel.func('void * __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)')

  type Handle = ReturnType<typeof createJob>
  function failure(operation: string, code = lastError()) {
    return Object.assign(new Error(operation + ' failed (Windows error ' + code + ')'), { code: 'EGITWORKER' })
  }

  function job() {
    const name = 'Local\\MousseGit-' + randomUUID()
    const owned = createJob(null, name)
    if (!owned) throw failure('CreateJobObjectW')
    // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, with neither breakaway flag. The handle itself is never inherited.
    if (!setJob(owned, 9, { basic: { flags: 0x2000 } }, ffi.sizeof(extendedLimit))) {
      const error = failure('SetInformationJobObject')
      close(owned)
      throw error
    }
    return { name, owned }
  }

  function active(owned: Handle): number {
    const info = { active: 0 }
    if (!queryJob(owned, 1, info, ffi.sizeof(accounting), null)) throw failure('QueryInformationJobObject')
    return info.active
  }

  function terminate(owned: Handle): void {
    if (!terminateJob(owned, 1)) throw failure('TerminateJobObject')
  }

  // Windows' C runtime command-line quoting, including backslashes before a quote or closing quote.
  function quote(arg: string): string {
    if (arg && !/[\s"]/.test(arg)) return arg
    return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"'
  }

  const isFile = (file: string): boolean => { try { return statSync(file).isFile() } catch { return false } }
  const invalid = (value: Handle): boolean => value == null || ffi.address(value) === BigInt.asUintN(pointerSize * 8, -1n)

  function pipe(writing: boolean, ignored: boolean) {
    const access = writing ? 0x80000000 : 0x40000000 // Git reads stdin, writes stdout/stderr.
    if (ignored) {
      const child = createFile('NUL', access, 3, null, 3, 0, null)
      if (invalid(child)) throw failure('Opening NUL')
      return { child, stream: null, closeChild: () => close(child) }
    }
    const fds = [-1, -1]
    // Only Node's end is overlapped (UV_NONBLOCK_PIPE). Git gets an ordinary synchronous standard handle.
    const status = ffi.call(pipeAddress, pipeType, fds, writing ? 0 : 0x40, writing ? 0x40 : 0)
    if (status) throw failure('Creating Git pipes (' + getSystemErrorName(status) + ')')
    const childFd = fds[writing ? 0 : 1]!
    const parentFd = fds[writing ? 1 : 0]!
    const child = ffi.call(osHandleAddress, osHandleType, childFd) as Handle
    try {
      return { child, stream: new Socket({ fd: parentFd, readable: !writing, writable: writing }), closeChild: () => closeSync(childFd) }
    } catch (error) {
      closeSync(childFd)
      closeSync(parentFd)
      throw error
    }
  }

  type Options = { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: readonly string[]; windowsHide?: boolean; detached?: boolean }

  function launch(file: string, args: readonly string[], options: Options, name: string, handles: readonly Handle[], beforeStart?: () => void) {
    const cwd = path.resolve(options.cwd ?? process.cwd())
    const environment = new Map<string, [string, string]>()
    const env = options.env ?? process.env
    for (const key of Object.keys(env).sort()) {
      const value = env[key]
      if (key.includes('\0') || value?.includes('\0')) throw new TypeError('Git environment contains a null byte')
      if (value !== undefined && !environment.has(key.toUpperCase())) environment.set(key.toUpperCase(), [key, value])
    }
    // The Windows variables libuv restores even when spawn is given a replacement environment.
    for (const key of ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']) {
      const value = process.env[key]
      if (value !== undefined && !environment.has(key)) environment.set(key, [key, value])
    }
    const block = [...environment.keys()].sort().map((key) => environment.get(key)!.join('=')).join('\0') + '\0\0'
    if ([file, ...args, cwd].some((item) => item.includes('\0'))) throw new TypeError('Git command contains a null byte')
    const folders = /[\\/:]/.test(file) ? [cwd] : [
      ...(searchWorkingDirectory('') ? [cwd] : []),
      ...(environment.get('PATH')?.[1].split(';').filter(Boolean) ?? [])
    ]
    let application: string | undefined
    for (const folder of folders) {
      const candidate = path.resolve(cwd, folder.replace(/^"(.*)"$/, '$1'), file)
      application = (path.extname(file) ? [candidate, candidate + '.com', candidate + '.exe'] : [candidate + '.com', candidate + '.exe']).find(isFile)
      if (application) break
    }
    function spawnError(code: string, errno = -4058) {
      return Object.assign(new Error('spawn ' + file + ' ' + code), { code, errno, syscall: 'spawn ' + file, path: file, spawnargs: args })
    }
    if (!application) throw spawnError('ENOENT')

    // Only the daemon owns the job. The spawning process opens it just for CreateProcessW, then closes it before
    // resuming Git. If the daemon went away during creation, this last close kills the still-suspended command.
    const membership = openJob(1, 0, name) // JOB_OBJECT_ASSIGN_PROCESS
    if (!membership) throw failure('OpenJobObjectW')
    const size = [0]
    initAttributes(null, 2, 0, size)
    const attributes = Buffer.alloc(size[0]!)
    let initialized = false
    const info: { process: Handle; thread: Handle; pid: number } = { process: null, thread: null, pid: 0 }
    try {
      if (!initAttributes(attributes, 2, 0, size)) throw failure('InitializeProcThreadAttributeList')
      initialized = true
      const inherited = Buffer.alloc(pointerSize * 3)
      const jobs = Buffer.alloc(pointerSize)
      ffi.encode(inherited, handle, handles, 3)
      ffi.encode(jobs, handle, membership)
      // PROC_THREAD_ATTRIBUTE_HANDLE_LIST and PROC_THREAD_ATTRIBUTE_JOB_LIST.
      if (!updateAttribute(attributes, 0, 0x20002, inherited, inherited.length, null, null) ||
          !updateAttribute(attributes, 0, 0x2000d, jobs, jobs.length, null, null)) throw failure('UpdateProcThreadAttribute')
      // EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED, plus CREATE_NEW_PROCESS_GROUP when
      // detached. Hidden unless `windowsHide: false` asks otherwise: CREATE_NO_WINDOW gives Git a console without a
      // window, which hooks and filters it starts share. Never DETACHED_PROCESS: without a console of its own, each
      // console program Git starts would open a new, visible one.
      const hide = options.windowsHide !== false
      const flags = 0x80404 | (options.detached ? 0x200 : 0) | (hide ? 0x08000000 : 0)
      const command = Buffer.from([file, ...args].map(quote).join(' ') + '\0', 'utf16le')
      const environmentBlock = Buffer.from(block, 'utf16le')
      beforeStart?.()
      for (const item of handles) if (!setHandle(item, 1, 1)) throw failure('SetHandleInformation')
      if (!createProcess(application, command, null, null, 1, flags, environmentBlock, cwd, {
        // STARTF_USESTDHANDLES, and STARTF_USESHOWWINDOW with SW_HIDE (show stays 0) when hidden.
        cb: ffi.sizeof(startup), flags: hide ? 0x101 : 0x100,
        stdin: handles[0], stdout: handles[1], stderr: handles[2], attributes
      }, info)) {
        const code = lastError()
        if ([2, 3, 267].includes(code)) throw spawnError('ENOENT')
        const errno = ffi.call(translateAddress, translateType, code) as number
        if (code === 193) throw spawnError(getSystemErrorName(errno), errno)
        throw failure('CreateProcessW', code)
      }
    } finally {
      if (initialized) deleteAttributes(attributes)
      for (const item of handles) setHandle(item, 1, 0)
      close(membership)
    }

    const resumed = resume(info.thread)
    const resumeError = resumed === 0xffffffff ? failure('ResumeThread') : undefined
    close(info.thread)
    if (resumeError) {
      terminateProcess(info.process, 1)
      close(info.process)
      throw resumeError
    }
    return info
  }

  function spawn(file: string, args: readonly string[], options: Options, name: string, beforeStart?: () => void): ChildProcess {
    const pipes: ReturnType<typeof pipe>[] = []
    let info: ReturnType<typeof launch> | undefined
    try {
      for (let fd = 0; fd < 3; fd++) pipes.push(pipe(fd === 0, options.stdio?.[fd] === 'ignore'))
      info = launch(file, args, options, name, pipes.map((item) => item.child), beforeStart)
    } finally {
      for (const item of pipes) {
        item.closeChild()
        if (!info) item.stream?.destroy()
      }
    }
    const { process: processHandle, pid } = info!
    const child = new ChildProcess()
    const [stdin, stdout, stderr] = pipes.map((item) => item.stream)
    Object.assign(child, { stdin, stdout, stderr, stdio: [stdin, stdout, stderr], pid, spawnfile: file, spawnargs: [file, ...args] })
    let exited = false
    let referenced = true
    let timer: NodeJS.Timeout | undefined
    let signal: NodeJS.Signals | null = null
    const outputs = [stdout, stderr].filter((stream) => stream !== null && stream !== undefined)
    let pending = outputs.length
    const maybeClose = (): void => { if (exited && pending === 0) child.emit('close', child.exitCode, child.signalCode) }
    for (const stream of outputs) stream.once('close', () => { pending -= 1; maybeClose() })
    const readExit = (): void => {
      if (wait(processHandle, 0) === 0) {
        const code = [1]
        exitCode(processHandle, code)
        close(processHandle)
        exited = true
        stdin?.destroy()
        Object.assign(child, { exitCode: signal ? null : code[0]!, signalCode: signal })
        child.emit('exit', child.exitCode, child.signalCode)
        for (const stream of outputs) if (stream.readableFlowing === null) stream.resume()
        maybeClose()
        return
      }
      timer = setTimeout(readExit, 5)
      if (!referenced) timer.unref()
    }
    child.ref = () => { referenced = true; timer?.ref() }
    child.unref = () => { referenced = false; timer?.unref() }
    child.kill = (requested = 'SIGTERM') => {
      if (exited || !terminateProcess(processHandle, 1)) return false
      signal = typeof requested === 'string' ? requested : 'SIGTERM'
      Object.assign(child, { killed: true })
      return true
    }
    process.nextTick(() => { child.emit('spawn'); readExit() })
    return child
  }

  /**
   * Final checks that must stay synchronous (for example an index read at mutation admission) cannot drain Node
   * streams while Git runs. Give them file-backed stdio and use the same job assignment as asynchronous Git.
   */
  function spawnSync(file: string, args: readonly string[], options: Options & { input?: string | Buffer; timeout?: number; maxBuffer?: number }) {
    const maxBuffer = options.maxBuffer ?? 1024 * 1024
    const dir = mkdtempSync(path.join(tmpdir(), 'mousse-git-stdio-'))
    const fds: number[] = []
    const ignored: ReturnType<typeof pipe>[] = []
    const opened = (name: string, flags: string): number => {
      const fd = openSync(path.join(dir, name), flags)
      fds.push(fd)
      return fd
    }
    let owned: Handle | undefined
    let root: Handle | undefined
    let status: number | null = null
    let error: NodeJS.ErrnoException | undefined
    let reaped = false
    let stdout = ''
    let stderr = ''
    try {
      const input = options.input !== undefined && options.stdio?.[0] !== 'ignore'
      if (input) writeFileSync(path.join(dir, 'in'), options.input!)
      const out = options.stdio?.[1] === 'ignore' ? undefined : opened('out', 'w+')
      const err = options.stdio?.[2] === 'ignore' ? undefined : opened('err', 'w+')
      const handles = [input ? opened('in', 'r') : undefined, out, err].map((fd, index) => {
        if (fd !== undefined) return ffi.call(osHandleAddress, osHandleType, fd) as Handle
        const nul = pipe(index === 0, true)
        ignored.push(nul)
        return nul.child
      })
      const group = job()
      owned = group.owned
      const info = launch(file, args, options, group.name, handles)
      root = info.process
      const deadline = options.timeout ? Date.now() + options.timeout : Infinity
      for (;;) {
        const waited = wait(root, Math.min(20, Math.max(0, deadline - Date.now())))
        if ((out !== undefined && fstatSync(out).size > maxBuffer) || (err !== undefined && fstatSync(err).size > maxBuffer)) {
          error = syncError('ENOBUFS')
          break
        }
        if (waited === 0) break
        if (waited !== 258) throw failure('WaitForSingleObject')
        if (Date.now() >= deadline) { error = syncError('ETIMEDOUT'); break }
      }
      finishSync(owned)
      reaped = true
      if (!error) {
        const value = [1]
        if (!exitCode(root, value)) throw failure('GetExitCodeProcess')
        status = value[0]!
      }
      const read = (fd: number) => {
        const result = Buffer.alloc(Math.min(maxBuffer, fstatSync(fd).size))
        return result.subarray(0, readSync(fd, result, { position: 0 })).toString('utf8')
      }
      if (out !== undefined) stdout = read(out)
      if (err !== undefined) stderr = read(err)
    } catch (cause) {
      error ??= cause as NodeJS.ErrnoException
    } finally {
      if (owned) {
        if (!reaped) finishSync(owned)
        close(owned)
      }
      if (root) close(root)
      for (const nul of ignored) nul.closeChild()
      for (const fd of fds) closeSync(fd)
      rmSync(dir, { recursive: true, force: true })
    }
    return { status, stdout, stderr, error }
  }

  function syncError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error('spawnSync git ' + code), { code, syscall: 'spawnSync git' })
  }

  function finishSync(owned: Handle): void {
    const pause = new Int32Array(new SharedArrayBuffer(4))
    let terminated = false
    for (;;) {
      try {
        if (active(owned) === 0) return
        if (!terminated) { terminate(owned); terminated = true }
      } catch { /* Keep the repository occupied until the job is empty. */ }
      Atomics.wait(pause, 0, 0, 10)
    }
  }

  return { job, active, terminate, close, spawn, spawnSync }
}
