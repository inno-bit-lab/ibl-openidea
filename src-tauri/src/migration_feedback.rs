//! Native feedback before the profile and Tauri are opened.

pub use platform::Feedback;

pub fn start(progress: std::sync::Arc<crate::migrate::Progress>) -> Feedback {
    platform::start(progress)
}

#[cfg(not(windows))]
mod platform {
    use crate::migrate::Progress;
    use std::sync::Arc;

    pub struct Feedback;

    pub fn start(_progress: Arc<Progress>) -> Feedback {
        Feedback
    }

    impl Feedback {
        pub fn finish(self) {}

        #[cfg(test)]
        pub(crate) fn worker_ended_flag(&self) -> Arc<std::sync::atomic::AtomicBool> {
            Arc::new(std::sync::atomic::AtomicBool::new(true))
        }
    }
}

#[cfg(windows)]
mod platform {
    use crate::migrate::{Progress, ProgressPhase};
    use std::cell::Cell;
    use std::os::windows::ffi::OsStrExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, OnceLock, mpsc};
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, S_FALSE, S_OK, WPARAM};
    use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal, GetUserDefaultUILanguage};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };
    use windows_sys::Win32::UI::Controls::{
        TASKDIALOGCONFIG, TDCBF_OK_BUTTON, TDE_CONTENT, TDF_CALLBACK_TIMER, TDF_SHOW_MARQUEE_PROGRESS_BAR,
        TDM_CLICK_BUTTON, TDM_ENABLE_BUTTON, TDM_SET_ELEMENT_TEXT, TDM_SET_PROGRESS_BAR_MARQUEE, TDN_BUTTON_CLICKED,
        TDN_CREATED, TDN_TIMER, TaskDialogIndirect,
    };
    use windows_sys::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IDOK,
        IsWindowVisible, SendMessageW, SetForegroundWindow,
    };

    pub struct Feedback {
        progress: Arc<Progress>,
        done: Arc<AtomicBool>,
        stop: Option<mpsc::Sender<()>>,
        exited: Option<mpsc::Receiver<()>>,
        worker: Option<JoinHandle<()>>,
        #[cfg(test)]
        ended: Arc<AtomicBool>,
    }

    pub fn start(progress: Arc<Progress>) -> Feedback {
        let mut feedback = Feedback {
            progress,
            done: Arc::new(AtomicBool::new(false)),
            stop: None,
            exited: None,
            worker: None,
            #[cfg(test)]
            ended: Arc::new(AtomicBool::new(true)),
        };
        if feedback.progress.phase() == ProgressPhase::Done {
            return feedback;
        }
        let (stop, interrupted) = mpsc::channel();
        let (exit, exited) = mpsc::channel();
        let progress = feedback.progress.clone();
        let done = feedback.done.clone();
        #[cfg(test)]
        let ended = feedback.ended.clone();
        #[cfg(test)]
        ended.store(false, Ordering::Release);
        match thread::Builder::new().name("profile-migration-feedback".into()).spawn(move || {
            run(progress, done, interrupted);
            #[cfg(test)]
            ended.store(true, Ordering::Release);
            let _ = exit.send(());
        }) {
            Ok(worker) => {
                feedback.stop = Some(stop);
                feedback.exited = Some(exited);
                feedback.worker = Some(worker);
            }
            Err(error) => {
                feedback.progress.set_feedback_error(format!("could not start feedback thread: {error}"));
                #[cfg(test)]
                feedback.ended.store(true, Ordering::Release);
            }
        }
        feedback
    }

    impl Feedback {
        pub fn finish(mut self) {
            self.done.store(true, Ordering::Release);
            if let Some(stop) = self.stop.take() {
                let _ = stop.send(());
            }
            if let Some(exited) = self.exited.take() {
                match exited.recv_timeout(Duration::from_secs(2)) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                        if let Some(worker) = self.worker.take()
                            && worker.join().is_err()
                        {
                            self.progress.set_feedback_error("feedback thread panicked".into());
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        // Dropping the handle detaches: feedback must never block profile startup.
                        self.progress.set_feedback_error("feedback thread did not end".into());
                    }
                }
            }
        }

        #[cfg(test)]
        pub(crate) fn worker_ended_flag(&self) -> Arc<AtomicBool> {
            self.ended.clone()
        }
    }

    fn run(progress: Arc<Progress>, done: Arc<AtomicBool>, interrupted: mpsc::Receiver<()>) {
        if interrupted.recv_timeout(Duration::from_millis(500)) != Err(mpsc::RecvTimeoutError::Timeout)
            || progress.phase() == ProgressPhase::Done
            || done.load(Ordering::Acquire)
        {
            return;
        }
        // Only this native UI thread changes DPI awareness; Tauri keeps its own bootstrap.
        unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        if progress.phase() == ProgressPhase::WaitingForOtherStart
            && let Some(window) = matching_dialogs().first()
        {
            unsafe { SetForegroundWindow(*window as HWND) };
            let _ = interrupted.recv();
            return;
        }
        let texts = texts();
        let title = wide(texts.title);
        let instruction = wide(texts.instruction);
        let content = wide(&texts.content(&progress));
        let callback = Callback { progress, done, texts, shown: Cell::new(None) };
        let config = TASKDIALOGCONFIG {
            cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
            dwFlags: TDF_SHOW_MARQUEE_PROGRESS_BAR | TDF_CALLBACK_TIMER,
            dwCommonButtons: TDCBF_OK_BUTTON,
            pszWindowTitle: title.as_ptr(),
            pszMainInstruction: instruction.as_ptr(),
            pszContent: content.as_ptr(),
            pfCallback: Some(dialog_callback),
            lpCallbackData: (&callback as *const Callback) as isize,
            ..Default::default()
        };
        // TaskDialogIndirect is synchronous: all strings and callback data outlive its callbacks.
        let result =
            unsafe { TaskDialogIndirect(&config, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) };
        if let Some(shown) = callback.shown.get() {
            callback.progress.set_dialog_shown_ms(shown.elapsed().as_millis().min(u128::from(u64::MAX)) as u64);
        }
        if result != S_OK {
            callback.progress.set_feedback_error(format!("TaskDialogIndirect failed: HRESULT {result:#010x}"));
        }
    }

    struct Callback {
        progress: Arc<Progress>,
        done: Arc<AtomicBool>,
        texts: &'static Texts,
        shown: Cell<Option<Instant>>,
    }

    impl Callback {
        fn finished(&self) -> bool {
            self.done.load(Ordering::Acquire) || self.progress.phase() == ProgressPhase::Done
        }
    }

    unsafe extern "system" fn dialog_callback(
        window: HWND,
        notification: u32,
        _wparam: WPARAM,
        _lparam: LPARAM,
        data: isize,
    ) -> i32 {
        // The synchronous TaskDialogIndirect call owns this context until after destruction.
        let callback = unsafe { &*(data as *const Callback) };
        match notification as i32 {
            TDN_CREATED => {
                callback.shown.set(Some(Instant::now()));
                unsafe {
                    SendMessageW(window, TDM_SET_PROGRESS_BAR_MARQUEE as u32, 1, 0);
                    SendMessageW(window, TDM_ENABLE_BUTTON as u32, IDOK as usize, 0);
                }
            }
            TDN_TIMER => {
                let content = callback.texts.content(&callback.progress);
                let buffer = wide(&content);
                unsafe {
                    SendMessageW(window, TDM_SET_ELEMENT_TEXT as u32, TDE_CONTENT as usize, buffer.as_ptr() as isize)
                };
                callback.progress.set_last_content(content);
                if callback.finished() {
                    unsafe {
                        SendMessageW(window, TDM_ENABLE_BUTTON as u32, IDOK as usize, 1);
                        SendMessageW(window, TDM_CLICK_BUTTON as u32, IDOK as usize, 0);
                    }
                }
            }
            TDN_BUTTON_CLICKED if !callback.finished() => return S_FALSE,
            _ => {}
        }
        S_OK
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    struct WindowSearch {
        title: Vec<u16>,
        executable: Vec<u16>,
        found: Vec<isize>,
    }

    pub(super) fn matching_dialogs() -> Vec<isize> {
        let Ok(executable) = std::env::current_exe() else { return Vec::new() };
        let mut search = WindowSearch {
            title: texts().title.encode_utf16().collect(),
            executable: normalize_path(executable.as_os_str().encode_wide().collect()),
            found: Vec::new(),
        };
        // EnumWindows calls synchronously with this stack-owned context.
        unsafe { EnumWindows(Some(find_dialog), (&mut search as *mut WindowSearch) as isize) };
        search.found
    }

    fn normalize_path(mut path: Vec<u16>) -> Vec<u16> {
        for unit in &mut path {
            if *unit == b'/' as u16 {
                *unit = b'\\' as u16;
            }
        }
        if path.starts_with(&[92, 92, 63, 92]) {
            path.drain(..4);
            if path.starts_with(&[85, 78, 67, 92]) {
                path.splice(..4, [92, 92]);
            }
        }
        path
    }

    unsafe extern "system" fn find_dialog(window: HWND, data: LPARAM) -> i32 {
        let search = unsafe { &mut *(data as *mut WindowSearch) };
        if unsafe { IsWindowVisible(window) } == 0 {
            return 1;
        }
        let mut class = [0u16; 32];
        let length = unsafe { GetClassNameW(window, class.as_mut_ptr(), class.len() as i32) };
        if length != 6 || class[..6] != [35, 51, 50, 55, 55, 48] {
            return 1;
        }
        let length = unsafe { GetWindowTextLengthW(window) };
        if length as usize != search.title.len() {
            return 1;
        }
        let mut title = vec![0u16; length as usize + 1];
        let copied = unsafe { GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32) };
        if copied != length || title[..length as usize] != search.title {
            return 1;
        }
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(window, &mut pid) };
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return 1;
        }
        let mut executable = vec![0u16; 32_768];
        let mut length = executable.len() as u32;
        let queried = unsafe { QueryFullProcessImageNameW(process, 0, executable.as_mut_ptr(), &mut length) };
        unsafe { CloseHandle(process) };
        if queried == 0 {
            return 1;
        }
        executable.truncate(length as usize);
        let executable = normalize_path(executable);
        if unsafe {
            CompareStringOrdinal(
                executable.as_ptr(),
                executable.len() as i32,
                search.executable.as_ptr(),
                search.executable.len() as i32,
                1,
            )
        } == CSTR_EQUAL
        {
            search.found.push(window as isize);
        }
        1
    }

    struct Texts {
        title: &'static str,
        instruction: &'static str,
        copying: &'static str,
        waiting: &'static str,
        publishing: &'static str,
        counter: fn(u64, u64) -> String,
    }

    impl Texts {
        fn content(&self, progress: &Progress) -> String {
            let message = match progress.phase() {
                ProgressPhase::WaitingForOtherStart => self.waiting,
                ProgressPhase::Publishing => self.publishing,
                _ => self.copying,
            };
            format!("{message}\n\n{}", (self.counter)(progress.files(), progress.bytes() / 1_048_576))
        }
    }

    fn texts() -> &'static Texts {
        static SELECTED: OnceLock<&'static Texts> = OnceLock::new();
        SELECTED.get_or_init(|| match unsafe { GetUserDefaultUILanguage() } & 0x3ff {
            0x10 => &ITALIAN,
            0x04 => &CHINESE,
            _ => &ENGLISH,
        })
    }

    static ENGLISH: Texts = Texts {
        title: "IBLOpenIdea: updating your profile",
        instruction: "Copying your settings from the previous version",
        copying: "This happens once, on the first start of this version. IBLOpenIdea opens when it finishes; do not close it.",
        waiting: "Another IBLOpenIdea start is updating your profile. This window closes when it finishes.",
        publishing: "Finishing…",
        counter: |files, mb| format!("{files} files, {mb} MB copied"),
    };
    static ITALIAN: Texts = Texts {
        title: "IBLOpenIdea: aggiornamento del profilo",
        instruction: "Copia delle impostazioni dalla versione precedente",
        copying: "Succede una sola volta, al primo avvio di questa versione. IBLOpenIdea si apre al termine: non chiuderlo.",
        waiting: "Un altro avvio di IBLOpenIdea sta aggiornando il profilo. Questa finestra si chiude al termine.",
        publishing: "Completamento…",
        counter: |files, mb| format!("{files} file, {mb} MB copiati"),
    };
    static CHINESE: Texts = Texts {
        title: "IBLOpenIdea：正在更新配置文件",
        instruction: "正在从旧版本复制设置",
        copying: "此操作仅在首次启动此版本时执行一次。完成后 IBLOpenIdea 将自动打开，请勿关闭。",
        waiting: "另一个 IBLOpenIdea 进程正在更新配置文件。完成后此窗口将关闭。",
        publishing: "正在完成…",
        counter: |files, mb| format!("已复制 {files} 个文件，{mb} MB"),
    };
}

