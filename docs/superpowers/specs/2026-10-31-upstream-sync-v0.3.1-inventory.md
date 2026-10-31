# Inventario upstream per v0.3.1 — A3FB87

Inventario read-only concluso. I 32 commit toccano 385 file (+16.476/-1.519); 38 sono modificati anche dal fork. La prova testuale a tre vie produce conflitti in 7 file. Altri 6 richiedono adattamento o rigenerazione pur combinandosi senza conflitti; 25 risultano clean, incluso un test gia identico. I rischi maggiori sono project trust e release ARM64, non la risoluzione dei marker.

## Perimetro e metodo

- Freeze/merge-base: `504d8592d243df533081d94b24c35ed64a9e6a4b`.
- Fork: `origin/next/v0.3.1 = 2847c42a8463ada1358e83049e58bb6238d1cdd3`.
- Upstream: `b2d11880490552ab6eb36f540b8d2fab0116ce0b` (v0.1.30).
- Il fork differisce dal freeze in 190 file: 38 comuni, 152 solo fork. Upstream ne ha 347 fuori dall'intersezione. Nessuna rename/delete di file nel delta upstream rilevato da `git diff --name-status`.
- Confrontati log, diff e blob dei tre SHA; per ogni file comune eseguito `git merge-file -p <fork-temp> <base-temp> <upstream-temp>`. E una prova per file, non un merge applicato al repository. Verificato che il vero merge-base sia il freeze.
- `clean` significa merge testuale riuscito e nessun adattamento specifico identificato in questo inventario; non significa funzionalita qualificata. `to re-apply` indica lavoro semantico o rigenerazione necessario. `conflict` indica conflitto testuale osservato. Gravita e motivazione sono nella tabella.
- Checkout rimasto a `b3e78aa9`, pulito; nessun checkout, modifica sorgente, commit, push, build o test applicativo. File di lavoro solo in `%TEMP%\ibl-openidea-inventory-A3FB87`. Nessuna CI avviata.

## 1. I 32 commit per area

### JVM, debugger e Services — 8

| Commit | PR | Cambiamento |
|---|---:|---|
| `9d670e62` | #512 | Icone JVM per moduli Maven/Gradle, package, classi Java/Kotlin, test, runnable e cartelle generate; resolver condiviso Project/tabs/Goto/Recent e RPC. |
| `8fe09eba` | #514 | Fissa `module: ""` nelle fixture Java separator per evitare risoluzione modulo non mockata. Gia identico nel fork. |
| `92cbdd0c` | #525 | Apre in scrittura il file prima di modificarne il timestamp nel test host/RPC JVM: compatibilita Windows. |
| `53bebe48` | #529 | Risolve WAR dal modulo Maven selezionato anziche dal parent; include opzioni/env, output personalizzati, errori con path e manifest Gradle UTF-8. |
| `a2405c08` | #545 | jdtls tratta forbidden/discouraged access come warning; mantiene veri errori di compilazione e non modifica `.settings` del progetto. |
| `7610fc3f` | #546 | Sessione/progresso e Stop durante preparazione Java debug; preparazione Run/Debug condivisa, JDK/Lombok fuori dall'async runtime, flush console in background. |
| `1e9cf1c4` | #540 | Services mostra console/stato della sessione debug; associa Run e debug, corregge Stop/Rerun e attende il processo Run prima del detach debugger. |
| `4796265b` | #555 | Formatta la preparazione del launch Java introdotta sopra. |

### Go — 2

| Commit | PR | Cambiamento |
|---|---:|---|
| `ac360b61` | #524 | Workflow Go completi: build tags/gopls, Run/Test/Delve, test JSON e rerun failed, benchmark/generate, moduli/go.work, tidy/download/sync/use, format/import su save. |
| `8f85f35e` | #550 | Test Go portabili senza toolchain e su Windows; whitelist i18n per variabili e placeholder Go. |

### C/C++ e LSP — 2

| Commit | PR | Cambiamento |
|---|---:|---|
| `1e8551ad` | #539 | CMake Configure/Build/CTest e target da File API; lldb-dap; canonicalizzazione/alias per rename e breakpoint; syntax highlighting CMake. |
| `999eb864` | #553 | Fixture mock LSP confrontate con path canonici su macOS/Windows. |

### Deployment — 2

| Commit | PR | Cambiamento |
|---|---:|---|
| `290abd30` | #521 | Server deployment locale/cartella montata oltre a SFTP, con filesystem backend condiviso e upload/save/download/delete/compare/sync; preserva SFTP esistente. |
| `ee2585e7` | #544 | Filtra server secondo mapping ed esclusioni dei path selezionati; coverage senza connessione, errori espliciti e reporting skipped. |

