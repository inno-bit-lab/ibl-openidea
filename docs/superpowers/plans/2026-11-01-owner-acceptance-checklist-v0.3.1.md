# Checklist dei test sul PC dell'owner: v0.3.1-1

- **Data**: 2026-11-01
- **Per chi**: l'owner, sul proprio PC Windows x64.
- **Release candidate**: https://github.com/inno-bit-lab/ibl-openidea/releases/tag/v0.3.1-1 (pre-release, pubblicata il 2026-11-01)
- **Perché**: sono le prove che nessun agente può fare, perché servono lo schermo e l'app vera. Con tutto OK si può preparare il tag finale `v0.3.1`.

Se non hai ancora finito la checklist precedente (`2026-10-31-owner-acceptance-checklist.md`, versioni 0.2.3 e 0.3.0), finiscila prima: questa parte dall'installazione che lascia.

Per ogni punto annota OK o KO. Per un KO scrivi cosa vedi e, se c'è, la riga di log o uno screenshot. I log sono in `%LOCALAPPDATA%\it.innobitlab.iblopenidea\logs`.

## 1. Aggiornamento alla 0.3.1-1

L'app installata cerca gli aggiornamenti solo tra le versioni definitive, quindi da sola non propone una pre-release. Falla puntare alla 0.3.1-1. In PowerShell:

```powershell
[Environment]::SetEnvironmentVariable('OPENIDEA_UPDATE_ENDPOINT','https://github.com/inno-bit-lab/ibl-openidea/releases/download/v0.3.1-1/latest.json','User')
```

- [ ] Chiudi l'app e riaprila dal menu Start, così legge la variabile.
- [ ] Help, Check for Updates: deve proporre la 0.3.1-1. Installala.
- [ ] Dopo il riavvio l'app parte e About mostra 0.3.1-1.
- [ ] Il profilo c'è ancora: preset, layout, JDK e progetti recenti.
- [ ] In Impostazioni di Windows, App installate, c'è una sola voce IBLOpenIdea. Se mostra ancora la versione precedente, segnalo ma non è un KO: è un limite noto.

In alternativa puoi installare a mano `IBLOpenIdea_0.3.1-1_x64-setup.exe` (39.781.475 byte) dalla pagina della release. Prima di lanciarlo controlla che sia integro:

```powershell
(Get-FileHash "$env:USERPROFILE\Downloads\IBLOpenIdea_0.3.1-1_x64-setup.exe" -Algorithm SHA256).Hash
```

Deve uscire `EA0533CA45B01B3A5D83E51FC5BCC45E7769333B2D3340FB456AFE7217558D5E`.

## 2. Italiano

Settings, Language and Region: "Italiano (Italian)".

- [ ] Schermata iniziale: a sinistra "Progetti", "Personalizza" e "Plugin".
- [ ] diff, task, workspace, breakpoint, timeline, effort, thinking, shelve, stash e stage restano in inglese ("Esegui shelve", "lo shelf").
- [ ] Cerca nei file: senza testo il campo dice "Digita il testo da cercare nel progetto"; con dei risultati il conteggio va al singolare e al plurale ("1 corrispondenza in 1 file", "3 corrispondenze in 2 file").
- [ ] Sostituisci tutto: la conferma è in italiano ("Sostituire 3 occorrenze di ... con ... in 1 file?") e così il messaggio finale.
- [ ] Impostazioni, Deploy: i pulsanti dicono "Globale" e "Questo progetto".
- [ ] Nessun testo tagliato o sovrapposto nelle finestre che usi di solito.

## 3. Attendibilità del progetto

Serve un progetto che IBLOpenIdea non ha mai aperto, per esempio una copia nuova di un repository.

- [ ] Aprendolo, l'app chiede se considerarlo attendibile. Scegli l'anteprima: compare "Il progetto è in modalità con restrizioni".
- [ ] In modalità con restrizioni puoi leggere e modificare i file. Non partono gli hook Git, i comandi di avvio del terminale, le esecuzioni e gli agenti. Suggest è disattivato.
- [ ] "Considera attendibile il progetto": da quel momento esecuzioni, agenti e Suggest funzionano.
- [ ] Settings, "Attendibilità del progetto": il progetto è nell'elenco dei progetti attendibili. "Revoca attendibilità" lo rimette in modalità con restrizioni.
- [ ] I progetti che avevi già aperto prima dell'aggiornamento sono attendibili senza nessuna domanda.

