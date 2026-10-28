//! The per-session helper of Mousse's SSH endpoint on Windows. Mousse's daemon starts it.
//!
//! It is named `sshd.exe` because VS Code's Windows server script walks up its own ancestors until it finds a
//! process of that name, refuses to run without one, and exits when it is gone. Under Win32-OpenSSH that
//! ancestor is sshd's own session process; here it is this helper, one per session.
//!
//! Everything a device starts on this computer runs in one Job object of the device, named
//! `Local\MousseEditor-<scope>` (the scope is the device's marker, lowercase hex the daemon computes). The job has
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and neither breakaway limit: no program in it can start one outside it, so
//! ending the job ends everything the device started, including a server that detached itself (`Start-Process`).
//! A job of that name is used only when the user (or the user's default owner) owns it and its integrity label is
//! not below medium; `keep` and `session` also want the limits above.
//!
//! Every mode checks that its parent is the process id it is given and takes only job names of the form above.
//! That is a check against misuse, not a guard: any program of the user could start the helper as its own child,
//! and the helper never has more rights than the program that started it.
//!
//! - `keep <daemon pid> <name>` makes the device's job (or opens it, if an earlier run of the daemon made it),
//!   prints `ready`, and holds it: a named job lasts only while a handle to it is open, and the daemon's own
//!   handles end with the daemon. The daemon starts it detached, outside its own job, so the keeper outlives it:
//!   it holds the job while the daemon runs (its standard input is a pipe from the daemon) and then until the job
//!   is empty, so a daemon that starts again finds the job by its name.
//! - `session <daemon pid> <name> <command line>` runs the command line exactly as given, in the environment a
//!   fresh logon of the user gets, and exits with the program's exit code. The program is made suspended, outside
//!   the daemon's job, with a copy of the daemon's own token (see `daemon_token`), put in the device's job, and only
//!   then let run. The helper itself stays outside the device's job.
//! - `end <daemon pid> <name>` ends every program in the device's job whatever its limits, waits until they are
//!   gone, and prints how many it ended and how many are left (`<ended> <left>`). A job that does not exist has
//!   nothing to end. A job that holds the calling daemon (one started from an editor's terminal) is not ended.
//! - `list <daemon pid>` prints the scope of every device job that exists in this logon session, one a line: the
//!   daemon ends the jobs of devices that may no longer run anything, without having to know them first.
//! - `drives <daemon pid>` prints the letters of the computer's local drives (not network drives), for SFTP's `/`.

#[cfg(not(windows))]
fn main() {
    eprintln!("mousse: this helper runs on Windows only");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    helper::main()
}

