| File | Esito | Motivazione |
|---|---|---|
| `.github/workflows/release.yml` | to re-apply | Alto: merge testuale pulito; estendere guardia RPM a Linux ARM e condizione manifest; mantenere includeUpdaterJson e skip release pubblicate. |
| `Cargo.lock` | conflict | Medio: 35 conflitti di versione workspace. Conservare tracing/tracing-subscriber fork e nuove dipendenze upstream ide-lsp/ide-run; rigenerare solo dopo versione concordata. |
| `Cargo.toml` | conflict | Basso: versione fork 0.3.0 contro upstream 0.1.30; destinazione prevista 0.3.1. |
| `crates/ide-agent/src/registry.rs` | clean | Medio: fallback binari Windows ARM64 indipendente da extra_args del fork; preservare entrambi. |
| `crates/ide-host/src/ops/agent.rs` | conflict | Alto: require_trust in providers collide con fallback Welcome; integrare complete/set_args con policy esplicita. |
| `crates/ide-host/src/ops/vcs.rs` | to re-apply | Alto: status diventa trust-aware, ignored del fork continua ad applicare Git executable senza guardia; classificare comando e allineare protezione. |
| `crates/ide-host/src/rpc.rs` | clean | Alto: conservare vcs_ignored con dispatcher/gate upstream; protocollo 1 -> 2. La policy va risolta in trust.rs. |
| `crates/ide-host/tests/rpc.rs` | to re-apply | Medio: open_host del fork invia initialize version=1 mentre upstream passa a 2; aggiornare protocollo e trust delle fixture, coprendo restricted. |
| `crates/ide-vcs/src/lib.rs` | to re-apply | Alto: status_with_ignored del fork deve ricevere ExecutionScope come status; non basta il merge pulito. Nuovo TextEncoding va preservato. |
| `crates/ide-vcs/tests/repo.rs` | clean | Medio: unire test ignored/clone fixture fork e nuovi test trust/encoding upstream. |
| `package.json` | conflict | Basso: solo bump versione concorrente; preservare identita del pacchetto fork. |
| `src-tauri/src/commands/mod.rs` | clean | Medio: registrazioni fork agent_complete/set_args/vcs_ignored e nuovi comandi upstream sono additive. |
| `src-tauri/src/commands/vcs.rs` | clean | Medio: mantenere vcs_ignored; accogliere shelf/TextEncoding; controllo accesso nel gate e host. |
| `src-tauri/src/lib.rs` | conflict | Alto: nuovo invoke_handler autorizzante e setup riscritto intorno al notice WebView; mantenere seed profilo prima letture/PATH e avviso dopo creazione main. |
| `src-tauri/src/menu.rs` | clean | Medio: native_menu_bar solo macOS; preservare IBLOpenIdea e vcs.showHistoryForSelection. Questa modifica e #279, non #561. |
| `src-tauri/tauri.conf.json` | conflict | Alto: versione concorrente; mai sostituire identifier, productName, endpoint updater e pubkey fork con upstream. |
| `src/bindings.ts` | to re-apply | Alto: merge testuale pulito ma artifact generato; rigenerare dopo Rust conservando comandi/tipi fork e nuovi trusted/TrustStatus/setting. |
| `src/editor/core/controller.test.ts` | clean | Basso: test menu/history fork e fixture trusted upstream separati. |
| `src/editor/core/controller.ts` | clean | Medio: selezione history fork indipendente da nuovo disk-sync; mantenere entrambi. |
| `src/features/agents/composerCommands.test.tsx` | clean | Basso: fixture upstream trusted si combina con fixture agent fork. |
| `src/features/agents/index.ts` | clean | Medio: sincronizzazione anche su trust-change insieme a catalogo/preset fork; verificare riattivazione e revoca. |
| `src/features/agents/store.ts` | clean | Medio: provider list vuota in restricted con preset/config fork; catalogo Welcome separato va coperto nel task trust. |
| `src/features/debugger/__tests__/javaSeparator.test.ts` | clean | Basso: risultato identico nei due rami, module vuoto gia corretto upstream da 8fe09eba. |
| `src/features/settings/__tests__/staging.test.ts` | clean | Basso: test impostazioni italiani e nuovi Go/native-to-ascii separati. |
| `src/features/settings/model/schema.ts` | clean | Medio: tenere LocaleId/LOCALES italiani insieme alle nuove opzioni upstream. |
| `src/features/settings/pages/behavior.tsx` | clean | Medio: lingua italiana piu main-menu style/custom schemes/sync-on-focus; evitare reset di preferenze. |
| `src/features/settings/pages/editor/colorScheme.tsx` | clean | Medio: import/export schemi amplia la pagina; mantenere branding nel SAMPLE. |
| `src/features/vcs/CommitView.tsx` | to re-apply | Alto: getDirectory upstream non confligge; Suggest fork va allineato a restricted/revoca senza perdere protezione draft/request generation. |
| `src/features/vcs/actions.tsx` | clean | Medio: shelf actions e directory context si combinano con azioni VCS/history fork; validare selezione singolo file e multi-repo. |
| `src/features/vcs/commitStore.ts` | clean | Basso: upstream aggiorna solo commento selectedShelf; preservare updateBeforeCommit=false fork. |
| `src/features/welcome/ProjectsPage.tsx` | clean | Basso: autofocus non sottrae focus al dialog trust; branding fork resta. |
| `src/platform/locales/text/zh.json` | conflict | Medio: append concorrenti; unione per chiave preservando 85 chiavi fork-only e rimozioni intenzionali; tradurre stesso delta in it. |
| `src/platform/locales/textCatalog.test.ts` | clean | Basso: whitelist Go upstream e Italiano fork additive; mantenere scansione su tutti i cataloghi. |
| `src/ui/Dialog.module.css` | clean | Medio: nuova messageAppIcon con limiti/scroll dialog fork; controllare dialog trust a viewport ridotto. |
| `src/ui/Tree.tsx` | clean | Basso: getDirectory/context upstream e tooltip detail fork indipendenti. |
| `src/ui/icons.tsx` | clean | Basso: icone JVM/editor upstream e agent agy/pi fork additive. |
| `src/workbench/TitleBar.tsx` | clean | Medio: Linux frameless con titolo IBLOpenIdea; integrazione layout/lingua da verificare. |
| `src/workbench/Workbench.test.tsx` | clean | Basso: fixture trusted e regression test notifiche multi-linea separati. |