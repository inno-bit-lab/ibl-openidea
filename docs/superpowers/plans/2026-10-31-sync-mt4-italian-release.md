# MT-4 Italian Locale, Version 0.3.0 and Final Gate Implementation Plan (upstream sync v0.3.0)

> **For agentic workers:** you are `dev-claude` in Crew team `ibl-openidea`; `rev-codex` reviews and `rev-agy` gives the final review. Translation batches may go to your own sub-agents (disjoint key ranges, one merge by you). Steps use checkbox (`- [ ]`) syntax. Report to `pilot-bridge` with `crew send`, never in your chat.

**Goal:** the port becomes the release: a complete Italian UI on top of every upstream and fork string, version `0.3.0`, the repository passing every `ci.yml` gate on `port/v0.3.0`, a prepared `-s ours` merge that lets the coordinator fast-forward `main` without a force-push, and a release-notes draft.

**Architecture:** the Italian catalogs (`src/platform/locales/it.json`, `text/it.json`) are added only here, so that no earlier PR fails `textCatalog.test.ts` on Italian. The locale plumbing follows upstream's `i18n.ts`, where `LOCALE_NAMES` was removed by #247 and must not return because knip forbids it. The merge commit keeps the old `main` history but takes its tree from the port.

**Tech Stack:** TypeScript (i18n, settings), JSON catalogs, Cargo/pnpm version files, git.

**Spec:** design `docs/superpowers/specs/2026-10-31-upstream-sync-design.md` (sections 2, 5 and 6 are binding), port map `docs/superpowers/specs/2026-10-31-upstream-sync-port-map.md` sections 1.5, 3, 4 and risk 4, release procedure in `docs/superpowers/specs/2026-10-30-release-hardening-design.md` section 4.5. Read them with `git show origin/fix/release-hardening:docs/superpowers/specs/<file>`.

## Global Constraints