### VCS shelf — 2

| Commit | PR | Cambiamento |
|---|---:|---|
| `c0f8557f` | #531 | Shelf consultabile per file: diff, compare local, patch/clipboard/import; unshelve/delete della sola selezione e basi salvate, anche binary/added/deleted. |
| `4418f49c` | #541 | Nome della fixture shelf valido anche su Windows. |

### Editor, ricerca, console e impostazioni — 9

| Commit | PR | Cambiamento |
|---|---:|---|
| `bde19959` | #518 | Import/export/delete `.icls`, custom schemes globali e selettori Appearance/Quick Switch; valida colori e file. |
| `d4b35473` | #527 | Risultati Find in-file nella Find window dal buffer corrente, opzioni/selection e azioni multiple cursors. |
| `cbdc177b` | #528 | Ricerca Run console con case/words/regex, contatore, highlighting e apertura fold del match. |
| `c5cb217c` | #534 | Find/Replace in Files usa cartella della selezione nell'albero attivo: Project, Changes/Commit, Bookmarks, Scratches. |
| `27ed0515` | #537 | Conversione native-to-ascii properties default-off; codec coerente per buffer, save, search, Git diff/staging/partial commit; preserva byte quando invariati. |
| `17e3cd2b` | #564 | Sync dei documenti da disco al focus, debounce e controllo dirty; refresh tree/VCS; nuova preferenza default-on. |
| `178fc9ea` | #554 | Controlli preview nella tab strip; floating toolbar quando tab nascoste, accessibilita tastiera e reduced motion. |
| `d6f6525c` | — | Campo di ricerca lingua visibile nello Scratch chooser. |
| `b2d11880` | #566 | Ripristina focus del terminale dopo chiusura del context menu. |

### Finestre, menu e distribuzione — 4

| Commit | PR | Cambiamento |
|---|---:|---|
| `a553dafa` | #279 | Linux frameless per project/Settings: menu e caption controls custom; niente GTK menu bar. Nuovo `tauri.linux.conf.json`. |
| `bdadecdf` | #558 | Settings window mantenuta nella work area su Windows/Linux. |
| `e7740e40` | #561 | Preferenza hamburger/merged main menu; barra persistente se c'e spazio, fallback responsive e gestione focus/tastiera. |
| `cf51b579` | #516 | Release desktop Windows/Linux ARM64, mapping updater; tool/JDK ARM nativi prima del fallback x64 Windows, agent npx/uvx prima dell'emulazione. |

### Project trust — 2

| Commit | PR | Cambiamento |
|---|---:|---|
| `2c9a6470` | #517 | Decisioni trust user-owned, restricted mode, gate backend e revoca; trust UI locale/remota; protocollo host 2. Modifica 103 file. |
| `2faa64fb` | #571 | Import dei test trust Unix confinati a `cfg(unix)`. |

### Versione — 1

| Commit | PR | Cambiamento |
|---|---:|---|
| `5329ddc4` | — | Bump upstream a 0.1.30 nei manifest e lockfile; da adattare alla linea fork 0.3.1. |

## 2. Intersezione completa e rischio per file

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

## 3. Punti critici di integrazione

### #516: ARM64 e release del fork

Il delta release upstream aggiunge due build (`ubuntu-22.04-arm` / `aarch64-unknown-linux-gnu`, `windows-11-arm` / `aarch64-pc-windows-msvc`) e cinque pattern di bundle nel manifest. La matrice desktop passa da 4 a 6; la matrice server musl aveva gia ARM64. `registry.rs`, `platform.rs`, `jdk.rs` e il registry tool aggiornano anche la selezione degli eseguibili: non ridurre il port al solo YAML.

Il merge testuale di `release.yml` riesce, ma e incompleto semanticamente. A `2847c42:.github/workflows/release.yml:127` la guardia pre-release controlla esattamente `matrix.os == 'ubuntu-22.04'`: il nuovo runner ARM non la soddisfa e tenta RPM con versione contenente `-`. Estenderla a tutti i build Linux (per esempio `runner.os == 'Linux'`) e rendere condizionale anche il pattern `.aarch64.rpm` aggiunto upstream. I soli RPM non vanno richiesti nel manifest pre-release; deb/AppImage restano obbligatori per entrambe le architetture.

