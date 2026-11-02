//! In-memory latched one-shot test seams for deterministically ordering concurrency races.
#![allow(dead_code)]

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Notify;

#[derive(Clone)]
pub struct ArmHandle {
    reached: Arc<Notify>,
    release: Arc<Notify>,
    is_reached: Arc<std::sync::atomic::AtomicBool>,
    is_released: Arc<std::sync::atomic::AtomicBool>,
}

impl ArmHandle {
    pub async fn wait_reached(&self) {
        if self.is_reached.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        self.reached.notified().await;
    }

    pub fn is_reached(&self) -> bool {
        self.is_reached.load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn release(&self) {
        if !self.is_released.swap(true, std::sync::atomic::Ordering::AcqRel) {
            self.release.notify_waiters();
        }
    }
}

pub struct Pauses {
    arms: Mutex<Vec<ArmHandle>>,
}

impl Default for Pauses {
    fn default() -> Self {
        Self::new()
    }
}

impl Pauses {
    pub fn new() -> Self {
        Self { arms: Mutex::new(Vec::new()) }
    }

    pub fn arm(&self, key: impl AsRef<Path>, name: &str) -> ArmHandle {
        let handle = arm(key, name);
        self.arms.lock().push(handle.clone());
        handle
    }

    pub fn observe(&self, key: impl AsRef<Path>, name: &str) -> ArmHandle {
        let handle = arm(key, name);
        handle.release();
        self.arms.lock().push(handle.clone());
        handle
    }

    pub fn release_all(&self) {
        for arm in self.arms.lock().iter() {
            arm.release();
        }
    }
}

impl Drop for Pauses {
    fn drop(&mut self) {
        self.release_all();
    }
}

static REGISTRY: Mutex<Option<HashMap<(PathBuf, String), ArmHandle>>> = Mutex::new(None);

fn with_registry<R>(f: impl FnOnce(&mut HashMap<(PathBuf, String), ArmHandle>) -> R) -> R {
    let mut guard = REGISTRY.lock();
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    f(guard.as_mut().unwrap())
}

pub fn arm(key: impl AsRef<Path>, name: &str) -> ArmHandle {
    let key = key.as_ref().to_path_buf();
    let name = name.to_string();
    let handle = ArmHandle {
        reached: Arc::new(Notify::new()),
        release: Arc::new(Notify::new()),
        is_reached: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        is_released: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    with_registry(|reg| {
        reg.insert((key, name), handle.clone());
    });
    handle
}

pub async fn point(key: impl AsRef<Path>, name: &str) {
    let key = key.as_ref().to_path_buf();
    let handle = with_registry(|reg| reg.remove(&(key, name.to_string())));
    if let Some(arm) = handle {
        arm.is_reached.store(true, std::sync::atomic::Ordering::Release);
        arm.reached.notify_waiters();
        if !arm.is_released.load(std::sync::atomic::Ordering::Acquire) {
            arm.release.notified().await;
        }
    }
}

pub fn observe(key: impl AsRef<Path>, name: &str) {
    let key = key.as_ref().to_path_buf();
    let handle = with_registry(|reg| reg.remove(&(key, name.to_string())));
    if let Some(arm) = handle {
        arm.is_reached.store(true, std::sync::atomic::Ordering::Release);
        arm.reached.notify_waiters();
    }
}