- Worktree `C:\projects\development\IBL\ibl-openidea\.ibl-crew-worktree\dev-claude` (bootstrapped in MT-3 Task 0; check that `git config --worktree core.autocrlf` prints `false` and that `core.hooksPath` is the per-worktree hooks dir). Branch `port/mt4-italian-release`; PR into `port/v0.3.0`.
- Early start: while MT-3 waits for review, cut `port/mt4-italian-release` from the current `origin/port/v0.3.0` and translate there (JSON only, no cargo). Switch branches only with a clean tree, and go back to MT-3 when review needs it. Rebase onto `origin/port/v0.3.0` once MT-1 to MT-3 have merged; Tasks 4 to 8 start only then.
- Fork sources, read-only: `origin/fix/release-hardening` at the tip given in the dispatch (at least `0d68ad7`, after the MT-A merge `4f9107f`) (fork `it.json` 392 keys, `text/it.json` 4584 entries) and `origin/fix/rh-mt-b` `86e8498` or later (it carries the review fix `7870140`; once PR #3 merges, read the same code from `origin/fix/release-hardening`).
- Cargo only as `pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo ...`, foreground, `$env:CARGO_TARGET_DIR = 'C:\projects\development\IBL\ibl-openidea\.ibl-crew-worktree\dev-claude\target'`, `$env:CARGO_PROFILE_DEV_DEBUG = 'line-tables-only'`. No `--release`, no local release build, no workspace clippy (CI gates it).
- Owner rules: never push tags, never push `main`, never force-push `port/v0.3.0`. The coordinator merges PRs, fast-forwards `main` and pushes `v0.3.0-N` and `v0.3.0`.
- `src/bindings.ts` regenerated only; `Cargo.lock` only through `cargo update --workspace`, never a bare `cargo update`.
- The pre-commit hook rewrites staged files. Conventional commits in English with `Co-Authored-By`.
- Reviewers: a worktree with `core.autocrlf=true` gives false `format:check` failures. Run MT-1 plan section 3.1 in the reviewer worktree first, or rely on CI for formatting.
- Report: `crew send pilot-bridge -t info "MT-4 <milestone>: <branch>@<sha> <one line>"` at each task end and at least every 30 minutes; final `crew send pilot-bridge -t res -r <dispatch id> --stdin`.

## Review Focus

1. `textCatalog.test.ts` passes for `it` with no stale entries, and `i18n.test.ts` checks `it` keyed parity, placeholders and parameters the same way it checks `zh` (C6).
2. `knip` stays clean: no `LOCALE_NAMES` or `localeDisplayName` comes back.
3. The version is `0.3.0` in exactly `Cargo.toml` (`[workspace.package]`), `package.json`, `src-tauri/tauri.conf.json` and the workspace entries of `Cargo.lock`; no other `Cargo.lock` line changes.
4. `port/release-v0.3.0` has the same tree as `port/v0.3.0`, and both `origin/main` and the newest `v0.2.x` tag are its ancestors.
5. Italian terminology matches the fork's existing catalog (glossary in Task 2), and `{placeholders}` survive unchanged.

## 1. Context and goal

Upstream grew `text/zh.json` from 4481 to 5232 lines between the fork base and `504d859`. Against the final upstream catalog, the fork's `text/it.json` misses 833 entries and holds 187 that are not upstream's: fork strings and stale ones. The keyed catalog misses 63 of upstream's 448 keys. MT-1 to MT-3 add and remove fork strings on top. MT-4 closes the gap, then turns the integration branch into the release.

## 2. Frozen base

Translation start: `origin/port/v0.3.0` at dispatch time. Tasks 4 to 8: `origin/port/v0.3.0` with MT-1, MT-2 and MT-3 merged (the coordinator gives the SHA).

## 3. Solution design

- **Locale plumbing (port map 1.5).** `i18n.ts`: `SUPPORTED_LOCALES = ["en", "it", "zh"]` only (upstream line 36). `schema.ts`: `LocaleId`/`LOCALES` include `"it"`. `behavior.tsx`: option "Italiano (Italian)" with keywords. `runtime.ts`: `root.lang = locale === "zh" ? "zh-CN" : locale`. `textCatalog.test.ts`: `"Italiano (Italian)"` in `UNTRANSLATED` (`"IBLOpenIdea"` is already there from MT-1). The catalogs load through `import.meta.glob` on `./locales/*.json` and `./locales/text/*.json`, so adding the files is enough.
- **Work list, generated rather than estimated.** `node --input-type=module -e` scripts list (a) `text/zh.json` keys missing from `text/it.json`, (b) `text/it.json` keys missing from `text/zh.json` (stale, to remove), (c) `en.json` keys missing from `it.json` and the reverse. The final `text/zh.json` on the rebased branch is the source of truth, because every earlier MT kept it complete.
- **Translation rules.** Keep keys byte-identical; keep `{name}` placeholders, ICU plural and select syntax, `…`, shortcuts and code identifiers; do not translate `IBLOpenIdea` or product names. Follow the terms the fork's `text/it.json` already uses (Git verbs as in the fork catalog, for example "Commit", "Push", "Pull", "Rebase", "Cherry-pick"; "repository"; "branch"). New terms go into the glossary of the delivery.
- **`-s ours` merge** (design section 2). Done on a branch `port/release-v0.3.0` cut from `origin/port/v0.3.0` after MT-4's PR has merged, never through a squash-merged PR.

## 4. Closed allowlist

`src/platform/i18n.ts`, `src/platform/i18n.test.ts`, `src/features/settings/model/schema.ts`, `src/features/settings/pages/behavior.tsx`, `src/features/settings/runtime.ts`, `src/features/settings/__tests__/staging.test.ts`, `src/features/app/__tests__/menuBridge.test.ts` (Italian case only), `src/platform/locales/{it.json, text/it.json}` (new), `src/platform/locales/textCatalog.test.ts` (`UNTRANSLATED` only), `src/platform/locales/{en.json, zh.json, text/zh.json}` (only to fix gaps the earlier MTs left; list each one); `Cargo.toml`, `package.json`, `src-tauri/tauri.conf.json` (`version` only), `Cargo.lock`; `docs/superpowers/**`, `docs/intents/**`, `docs/releases/v0.3.0.md` (new).

## 5. Ordered tasks

### Task 1: Locale plumbing and tests

- [ ] Tests first. `i18n.test.ts`: extend upstream's `describe("catalogs")` to `it`: "have the same keys", "keep the placeholders of source-text templates", "use the same parameters across locales", and "translate source text into non-empty, different text (except approved Italian cognates)" with the fork's cognates list (`release-hardening` i18n.test.ts:22). Replace the fork's "resolves locale tags and display names" with a tags-only case (`it-IT` resolves to `it`). Keep the fork's Italian assertions from `release-hardening` `i18n.test.ts`: in `describe("formatMessage")` the plural `one`/`other` cases, and in `describe("t / locales")` `setLocale("it")`, `t("common.cancel")`, `app.keymap.count`, `tx`, `txTemplate` and the `tx` tag rebuild. `staging.test.ts`: `validateSettings({ appearance: { locale: "it" } })` keeps `it`. `menuBridge.test.ts`: under `setLocale("it")` the menu labels come from `it.json` (`menu.file.save` is "Salva tutto").
- [ ] Implement 3 (locale plumbing) with stub catalogs copied from the fork. Commit (the catalog tests stay red until Task 3).

### Task 2: Keyed catalog `it.json`

- [ ] From the fork's `it.json`: add the keys missing against the final `en.json` (63 upstream keys plus those added by MT-1 to MT-3) and remove keys `en.json` no longer has (for example `menu.vcs.compareWithRevision`).
- [ ] `pnpm exec vitest run src/platform/i18n.test.ts -t "same keys"` passes for `it`. Commit.

### Task 3: Source-text catalog `text/it.json`

- [ ] Generate the work list (3, work list). Remove the stale entries. An entry whose Italian equals its English key (glossary terms such as "Commit" or "Push") fails the cognates test unless it is on the cognates list ported in Task 1: add it there and list every addition in the delivery. Translate the missing ones in batches of about 150 sorted keys; for each batch, check that `node -e` validation finds no placeholder or ICU mismatch before merging. Keep the file sorted as `text/zh.json` is.
- [ ] `pnpm exec vitest run src/platform/locales/textCatalog.test.ts src/platform/i18n.test.ts`: passes for `en`, `zh` and `it` (C6). Commit per batch group; send an `info` with counts (added, removed, remaining) at each commit.

### Task 4: Version 0.3.0 (after the rebase)

- [ ] `0.3.0` in `Cargo.toml` `[workspace.package] version`, `package.json` `version` and `src-tauri/tauri.conf.json` `version`. Run `pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo update --workspace`.
- [ ] `git diff Cargo.lock` changes only `version = "0.3.0"` lines of workspace crates. `git grep -n "0\.1\.29" -- Cargo.toml package.json src-tauri crates src scripts` returns nothing (docs mention v0.1.29 on purpose). Commit.

### Task 5: Docs re-sync

- [ ] Bring the fork docs that changed after MT-1 copied them: `git checkout origin/fix/release-hardening -- docs/superpowers docs/intents` (or `origin/main` if the coordinator says v0.2.x docs landed there). Leave `docs/development/` alone: MT-1 rewrote `parallel-local-dev.md` for the upstream launcher. Then run `pnpm exec oxfmt docs`. Commit.

### Task 6: Final repo-wide gate

- [ ] `pnpm format` across the repository. It should change nothing: commit a rewrite as `style:` only for allowlisted files; if it rewrites anything outside the allowlist, revert it and report the paths to the coordinator. Then `pnpm format:check`, `pnpm knip`, `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- [ ] `cargo test -p openidea --test export_bindings` and `git diff --exit-code src/bindings.ts`; `cargo fmt --all --check`.
- [ ] Push; `gh workflow run ci.yml --repo inno-bit-lab/ibl-openidea --ref port/mt4-italian-release`; green; open the PR. Ask `rev-codex` for review, then `rev-agy` for the final review (through the bridge).
- [ ] After the coordinator merges it: `gh workflow run ci.yml --repo inno-bit-lab/ibl-openidea --ref port/v0.3.0`; every job green (C1).

### Task 7: Release notes draft

- [ ] Write `docs/releases/v0.3.0.md` from the delivery reports of MT-1 to MT-3. Sections: rebuilt on OpenIDEA `504d859` (v0.1.29 plus fixes), with the upstream features gained (native Claude and Codex, ACP Registry, multi-repository Git window, GitHub pull requests tool window #477, notebooks, fonts); fork features kept; fork features replaced by upstream ones (History tab, Compare with Revision, built-in agy and pi); behaviour changes (Update Project runs at once because `showUpdateOptions` defaults to false; agent ids and custom arguments migrated; "Codex" and "Claude Code" now use the native CLIs, so users without `codex` or `claude` on PATH switch to "Codex (ACP)" or "Claude Code (ACP)"; Roots filter and Tag/Reset repo picker removed); upgrade notes (profile migration across the identifier change, in both cases: v0.2.3 already installed, or coming from v0.2.2 or older); known limitations (NOT_VERIFIED items, absolute paths into the old profile).
- [ ] Run the `humanizer` skill on the text, then `pnpm exec oxfmt docs/releases`. Commit.

### Task 8: Prepare the `-s ours` merge (not pushed to `main`)

- [ ] After the coordinator has merged MT-4 into `port/v0.3.0` and C1 is green:

```powershell
git fetch origin --tags
git switch -C port/release-v0.3.0 origin/port/v0.3.0
git merge -s ours --no-ff origin/main -m "chore: merge main history into the v0.3.0 port (tree from port/v0.3.0)"
$tags = git tag -l 'v0.2.*'          # every v0.2.x tag, rc included: version sort would rank v0.2.3-rc.2 above v0.2.3
foreach ($t in $tags) { git merge-base --is-ancestor $t HEAD; if ($LASTEXITCODE) { git merge -s ours --no-ff $t -m "chore: merge $t history into the v0.3.0 port" } }
git diff --exit-code origin/port/v0.3.0 HEAD
git merge-base --is-ancestor origin/main HEAD; if ($LASTEXITCODE) { throw "origin/main is not an ancestor" }
foreach ($t in $tags) { git merge-base --is-ancestor $t HEAD; if ($LASTEXITCODE) { throw "$t is not an ancestor" } }
git push origin port/release-v0.3.0
gh workflow run ci.yml --repo inno-bit-lab/ibl-openidea --ref port/release-v0.3.0
```

- [ ] Report the SHA, the ancestry checks and the CI run. The coordinator fast-forwards `main` with `git push origin port/release-v0.3.0:main` and handles the rc commit and tags.
- [ ] When the coordinator announces `v0.3.0-N`, check `gh release view v0.3.0-N --repo inno-bit-lab/ibl-openidea --json assets` against spec 4.5: NSIS and MSI; two DMGs and two `.app.tar.gz`; AppImage, deb and rpm; a `.sig` per updater bundle; four `openidea-server-*.gz` with `.sha256`; `latest.json` with every platform key (C2).

## 6. Verification (exact commands)

```powershell
pnpm exec vitest run src/platform src/features/settings src/features/app
pnpm typecheck; pnpm lint; pnpm format:check; pnpm knip; pnpm test
pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo test -p openidea --test export_bindings
pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo fmt --all --check
git diff --exit-code src/bindings.ts
git grep -n "0\.1\.29" -- Cargo.toml package.json src-tauri crates src scripts
git grep -n -E "LOCALE_NAMES|localeDisplayName" -- src
git diff --exit-code origin/port/v0.3.0 port/release-v0.3.0
gh run list --repo inno-bit-lab/ibl-openidea --workflow ci.yml --branch port/v0.3.0 -L 1
gh run watch <run id> --repo inno-bit-lab/ibl-openidea --exit-status
```

## 7. Definition of Done

- Tasks 1 to 7 on `port/mt4-italian-release`, reviewed by `rev-codex` and signed off by `rev-agy`, merged by the coordinator; CI green on `port/v0.3.0`.
- `port/release-v0.3.0` pushed with the merge commit, same tree as `port/v0.3.0`, CI green; `main` untouched by you.
- Delivery `res` to `pilot-bridge`: SHAs, PR URL, CI run URLs (MT-4 branch, `port/v0.3.0`, `port/release-v0.3.0`), catalog counts (added, removed, final), the glossary of new terms, outputs of section 6, the release-notes path, the C2 asset check once the rc exists, and NOT_VERIFIED items.

## 8. Acceptance criteria

| Criterion | Verified by |
|---|---|
| C1: every `ci.yml` job green on the final `port/v0.3.0` | Task 6 dispatched run |
| C2: `v0.3.0-N` has every release asset | Task 8 asset check |
| C6: Italian UI complete | `textCatalog.test.ts` and `i18n.test.ts` for `it` |
| Version 0.3.0 everywhere, lock churn minimal | Task 4 diff and grep |
| History kept, no force-push, `v0.2.x` tags valid | Task 8 ancestry checks and tree diff |
| Release notes ready for people | `docs/releases/v0.3.0.md`, humanizer pass |

## 9. Risks and NOT_VERIFIED

- Translation volume (about 900 new entries) is the long pole: start early on the side branch; rebase conflicts stay in the JSON files and resolve by regenerating the work list.
- MT-1 to MT-3 may leave a `text/zh.json` gap that only shows when `it` is added; fix it here and list it.
- C3 (updater from a CI-built v0.2.x to the rc on the owner's PC) and C4 and C5 manual runs belong to the coordinator and the owner; carry them as NOT_VERIFIED unless the delivery reports of MT-2 and MT-3 cover them.
- The release workflow requires the tag to match `tauri.conf.json` (release.yml:31-35). Release candidates use a numeric pre-release version, `0.3.0-N` with tag `v0.3.0-N`, because WiX rejects a non-numeric pre-release such as `0.3.0-rc.1` in the MSI version. The rc commit is the coordinator's.
- If `v0.2.2` or `v0.2.3` is tagged off `fix/release-hardening` rather than `main`, Task 8's second merge makes it an ancestor; check that `origin/main` then still fast-forwards.
