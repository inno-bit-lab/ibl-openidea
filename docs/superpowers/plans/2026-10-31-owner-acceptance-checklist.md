# Checklist dei test sul PC dell'owner (v0.2.2, v0.2.3, v0.3.0)

- **Data**: 2026-10-31
- **Per chi**: l'owner, sul proprio PC Windows. I test A5 e B3 li esegue il team.
- **Perché**: i tag finali `v0.2.2`, `v0.2.3` e `v0.3.0` partono solo quando questi test passano.

I test vanno fatti in quest'ordine, perché ognuno parte dall'installazione lasciata dal precedente: prima v0.2.2, poi l'aggiornamento a v0.2.3, poi l'aggiornamento a v0.3.0. Hai già accettato che le impostazioni di IBLOpenIdea possano andare perse. La migrazione però copia soltanto: il profilo `ai.l0ng.openidea` resta intatto.

Le release candidate da usare:

- v0.2.2: https://github.com/inno-bit-lab/ibl-openidea/releases/tag/v0.2.2-2
- v0.2.3: https://github.com/inno-bit-lab/ibl-openidea/releases/tag/v0.2.3-2
- v0.3.0: https://github.com/inno-bit-lab/ibl-openidea/releases/tag/v0.3.0-1

Per ogni punto annota OK o KO. Per un KO scrivi cosa vedi e, se c'è, la riga di log o uno screenshot.

## 1. v0.2.2

### 1.1 Installazione

- [ ] Chiudi IBLOpenIdea, poi scarica e installa `IBLOpenIdea_0.2.2-2_x64-setup.exe` dalla release v0.2.2-2. La versione 0.2.0 o 0.2.1 è firmata con la chiave vecchia, quindi questo passaggio va fatto a mano.
- [ ] Apri l'app: Help, About IBLOpenIdea deve mostrare 0.2.2-2.

### 1.2 A3: suggerimento del messaggio di commit in sola lettura

Serve un progetto Git con almeno un file modificato.

- [ ] Nelle Settings apri la pagina Message Suggestion (cercala con "suggest") e scegli Claude.
- [ ] Nella finestra Commit premi Suggest: deve arrivare un messaggio proposto.
- [ ] Ripeti con Antigravity (agy), se è installato e hai fatto il login.
- [ ] Apri il log di oggi in `%LOCALAPPDATA%\ai.l0ng.openidea\logs` (la 0.2.2 usa ancora il vecchio identifier). Per ogni suggerimento deve esserci una riga con l'agente, una modalità tra `read-only`, `read_only` e `default`, e una cartella di lavoro temporanea `ibl-suggest-...`.
- [ ] Facoltativo: con un agente che non ha modalità restrittive (per esempio Pi) il suggerimento deve dare un errore che dice che l'agente non può lavorare in sola lettura.

### 1.3 A4: sviluppo remoto su un host Linux

Serve un host Linux raggiungibile in SSH (un server o una WSL con `sshd`). Se non ne hai uno, segna A4 come "non eseguito".

- [ ] Apri un progetto remoto su quell'host.
- [ ] L'app deve scaricare `openidea-server` dalla release v0.2.2-2 e partire senza errori 404.
- [ ] Nel log deve risultare che il file `.sha256` è stato verificato.

### 1.4 A6 (facoltativo, solo con un Mac)

- [ ] Il DMG non firmato si apre seguendo le istruzioni delle release notes.

## 2. v0.2.3 (nuovo identifier e migrazione)

### 2.1 B1: aggiornamento con l'updater

Prepara qualcosa da ritrovare dopo l'aggiornamento, nella 0.2.2:

- [ ] Crea un preset di agente.
- [ ] Cambia il layout, per esempio sposta una finestra degli strumenti.
- [ ] Scarica un JDK (Settings, SDK).

Fai puntare l'updater alla release candidate. In PowerShell:

```powershell
[Environment]::SetEnvironmentVariable('OPENIDEA_UPDATE_ENDPOINT','https://github.com/inno-bit-lab/ibl-openidea/releases/download/v0.2.3-2/latest.json','User')
```

