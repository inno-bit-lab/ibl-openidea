# Italian glossary

- **Date**: 2026-10-31
- **Status**: Applied to `src/platform/locales/it.json` and `src/platform/locales/text/it.json` on `port/mt4-italian-release` (MT-4). The owner may still change single choices; a change updates this file and the catalogs in one delta commit.
- **Plan**: [`2026-10-31-sync-mt4-italian-release.md`](../plans/2026-10-31-sync-mt4-italian-release.md).
- **Source**: the fork catalog at `c8ed282` (`text/it.json`, 4584 entries, and `it.json`). Where the fork rendered one string in two ways, mostly a menu label against a text-catalog entry, one rendering was kept, usually the text catalog's (section 7).

Use it for every new Italian string, and check the strings the remaining v0.3.0 tasks add (MT-2 and MT-3) against it.

## 1. Git terms kept in English

Commit, Push, Pull, Fetch, Merge, Rebase, Cherry-Pick, Stash, Checkout, Tag, Revert and Reset (as Git operations), Patch, Upstream and HEAD stay in English, lower case inside a phrase: "Nessun commit", "Interrompi rebase".

Repository, branch, worktree and pull request stay in English too. The first three are masculine (il repository, il branch) and the plural does not change: "In tutti i {count} repository", "Nessun repository o branch corrispondente". Pull request is feminine: "Nessuna pull request".

| Use                   | Pattern                         | Examples                                                                     |
| --------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| Action                | Esegui + term                   | "Esegui commit del file…", "Esegui merge e push", "Esegui revert del commit" |
| Action on a target    | term + di/della                 | "Checkout della revisione", "Reset di HEAD…"                                 |
| Repeat                | Esegui di nuovo il + term       | "Esegui di nuovo il pull"                                                    |
| Operation in progress | term + in corso                 | "Push in corso", "Rebase in corso"                                           |
| Outcome               | term + non riuscito, interrotto | "Rebase non riuscito", "Merge interrotto"                                    |
| Error                 | Impossibile eseguire il + term  | "Impossibile eseguire il commit"                                             |

Merge as a noun stays in English ("Merge della pull request eseguito correttamente"). The adjective and the verb are translated: "Unite" (merged pull requests), "commit non uniti", "Branch da unire".

Revert alone, as a button, is "Ripristina"; "Revert Change" is "Annulla modifica". Docker pull is a download: "Scarica immagine".

## 2. Other terms kept in English

Debug, Debugger, Build (as a name), Plugin, Server, Language server, Editor, Thread, Test, Directory, Chat, Log ("Log Git"), Classpath, JDK, JRE, Proxy, code lens, LightEdit, prompt and preset ("Gestisci preset…", "Nuovo preset"). Product names, language names, file names, paths, commands, options, environment variables and shortcuts never change.

## 3. Translated terms

