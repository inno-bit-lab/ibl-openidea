//! Agent process containment. Other tool processes keep their existing lifetime.

#[cfg(windows)]
pub use windows::ProcessTree;
#[cfg(windows)]
#[doc(hidden)]
pub use windows::{is_process_in_job, terminate_pid, wait_for_pid_exit};

/// Agent containment is intentionally a no-op outside Windows for now.
#[cfg(not(windows))]
pub struct ProcessTree;

#[cfg(not(windows))]
impl ProcessTree {
    pub fn contain(_command: &mut std::process::Command) {}
    pub fn adopt<T>(_child: &T) -> std::io::Result<Self> {
        Ok(Self)
    }
    pub fn kill(&self) {}
}

#[cfg(windows)]
mod windows {
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{
        ERROR_INVALID_PARAMETER, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        CREATE_SUSPENDED, GetProcessId, OpenProcess, OpenThread, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, ResumeThread, THREAD_SUSPEND_RESUME, TerminateProcess,
        WaitForSingleObject,
    };

    /// Owns the job containing one agent and its descendants. Closing its last job
    /// handle also tears the tree down on IDE exit. Explicit breakaway is permitted.
    #[derive(Debug)]
    pub struct ProcessTree {
        job: Option<OwnedHandle>,
        pid: u32,
    }

    #[derive(Default)]
    struct Faults {
        assignment: bool,
        zero_resumes: bool,
    }

    impl ProcessTree {
        /// Call after `process::prepare`: no child code runs before job assignment.
        pub fn contain(command: &mut Command) {
            command.creation_flags(crate::process::CREATE_NO_WINDOW | CREATE_SUSPENDED);
        }

        /// Adopts a live child spawned with `contain`. Its handle stays borrowed
        /// through assignment and resume, preventing PID reuse during either step.
        pub fn adopt(child: &impl AsRawHandle) -> io::Result<Self> {
            Self::adopt_with(child, Faults::default())
        }

        fn adopt_with(child: &impl AsRawHandle, faults: Faults) -> io::Result<Self> {
            let process = child.as_raw_handle();
            // SAFETY: the caller keeps the child handle live for this borrow.
            let pid = unsafe { GetProcessId(process) };
            let job = match assign_job(process, faults.assignment) {
                Ok(job) => Some(job),
                Err(error) => {
                    tracing::warn!(pid, %error, "cannot contain agent process tree; using taskkill fallback");
                    None
                }
            };
            let resumed = resume_threads(pid, faults.zero_resumes);
            if !matches!(resumed, Ok(count) if count > 0) {
                // The suspended process has never executed, so it has no children.
                // SAFETY: live borrowed handle returned by the caller's spawn.
                if unsafe { TerminateProcess(process, 1) } == 0 {
                    tracing::warn!(pid, error = %io::Error::last_os_error(), "cannot terminate unresumed agent");
                }
                return Err(io::Error::other(format!("agent {pid}: no threads resumed: {resumed:?}")));
            }
            Ok(Self { job, pid })
        }