## 4. Suggest e agenti

Serve un progetto attendibile con almeno un file modificato.

- [ ] Suggest con Claude: il messaggio arriva nel campo del commit.
- [ ] Suggest con Codex: il messaggio arriva.
- [ ] Suggest con Antigravity: il messaggio arriva, oppure compare un errore. In nessun caso il testo dell'errore finisce nel campo del commit, e la bozza che avevi scritto resta. Antigravity 1.4.5 a volte non parte entro 30 secondi: in quel caso annota solo l'errore.
- [ ] Gli errori che arrivano dal motore degli agenti possono essere in inglese anche nell'interfaccia italiana: è un limite noto.
- [ ] Avvia un Suggest e, mentre lavora, revoca l'attendibilità del progetto oppure chiudilo. Il suggerimento si annulla.
- [ ] Dopo i Suggest, in `%TEMP%` non restano cartelle `ibl-suggest-*` nuove, e in Gestione attività non restano processi dell'agente appesi (per esempio `antigravity` o `node` lanciati dall'agente).

## 5. Finestre e menu

- [ ] Settings, cerca "menu": attiva l'opzione per unire il menu principale alla barra degli strumenti. Il menu compare nella toolbar ("Unito alla barra degli strumenti principale").
- [ ] Restringi la finestra finché il menu unito si riduce all'icona con le tre righe. Con la tastiera (Alt, frecce) il focus non si perde.
- [ ] Su un monitor scalato o secondario la finestra Settings resta tutta dentro lo schermo.

## 6. Editor e file

- [ ] Modifica un file aperto con un altro programma, poi torna su IBLOpenIdea: il contenuto si aggiorna da solo. Si può disattivare nelle Settings.
- [ ] Nella console di un'esecuzione funziona la ricerca nell'output.
- [ ] Nello shelf le modifiche si vedono file per file, con le azioni sul singolo file.

## 7. Sviluppo remoto

Serve l'host Linux che hai usato per la 0.2.2 (la WSL con `sshd` o il server).

- [ ] Apri un progetto remoto: l'app scarica il nuovo `openidea-server` dalla release v0.3.1-1 e si collega. Un server vecchio non è più compatibile, quindi il download è previsto.

## 8. Facoltativo: finestra di avanzamento della migrazione

La finestra compare solo al primo avvio dopo un aggiornamento dalla 0.2.x, quando il profilo va copiato. Sul tuo PC la copia è già stata fatta, quindi per vederla bisogna rifarla.

- [ ] Chiudi IBLOpenIdea. Rinomina `%APPDATA%\it.innobitlab.iblopenidea` in `%APPDATA%\it.innobitlab.iblopenidea.bak`.
- [ ] Avvia IBLOpenIdea: compare una finestra di avanzamento mentre copia il profilo da `ai.l0ng.openidea`. Si chiude da sola e poi si apre l'app. Non chiuderla mentre copia.
- [ ] Se preferisci tornare al profilo di prima: chiudi l'app, elimina la cartella nuova `it.innobitlab.iblopenidea` e rinomina `.bak` com'era.

## 9. Alla fine

- [ ] Togli la variabile dell'updater, così l'app torna al canale normale:

```powershell
[Environment]::SetEnvironmentVariable('OPENIDEA_UPDATE_ENDPOINT',$null,'User')
```

- [ ] Manda al coordinator l'esito, OK o KO per ogni punto.

Con tutto OK il coordinator prepara la 0.3.1 definitiva: un commit con versione 0.3.1, il tag `v0.3.1` e la release, ognuno con il tuo via. Un KO diventa una correzione e una nuova versione di prova 0.3.1-2.

## Cosa non si prova qui

Windows ARM64, macOS e Linux desktop non sono verificati da nessuno: le build esistono e sono firmate, ma servirebbe una macchina con quel sistema. Restano verificati solo in CI.