| English                        | Italian                                     | Example                                                  |
| ------------------------------ | ------------------------------------------- | -------------------------------------------------------- |
| diff                           | differenze                                  | "Mostra differenze", "Nessuna differenza"                |
| agent                          | agente                                      | "Attività dell'agente"                                   |
| arguments                      | argomenti                                   | "Argomenti dell'agente"                                  |
| effort, thinking, reasoning    | intensità, elaborazione, ragionamento       | "Intensità di elaborazione"                              |
| enable, disabled               | Abilita, disabilitato                       | "Questo agente è disabilitato"                           |
| ACP Registry                   | registro ACP                                | "Impossibile caricare il registro ACP: {error}"          |
| run                            | Esegui, esecuzione                          | "Azioni di esecuzione"                                   |
| build (action)                 | Compila, compilazione                       | "Arresta compilazione"                                   |
| breakpoint                     | punto di interruzione                       | "Visualizza punti di interruzione…"                      |
| watchpoint                     | punto di osservazione                       | "Aggiungi punto di osservazione campo"                   |
| step into, step over, step out | Entra in, Passa oltre, Esci da              | "Forza passa oltre", "Entra intelligente"                |
| pause, stop                    | Metti in pausa, Arresta                     | "Metti in pausa il programma"                            |
| project                        | progetto                                    | "Nuovo progetto…"                                        |
| workspace                      | area di lavoro                              | "Configurazione dell'area di lavoro"                     |
| settings                       | impostazioni                                | "Tutte le impostazioni…"                                 |
| changes                        | modifiche                                   | "Modifiche locali"                                       |
| changelist                     | elenco modifiche                            | "Nuovo elenco modifiche…"                                |
| revision                       | revisione                                   | "Confronta con branch o revisione…"                      |
| remote                         | remoto                                      | "Gestisci remoti…"                                       |
| conflict, resolve              | conflitto, Risolvi                          | "Risolvi conflitti…"                                     |
| history                        | cronologia                                  | "Cronologia locale"                                      |
| annotate                       | Annota                                      | "Annota con Git Blame"                                   |
| shelve, shelved                | Accantona, accantonate                      | "Accantona modifiche…", "Modifiche accantonate"          |
| shelf (noun), unshelve         | scaffale, Ripristina dallo scaffale         | "Mostra scaffale"                                        |
| stash (verb), pop, apply       | Metti in stash, Estrai, Applica             | "Metti in stash le modifiche…", "Estrai stash"           |
| stage, unstage                 | Prepara (stage), Rimuovi dallo stage        |                                                          |
| untracked, ignored             | non tracciati, ignorati                     | "Includi file non tracciati", "File e cartelle ignorati" |
| amend, squash, reword          | Emenda, Comprimi (squash), Riformula        | "Emenda commit"                                          |
| rollback                       | Annulla modifiche                           | "Annulla modifiche…"                                     |
| reset (outside Git)            | Ripristina                                  | "Ripristina zoom dell'IDE", "Ripristina frame"           |
| compare                        | Confronta                                   | "Confronta con…"                                         |
| review (pull request)          | revisione, Revisiona, revisori              | "Nessuna revisione"                                      |
| timeline                       | sequenza temporale                          | "Controlla nuovi eventi nella sequenza temporale"        |
| tool window                    | finestra degli strumenti                    | "Massimizza finestra degli strumenti"                    |
| tab, Tab key                   | scheda, Tabulazione                         | "Nuova scheda", "Dimensione tabulazione"                 |
| terminal                       | terminale                                   | "Apri nel terminale"                                     |
| keymap, shortcut               | mappa tasti, scorciatoia                    | "Riferimento scorciatoie" (Keymap Reference)             |
| inspection                     | ispezione                                   | "Riesegui ispezione"                                     |
| caret                          | cursore                                     | "Usa cursore a blocco"                                   |
| gutter                         | barra laterale                              | "Icone della barra laterale"                             |
| task                           | attività                                    | "Nuova attività…"                                        |
| refactor                       | refactoring                                 | "Esegui refactoring di questo…"                          |
| live template                  | modello live                                | "Inserisci modello live…"                                |
| scratch file                   | file temporaneo                             | "Nuovo file temporaneo…"                                 |
| indent                         | rientro                                     | "Applica rientro automatico alle righe"                  |
| folding                        | Compressione codice                         |                                                          |
| splitter                       | divisione                                   | "Vai alla divisione successiva"                          |
| folder, module                 | cartella, modulo                            | "Nuova cartella…"                                        |
| show, hide                     | Mostra, Nascondi                            | "Mostra cronologia"                                      |
| view (verb), view (noun)       | Visualizza, vista                           | "Vista progetto"                                         |
| delete, remove, rename         | Elimina, Rimuovi, Rinomina (noun: rinomina) | "Annulla spostamento / rinomina"                         |
| search, find, replace          | Cerca, Trova, Sostituisci                   | "Trova utilizzi"                                         |
| failed                         | non riuscito                                | "Compilazione non riuscita"                              |
| Cannot X                       | Impossibile X                               | "Impossibile aprire il file"                             |
| Loading…                       | Caricamento…                                | "Caricamento plugin"                                     |
| No X                           | Nessun X, Nessuna X                         | "Nessun remoto"                                          |

## 4. Tone

Actions and menu items use the imperative, second person singular: "Apri…", "Salva tutto", "Mostra cronologia". Yes/no confirmations use the infinitive: "Eliminare il container '{name}'?". No action label uses the infinitive.

The UI speaks to the user with "tu" ("Le tue modifiche", "modifica direttamente i tuoi file"), never with "Lei": there are 0 occurrences in the fork and in the new strings. Setting labels are nouns. Capitalization follows the catalog's sentence case. Trailing colons and question marks stay as in the source.

## 5. Punctuation, placeholders and plurals

An ellipsis `…` (U+2026) in the source stays `…` in Italian: 376 of 376 fork entries, 57 of 57 new ones after the MT-2 strings. The fork had 4 source strings written with three dots (for example "Search agents..."), which kept the three dots. The current source has none: upstream writes "Search agents…".

