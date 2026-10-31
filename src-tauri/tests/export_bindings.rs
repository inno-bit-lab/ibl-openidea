//! `cargo test -p openidea --test export_bindings` regenerates `src/bindings.ts`
//! without launching the app (used by `pnpm gen:bindings` and CI drift checks).

#[test]
fn export_bindings() {
    openidea_lib::export_bindings(&openidea_lib::specta_builder()).unwrap();
}

#[test]
fn export_bindings_fails_when_temp_directory_is_invalid() {
    let test_exe = std::env::current_exe().unwrap();
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let blocked_dir = std::env::temp_dir().join(format!("openidea-bindings-blocked-{}-{nonce}", std::process::id()));
    std::fs::write(&blocked_dir, "This file cannot be used as a directory.").unwrap();

    // A separate process avoids changing the temporary directory of parallel tests.
    let output = std::process::Command::new(test_exe)
        .args(["--exact", "export_bindings", "--nocapture"])
        .env("TEMP", &blocked_dir)
        .env("TMP", &blocked_dir)
        .env("TMPDIR", &blocked_dir)
        .output();
    std::fs::remove_file(&blocked_dir).unwrap();
    let output = output.expect("failed to run the bindings export test subprocess");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let diagnostic = format!("{stdout}\n{stderr}");
    assert!(!output.status.success(), "bindings export test passed with an invalid temporary directory: {diagnostic}");
    assert!(diagnostic.contains("failed to export TypeScript bindings"), "unexpected export failure: {diagnostic}");
}