        /// Blocking. Async callers must await `spawn_blocking` before killing the
        /// leader: taskkill needs that live leader to discover its descendants.
        pub fn kill(&self) {
            if let Some(job) = &self.job {
                // SAFETY: this object owns the live job handle with terminate rights.
                if unsafe { TerminateJobObject(job.as_raw_handle(), 1) } == 0 {
                    tracing::warn!(pid = self.pid, error = %io::Error::last_os_error(), "cannot terminate agent job");
                }
                return;
            }
            let system = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
            let mut command = Command::new(std::path::PathBuf::from(system).join("System32/taskkill.exe"));
            crate::process::prepare(&mut command);
            let result = command
                .args(["/T", "/F", "/PID", &self.pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if !matches!(result, Ok(status) if status.success()) {
                tracing::warn!(pid = self.pid, ?result, "agent taskkill fallback failed");
            }
        }
    }

    fn assign_job(process: HANDLE, fail_assignment: bool) -> io::Result<OwnedHandle> {
        // SAFETY: unnamed job, default security, no inherited handle.
        let job = owned(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        // SAFETY: correctly sized POD information and a live owned job handle.
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if fail_assignment {
            return Err(io::Error::other("forced job assignment failure"));
        }
        // SAFETY: the spawned process is still suspended and both handles are live.
        if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    fn resume_threads(pid: u32, force_zero: bool) -> io::Result<usize> {
        if force_zero {
            return Ok(0);
        }
        // SAFETY: the snapshot is owned below; no raw handle escapes this function.
        let snapshot = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })?;
        let mut entry = THREADENTRY32 { dwSize: std::mem::size_of::<THREADENTRY32>() as u32, ..Default::default() };
        let mut resumed = 0;
        // SAFETY: entry points to a correctly sized writable structure.
        let mut more = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } != 0;
        while more {
            if entry.th32OwnerProcessID == pid {
                // SAFETY: access is limited to resuming the recorded child thread.
                if let Ok(thread) = owned(unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) }) {
                    loop {
                        // SAFETY: this scope owns a live thread handle with resume rights.
                        match unsafe { ResumeThread(thread.as_raw_handle()) } {
                            u32::MAX => break,
                            0 | 1 => {
                                resumed += 1;
                                break;
                            }
                            _ => {} // A previous count >1 is still suspended; finish resuming it.
                        }
                    }
                }
            }
            // SAFETY: same live snapshot and writable entry as above.
            more = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } != 0;
        }
        Ok(resumed)
    }

    fn owned(raw: HANDLE) -> io::Result<OwnedHandle> {
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            // SAFETY: callers supply newly created, valid, uniquely owned handles.
            Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
        }
    }

    fn open_process(pid: u32, access: u32) -> io::Result<Option<OwnedHandle>> {
        // SAFETY: no inheritance, access checked by the OS for this recorded PID.
        match owned(unsafe { OpenProcess(access, 0, pid) }) {
            Ok(handle) => Ok(Some(handle)),
            Err(error) if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) => Ok(None),
            Err(error) => Err(error),
        }
    }

    #[doc(hidden)]
    pub fn is_process_in_job(pid: u32) -> io::Result<bool> {
        let process = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION)?
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "process exited"))?;
        let mut in_job = 0;
        // SAFETY: live query handle and writable BOOL, null means any job.
        if unsafe { IsProcessInJob(process.as_raw_handle(), std::ptr::null_mut(), &mut in_job) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(in_job != 0)
        }
    }

    #[doc(hidden)]
    pub fn wait_for_pid_exit(pid: u32, timeout: Duration) -> io::Result<bool> {
        let Some(process) = open_process(pid, PROCESS_SYNCHRONIZE)? else { return Ok(true) };
        let milliseconds = timeout.as_millis().min(u32::MAX as u128 - 1) as u32;
        // SAFETY: live synchronization handle; the timeout is finite.
        match unsafe { WaitForSingleObject(process.as_raw_handle(), milliseconds) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(io::Error::last_os_error()),
        }
    }

    #[doc(hidden)]
    pub fn terminate_pid(pid: u32) -> io::Result<()> {
        let Some(process) = open_process(pid, PROCESS_TERMINATE)? else { return Ok(()) };
        // SAFETY: live terminate handle for the test's recorded PID only.
        if unsafe { TerminateProcess(process.as_raw_handle(), 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::io::{BufRead, Write};
        use std::process::{Child, Command, Stdio};
        use std::sync::{Arc, Mutex, mpsc};
        use std::time::Duration;

        const ROLE: &str = "IBL_CORE_PROCESS_TREE_ROLE";
        const FIXTURE: &str = "process_tree::windows::tests::fixture";

        #[test]
        fn fixture() {
            let Some(role) = std::env::var_os(ROLE) else { return };
            if role == "grandchild" {
                std::thread::sleep(Duration::from_secs(120));
                return;
            }
            assert_eq!(role, "parent");
            let child = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", FIXTURE, "--nocapture"])
                .env(ROLE, "grandchild")
                .stdin(Stdio::null())
                .spawn()
                .unwrap();
            println!("ready {}", child.id());
            std::io::stdout().flush().unwrap();
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).unwrap();
        }

        struct OwnedFixture {
            child: Child,
            grandchild: Option<u32>,
            cwd: tempfile::TempDir,
        }

        impl OwnedFixture {
            fn suspended() -> Self {
                eprintln!("PROCESS_TREE_TEST in_job={:?}", is_process_in_job(std::process::id()).unwrap());
                let cwd = tempfile::tempdir().unwrap();
                let mut cmd = Command::new(std::env::current_exe().unwrap());
                crate::process::prepare(&mut cmd);
                ProcessTree::contain(&mut cmd);
                let child = cmd
                    .args(["--exact", FIXTURE, "--nocapture"])
                    .env(ROLE, "parent")
                    .current_dir(cwd.path())
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap();
                eprintln!("PROCESS_TREE_TEST leader={}", child.id());
                Self { child, grandchild: None, cwd }
            }

            fn ready(&mut self) -> u32 {
                let stdout = self.child.stdout.take().unwrap();
                let (send, receive) = mpsc::channel();
                std::thread::spawn(move || {
                    for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
                        if let Some(pid) = line.strip_prefix("ready ").and_then(|v| v.parse::<u32>().ok()) {
                            let _ = send.send(pid);
                        }
                    }
                });
                let pid = receive.recv_timeout(Duration::from_secs(10)).expect("fixture readiness");
                self.grandchild = Some(pid);
                eprintln!("PROCESS_TREE_TEST grandchild={pid}");
                pid
            }
        }

        impl Drop for OwnedFixture {
            fn drop(&mut self) {
                if let Some(pid) = self.grandchild {
                    let _ = terminate_pid(pid);
                    let _ = wait_for_pid_exit(pid, Duration::from_secs(5));
                }
                let _ = terminate_pid(self.child.id());
                let _ = self.child.wait();
            }
        }

        #[derive(Clone, Default)]
        struct Warnings(Arc<Mutex<Vec<String>>>);

        impl tracing::Subscriber for Warnings {
            fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
                *metadata.level() == tracing::Level::WARN
            }
            fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
                tracing::span::Id::from_u64(1)
            }
            fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
            fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
            fn event(&self, event: &tracing::Event<'_>) {
                struct Message(String);
                impl tracing::field::Visit for Message {
                    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                        if field.name() == "message" {
                            self.0 = format!("{value:?}");
                        }
                    }
                }
                let mut message = Message(String::new());
                event.record(&mut message);
                self.0.lock().unwrap().push(message.0);
            }
            fn enter(&self, _: &tracing::span::Id) {}
            fn exit(&self, _: &tracing::span::Id) {}
        }

        #[test]
        fn assignment_failure_warns_resumes_and_fallback_kills_descendants() {
            let mut fixture = OwnedFixture::suspended();
            let warnings = Warnings::default();
            let tree = tracing::subscriber::with_default(warnings.clone(), || {
                ProcessTree::adopt_with(&fixture.child, Faults { assignment: true, zero_resumes: false })
            })
            .expect("assignment failure must fail open");
            let pid = fixture.ready();
            assert!(!wait_for_pid_exit(pid, Duration::from_millis(100)).unwrap(), "fixture exited before tree kill");
            let captured = warnings.0.lock().unwrap().clone();
            eprintln!("PROCESS_TREE_TEST warnings={captured:?}");
            assert!(captured.iter().any(|line| line.contains("cannot contain agent process tree")));
            tree.kill();
            assert!(wait_for_pid_exit(pid, Duration::from_secs(5)).unwrap(), "grandchild survived fallback");
            fixture.child.wait().unwrap();
            std::fs::remove_dir_all(fixture.cwd.path()).expect("cwd remains locked after fallback");
        }

        #[test]
        fn zero_resumed_threads_terminates_child_and_returns_error() {
            let mut fixture = OwnedFixture::suspended();
            let result = ProcessTree::adopt_with(&fixture.child, Faults { assignment: false, zero_resumes: true });
            assert!(result.is_err(), "zero resumed threads must reject the spawn");
            assert!(wait_for_pid_exit(fixture.child.id(), Duration::from_secs(5)).unwrap(), "child left suspended");
            fixture.child.wait().unwrap();
        }
    }
}