#[cfg(windows)]
mod helper {
    use std::ffi::c_void;
    use std::io::{Read, Write};
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};

    use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
    use windows_sys::Wdk::Storage::FileSystem::{
        NtDuplicateToken, NtOpenDirectoryObject, NtOpenProcessToken, NtQueryDirectoryObject,
        NtQueryInformationToken, NtQuerySecurityObject,
    };
    use windows_sys::Wdk::System::SystemServices::DIRECTORY_QUERY;
    use windows_sys::Win32::Foundation::{
        CloseHandle, FreeLibrary, GetLastError, SetHandleInformation, ERROR_ACCESS_DENIED,
        ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, HANDLE, HANDLE_FLAG_INHERIT,
        INVALID_HANDLE_VALUE, OBJ_CASE_INSENSITIVE, STATUS_NO_MORE_ENTRIES, UNICODE_STRING,
    };
    use windows_sys::Win32::Security::{
        SecurityImpersonation, TokenIntegrityLevel, TokenOwner, TokenPrimary, TokenUser,
        SECURITY_QUALITY_OF_SERVICE, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY,
        TOKEN_DUPLICATE, TOKEN_IMPERSONATE, TOKEN_INFORMATION_CLASS, TOKEN_MANDATORY_LABEL, TOKEN_OWNER,
        TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_C_EVENT,
        STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Environment::GetCommandLineW;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
        JobObjectAssociateCompletionPortInformation, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, OpenJobObjectW, QueryInformationJobObject,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_ASSOCIATE_COMPLETION_PORT,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    };
    use windows_sys::Win32::System::LibraryLoader::{
        GetModuleHandleW, GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
    };
    use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows_sys::Win32::System::Threading::{
        DeleteProcThreadAttributeList, GetCurrentProcess, GetCurrentProcessId, GetExitCodeProcess,
        InitializeProcThreadAttributeList, OpenProcess, ResumeThread, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW,
        CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
        PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
    };
    use windows_sys::Win32::System::IO::{
        CreateIoCompletionPort, GetQueuedCompletionStatus, OVERLAPPED,
    };

    // Job access rights (winnt.h).
    const JOB_OBJECT_ASSIGN_PROCESS: u32 = 0x0001;
    const JOB_OBJECT_QUERY: u32 = 0x0004;
    const JOB_OBJECT_TERMINATE: u32 = 0x0008;
    const READ_CONTROL: u32 = 0x0002_0000;
    // Security information classes and descriptor parts (winnt.h).
    const OWNER_SECURITY_INFORMATION: u32 = 0x1;
    const LABEL_SECURITY_INFORMATION: u32 = 0x10;
    const SE_SACL_PRESENT: u16 = 0x0010;
    const SYSTEM_MANDATORY_LABEL_ACE_TYPE: u8 = 0x11;
    const SECURITY_MANDATORY_MEDIUM_RID: u32 = 0x2000;
    // Drive types (winbase.h).
    const DRIVE_NO_ROOT_DIR: u32 = 1;
    const DRIVE_REMOTE: u32 = 4;

    /// The only job names the helper takes: `Local\MousseEditor-` and a scope (see `is_scope`).
    const NAME_PREFIX: &str = "Local\\MousseEditor-";
    /// The same names as they appear in the session's object folder.
    const OBJECT_PREFIX: &str = "MousseEditor-";
    /// The variable that lists, separated by `;`, the variables of the helper's own environment that the program
    /// gets on top of the logon environment. Nothing else of the helper's environment reaches the program.
    const OVERLAY: &str = "MOUSSE_SSHD_ENV";
    /// What a session exits with when the helper could not start the program, as a shell does.
    const NOT_STARTED: i32 = 127;

    /// A handle that is closed when it goes out of scope.
    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    fn fail(code: i32, message: &str) -> ! {
        let _ = writeln!(std::io::stderr(), "mousse: {message}");
        std::process::exit(code)
    }

    fn last_error() -> u32 {
        unsafe { GetLastError() }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    // ------------------------------------------------------------------ the command line

    fn is_space(c: u16) -> bool {
        c == b' ' as u16 || c == b'\t' as u16
    }

    fn skip_spaces(s: &[u16]) -> &[u16] {
        let start = s.iter().position(|&c| !is_space(c)).unwrap_or(s.len());
        &s[start..]
    }

    /// What follows the program's own name, by the rule Windows uses for the first word of a command line.
    fn after_program(s: &[u16]) -> &[u16] {
        if s.first() == Some(&(b'"' as u16)) {
            match s[1..].iter().position(|&c| c == b'"' as u16) {
                Some(end) => &s[end + 2..],
                None => &[],
            }
        } else {
            let end = s.iter().position(|&c| is_space(c)).unwrap_or(s.len());
            &s[end..]
        }
    }

    /// The next word and what follows it.
    fn word(s: &[u16]) -> (String, &[u16]) {
        let s = skip_spaces(s);
        let end = s.iter().position(|&c| is_space(c)).unwrap_or(s.len());
        (String::from_utf16_lossy(&s[..end]), &s[end..])
    }

    fn own_command_line() -> Vec<u16> {
        unsafe {
            let line = GetCommandLineW();
            let mut length = 0;
            while *line.add(length) != 0 {
                length += 1;
            }
            std::slice::from_raw_parts(line, length).to_vec()
        }
    }

    // ------------------------------------------------------------------ the daemon, tokens and the device's job

    fn parent_pid() -> Option<u32> {
        unsafe {
            let snapshot = Owned(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
            if snapshot.0 == INVALID_HANDLE_VALUE {
                return None;
            }
            let me = GetCurrentProcessId();
            let mut entry: PROCESSENTRY32W = zeroed();
            entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
            let mut more = Process32FirstW(snapshot.0, &mut entry);
            while more != 0 {
                if entry.th32ProcessID == me {
                    return Some(entry.th32ParentProcessID);
                }
                more = Process32NextW(snapshot.0, &mut entry);
            }
            None
        }
    }

    /// A device's marker: 8 to 64 lowercase hex digits.
    fn is_scope(scope: &str) -> bool {
        (8..=64).contains(&scope.len())
            && scope.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }

    /// The daemon's pid, checked to be the parent's (against misuse, see the module's comment).
    fn daemon(rest: &[u16]) -> (u32, &[u16]) {
        let (pid, rest) = word(rest);
        let pid: u32 = pid.parse().unwrap_or(0);
        if pid == 0 || parent_pid() != Some(pid) {
            fail(2, "this helper only runs for the Mousse daemon that started it");
        }
        (pid, rest)
    }

    /// The daemon's pid and the device's job name, checked.
    fn daemon_and_job(rest: &[u16]) -> (u32, String, &[u16]) {
        let (pid, rest) = daemon(rest);
        let (name, rest) = word(rest);
        if !is_scope(name.strip_prefix(NAME_PREFIX).unwrap_or("")) {
            fail(2, "not a device's job");
        }
        (pid, name, rest)
    }

    /// The bytes of a SID: 8, then 4 for each sub-authority.
    unsafe fn sid_bytes(sid: *const u8) -> Vec<u8> {
        let count = *sid.add(1) as usize;
        std::slice::from_raw_parts(sid, 8 + 4 * count).to_vec()
    }

    /// The last sub-authority of a SID: the level of an integrity label.
    fn sid_rid(sid: &[u8]) -> u32 {
        let count = sid.get(1).copied().unwrap_or(0) as usize;
        if count == 0 || sid.len() < 8 + 4 * count {
            return 0;
        }
        let at = 8 + 4 * (count - 1);
        u32::from_le_bytes([sid[at], sid[at + 1], sid[at + 2], sid[at + 3]])
    }

    /// One class of a token's information, in a buffer aligned for the structure it holds.
    fn token_information(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Option<Vec<u64>> {
        unsafe {
            let mut length = 0u32;
            NtQueryInformationToken(token, class, null_mut(), 0, &mut length);
            if length == 0 {
                return None;
            }
            let mut buffer = vec![0u64; (length as usize).div_ceil(8)];
            let status = NtQueryInformationToken(
                token,
                class,
                buffer.as_mut_ptr() as *mut c_void,
                (buffer.len() * 8) as u32,
                &mut length,
            );
            (status >= 0).then_some(buffer)
        }
    }

    /// The user, the default owner and the integrity level of a token.
    struct Identity {
        user: Vec<u8>,
        owner: Vec<u8>,
        integrity: u32,
    }

    fn identity(token: HANDLE) -> Option<Identity> {
        unsafe {
            let user = token_information(token, TokenUser)?;
            let owner = token_information(token, TokenOwner)?;
            let label = token_information(token, TokenIntegrityLevel)?;
            let user = sid_bytes((*(user.as_ptr() as *const TOKEN_USER)).User.Sid as *const u8);
            let owner = sid_bytes((*(owner.as_ptr() as *const TOKEN_OWNER)).Owner as *const u8);
            let label =
                sid_bytes((*(label.as_ptr() as *const TOKEN_MANDATORY_LABEL)).Label.Sid as *const u8);
            Some(Identity { user, owner, integrity: sid_rid(&label) })
        }
    }

    fn own_token(access: u32) -> Owned {
        let mut token: HANDLE = null_mut();
        let status = unsafe { NtOpenProcessToken(GetCurrentProcess(), access, &mut token) };
        if status < 0 {
            fail(NOT_STARTED, &format!("cannot read the user's token (status {status:#x})"));
        }
        Owned(token)
    }

    fn own_identity() -> Identity {
        identity(own_token(TOKEN_QUERY).0)
            .unwrap_or_else(|| fail(NOT_STARTED, "cannot read the user's token"))
    }

    /// A primary token copied from the daemon's own. Windows gives a program named `sshd.exe` the redirection guard
    /// (an Image File Execution Options entry names the image), and what it starts with its own token inherits it:
    /// such a program cannot follow a junction a user made (fnm, Scoop, a pnpm `node_modules`). The daemon's token
    /// has no guard. It is the same user's ordinary token, a sibling of the helper's own in the same logon, so using
    /// it takes no privilege and grants nothing the daemon, a Mousse terminal or a local terminal does not have. It
    /// is checked to be the helper's own user, at no higher integrity than the helper's.
    fn daemon_token(pid: u32, own: &Identity) -> Owned {
        unsafe {
            let process = Owned(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
            if process.0.is_null() {
                fail(NOT_STARTED, &format!("cannot reach the daemon (error {})", last_error()));
            }
            let mut token: HANDLE = null_mut();
            let status = NtOpenProcessToken(process.0, TOKEN_DUPLICATE | TOKEN_QUERY, &mut token);
            if status < 0 {
                fail(NOT_STARTED, &format!("cannot read the daemon's token (status {status:#x})"));
            }
            let token = Owned(token);
            let quality = SECURITY_QUALITY_OF_SERVICE {
                Length: size_of::<SECURITY_QUALITY_OF_SERVICE>() as u32,
                ImpersonationLevel: SecurityImpersonation,
                ContextTrackingMode: 0,
                EffectiveOnly: false,
            };
            let attributes = OBJECT_ATTRIBUTES {
                Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
                RootDirectory: null_mut(),
                ObjectName: null(),
                Attributes: 0,
                SecurityDescriptor: null(),
                SecurityQualityOfService: &quality,
            };
            let mut primary: HANDLE = null_mut();
            let status = NtDuplicateToken(
                token.0,
                TOKEN_QUERY
                    | TOKEN_DUPLICATE
                    | TOKEN_IMPERSONATE
                    | TOKEN_ASSIGN_PRIMARY
                    | TOKEN_ADJUST_DEFAULT
                    | TOKEN_ADJUST_SESSIONID,
                &attributes,
                false,
                TokenPrimary,
                &mut primary,
            );
            if status < 0 {
                fail(NOT_STARTED, &format!("cannot copy the daemon's token (status {status:#x})"));
            }
            let primary = Owned(primary);
            match identity(primary.0) {
                Some(theirs) if theirs.user == own.user && theirs.integrity <= own.integrity => primary,
                _ => fail(NOT_STARTED, "the daemon runs as another user or at a higher level"),
            }
        }
    }

    /// Whether this process's user (or its default owner) owns `job`, and its integrity label is not below medium:
    /// a job of the right name that another account, or a lower-integrity program, made is never used.
    fn owned_by_user(job: HANDLE, own: &Identity) -> bool {
        unsafe {
            let information = OWNER_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION;
            let mut length = 0u32;
            NtQuerySecurityObject(job, information, null_mut(), 0, &mut length);
            if length < 20 {
                return false;
            }
            let mut buffer = vec![0u64; (length as usize).div_ceil(8)];
            if NtQuerySecurityObject(job, information, buffer.as_mut_ptr() as *mut c_void, length, &mut length) < 0 {
                return false;
            }
            // A self-relative descriptor: revision, padding, control, then the offsets of owner, group, SACL, DACL.
            let bytes = std::slice::from_raw_parts(buffer.as_ptr() as *const u8, length as usize);
            let read32 = |at: usize| u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
            let control = u16::from_le_bytes([bytes[2], bytes[3]]);
            let owner_at = read32(4) as usize;
            if owner_at == 0 || owner_at + 8 > bytes.len() {
                return false;
            }
            let owner = sid_bytes(bytes.as_ptr().add(owner_at));
            if owner != own.user && owner != own.owner {
                return false;
            }
            // An object without a label is at medium.
            let mut level = SECURITY_MANDATORY_MEDIUM_RID;
            let sacl_at = read32(12) as usize;
            if control & SE_SACL_PRESENT != 0 && sacl_at != 0 && sacl_at + 8 <= bytes.len() {
                let count = u16::from_le_bytes([bytes[sacl_at + 4], bytes[sacl_at + 5]]) as usize;
                let mut ace = sacl_at + 8;
                for _ in 0..count {
                    if ace + 8 > bytes.len() {
                        break;
                    }
                    let size = u16::from_le_bytes([bytes[ace + 2], bytes[ace + 3]]) as usize;
                    if bytes[ace] == SYSTEM_MANDATORY_LABEL_ACE_TYPE && ace + 16 <= bytes.len() {
                        level = sid_rid(&sid_bytes(bytes.as_ptr().add(ace + 8)));
                    }
                    if size == 0 {
                        break;
                    }
                    ace += size;
                }
            }
            level >= SECURITY_MANDATORY_MEDIUM_RID
        }
    }

    fn limits(job: HANDLE) -> Option<JOBOBJECT_EXTENDED_LIMIT_INFORMATION> {
        unsafe {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            let ok = QueryInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                null_mut(),
            );
            (ok != 0).then_some(info)
        }
    }

    /// The limits `keep` sets: everything in the job ends with it, and nothing in it may leave it.
    fn has_device_limits(job: HANDLE) -> bool {
        limits(job).is_some_and(|info| {
            let flags = info.BasicLimitInformation.LimitFlags;
            flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE != 0
                && flags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) == 0
        })
    }

    /// The device's job, if it exists. It must be the user's; `with_limits` also wants `keep`'s limits (to join it).
    /// Ending does not: a program of the device could change its own job's limits, and the job is ended anyway.
    fn open_job(name: &str, access: u32, own: &Identity, with_limits: bool) -> Option<Owned> {
        let job = unsafe { OpenJobObjectW(access | JOB_OBJECT_QUERY | READ_CONTROL, 0, wide(name).as_ptr()) };
        if job.is_null() {
            if last_error() == ERROR_FILE_NOT_FOUND {
                return None;
            }
            fail(3, &format!("cannot open the device's job (error {})", last_error()));
        }
        let job = Owned(job);
        if !owned_by_user(job.0, own) {
            fail(3, "the device's job belongs to someone else");
        }
        if with_limits && !has_device_limits(job.0) {
            fail(3, "the device's job has the wrong limits");
        }
        Some(job)
    }

    fn active_processes(job: HANDLE) -> u32 {
        unsafe {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
            let ok = QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut c_void,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            );
            if ok == 0 {
                0
            } else {
                info.ActiveProcesses
            }
        }
    }

    fn keep(rest: &[u16]) -> ! {
        let (_, name, _) = daemon_and_job(rest);
        let own = own_identity();
        let job = unsafe {
            let job = Owned(CreateJobObjectW(null(), wide(&name).as_ptr()));
            if job.0.is_null() {
                fail(1, &format!("cannot make the device's job (error {})", last_error()));
            }
            if last_error() == ERROR_ALREADY_EXISTS {
                // An earlier run of the daemon made it, and its keeper still holds it: it is used as it is, if it is
                // the user's and has the limits.
                if !owned_by_user(job.0, &own) {
                    fail(3, "the device's job belongs to someone else");
                }
                if !has_device_limits(job.0) {
                    fail(3, "the device's job has the wrong limits");
                }
            } else {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                // Not JOB_OBJECT_LIMIT_BREAKAWAY_OK or JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK: a program in the job
                // cannot start one outside it, so ending the job finds everything.
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    fail(1, &format!("cannot set the job's limits (error {})", last_error()));
                }
            }
            job
        };
        // Told when the job empties. A job has one completion port at most: if an earlier keeper took it, this one
        // looks every few seconds instead.
        let port = unsafe {
            let port = Owned(CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1));
            let association =
                JOBOBJECT_ASSOCIATE_COMPLETION_PORT { CompletionKey: null_mut(), CompletionPort: port.0 };
            let associated = !port.0.is_null()
                && SetInformationJobObject(
                    job.0,
                    JobObjectAssociateCompletionPortInformation,
                    &association as *const _ as *const c_void,
                    size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
                ) != 0;
            associated.then_some(port)
        };
        println!("ready");
        let _ = std::io::stdout().flush();
        // While the daemon runs, its pipe stays open; when it ends (an exit, a crash or a restart), the read ends.
        let mut sink = [0u8; 64];
        let mut input = std::io::stdin();
        while matches!(input.read(&mut sink), Ok(n) if n > 0) {}
        // Then the job is kept until nothing is left in it.
        while active_processes(job.0) > 0 {
            match &port {
                Some(port) => unsafe {
                    let mut bytes = 0u32;
                    let mut key = 0usize;
                    let mut overlapped: *mut OVERLAPPED = null_mut();
                    GetQueuedCompletionStatus(port.0, &mut bytes, &mut key, &mut overlapped, 5_000);
                },
                None => std::thread::sleep(std::time::Duration::from_secs(5)),
            }
        }
        std::process::exit(0)
    }

    fn end(rest: &[u16]) -> ! {
        let (pid, name, _) = daemon_and_job(rest);
        let own = own_identity();
        let Some(job) = open_job(&name, JOB_OBJECT_TERMINATE, &own, false) else {
            println!("0 0");
            std::process::exit(0)
        };
        // A daemon started from an editor's terminal is in that device's job: ending the job would end Mousse.
        let mut inside = 0;
        let daemon = Owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) });
        if daemon.0.is_null() || unsafe { IsProcessInJob(daemon.0, job.0, &mut inside) } == 0 || inside != 0 {
            println!("0 {}", active_processes(job.0));
            fail(4, "the daemon itself is in this job, which is left alone");
        }
        let ended = active_processes(job.0);
        unsafe { TerminateJobObject(job.0, 1) };
        // A terminated program leaves the job once it is gone: wait for that, for three seconds at most.
        let mut left = active_processes(job.0);
        for _ in 0..150 {
            if left == 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
            left = active_processes(job.0);
        }
        println!("{ended} {left}");
        std::process::exit(0)
    }

    fn drives(rest: &[u16]) -> ! {
        daemon(rest);
        let mask = unsafe { GetLogicalDrives() };
        let mut found = String::new();
        for index in 0..26u32 {
            if mask & (1 << index) == 0 {
                continue;
            }
            let letter = char::from(b'A' + index as u8);
            // A network drive can take many seconds to answer, and its files are another computer's.
            let kind = unsafe { GetDriveTypeW(wide(&format!("{letter}:\\")).as_ptr()) };
            if kind != DRIVE_REMOTE && kind != DRIVE_NO_ROOT_DIR {
                found.push(letter);
            }
        }
        println!("{found}");
        std::process::exit(0)
    }

    /// One entry of an object folder (`OBJECT_DIRECTORY_INFORMATION`).
    #[repr(C)]
    struct FolderEntry {
        name: UNICODE_STRING,
        kind: UNICODE_STRING,
    }

    fn text_of(value: &UNICODE_STRING) -> String {
        if value.Buffer.is_null() {
            return String::new();
        }
        let units = unsafe { std::slice::from_raw_parts(value.Buffer, value.Length as usize / 2) };
        String::from_utf16_lossy(units)
    }

    fn list(rest: &[u16]) -> ! {
        daemon(rest);
        let mut session = 0u32;
        unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) };
        // `Local\` names live in the logon session's own folder of named objects.
        let path = if session == 0 {
            "\\BaseNamedObjects".to_string()
        } else {
            format!("\\Sessions\\{session}\\BaseNamedObjects")
        };
        let mut wide_path: Vec<u16> = path.encode_utf16().collect();
        let bytes = (wide_path.len() * 2) as u16;
        let name = UNICODE_STRING { Length: bytes, MaximumLength: bytes, Buffer: wide_path.as_mut_ptr() };
        let attributes = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: null_mut(),
            ObjectName: &name,
            Attributes: OBJ_CASE_INSENSITIVE,
            SecurityDescriptor: null(),
            SecurityQualityOfService: null(),
        };
        let mut folder: HANDLE = null_mut();
        let status = unsafe { NtOpenDirectoryObject(&mut folder, DIRECTORY_QUERY, &attributes) };
        if status < 0 {
            fail(1, &format!("cannot read the session's named objects (status {status:#x})"));
        }
        let folder = Owned(folder);
        let mut buffer = vec![0u64; 8 * 1024];
        let mut context = 0u32;
        let mut first = true;
        let mut out = std::io::stdout().lock();
        loop {
            let mut length = 0u32;
            let status = unsafe {
                NtQueryDirectoryObject(
                    folder.0,
                    buffer.as_mut_ptr() as *mut c_void,
                    (buffer.len() * 8) as u32,
                    false,
                    first,
                    &mut context,
                    &mut length,
                )
            };
            first = false;
            if status == STATUS_NO_MORE_ENTRIES {
                break;
            }
            if status < 0 {
                fail(1, &format!("cannot list the session's named objects (status {status:#x})"));
            }
            let entries = buffer.as_ptr() as *const FolderEntry;
            let mut index = 0;
            loop {
                let entry = unsafe { &*entries.add(index) };
                if entry.name.Buffer.is_null() || entry.name.Length == 0 {
                    break;
                }
                if text_of(&entry.kind) == "Job" {
                    if let Some(scope) = text_of(&entry.name).strip_prefix(OBJECT_PREFIX) {
                        if is_scope(scope) {
                            let _ = writeln!(out, "{scope}");
                        }
                    }
                }
                index += 1;
            }
        }
        let _ = out.flush();
        std::process::exit(0)
    }
    // ------------------------------------------------------------------ a session

    /// The environment a fresh logon of this user gets (the registry's machine and user variables, then the
    /// per-logon ones), with the session's variables from the daemon on top. The helper's own environment is
    /// not passed on.
    fn environment() -> Vec<u16> {
        let mut entries: Vec<Vec<u16>> = Vec::new();
        unsafe {
            // userenv.dll (and what it loads) is needed for this one call: it is loaded for it and let go after, so
            // the helper that then waits for the session's program stays small.
            let library = LoadLibraryExW(wide("userenv.dll").as_ptr(), null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32);
            if library.is_null() {
                fail(NOT_STARTED, &format!("cannot load userenv.dll (error {})", last_error()));
            }
            type Create = unsafe extern "system" fn(*mut *mut c_void, HANDLE, i32) -> i32;
            type Destroy = unsafe extern "system" fn(*const c_void) -> i32;
            let (Some(create), Some(destroy)) = (
                GetProcAddress(library, c"CreateEnvironmentBlock".as_ptr() as *const u8),
                GetProcAddress(library, c"DestroyEnvironmentBlock".as_ptr() as *const u8),
            ) else {
                fail(NOT_STARTED, "userenv.dll has no environment functions")
            };
            let create: Create = std::mem::transmute(create);
            let destroy: Destroy = std::mem::transmute(destroy);
            // The process's own token, opened through ntdll (always loaded) rather than advapi32 (which would stay).
            let mut token: HANDLE = null_mut();
            let status = NtOpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE, &mut token);
            if status < 0 {
                fail(NOT_STARTED, &format!("cannot read the user's token (status {status:#x})"));
            }
            let token = Owned(token);
            let mut block: *mut c_void = null_mut();
            if create(&mut block, token.0, 0) == 0 {
                fail(NOT_STARTED, &format!("cannot build the user's environment (error {})", last_error()));
            }
            let mut at = block as *const u16;
            loop {
                let mut length = 0;
                while *at.add(length) != 0 {
                    length += 1;
                }
                if length == 0 {
                    break;
                }
                entries.push(std::slice::from_raw_parts(at, length).to_vec());
                at = at.add(length + 1);
            }
            destroy(block);
            drop(token);
            FreeLibrary(library);
        }
        // A user variable may name a per-logon one that the block sets after it (`%HomeDrive%%HomePath%` in a
        // module path); a logon ends up with it expanded, so the names the block has are expanded once.
        let known = entries.clone();
        for entry in entries.iter_mut() {
            *entry = expand(entry, &known);
        }
        let names = std::env::var(OVERLAY).unwrap_or_default();
        for name in names.split(';').filter(|name| !name.is_empty() && !name.contains('=')) {
            let Some(value) = std::env::var_os(name) else { continue };
            let wide: Vec<u16> = name.encode_utf16().collect();
            entries.retain(|entry| !same_name(entry, &wide));
            let mut entry = wide;
            entry.push(b'=' as u16);
            entry.extend(value.encode_wide());
            entries.push(entry);
        }
        let mut block: Vec<u16> = Vec::new();
        for entry in entries {
            block.extend(entry);
            block.push(0);
        }
        block.push(0);
        block
    }

    /// `entry` with each `%NAME%` in its value that `known` sets replaced by that value; others are left alone.
    fn expand(entry: &[u16], known: &[Vec<u16>]) -> Vec<u16> {
        let percent = b'%' as u16;
        let start = entry.iter().skip(1).position(|&c| c == b'=' as u16).map_or(entry.len(), |i| i + 2);
        let mut out = entry[..start.min(entry.len())].to_vec();
        let mut rest = &entry[start.min(entry.len())..];
        while let Some(open) = rest.iter().position(|&c| c == percent) {
            out.extend_from_slice(&rest[..open]);
            let after = &rest[open + 1..];
            match after.iter().position(|&c| c == percent) {
                Some(close) if close > 0 => {
                    let name = &after[..close];
                    match known.iter().find(|candidate| same_name(candidate, name)) {
                        Some(found) => out.extend_from_slice(&found[name.len() + 1..]),
                        None => {
                            out.push(percent);
                            out.extend_from_slice(name);
                            out.push(percent);
                        }
                    }
                    rest = &after[close + 1..];
                }
                _ => {
                    out.push(percent);
                    rest = after;
                }
            }
        }
        out.extend_from_slice(rest);
        out
    }

    /// Whether `entry` (`NAME=value`) sets `name`. Names are not case-sensitive; one may start with `=` (`=C:`).
    fn same_name(entry: &[u16], name: &[u16]) -> bool {
        let end = entry.iter().skip(1).position(|&c| c == b'=' as u16).map_or(entry.len(), |i| i + 1);
        let upper = |c: u16| if (b'a' as u16..=b'z' as u16).contains(&c) { c - 32 } else { c };
        end == name.len() && entry[..end].iter().zip(name).all(|(&a, &b)| upper(a) == upper(b))
    }

    /// Ctrl+C and Ctrl+Break on a terminal are for the program, not the helper. A handler of its own (unlike
    /// ignoring them outright) is not inherited by the program.
    unsafe extern "system" fn keep_running(event: u32) -> i32 {
        (event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT) as i32
    }

    type CreateAsUser = unsafe extern "system" fn(
        HANDLE,
        *const u16,
        *mut u16,
        *const c_void,
        *const c_void,
        i32,
        u32,
        *const c_void,
        *const u16,
        *const STARTUPINFOW,
        *mut PROCESS_INFORMATION,
    ) -> i32;

    /// `CreateProcessAsUserW`, from kernel32 where Windows has it (so advapi32 is not loaded for the session's
    /// whole life), else from advapi32.
    fn create_as_user() -> CreateAsUser {
        unsafe {
            let name = c"CreateProcessAsUserW".as_ptr() as *const u8;
            let mut found = GetProcAddress(GetModuleHandleW(wide("kernel32.dll").as_ptr()), name);
            if found.is_none() {
                let library = LoadLibraryExW(wide("advapi32.dll").as_ptr(), null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32);
                if !library.is_null() {
                    found = GetProcAddress(library, name);
                }
            }
            match found {
                Some(function) => std::mem::transmute::<_, CreateAsUser>(function),
                None => fail(NOT_STARTED, "this Windows has no CreateProcessAsUserW"),
            }
        }
    }

    fn session(rest: &[u16]) -> ! {
        unsafe { SetConsoleCtrlHandler(Some(keep_running), 1) };
        let (pid, name, rest) = daemon_and_job(rest);
        let mut command: Vec<u16> = skip_spaces(rest).to_vec();
        if command.is_empty() {
            fail(NOT_STARTED, "no command");
        }
        command.push(0);
        let own = own_identity();
        // Held while the session lasts: the job stays reachable by its name even if its keeper is gone.
        let Some(job) = open_job(&name, JOB_OBJECT_ASSIGN_PROCESS, &own, true) else {
            fail(NOT_STARTED, "the device's job is gone")
        };
        let token = daemon_token(pid, &own);
        let environment = environment();
        let create = create_as_user();

        unsafe {
            let streams = [
                GetStdHandle(STD_INPUT_HANDLE),
                GetStdHandle(STD_OUTPUT_HANDLE),
                GetStdHandle(STD_ERROR_HANDLE),
            ];
            let mut mode = 0u32;
            // Under a terminal the program shares the helper's console and takes its handles from it; with pipes,
            // the program gets the three pipes and no other handle of the helper.
            let console = streams.iter().any(|&h| !h.is_null() && GetConsoleMode(h, &mut mode) != 0);
            let mut inherited: Vec<HANDLE> = Vec::new();
            if !console {
                for &h in &streams {
                    if !h.is_null() && h != INVALID_HANDLE_VALUE && !inherited.contains(&h) {
                        SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
                        inherited.push(h);
                    }
                }
            }
            let mut startup: STARTUPINFOEXW = zeroed();
            startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
            let mut attributes: Vec<u8> = Vec::new();
            if !inherited.is_empty() {
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = streams[0];
                startup.StartupInfo.hStdOutput = streams[1];
                startup.StartupInfo.hStdError = streams[2];
                let mut size = 0usize;
                InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
                attributes = vec![0u8; size];
                let list = attributes.as_mut_ptr() as *mut c_void;
                if InitializeProcThreadAttributeList(list, 1, 0, &mut size) == 0
                    || UpdateProcThreadAttribute(
                        list,
                        0,
                        PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                        inherited.as_ptr() as *const c_void,
                        inherited.len() * size_of::<HANDLE>(),
                        null_mut(),
                        null(),
                    ) == 0
                {
                    fail(NOT_STARTED, &format!("cannot pass the session's pipes (error {})", last_error()));
                }
                startup.lpAttributeList = list;
            }
            // Made suspended, and outside the daemon's job (Node puts its children in a job of its own that ends
            // with the daemon), then put in the device's job before it runs a single instruction. A program on
            // pipes gets a console of its own with no window. A job above the daemon that allows no breakaway keeps
            // the program in it: then it is made inside, and the device's job is nested under that one.
            let base = CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT
                | CREATE_SUSPENDED
                | if console { 0 } else { CREATE_NO_WINDOW };
            let mut process: PROCESS_INFORMATION = zeroed();
            let mut start = |flags: u32| {
                create(
                    token.0,
                    null(),
                    command.as_mut_ptr(),
                    null(),
                    null(),
                    (!inherited.is_empty()) as i32,
                    flags,
                    environment.as_ptr() as *const c_void,
                    null(),
                    &startup.StartupInfo,
                    &mut process,
                )
            };
            let mut started = start(base | CREATE_BREAKAWAY_FROM_JOB);
            if started == 0 && last_error() == ERROR_ACCESS_DENIED {
                started = start(base);
            }
            let error = last_error();
            if !attributes.is_empty() {
                DeleteProcThreadAttributeList(attributes.as_mut_ptr() as *mut c_void);
            }
            if started == 0 {
                fail(NOT_STARTED, &format!("cannot start the program (error {error})"));
            }
            if AssignProcessToJobObject(job.0, process.hProcess) == 0 {
                let error = last_error();
                TerminateProcess(process.hProcess, NOT_STARTED as u32);
                fail(NOT_STARTED, &format!("cannot put the program in the device's job (error {error})"));
            }
            ResumeThread(process.hThread);
            CloseHandle(process.hThread);
            drop(token);
            // The program holds the pipes now: when it and what it started are done with them, the daemon sees
            // them close, whether or not the helper is still there.
            for &h in &inherited {
                CloseHandle(h);
            }
            WaitForSingleObject(process.hProcess, INFINITE);
            let mut code = 1u32;
            GetExitCodeProcess(process.hProcess, &mut code);
            CloseHandle(process.hProcess);
            drop(job);
            std::process::exit(code as i32)
        }
    }

    pub fn main() {
        let line = own_command_line();
        let (mode, rest) = word(after_program(&line));
        match mode.as_str() {
            "session" => session(rest),
            "keep" => keep(rest),
            "end" => end(rest),
            "list" => list(rest),
            "drives" => drives(rest),
            _ => fail(2, "this helper is started by Mousse's daemon only"),
        }
    }
}