Preservare `includeUpdaterJson: false` (fork riga 129), writer unico `updater-manifest`, guardie `already_published` su build/server/manifest/publish, draft/tag-version guard e branding. Le nuove chiavi sono `linux-aarch64`, `linux-aarch64-appimage`, `linux-aarch64-deb`, `linux-aarch64-rpm`, `windows-aarch64`, `windows-aarch64-msi`, `windows-aarch64-nsis`: manifest atteso di 18 chiavi stable, 16 pre-release. Associare sempre il nome bundle corretto alla sua `.sig`.

#516 non modifica la gestione signing. Conservare il secret updater e la pubkey fork ID `A31A0E471F28FEEC` e l'endpoint InnoBitLab; nessuna rotazione implicita. Firma updater, code signing Windows e notarizzazione Apple sono evidenze distinte. L'attuale comportamento con zero `.sig` salta il manifest: non equivale a un updater qualificato. Da verificare con fixture stable/pre-release/asset mancante e poi con artifact firmati delle nuove architetture. Disponibilita runner, firma effettiva, installazione e update ARM: NOT_VERIFIED qui.

### #517: trust, agenti, Suggest, Git e PATH

Upstream applica `authorize_command` sia al dispatcher RPC (`b2d11880:crates/ide-host/src/rpc.rs:303`) sia all'invoke Tauri locale/remoto (`src-tauri/src/lib.rs:97,106`). I nuovi comandi di esecuzione non classificati sono negati. Serve un'integrazione esplicita dei comandi fork, non un'eccezione generica `agent_*` o `vcs_*`.

1. **Welcome e catalogo agenti.** Il fork supporta `agent_providers` e `agent_set_args` senza progetto (`2847c42:crates/ide-host/src/ops/agent.rs:22,32`). Il gate upstream e `require_trust` su providers renderebbero irraggiungibile quel percorso: `Host::require_trust` richiede un progetto aperto. Separare lettura/configurazione del profilo user-owned dall'esecuzione di provider. Testare Welcome, Settings figlia, progetto restricted/trusted, locale e remote. Preservare catalogo/preset, extra_args e migrazione nativa del fork.
2. **Suggest Commit Message.** `agent_complete` e fork-only e oggi esegue una sessione temporanea: il fatto che sia read-only non elimina l'avvio di un processo. Deve restare negato in restricted, con controllo anche nell'operazione host prima dello spawn e UX coerente. Conservare le protezioni di `CommitView` contro risultato tardivo, cambio repo, Cancel e modifica manuale. Aggiungere revoca trust mentre Suggest e in volo: staticamente `Agents::shutdown()` percorre i task registrati, mentre `complete()` ha un proprio `CompletionScope` fuori dalla task map. La cessazione del completamento in corso non e dimostrata dal nuovo shutdown upstream e va integrata/verificata; non dichiararla coperta.
3. **VCS ignored.** Il gate non classifica `vcs_ignored`; senza adattamento Show Ignored fallisce in restricted. Se si mantiene la lettura disponibile come `vcs_status`, prima applicare le stesse protezioni: non prendere l'eseguibile Git dalle settings del progetto non trusted e aggiungere `ExecutionScope` al nuovo `Repo::status_with_ignored`. Il fork `Repos::status()` passa proprio da quel metodo, anche con `include_ignored=false`; va controllato anche il normale status. `Repo::gix()` upstream filtra gia la config quando restricted: questa osservazione NON e una dimostrazione di exploit, ma evidenzia una guardia mancante nel wrapper aggiunto dal fork. Servono test di non-esecuzione con executable/hook/fsmonitor malevoli, inclusi multi-repo.
4. **PATH budget.** Upstream non tocca `ide-core/src/tool_path.rs` o `ide-tools/src/lib.rs`: mantenere il budget, dedup e warning del fork. Trust cambia invece environment/postStartCommand e terminal spawn (restricted elimina shell/args/env di progetto e virtualenv activation). Verificare trusted/restricted/revoke, terminale esplicito, CMD con PATH lungo e resolver managed-tool. Trust non sostituisce il budget e non rende il terminale una sandbox: l'utente puo eseguire comandi e la shell puo usare Git del repository.
5. **Persistenza e prima apertura.** `TrustStore::load` salva in data `project-trust.json` e, se assente, importa come trusted i recent projects esistenti (`trust.rs:23-35`). Con il seed profilo fork, progetti recenti copiati possono risultare gia trusted: comportamento da documentare e testare, non assumere che ogni progetto migrato mostri il prompt. Verificare ordine seed -> Host/TrustStore, revoca persistente e directory parent trusted.
6. **Remote e test.** Protocollo host passa 1 -> 2: aggiornare server e client insieme, lasciare esplicita l'incompatibilita con server vecchi. Il helper fork `open_host` in `crates/ide-host/tests/rpc.rs` manda ancora `initialize {version:1}`; il merge pulito non aggiorna quel codice. Le fixture nuove richiedono una scelta trust esplicita. Nuovo `ProjectInfo.trusted` si propaga anche ai test frontend fork non toccati upstream. Alcuni test trust sono Unix-only: verde Windows non li qualifica.

