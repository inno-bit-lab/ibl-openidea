# Local development in parallel worktrees

Run these commands from the worktree root in PowerShell 7. The local scripts require Windows, Visual Studio 2022 with the C++ tools, Rust, Node with TypeScript stripping support and pnpm 11. They locate VS2022 through the Visual Studio Installer's `vswhere.exe`, import `vcvars64.bat`, and put the current user's cargo binaries first on `PATH`.

A fresh worktree installs dependencies with `pnpm install --frozen-lockfile` and creates `dist/` when needed. Each worktree keeps its own `node_modules/` and `target/`. Set `CARGO_TARGET_DIR` to that worktree's absolute `target/` path when coordinating local builds.

## Commands

| Command                                                     | Purpose                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm dev:local`                                            | Prebuild the desktop app in a build slot, then run upstream's development launcher.                     |
| `pwsh -NoProfile -File scripts/local/dev.ps1 -WhatIf`       | Print the identifier, preferred port, seed source and debug level without building or starting the app. |
| `pwsh -NoProfile -File scripts/local/dev.ps1 -FullDebug`    | Use full development debug information instead of `line-tables-only`.                                   |
| `pnpm dev:status`                                           | Show this worktree's development session, including its MCP port after the app starts.                  |
| `pnpm build:local`                                          | Build a local NSIS installer with thin LTO, 16 codegen units and updater artifacts disabled.            |
| `pnpm test:rust -- -p ide-agent`                            | Run a targeted cargo test through a build slot.                                                         |
| `pnpm test:full`                                            | Run the full Vitest suite through a build slot.                                                         |
| `pnpm exec vitest run src/platform`                         | Run targeted frontend tests without taking a build slot.                                                |
| `pwsh -NoProfile -File scripts/local/acceptance.ps1`        | Generate `target/local/acceptance.wsb` and print its absolute path.                                     |
| `pwsh -NoProfile -File scripts/local/acceptance.ps1 -Start` | Generate the Sandbox file and open Windows Sandbox.                                                     |

`build:local` prints the installer path, its size and elapsed time. Its output is `target/release/bundle/nsis/IBLOpenIdea_<version>_x64-setup.exe`. It uses `src-tauri/tauri.local.conf.json`; the committed release configuration and versions stay unchanged. The local installer does not need an updater signing key. Run release builds only when the current mandate authorizes them; the v0.3.0 port uses CI for release builds.

## Build slots and resource limits

Cargo commands and the full frontend suite use one of two named mutexes, `Local\ibl-openidea-cargo-0` and `Local\ibl-openidea-cargo-1`. A third caller waits. `CARGO_BUILD_JOBS` defaults to the processor count divided by the slot count, rounded down to at least one; an existing value is preserved.

Use the wrapper for cargo build, test and clippy commands:

```powershell
pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo test -p openidea --test export_bindings
pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo clippy -p openidea --all-targets -- -D warnings
```

The wrapper accepts `-Slots <K>` and `-Name <mutex-prefix>` before `--`:

```powershell
pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -Slots 1 -- cargo build -p openidea
```

Agree on K before starting parallel work. Every participant must use the same K and mutex prefix; callers with different limits do not enforce a common maximum. The `pnpm` commands above use K = 2. Use direct wrapper calls for a coordinated run with another K, and do not mix that run with the default commands. Do not wrap `pnpm build:local`, `pnpm test:rust` or `pnpm test:full` in another slot wrapper: those commands already acquire one.

A mutex becomes abandoned when its owner dies, so the next waiter can acquire it. The wrapper releases its mutex on normal completion and preserves the command's exit code. Killing only the wrapper can leave its native child running; when cancelling a build, stop the owned process tree and check that its cargo or test processes have exited. Slot recovery does not prove that a native workload stopped.

`dev:local` holds a slot for its initial cargo build. It releases that slot before starting the long-running development session with `pnpm dev:app`. Keep manual builds and test runs inside the wrapper while dev windows remain open.

## Profiles, ports and seeding

Upstream's `scripts/dev-session.ts` owns the development identifier and preferred Vite port. Its `worktreeId(worktreeRoot)` function hashes the resolved worktree path with FNV-1a and returns `it.innobitlab.iblopenidea.dev.w<hash>`. The Rust debug runtime uses the same identifier. Settings, tools, data, logs and WebView storage follow that identifier; the primary checkout also gets its own path hash.

`preferredVitePort(identifier)` selects a port from the hash. The PowerShell script imports both functions from `scripts/dev-session.ts`; it does not allocate a second port or write an identifier overlay. Before and after the prebuild it checks the preferred port and its neighbour. If either is occupied, it warns that the launcher may choose another Vite port and rebuild `openidea` with the resolved `devUrl`. The launcher owns the Vite listener, session lock and final URL. Use `pnpm dev:status` to inspect the running session.

The prebuild uses `src-tauri/tauri.dev.conf.json` merged with the launcher's `beforeDevCommand` and `devUrl`, passed as compressed `TAURI_CONFIG`. Its cargo package and feature flags match Tauri's development command. The script clears `TAURI_CONFIG` before starting the launcher, which supplies its own config.

By default, `IBLOPENIDEA_SEED_FROM` selects `it.innobitlab.iblopenidea` when that installed profile exists under `%APPDATA%` or `%LOCALAPPDATA%`, otherwise `ai.l0ng.openidea`. To select a source explicitly:

```powershell
pwsh -NoProfile -File scripts/local/dev.ps1 -SeedFrom ai.l0ng.openidea
```

The app seeds the development profile after configuring its runtime identifier. It copies the selected source only when the target profile is absent; it keeps the source. Starting a debug app directly without `IBLOPENIDEA_SEED_FROM` does not seed a profile.

## Optional compile cache

Install `sccache` on the machine and put its executable on `PATH` to enable it. `env.ps1` sets `RUSTC_WRAPPER=sccache` only when sccache is available and no wrapper is already configured. It works without sccache, and every worktree retains its own cargo target directory and lock.

Check cache statistics with `sccache --show-stats` after building in more than one worktree. A useful hit rate for the MSVC and Tauri workload must be measured; the scripts make no guaranteed cache or build-time claim.

## Sandbox acceptance

Build the installer before launching the generated Sandbox file. `acceptance.ps1` maps the absolute `target/release/bundle/nsis` directory read-only to `C:\installers` and opens Explorer there. The generated XML escapes path characters, so spaces, Unicode and `&` in the checkout path do not change the mapping.

Windows Sandbox must be enabled on the machine. Only one Sandbox acceptance run takes place at a time; the integrator owns those runs. Generating a `.wsb` file does not validate installation, updater signatures or profile migration.

## Worktrees and cleanup

Crew member worktrees belong in `<base>/.ibl-crew-worktree/<member>`. Keep `/.ibl-crew-worktree/` in the repository's common `info/exclude`, not in the project's `.gitignore`. Do not nest one member worktree under another. Inspect registered paths with `git worktree list` before removing a worktree.

Close the corresponding dev app and its build or test processes before deleting generated files. `git worktree remove <exact-worktree-path>` removes a clean worktree; it can refuse when generated or untracked files remain. Preserve any source changes first. An obsolete worktree's `target/` can be deleted after verifying its resolved absolute path is inside that exact worktree. Keep active worktrees' target directories: deleting them forces a full rebuild.

Dev profiles are separate from worktrees. Record the identifier using `dev.ps1 -WhatIf` before retiring a worktree. On Windows, inspect that exact `it.innobitlab.iblopenidea.dev.w<hash>` directory under both `%APPDATA%` and `%LOCALAPPDATA%`; deduplicate paths when the platform resolves them to the same location. Delete only that profile after closing its app. Keep installed profiles such as `it.innobitlab.iblopenidea` and `ai.l0ng.openidea`. Avoid a wildcard deletion over `*.dev.*`, because another worktree may still use one of those profiles.