- [ ] Chiudi l'app e riaprila dal menu Start, così legge la variabile.
- [ ] Help, Check for Updates: deve proporre la 0.2.3-2. Installala.
- [ ] Dopo il riavvio l'app parte e About mostra 0.2.3-2.
- [ ] In Impostazioni di Windows, App installate, deve esserci UNA sola voce IBLOpenIdea.
- [ ] Esiste `%APPDATA%\it.innobitlab.iblopenidea\.migrated.json`.
- [ ] Il preset, il layout, il JDK e gli agenti di prima ci sono ancora.

### 2.2 B2: convivenza con OpenIDEA di upstream

Solo se hai installato anche OpenIDEA originale (`ai.l0ng.openidea`). Altrimenti segna B2 come "non eseguito".

- [ ] Apri insieme IBLOpenIdea e OpenIDEA: partono tutti e due, e ognuno ha le sue impostazioni.

## 3. v0.3.0 (fork ricostruita su upstream)

### 3.1 C3: aggiornamento con l'updater

Dalla 0.2.3-2 installata al punto 2:

```powershell
[Environment]::SetEnvironmentVariable('OPENIDEA_UPDATE_ENDPOINT','https://github.com/inno-bit-lab/ibl-openidea/releases/download/v0.3.0-1/latest.json','User')
```

- [ ] Chiudi e riapri l'app dal menu Start, poi Check for Updates: deve proporre la 0.3.0-1. Installala.
- [ ] L'app parte, About mostra 0.3.0-1, e in App installate c'è una sola voce.
- [ ] Il profilo c'è ancora: preset, layout, JDK e progetti recenti.

### 3.2 C4: suggerimento di commit con gli agenti nativi

- [ ] Message Suggestion con **Claude Code** nativo: il suggerimento arriva. Nel log di `%LOCALAPPDATA%\it.innobitlab.iblopenidea\logs` la modalità è `default`.
- [ ] Message Suggestion con **Codex** nativo: il suggerimento arriva e la modalità è `read-only`.
- [ ] Con un agente senza modalità restrittive (per esempio Pi), il suggerimento viene rifiutato con un errore chiaro.
- [ ] Il bottone Suggest c'è sia nella finestra Commit sia nel dialog di commit.

### 3.3 C5: finestra Git su una cartella con più repository

Apri una cartella che contiene due o più repository Git.

- [ ] La finestra Git mostra tutti i repository.
- [ ] History for Selection: selezioni alcune righe in un file e ne vedi la cronologia.
- [ ] Show Ignored Files: compaiono i file ignorati, e spariscono quando lo togli.
- [ ] Compare Branches apre l'editor a due pannelli. Se lo stesso branch esiste in due repository, ogni confronto resta nel suo repository.
- [ ] Pull, Merge e Rebase ti fanno scegliere il repository.

### 3.4 Lingua italiana

- [ ] Settings, Language and Region: scegli "Italiano (Italian)". Menu e finestre principali sono in italiano. Se vuoi cambiare qualche termine, il glossario è in `docs/superpowers/specs/2026-10-31-italian-glossary.md`.

## 4. Alla fine

- [ ] Togli la variabile dell'updater, così l'app torna al canale normale:

```powershell
[Environment]::SetEnvironmentVariable('OPENIDEA_UPDATE_ENDPOINT',$null,'User')
```

- [ ] Manda al coordinator l'esito, OK o KO per ogni punto.

Con tutto OK, il coordinator mette i tag finali `v0.2.2`, `v0.2.3` e `v0.3.0` in quest'ordine, sposta `main` sulla v0.3.0 e pubblica le release. Un KO diventa una correzione e una nuova release candidate.

## Test che fa il team (non servono a te)

- **A5**: due worktree con `pnpm dev:local` in parallelo, ognuno con porta e profilo suoi, senza `ERROR_BUSY`.
- **B3**: build di debug con `IBLOPENIDEA_SEED_FROM=ai.l0ng.openidea` e nessun profilo di destinazione. Il seed parte al primo avvio e non al secondo.
