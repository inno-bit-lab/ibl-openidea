//! One test in its own binary: managed candidates are process-global startup data.
use ide_core::tool_path::{register_managed_dirs, search_path};

#[test]
fn search_path_finds_a_tool_installed_after_startup() {
    let tmp = tempfile::tempdir().unwrap();
    let installed_later = tmp.path().join("gopls/bin");
    // Register before starting application threads or performing any lookup.
    register_managed_dirs(vec![installed_later.clone()]);
    assert!(!std::env::split_paths(&search_path()).any(|path| path == installed_later));

    std::fs::create_dir_all(&installed_later).unwrap();
    let after: Vec<_> = std::env::split_paths(&search_path()).collect();
    assert_eq!(after.first(), Some(&installed_later));
    assert_eq!(after.iter().filter(|path| **path == installed_later).count(), 1);
    assert_eq!(std::env::split_paths(&search_path()).collect::<Vec<_>>(), after);
}