### #561: merged main menu e voci fork

#561 non modifica `src-tauri/src/menu.rs`: lavora in `MainMenu.tsx`, settings, CSS e test. Il cambiamento Rust dell'intervallo proviene da #279 e rende native la barra solo su macOS. Il modello resta `commands.menuModel()` e quindi usa la stessa spec Rust. Il merge conserva `IBLOpenIdea`, About/Quit/Hide e `vcs.showHistoryForSelection`; non occorre ricostruire una seconda lista di voci frontend.

Verificare italiano/en/zh, Windows/Linux hamburger e merged, narrow fallback, Alt/frecce/Escape e focus, e menu nativo macOS. Le traduzioni italiane piu lunghe possono attivare il fallback. Fuori dall'intersezione dei 38 file, il nuovo `src-tauri/tauri.linux.conf.json` contiene ancora `title: "OpenIDEA"`: aggiungerlo all'allowlist del branding. E un esempio concreto del motivo per cui l'intersezione non esaurisce il port.

### Cataloghi italiani

Confronto strutturale JSON eseguito sui blob:

| Catalogo | Freeze | Upstream | Fork attuale | Delta da portare |
|---|---:|---:|---:|---|
| keyed `en.json` / `zh.json` | 448 | 448 | 449 | Nessun delta upstream; mantenere chiave selection history e branding fork. `it.json` resta allineato a 449. |
| source-text `text/zh.json` | 5230 | 5346 | 5311 | +119 nuove chiavi, -3 rimosse, 0 valori esistenti modificati da upstream. |
| source-text `text/it.json` | assente upstream | assente upstream | 5311 | Tutte le 119 aggiunte mancano; rimuovere le stesse 3 chiavi obsolete dopo verifica nel sorgente integrato. |

Le rimozioni sono `Copy Patch to Clipboard`, `Invalid Tomcat deployment`, `The built WAR artifact does not exist`: sostituite da testi nuovi, gli ultimi due con `{path}`. L'unione del delta sul fork produce **5427 chiavi source-text attese**, prima di eventuali nuove stringhe introdotte dal nostro adattamento trust. Preservare 85 chiavi fork-only ancora valide, branding e rimozioni intenzionali (`Direction`, `In {left}, not in {right}` ecc.); non sostituire il catalogo con quello upstream.