#[cfg(all(test, windows))]
pub(crate) mod testing {
    pub fn dialog_test_guard() -> std::fs::File {
        // Re-exec DPI probes and W3 have the same executable/title under nextest too.
        // This test-only OS lock keeps their native dialogs out of each other's witness.
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(std::env::temp_dir().join("iblopenidea-migration-dialog-tests.lock"))
            .expect("dialog test lock file");
        file.lock().expect("exclusive dialog test lock");
        file
    }

    pub fn visible_dialogs() -> Vec<isize> {
        super::platform::matching_dialogs()
    }

    pub fn request_close(window: isize) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
        unsafe { PostMessageW(window as _, WM_CLOSE, 0, 0) };
    }
}

#[cfg(test)]
mod tests {
    use crate::migrate::{Progress, ProgressPhase};
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    #[cfg(windows)]
    #[test]
    fn helper_thread_dialog_preserves_main_thread_dpi_awareness() {
        use std::process::{Command, Stdio};
        use windows_sys::Win32::Foundation::{GetLastError, SetLastError};
        use windows_sys::Win32::UI::HiDpi::{
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetAwarenessFromDpiAwarenessContext,
            GetThreadDpiAwarenessContext, SetProcessDpiAwarenessContext,
        };

        const CHILD_ENV: &str = "IBLOPENIDEA_MIGRATION_DPI_PROBE";
        const TEST: &str = "migration_feedback::tests::helper_thread_dialog_preserves_main_thread_dpi_awareness";
        if let Ok(mode) = std::env::var(CHILD_ENV) {
            assert!(matches!(mode.as_str(), "control" | "dialog"));
            if mode == "dialog" {
                let progress = Arc::new(Progress::default());
                progress.set_phase(ProgressPhase::Copying);
                let feedback = super::start(progress.clone());
                let ended = feedback.worker_ended_flag();
                let deadline = Instant::now() + Duration::from_secs(5);
                while progress.last_content().is_empty() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                let updated_content = !progress.last_content().is_empty();
                progress.set_phase(ProgressPhase::Done);
                feedback.finish();
                assert!(updated_content, "DPI probe never displayed and updated the native dialog");
                assert!(progress.dialog_shown_ms() > 0);
                assert!(progress.feedback_error().is_none(), "{:?}", progress.feedback_error());
                assert!(ended.load(Ordering::Acquire));
            }
            // Each re-exec has an untouched calling thread, like Tauri after the helper returns.
            let (set_succeeded, last_error, awareness) = unsafe {
                SetLastError(0);
                let result = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                let error = GetLastError();
                let awareness = GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext());
                (result != 0, error, awareness)
            };
            println!(
                "MIGRATION_DPI {}",
                serde_json::json!({"set_succeeded":set_succeeded,"last_error":last_error,"awareness":awareness})
            );
            return;
        }