Placeholders such as `{name}` keep their names and their count, and ICU `plural` and `select` messages keep their structure; only the text inside the branches is translated. The `catalogs` tests in `src/platform/i18n.test.ts` enforce this.

## 6. Deliberate double renderings

The consistency check (section 7) still lists these 14 groups. Each one is intended:

| English                         | Renderings                                                                        | Why                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Minimize, Zoom, Show All, Redo  | macOS application menu: "Contrai", "Ridimensiona", "Mostra tutte", "Ripristina"   | The `menu.native.*` labels follow macOS                                          |
| Maximize, Minimize              | window caption: "Ingrandisci", "Riduci a icona"; tool window action: "Massimizza" | The `window.caption.*` labels follow Windows                                     |
| Build                           | "Build" as the menu, tool window and About name; "Compila" as an action           | Name and verb                                                                    |
| Profile                         | "Profilo", "Profilo:" as a noun; "Profilazione" as the Run menu action            | Noun and action                                                                  |
| Source, Source:                 | "Sorgente" for code; "Origine:" for where something comes from                    | Two meanings                                                                     |
| Check out, Check out:           | "Checkout"; "Checkout di:" when a target follows                                  | The colon introduces a target                                                    |
| delete, on, more, view, running | "eliminare", "su", "altri", "vista", "in esecuzione"                              | Lower-case fragments inside sentences, for example "Ora puoi {delete} {branch}." |

The code-coverage column "Branch, %" is "Ramo, %": it counts code branches, not Git branches.

## 7. Consistency check

The rule is that one English string has one Italian rendering across `text/it.json` and `it.json`, apart from the groups in section 6.

Normalization: lower-case the English and the Italian and drop trailing `…`, `...`, `:` and white space, so "Rename" and "Rename…" form one group. A group with more than one normalized Italian value is a double rendering.

After "feat(i18n): complete the Italian source-text catalog" the check found 79 groups. 25 involved strings new in the v0.3.0 sync and were fixed in "fix(i18n): give the new Italian strings one rendering each", which also fixed `menu.vcs.compareWithBranch` (still "Confronta con branch…" after its English became "Compare with Branch or Revision…"). The others were fork menu labels translated apart from the text catalog, aligned in "fix(i18n): align the Italian menu labels with the text catalog". After it the check reports only the 14 groups of section 6.

The MT-3 tranche 1 strings ("feat(i18n): translate the MT-3 strings into Italian", 29 added, 2 removed) added no group: the check still reports the same 14.

The MT-2 strings ("feat(i18n): translate the MT-2 strings into Italian", 49 added to the text catalog, no keyed change) added no group either. 38 values come from the fork. 10 strings the fork never had are new. "Reasoning effort (thinking level) used when generating commit message suggestions." is reworded to "Intensità di ragionamento (livello di elaborazione)…", because the fork's "Livello di ragionamento (intensità di elaborazione)" swapped the terms of "Effort" and "Thinking".

The MT-3 tranche 2 strings ("feat(i18n): translate the MT-3 tranche 2 strings into Italian": 4 source texts of the Suggest Commit Message button and the `menu.vcs.showHistoryForSelection` key) all come from the fork and add no group.

To run it, save this as `glossary-check.mjs` outside the repository and run `node glossary-check.mjs <repository root>`:

```js
import { readFileSync } from "node:fs";

const root = process.argv[2];
const read = (p) => JSON.parse(readFileSync(`${root}/src/platform/locales/${p}`, "utf8"));
const flat = (o, prefix = "", out = {}) => {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "object") flat(v, `${prefix}${k}.`, out);
    else out[prefix + k] = v;
  }
  return out;
};
const en = flat(read("en.json"));
const it = flat(read("it.json"));
const pairs = Object.entries(read("text/it.json"))
  .map(([e, i]) => [e, i, ""])
  .concat(Object.keys(it).map((k) => [en[k], it[k], `key:${k} `]));
const norm = (s) =>
  s
    .toLowerCase()
    .replace(/(…|\.\.\.|:|\s)+$/u, "")
    .trim();
const groups = new Map();
for (const p of pairs) groups.set(norm(p[0]), [...(groups.get(norm(p[0])) ?? []), p]);
let count = 0;
for (const [english, ps] of groups) {
  if (new Set(ps.map((p) => norm(p[1]))).size < 2) continue;
  count++;
  console.log(english);
  for (const [e, i, src] of ps) console.log(`    ${src}${e} => ${i}`);
}
console.log(`groups ${count}`);
```

Read every group it prints: either align the renderings or, if the difference is intended, add the group to section 6.