Nuove famiglie: trust/restricted/security (18 aggiunte nel commit #517), Go, color scheme import/export, local deployment/coverage, shelf/patch, console search, CMake/Java progress, main-menu style (3), sync-on-focus, native-to-ascii e preview. Elenco completo delle 119 chiavi: `italian-new-strings.json` nel bundle temporaneo. `en-delta.json`, `zh-delta.json`, `zh-text-delta.json` conservano conteggi, aggiunte/rimozioni e confronto col fork. L'elenco `missing_from_fork` del JSON zh comprende anche vecchie stringhe volutamente eliminate/rinominate dal fork: NON e la lista da tradurre; usare le 119 `added` e il sorgente finale.

## 4. Patch gia assorbite upstream?

| Patch fork | Esito al freeze b2d11880 | Evidenza / azione |
|---|---|---|
| PATH budget | **No** | Blob `crates/ide-core/src/tool_path.rs` e `crates/ide-tools/src/lib.rs` invariati da 504d859. Upstream `extend_process_path` continua a espandere PATH senza il budget fork. Preservare implementazione e test. |
| actionTitles Windows | **No** | `src/platform/locales/actionTitles.test.ts` e identico al freeze, blob `18274c970f2b2ad4391b12b6f65acd4970ade18f`. Manca `.replaceAll("\\", "/")` della patch fork `2484d007`. |
| includeUpdaterJson | **No** | Upstream conserva `uploadUpdaterJson: false`; il fork ha corretto `includeUpdaterJson: false`. Non regredire il writer unico. |
| RPM pre-release | **No** | Upstream non ha guardie per bundle RPM pre-release e rende obbligatorio anche aarch64-rpm. Il fix fork va esteso ad ARM. |
| reviewDiff flaky | **No** | `src/features/github/diff/reviewDiff.test.tsx` ha lo stesso blob `cbde3dbedaf953880ee4fa50bddddb0f3f384b73` nei tre SHA; anche `reviewDiff.tsx` non cambia upstream. La PR small-fixes resta necessaria. Nessuna prova di stabilita runtime eseguita. |
| Java separator | **Si, aggiuntivo** | `8fe09eba` #514 introduce lo stesso `module: ""` gia nel fork; file finale identico. Non duplicare patch/fixture. |

## 5. Proposta macro-task e ordine

E una scomposizione proposta, non un mandato di sviluppo. Ogni task va chiuso con base congelata, allowlist, verifica e DoD; i file comuni richiedono integrazione seriale. Preferisco questi blocchi, mantenendo la provenienza dei commit e con traduzioni dei rispettivi delta a ogni tranche affinche il gate cataloghi non rimanga rosso.

| Ordine | Macro-task | Perimetro e gate essenziale |
|---|---|---|
| 0 | Freeze e small-fixes | Recepisce la PR reviewDiff/doc ide-tools quando approvata, congela nuovo SHA next/v0.3.1, registra upstream b2d11880; ricalcola overlap se cambia base. Non dichiarare la PR gia revisionata. |
| 1 | JVM / Go / C++ / runtime | I 12 commit delle prime tre aree, con eventuali sub-tranche JVM (8), Go (2), C++/LSP (2). Portare insieme bugfix test pertinenti. Gate run/debug/cancel/Services, path canonici, Go assente, alias; consultare design teardown per non sovrapporre ownership. |
| 2 | Deployment | #521 + #544 (2 commit), contratto backend/IPC/RPC e mapping; gate local/SFTP, file grande, source=dest, exclusions e server coverage. |
| 3 | Editor / ricerca / console / shelf | 11 commit delle due aree, divisibili in editor/find (9) e shelf (2) con boundary seriale per file condivisi. Gate properties bytes e partial commit, dirty disk-sync, shelf per-file e regressioni VCS fork. |
| 4 | Shell / menu | #279 + #558 + #561 (3 commit): Linux frameless, work area, merged menu, branding nuova config Linux; gate menu e focus multi-OS/italiano. |
| 5 | Release ARM64 / tool selection | #516 (1 commit), guardie release fork adattate e manifest stable/pre-release. Verifica statica/fixture prima dei build firmati; non pubblicare senza mandato. |
| 6 | Trust e integrazione fork | #517 + #571 (2 commit), dopo le feature che deve proteggere. Decisione esplicita su catalogo Welcome, Suggest/revoca, ignored, PATH, migrazione recent projects e protocollo 2. Gate negativi di non-esecuzione + positivi trusted, locale/remoto, Unix e Windows. Task ad alto rischio: review separata. |
| 7 | Consolidamento italiano e versione | Adattare `5329ddc4` (1 commit) a 0.3.1; audit finale cataloghi/glossario e branding, bindings rigenerati, lockfile/versioni coerenti, release notes comprese trust migration e remote protocol. Full CI prima dell'accettazione; runtime/update restano gate distinti. |

Totale assegnato: 12 + 2 + 11 + 3 + 1 + 2 + 1 = 32 commit. I sub-task JVM/Go/C++ e editor/shelf servono a contenere dimensione e review; non autorizzano scritture simultanee su `src/bindings.ts`, Cargo.lock, cataloghi, run/debugger o registrazioni condivise. Analisi e preparazione di allowlist possono procedere in parallelo; ogni integratore parte dall'ultimo SHA accettato. Il task trust va dopo le feature per classificare tutti i nuovi entry point e deve coordinarsi col teardown gia in progettazione.

## Evidenze e limiti

Bundle: `C:\Users\Innotech\AppData\Local\Temp\ibl-openidea-inventory-A3FB87`.

- `commits.txt`, `upstream-numstat.txt`: log e dimensione delta.
- `overlap.json`: 38 file, indice e return code di merge-file; 31 merge puliti, 7 conflittuali (Cargo.lock: 35 blocchi).
- `overlap-classified.json`, `overlap.csv`, `overlap-table.md`: rischio stimato per tutti i 38 file.
- `overlap-diffs.txt`, `<indice>-base/fork/upstream/merged.txt`: diff e byte della prova a tre vie.
- `critical-references.txt`: riferimenti puntuali a file/linea congelati.
- `italian-new-strings.json` e `*-delta.json`: delta cataloghi riproducibile.

NOT_VERIFIED: compilazione del risultato integrato, test dopo merge, comportamento UI/native, trust revocation di processi in corso, firma/installazione/updater ARM, disponibilita runner ARM e nuovi gate CI. L'inventario non autorizza merge o pubblicazione. Nessun codice modificato. Resto disponibile per la review separata della small-fixes PR prevista dal mandato.