        let _serial = super::testing::dialog_test_guard();
        let mut records = Vec::new();
        for mode in ["control", "dialog"] {
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--nocapture"])
                .env(CHILD_ENV, mode)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut timed_out = false;
            while child.try_wait().unwrap().is_none() {
                if Instant::now() >= deadline {
                    timed_out = true;
                    child.kill().unwrap();
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let output = child.wait_with_output().unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            eprintln!(
                "MIGRATION_DPI_CHILD mode={mode} status={} timed_out={timed_out}\n{stdout}\n{stderr}",
                output.status
            );
            assert!(!timed_out && output.status.success(), "DPI child {mode} failed");
            let line = stdout.lines().find_map(|line| line.strip_prefix("MIGRATION_DPI ")).expect("DPI record");
            records.push(serde_json::from_str::<serde_json::Value>(line).unwrap());
        }
        assert_eq!(records[0]["set_succeeded"], true, "control cannot establish process DPI awareness");
        assert_eq!(records[0]["awareness"], 2, "control is not per-monitor aware");
        assert_eq!(records[1], records[0], "native feedback changed Tauri's later process-DPI setup");
    }

    #[test]
    fn finish_without_a_migration_returns_at_once() {
        let progress = Arc::new(Progress::default());
        progress.set_phase(ProgressPhase::Done);
        let started = Instant::now();
        let feedback = super::start(progress.clone());
        let ended = feedback.worker_ended_flag();
        feedback.finish();
        let elapsed = started.elapsed();
        eprintln!("MIGRATION_W4 elapsed={elapsed:?} shown_ms={}", progress.dialog_shown_ms());
        assert!(elapsed < Duration::from_millis(50), "no-migration feedback delayed startup: {elapsed:?}");
        assert_eq!(progress.dialog_shown_ms(), 0);
        assert!(progress.feedback_error().is_none());
        assert!(ended.load(Ordering::Acquire), "this feedback worker has not ended");
    }
}
