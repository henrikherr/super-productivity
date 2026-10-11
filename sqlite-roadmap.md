# SQLite-Persistenz für Super Productivity – Roadmap

Lebendes Arbeitsdokument. Stand: 2026-10-10. Branch: `feature/sqlite-persistence`
(Basis `origin/master` @ `71eb778`). Arbeitsverzeichnis:
`C:\Users\henrik.herr\source\repos\henrikherr\superprod\superprod-sqlite`.

## Zusammenfassung

**Status: im geplanten Umfang abgeschlossen** (Schritte S0–S8). Offen: S-E (Bilder,
braucht App-Änderungen) und ein seltener Testabsturz unter Überlast (§9.5). Noch
nicht committet.

**Was ist entstanden?** Ein eigener Server `packages/sqlite-server`, der deine
Super-Productivity-Daten zentral in **einer SQLite-Datei** speichert, z. B. auf einem
Raspberry Pi zuhause. Am App-Code ist nichts geändert.

```
Desktop / Handy / Browser ──SuperSync──▶ sqlite-server ──▶ superprod.sqlite
                                              │             ├─ Änderungs-Log (Original)
superprod-mcp (KI) ──REST /api/v1─────────────┘             └─ Tabellen (daraus berechnet)
                                                             └─▶ Backups (NAS)
```

| Baustein              | Was er tut                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sync-Server           | Spricht das SuperSync-Protokoll; die Apps verbinden sich über „SuperSync, eigene URL“. Konflikte, Wiederholungen und Push wie beim Original                 |
| Tabellen (Projektion) | Der Server rechnet mit den echten App-Reducern alle Änderungen nach und legt lesbare Tabellen an (Tasks, Projekte, Tags, Notizen, Zeiterfassung, Archiv …)  |
| REST-API für MCP      | `superprod-mcp` funktioniert unverändert; Desktop-App muss nicht laufen. Schreibzugriffe werden zu normalen Sync-Änderungen und kommen auf allen Geräten an |
| Betrieb               | Tokens je Gerät/Programm, Backups (auch aufs NAS), Schema-Migration mit Sicherungskopie, CLI, Anleitung für Pi + Tailscale                                  |

**Wichtige Eigenschaften**

- Die **Datenbank auf dem Server ist das Original**; die Apps halten nur eine Kopie
  und funktionieren auch offline.
- Erreichbar **nur im privaten Tailscale-Netz**, nicht öffentlich.
- Der Server **kennt das Sync-Passwort** (die Apps verschlüsseln immer) und speichert
  die Tabellen im Klartext.
- **Alte Daten** kommen über die App: Das erste verbundene Gerät lädt beim ersten Sync
  alles hoch, alternativ per Backup-Import.

**Nachweise:** 71 neue Server-Tests, 66 E2E-Tests der App gegen den Server
(0 Fehlschläge), MCP-Test mit echtem `superprod-mcp`. Alle bestehenden Tests
unverändert grün (identisch mit dem Stand vor den Änderungen).

**Grenzen:**

- Timer, Fokus und Status gibt es per API nur in der laufenden App (Antwort 501).
- Short-Syntax (`#tag`, `30m`) und Folgeaktionen wie Wiederholungs-Tasks werden nicht
  auf dem Server, sondern auf den Geräten ausgewertet.
- Eingefügte Bilder bleiben auf dem Gerät.
- Nicht getestet auf echtem Pi und mit den Handy-Apps.

**Weiterlesen:**

- Einrichtung Schritt für Schritt: [`readme_sqlite.md`](readme_sqlite.md)
- KI-Zugriff von überall (Claude/ChatGPT): [`superprod_mcp_roadmap.md`](superprod_mcp_roadmap.md)
- Technische Referenz: [`packages/sqlite-server/README.md`](packages/sqlite-server/README.md)
- Details: Abschnitte 1–11 unten

---

> **Fortsetzen nach Kontextverlust:** Abschnitt [7 Implementierungsplan](#7-implementierungsplan-und-status)
> zeigt den nächsten offenen Schritt; Abschnitt [9 Prüfprotokoll](#9-tests-und-prüfungen)
> die zuletzt ausgeführten Kommandos. Caches/Temp/Logs liegen unter `.local-cache/`
> (per `.git/info/exclude` ignoriert). Befehle immer mit
> `npm_config_cache=$PWD/.local-cache/npm TEMP=$PWD/.local-cache/tmp TMP=$PWD/.local-cache/tmp` ausführen.

## 1. Ziel und Abnahmekriterien

**Ziel:** Alle dauerhaft benötigten Anwendungsdaten liegen maßgeblich in einer
SQLite-Datenbank auf einem zentralen Server (Zielbetrieb: Raspberry Pi zuhause,
nur über Tailscale erreichbar). Mehrere Geräte (Desktop, Browser, Handy) nutzen
dieselben Daten; `superprod-mcp` liest und ändert sie über den Server nach
denselben Regeln wie die UI.

Entscheidungen des Auftraggebers (2026-10-09):

- Checkout: Fork in das Arbeitsverzeichnis geklont, Feature-Branch.
- Client-Datenbank (IndexedDB) bleibt **nur Cache/Outbox**; maßgeblich ist SQLite auf dem Server.
- Betrieb: Raspberry Pi + Tailscale, nicht öffentlich. SQLite-Datei auf Pi-lokalem
  Speicher; Backups auf ein Synology-NAS (Live-DB auf Netzlaufwerk wird **nicht** unterstützt, s. ADR-7).

Überprüfbare Abnahmekriterien:

| #   | Kriterium                                                                                                                                                           | Nachweis                                                                                                       | Status                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------- |
| A1  | Jede synchronisierte Änderung wird transaktional im Op-Log (`operations`) gespeichert; die relationale Projektion folgt in eigener Transaktion mit Cursor (ADR-13). | `sync-service.spec`, `projection.spec`, E2E §9.3                                                               | erfüllt                |
| A2  | Daten überstehen Server-Neustart; ein frischer Client erhält den vollständigen Stand vom Server.                                                                    | `http.spec` (Neustart), `projection.spec`, `rest-api.spec`, E2E Late-Join + Rundlauf                           | erfüllt                |
| A3  | Vorhandene Daten lassen sich nachvollziehbar übernehmen.                                                                                                            | Client-Pfad SYNC_IMPORT/BACKUP_IMPORT (E2E `archive-data-sync`, `backup-recovery`, `import-*`); Begründung §10 | erfüllt (über die App) |
| A4  | Alle synchronisierten Datenarten sind speicherbar, ladbar, änderbar, löschbar; Beziehungen bleiben erhalten.                                                        | `projection-all-models.spec`, `projection.spec`                                                                | erfüllt                |
| A5  | Konkurrierende Änderungen werden nach SuperSync-Semantik behandelt, kein stiller Datenverlust.                                                                      | `sync-service.spec`, E2E `lww-conflict`, `cross-entity`, `network-failure`                                     | erfüllt                |
| A6  | MCP-taugliche API liest aus SQLite und schreibt über die echten Reducer; Clients sehen Änderungen per Sync.                                                         | `rest-api.spec`, MCP-Lauf §9.4, E2E-Rundlauf                                                                   | erfüllt                |
| A7  | Schreibende Endpunkte nur mit Token; Bind-Default `127.0.0.1`.                                                                                                      | `http.spec`, `rest-api.spec` (Scopes)                                                                          | erfüllt                |
| A8  | Schema-Migrationen idempotent, sauberer Abbruch, Backup vor Upgrade.                                                                                                | `database.spec`                                                                                                | erfüllt                |
| A9  | Bestehende Tests ohne neu verursachte Regressionen.                                                                                                                 | §9.5                                                                                                           | erfüllt                |
| A10 | Betriebsanleitung (Pi, Tailscale, NAS-Backup, MCP).                                                                                                                 | `packages/sqlite-server/README.md`                                                                             | erfüllt                |

## 2. Bestandsaufnahme und Codemap (bestätigte Fakten)

### 2.1 Laufzeitumgebungen und Einstiegspunkte

| Laufzeit                 | Einstieg                                                                                       | Persistenz                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Web/PWA (Angular 20+)    | `src/main.ts`, `src/app/app.component.ts`                                                      | IndexedDB + localStorage im Browser                                    |
| Electron Desktop         | `electron/main.ts`, IPC `electron/ipc-handler.ts`                                              | Renderer-IndexedDB + Dateien in `userData` (Backups, Bilder)           |
| Android/iOS (Capacitor)  | `android/`, `ios/`, `capacitor.config.ts`                                                      | WebView-IndexedDB; Android-Backup in nativer SQLite (`KeyValStore.kt`) |
| SuperSync-Server         | `packages/super-sync-server/src/index.ts`                                                      | PostgreSQL via Prisma (`prisma/schema.prisma`)                         |
| Local REST API (Desktop) | `electron/local-rest-api.ts` → IPC → `src/app/core/electron/local-rest-api-handler.service.ts` | – (operiert auf NgRx-Store)                                            |

### 2.2 Datenfluss UI → Speicher (bestätigt, `src/app/README.md`)

1. UI ruft Services (z. B. `TaskService`) → dispatcht NgRx-Action mit `meta.isPersistent`.
2. Meta-Reducer-Kette `src/app/root-store/meta/meta-reducer-registry.ts` (`META_REDUCERS`):
   Phase 0 Fehler-Guard, Phase 1 `operationCaptureMetaReducer` (zählt Op), Phasen 2–7
   Bulk/Kaskaden (z. B. `taskSharedCrudMetaReducer` pflegt `project.taskIds`), Feature-Reducer.
3. `OperationLogEffects` (`src/app/op-log/capture/operation-log.effects.ts`) schreibt die
   Operation über `OperationLogStoreService` (`src/app/op-log/persistence/operation-log-store.service.ts`)
   und den Port `OpLogDbAdapter` (`op-log-db-adapter.ts`) → `IndexedDbOpLogAdapter` → IndexedDB `SUP_OPS`.
4. Laden: `OperationLogHydratorService` (`operation-log-hydrator.service.ts`) lädt Snapshot
   (`state_cache`) + Tail-Ops und dispatcht `loadAllData` bzw. Bulk-Replay.
5. Sync: `src/app/op-log/sync/*` + Provider (`packages/sync-providers/src/super-sync/super-sync.ts`):
   Upload/Download von Ops; Remote-Ops werden mit `convertOpToAction`
   (`src/app/op-log/apply/operation-converter.util.ts`) wieder durch **dieselben Reducer** geschickt.
6. Archiv (`archiveYoung`/`archiveOld`) ist **nicht** im NgRx-State; es wird von
   `ArchiveOperationHandler` (`src/app/op-log/apply/archive-operation-handler.service.ts`) als
   Nebeneffekt in die Stores `archive_young`/`archive_old` geschrieben.

### 2.3 Operation-Format (bestätigt)

`packages/sync-core/src/operation.types.ts` `Operation`: `id` (UUIDv7), `actionType`, `opType`
(`CRT|UPD|DEL|MOV|BATCH|SYNC_IMPORT|BACKUP_IMPORT|REPAIR`), `entityType`
(`packages/shared-schema/src/entity-types.ts`), `entityId`/`entityIds`, `payload`
(`{actionPayload, entityChanges}`; `entityChanges` ist fast immer `[]`, s. `OperationCaptureService.extractEntityChanges`),
`clientId`, `vectorClock`, `timestamp`, `schemaVersion`.
**Folgerung:** Ops enthalten Absichten (Action-Payloads), keine fertigen Datensätze. Eine relationale
Server-Projektion braucht die echten Reducer.

### 2.4 Bestehende Schnittstellen

- **SuperSync-HTTP-Vertrag:** `packages/shared-schema/src/supersync-http-contract.ts` (zod). Client-Aufrufe in
  `packages/sync-providers/src/super-sync/super-sync.ts`: `POST/GET /api/sync/ops`, `POST/GET /api/sync/snapshot`,
  `GET /api/sync/restore-points`, `GET /api/sync/restore/:seq`, `GET /api/sync/devices`, `POST /api/replace-token`,
  `DELETE /api/sync/data`; WebSocket `GET /api/sync/ws?token=&clientId=` (`src/app/op-log/sync/super-sync-websocket.service.ts`).
  Client erlaubt frei wählbare `baseUrl` + `accessToken` (`super-sync.model.ts`).
- **Local REST API** (Desktop, `127.0.0.1:3876`, Bearer-Token): Antwortformat `{ok,data}|{ok:false,error}`
  (`electron/shared-with-frontend/local-rest-api.model.ts`), Routen in `local-rest-api-handler.service.ts`:
  `GET /status`, `GET /focus`, `GET|POST /task-control/current`, `POST /task-control/stop`, `GET|POST /tasks`,
  `GET|PATCH|DELETE /tasks/:id`, `POST /tasks/:id/start|archive|restore`, `GET /projects`, `GET /tags`,
  Repeat-Configs (`local-rest-api-task-repeat-cfg-routes.service.ts`).
- **superprod-mcp** (`..\superprod-mcp`, nur gelesen): Python/FastMCP, nutzt ausschließlich die Local REST API;
  Basis-URL über `SP_API_URL`, Token über `SP_API_TOKEN`/`~/.sp-token/sp-token.txt` (`src/sp_mcp/client.py`).
  Tools: health, list/get/create/update/complete/start/archive/restore/delete task, list projects/tags, status, focus, stop.

### 2.5 Build/Test (bestätigt aus `package.json`, `AGENTS.md`)

`npm test` = `packages:test` (sync-core, shared-schema, sync-providers; Vitest) + `release-notes:test` + Karma
(`ng test`, TZ Berlin) + TZ LA. `npm run test:electron` (node:test). Server: `npm --prefix packages/super-sync-server test`.
E2E: Playwright `e2e/`; SuperSync-E2E erwartet Server unter `SUPERSYNC_E2E_URL` (Default `http://localhost:1901`)
mit Test-Endpunkten `/api/test/create-user|cleanup|user/:id` (`e2e/utils/supersync-helpers.ts`).
Lint: `npm run checkFile <files>`; `npm run lint`.

### 2.6 Arbeitsverzeichnis-Prüfung

- Symlinks im Repo: `CLAUDE.md`, `e2e/CLAUDE.md`, `e2e/store-video/CLAUDE.md` → relativ auf `AGENTS.md` (intern).
- `node_modules/@sp/*` sind Workspace-Links auf `packages/*` innerhalb des Arbeitsverzeichnisses.
- npm-Cache, Temp, Electron-/Playwright-Caches: `.local-cache/` (per Umgebungsvariablen gesetzt).
- Husky (`prepare`) setzt `core.hooksPath` nur in der lokalen `.git/config` dieses Checkouts.

## 3. Bestätigte Fakten, Schlussfolgerungen, offene Fragen

**Fakten**

- F1 Upstream hat eine native SQLite-Op-Log-Variante entfernt und „geparkt“ (`docs/sync-and-op-log/sqlite-migration.md`); sie zielte nur auf lokale Mobil-Persistenz, nicht auf zentralen Betrieb.
- F2 Der SuperSync-Server ist Postgres-spezifisch (Arrays, GIN, `FOR UPDATE`, `GREATEST`, Raw-SQL in 8 Dateien).
- F3 Node 24 enthält `node:sqlite` (`DatabaseSync`); keine native Zusatzabhängigkeit nötig (ARM-tauglich).
- F4 Spike (2026-10-09, `.local-cache/spike/`): App-Reducer + `META_REDUCERS` laufen in Node, gebündelt mit esbuild
  (+ `@angular/compiler`, Shims für `window`/`localStorage`/`document`). `addTask` erzeugt Task **und** Kaskade in `project.taskIds`.
- F5 Archiv-Logik hängt an Angular-DI (`TaskArchiveService`, `TimeTrackingService`, `ArchiveDbAdapter`).
- F6 E2E-SuperSync-Tests aktivieren standardmäßig E2E-Verschlüsselung (`getSuperSyncConfig`).
- F7 Der Client erzwingt SuperSync-Verschlüsselung (`isEncryptionMandatory`); Payload = `encrypt(JSON.stringify(payload), passwort)` (`src/app/op-log/sync/operation-encryption.service.ts`).
- F8 Der echte `ArchiveOperationHandler` läuft per Angular-DI in Node (Spike + `projection.spec.ts`).
- F9 Clients wenden Remote-Ops über `bulkApplyOperations` + `bulkOperationsMetaReducer` an und filtern nebenläufige Ops gegen den letzten Import (`SyncImportFilterService`).
- F10 Electron setzt `Access-Control-Allow-Origin: *` selbst (`electron/main-window.ts:302`); Mobil-Apps nutzen natives HTTP → CORS nur für Browser auf fremden Origins relevant.

**Schlussfolgerungen**

- S1 Ein SuperSync-kompatibler Server ermöglicht Mehrgeräte-Betrieb **ohne** Client-Umbau.
- S2 Relationale Projektion und MCP-Schreibzugriffe mit identischen Regeln sind durch serverseitige Ausführung der echten Reducer erreichbar (F4).
- S3 (revidiert nach F7) Verschlüsselung kann nicht abgeschaltet werden, ohne Store-Apps zu ersetzen → der Server entschlüsselt mit dem Nutzerpasswort (ADR-9).

**Offene Fragen (Stand: beantwortet bzw. entschieden)**

- Q1 Laufzeit-Endpunkte (`/status`, `/focus`, `/task-control/*`, `/tasks/:id/start`): Der aktuelle Task ist UI-Laufzeitzustand eines Geräts (`currentTaskId` im Task-Slice, nicht geräteübergreifend sinnvoll) → 501 `NOT_AVAILABLE_ON_SERVER` (ADR-16).
- Q2 Eingefügte Bilder: werden heute nicht synchronisiert; zentrale Ablage braucht Client-Änderungen → S-E offen (§11).
- Q3 Client-DB-Rolle: vom Auftraggeber entschieden – IndexedDB nur Cache/Outbox.
- Q4 Betrieb: vom Auftraggeber entschieden – Raspberry Pi + Tailscale; NAS nur als Backup-Ziel.

## 4. Inventar dauerhaft benötigter Daten

Alle Spalten „Ziel (SQLite)“ sind umgesetzt (Migration 2, `packages/sqlite-server/src/db/migrations.ts`). Jede Datenart steht zusätzlich verlustfrei als JSON in `entity_data` (Entitäten) bzw. `projection_model` (übrige Modellteile) – daraus wird nach einem Neustart der exakte App-Zustand ohne Replay rekonstruiert. Maßgeblich bleibt `operations` (Op-Log); alle Tabellen sind daraus neu aufbaubar.

| Daten                                      | Modell / Quelle                                                  | Heutiger Speicherort (Client)                      | Ziel (SQLite)                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Tasks, Subtasks, Zeit je Tag, Issue-Felder | `task` (`MODEL_CONFIGS`, `src/app/op-log/model/model-config.ts`) | IndexedDB `SUP_OPS` (`ops`, `state_cache`)         | `task`, `task_tag`, `task_subtask`, `task_time_spent` (bucket `live`)                         |
| Projekte inkl. Task-/Backlog-Reihenfolge   | `project`                                                        | wie oben                                           | `project`, `project_task` (list `today`/`backlog`, `position`)                                |
| Tags inkl. Reihenfolge                     | `tag` (TODAY virtuell, ADR #2 upstream)                          | wie oben                                           | `tag`, `tag_task`                                                                             |
| Notizen                                    | `note`                                                           | wie oben                                           | `note`                                                                                        |
| Sections                                   | `section`                                                        | wie oben                                           | `section`, `section_task`                                                                     |
| Boards                                     | `boards`                                                         | wie oben                                           | `board` (+ Panels in `projection_model`)                                                      |
| Menübaum                                   | `menuTree`                                                       | wie oben                                           | `projection_model`                                                                            |
| Planer                                     | `planner`                                                        | wie oben                                           | `planner_day`                                                                                 |
| Globale Einstellungen                      | `globalConfig`                                                   | wie oben                                           | `global_config` (je Abschnitt)                                                                |
| Wiederholungen                             | `taskRepeatCfg`                                                  | wie oben                                           | `task_repeat_cfg`                                                                             |
| Erinnerungen                               | `reminders`                                                      | wie oben                                           | `reminder`                                                                                    |
| Zeitaufzeichnung je Projekt/Tag/Tag        | `timeTracking`                                                   | wie oben                                           | `time_tracking` (bucket `live`)                                                               |
| Archiv jung/alt (erledigte Tasks + Zeit)   | `archiveYoung`, `archiveOld`                                     | `SUP_OPS.archive_young/old`                        | `task*`/`time_tracking` mit bucket `young`/`old`                                              |
| Issue-Provider-Konfiguration               | `issueProvider`                                                  | `SUP_OPS`                                          | `issue_provider` (+ JSON; kann Zugangsdaten enthalten → Server-Schutz, §11)                   |
| Metriken/Auswertungen                      | `metric`                                                         | `SUP_OPS`                                          | `metric`                                                                                      |
| Simple Counter                             | `simpleCounter`                                                  | `SUP_OPS`                                          | `simple_counter`, `simple_counter_day`                                                        |
| Plugin-Nutzerdaten / -Metadaten            | `pluginUserData`, `pluginMetadata`                               | `SUP_OPS`                                          | `plugin_data` (kind `user_data`/`metadata`)                                                   |
| Verlauf/History                            | Op-Log                                                           | `SUP_OPS.ops` (lokal kompaktiert)                  | `operations` (vollständig, keine Retention)                                                   |
| Eingefügte Bilder                          | `ClipboardImageService`                                          | IndexedDB `sp-clipboard-images` / Electron-Dateien | **offen** (S-E): nicht Teil des Sync-Modells                                                  |
| Sync-Zugangsdaten                          | `credential-store.service.ts`                                    | IndexedDB `sup-sync`                               | bleibt gerätelokal (Geheimnis je Gerät)                                                       |
| Plugin-Secrets / OAuth-Tokens              | `plugin-secret-store.ts`, `plugin-oauth-token-store.ts`          | IndexedDB `sup-plugin-secrets`, `sup-plugin-oauth` | bleibt gerätelokal                                                                            |
| Eigene Themes                              | `theme-storage.service.ts`                                       | IndexedDB `SUPThemes`                              | bleibt gerätelokal (Darstellung)                                                              |
| Client-ID, Vektoruhr, Snapshot-Cache       | `SUP_OPS.client_id`, `vector_clock`, `state_cache`               | IndexedDB                                          | gerätelokal (Cache-Metadaten des Clients)                                                     |
| UI-Präferenzen                             | `LS` in `src/app/core/persistence/storage-keys.const.ts`         | localStorage                                       | gerätelokal (bewusst)                                                                         |
| Lokale Backups (Desktop/Android)           | `electron/backup.ts`, `KeyValStore.kt`                           | Dateien `userData/backups`, native SQLite          | gerätelokal; Server-Backups (`SP_BACKUP_DIR`) ersetzen sie funktional                         |
| Legacy-Daten (pfapi)                       | `legacy-pf-db.service.ts`                                        | IndexedDB `pf`                                     | einmalige Migration im Client (unverändert)                                                   |
| Server-eigene Daten                        | –                                                                | –                                                  | `users`, `api_tokens`, `sync_state`, `sync_devices`, `projection_status`, `schema_migrations` |

Kategorien: **synchronisiert** (alle `MODEL_CONFIGS`-Slices) → maßgeblich SQLite-Server;
**gerätelokal** (Geheimnisse, Darstellung, Caches) → bleibt bewusst lokal; **offen** → Bilder.

## 5. Architekturentscheidungen (ADR)

- **ADR-1 Zentraler Server statt SQLite im Browser.** SQLite im Browser (WASM/OPFS) bliebe gerätelokal und löst Mehrgeräte/MCP nicht.
- **ADR-2 SuperSync-kompatibles Protokoll.** Clients (Web, Desktop, Mobil) bleiben unverändert und offline-fähig; IndexedDB ist nur Cache/Outbox (Auftraggeber-Entscheid). Server vergibt `serverSeq`, erkennt Konflikte, baut neue Geräte auf.
- **ADR-3 Neues Paket statt Port des Postgres-Servers.** `packages/sqlite-server`: Node 24, `node:sqlite`, `node:http`, keine Laufzeitabhängigkeit außer Workspace-Paketen (`@sp/shared-schema`, `@sp/sync-core`). Semantik der Referenz (`packages/super-sync-server`) wird übernommen und mit eigenen Tests sowie den unveränderten E2E-SuperSync-Specs belegt.
- **ADR-4 Speicherung: Op-Log (maßgeblich, append-only) + relationale Projektion.** `operations` garantiert verlustfreie Historie, Konfliktprüfung und Wiederaufbau. Die Projektion (typisierte Tabellen je Datenart, Join-Tabellen für Beziehungen/Reihenfolgen mit `position`, `entity_data`/`projection_model` als exakte JSON-Kopie für verlustfreie Neustarts) dient Abfragen und der API. Sie ist jederzeit aus dem Op-Log neu aufbaubar (`POST /api/v1/projection/rebuild`). Ein reines JSON-Gesamtstand-Blob wurde verworfen: gezielte Abfragen, Teil-Updates und MCP-Zugriffe wären nicht möglich.
- **ADR-5 Gleiche Regeln für MCP und UI.** Server führt die echten App-Reducer aus (F4). MCP-Schreibzugriffe erzeugen Actions → Reducer → reguläre Ops mit eigener Server-`clientId` → Clients übernehmen sie per Sync.
- **ADR-6 Zugriffskontrolle.** Bearer-Tokens (gehasht in SQLite), getrennt nach Rolle `sync` und `api` (MCP, optional nur lesend). Bind-Default `127.0.0.1`; Tailscale (`tailscale serve`) übernimmt Netz/TLS. Kein öffentliches Internet.
- **ADR-7 Speicherort.** Live-DB nur auf lokalem Dateisystem (WAL). Netzlaufwerke (SMB/NFS, Synology) nur als Backup-Ziel (`VACUUM INTO`/Online-Backup, rotierend).
- **ADR-8 Versionskopplung.** Server-Reducer-Bundle und Clients stammen aus demselben Stand; Server lehnt Ops mit höherer `schemaVersion` als seiner eigenen ab (Projektion), speichert sie aber nicht ohne Prüfung.
- **ADR-9 Server kennt das Sync-Passwort.** Fakt: Der Client erzwingt SuperSync-Verschlüsselung (`isEncryptionMandatory`, `src/app/imex/sync/snapshot-upload.service.ts:257`, `import-encryption-handler.service.ts:95`). Damit unveränderte Store-Apps (Android/iOS) funktionieren, entschlüsselt der Server Payloads mit dem Nutzerpasswort (gleiche Bibliothek `@sp/sync-core` `decrypt`/`encrypt`, Argon2id + AES-GCM) für Projektion/MCP und verschlüsselt eigene (MCP-)Ops wieder. Passwort liegt in einer Datei mit restriktiven Rechten (`SP_ENCRYPTION_KEY_FILE`). Alternative (Client-Fork ohne Pflicht-Verschlüsselung) verworfen: erfordert Eigenbau-Apps auf allen Geräten.
- **ADR-10 Ein Prozess, synchrone Transaktionen.** `node:sqlite` ist synchron; jede Upload-Anfrage läuft komplett in einem `BEGIN IMMEDIATE`-Block in einem JS-Turn → Schreiber sind strikt serialisiert (ersetzt RepeatableRead + Row-Lock der Postgres-Referenz). Asynchrone Arbeit (Entschlüsselung) erfolgt **vor** der Transaktion. Eine Prozess-Sperrdatei (`<db>.lock`) verhindert eine zweite Server-Instanz auf derselben Datei.
- **ADR-11 Konfliktsuche ohne GIN.** Tabelle `operation_entities(user_id, entity_type, entity_id, server_seq)` hält Skalar-ID ∪ `entityIds` jeder Op; „letzte Op je Entität“ = ein Index-Seek. Entscheidungslogik 1:1 aus `packages/super-sync-server/src/sync/conflict.ts` portiert.
- **ADR-12 Keine Quoten/Retention.** Selbst gehostet: kein Speicherkontingent (Status meldet sehr großes Kontingent), kein Löschen alter Ops (vollständige Historie bleibt). Rate-Limits entfallen (nur Tailnet-Zugriff).
- **ADR-13 Projektion nach dem Commit (Projektor).** Fakt: Die Archiv-Logik der App ist asynchron (`ArchiveOperationHandler`). Darum wird nicht in der Upload-Transaktion projiziert, sondern ein global serialisierter Projektor (`src/projection/projector.ts`) liest Ops ab `projection_status.applied_seq`, entschlüsselt, wendet sie an und schreibt Tabellen-Diff + Cursor in **einer** Transaktion. Optimistische Prüfung (Cursor/Reset-Generation) verhindert, dass ein gleichzeitiger Clean-Slate mit veralteten Daten überschrieben wird. Sync scheitert nie an der Projektion; API-Lesezugriffe holen vorher auf (Read-your-writes).
- **ADR-14 Engine aus App-Quellen.** `packages/sqlite-server/engine/entry.ts` bündelt (esbuild) die echten Reducer + Meta-Reducer, `convertOpToAction`, `bulkApplyOperations`, `replayOperationBatch` (sync-core), Schema-Migrationen (shared-schema) und den `ArchiveOperationHandler` samt Archiv-Services per Angular-DI (Store/ArchiveDbAdapter/LockService durch Server-Implementierungen ersetzt). Der SYNC_IMPORT-Filter (`classifyOpAgainstSyncImport`) wird wie im `SyncImportFilterService` angewandt. Keine Domänenregel ist im Server nachgebaut.
- **ADR-15 Server als Sync-Client für API-Schreibzugriffe.** REST/MCP-Schreiben erzeugt App-Actions → Op mit `clientId = sp_sqlite_server`, Vektoruhr = Merge der letzten Uhren aller berührten Entitäten + letzter Import + eigener Zähler (dominiert → keine Server-Konflikte; Clients lösen Konflikte mit eigenen ausstehenden Änderungen regulär). Payload wird mit dem Nutzerpasswort verschlüsselt, wenn der Nutzer verschlüsselt synchronisiert. Gespeichert über denselben Upload-Pfad (Validierung, Konfliktprüfung).
- **ADR-16 REST-API = Local-REST-API-Vertrag.** `/api/v1/*` übernimmt Pfade, Envelope, erlaubte Felder, Fehlercodes und Deadline-Logik von `local-rest-api-handler.service.ts`, damit `superprod-mcp` unverändert funktioniert (`SP_API_URL=<server>/api/v1`). Laufzeit-Endpunkte einer App-Instanz → 501.

## 6. Zielarchitektur (umgesetzt)

```
 Browser/PWA ─┐                          Raspberry Pi (Tailscale: https://<pi>.<tailnet>.ts.net)
 Desktop  ────┼── SuperSync-HTTP+WS ──▶ tailscale serve ─▶ sp-sqlite-server (127.0.0.1:1902)
 Android/iOS ─┘   (verschlüsselt)                          │
 superprod-mcp ── /api/v1 (Local-REST-Vertrag) ──────────▶ │
                                                           ├─ /api/sync/*   Upload/Download/Snapshot (Op-Log, Konflikte)
                                                           ├─ /api/sync/ws  Push (new_ops, Presence)
                                                           ├─ Projektor ── Engine (App-Reducer, Archiv, Migrationen)
                                                           ├─ /api/v1/*     lesen: Projektion; schreiben: Action → Op
                                                           └─ /             Web-App (SP_WEB_ROOT) oder Token-Hinweis
                                                           ▼
             SQLite (WAL, lokal):  operations (maßgeblich) · users · api_tokens · sync_state · sync_devices
                                   task* · project* · tag* · note · section* · task_repeat_cfg · reminder ·
                                   time_tracking · planner_day · board · global_config · simple_counter* ·
                                   issue_provider · metric · plugin_data · entity_data · projection_model
                                   ──▶ periodische Online-Backups → NAS (SP_BACKUP_DIR)
```

Datenfluss: Gerät ändert (auch offline) → Op in IndexedDB (Outbox) → Upload → Validierung + Konfliktprüfung → `operations` (Commit) → WebSocket-Push an andere Geräte → Projektor entschlüsselt und wendet die App-Reducer an → Tabellen. API-Schreiben: Action → Reducer → Op (Server-Client, verschlüsselt) → derselbe Upload-Pfad → Geräte laden sie wie jede Remote-Op.

## 7. Implementierungsplan und Status

| Schritt | Inhalt                                                                                                                                                                                                                                             | Abhängig von | Status                                         |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------- |
| S0      | Checkout, Bestandsaufnahme, Baseline, Roadmap                                                                                                                                                                                                      | –            | abgeschlossen                                  |
| S1      | `packages/sqlite-server`: DB-Schicht (versionierte Migrationen, Backup vor Migration), Transaktionen, Nutzer/Tokens/Scopes, CLI, Online-Backup, Prozess-Sperre                                                                                     | S0           | abgeschlossen                                  |
| S2      | SuperSync-Protokoll: Upload (Validierung, Konflikte, Dedup, Clean-Slate, Full-State, Fences, REPAIR), Download (Gaps, Fast-Forward, Snapshot-Uhr), Snapshot, Status, Devices, Restore-Points, Delete, replace-token, WebSocket (new_ops, Presence) | S1           | abgeschlossen                                  |
| S3      | Test-Endpunkte (`SP_TEST_MODE`) + vorhandene SuperSync-E2E gegen SQLite-Server                                                                                                                                                                     | S2           | abgeschlossen (Ergebnisse §9.3)                |
| S4      | Engine-Bundle aus App-Quellen, Projektor, relationale Tabellen, verlustfreier Neustart, Rebuild, Archiv, Import-Filter, Entschlüsselung                                                                                                            | S2           | abgeschlossen                                  |
| S5      | REST-API `/api/v1` (Local-REST-Vertrag) für MCP; Schreiben über Reducer → verschlüsselte Ops                                                                                                                                                       | S4           | abgeschlossen                                  |
| S6      | Datenübernahme über den validierten Client-Pfad (Erst-Sync = SYNC_IMPORT; oder Backup-Import in der App)                                                                                                                                           | S2, S4       | abgeschlossen (Begründung §10)                 |
| S7      | Betrieb: NAS-Backups, Web-App-Auslieferung, Token-Hinweisseite, systemd/Tailscale-Anleitung (`packages/sqlite-server/README.md`)                                                                                                                   | S2           | abgeschlossen                                  |
| S8      | Abschlussprüfung: Testsuite, Lint, Build, Roadmap                                                                                                                                                                                                  | S1–S7        | abgeschlossen (§9.5; offener Überlast-Absturz) |
| S-E     | Zentrale Ablage eingefügter Bilder                                                                                                                                                                                                                 | –            | offen (erfordert Client-Änderungen, §11)       |

## 8. Änderungen je Schritt

### S1/S2 – Paket `packages/sqlite-server` (neu)

- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` — Workspace-Paket `@sp/sqlite-server`; Laufzeit-Abhängigkeiten nur `@sp/shared-schema`, `@sp/sync-core`; devDependencies `typescript`, `vitest`, `@types/node`, `esbuild` (im Repo bereits vorhandene Versionen). Keine Root-Abhängigkeit geändert (AGENTS.md). `package-lock.json`: nur Einträge des neuen Pakets (eine ungewollte `magic-string`-Hebung anderer Pakete wurde zurückgenommen).
- `src/db/migrations.ts` — v1 Sync-Kern (`users`, `api_tokens`, `sync_state`, `operations`, `operation_entities`, `sync_devices`), v2 Projektion (§4).
- `src/db/database.ts` — WAL, `synchronous=FULL`, Foreign Keys, Busy-Timeout; Migrationen je in eigener Transaktion, Abbruch bei neuerer DB, `VACUUM INTO`-Kopie vor dem Upgrade einer bestehenden DB; `transaction()` nur synchron.
- `src/db/backup.ts`, `src/db/process-lock.ts`, `src/auth/tokens.ts`.
- `src/sync/*` — portierte SuperSync-Semantik (Quellen im Dateikopf).
- `src/http/{body,router,websocket,static-files,info-page}.ts`, `src/app.ts`, `src/config.ts`, `src/index.ts`, `src/cli.ts`.

### S4 – Projektion

- `engine/entry.ts`, `engine/node-shims.js`, `scripts/build-engine.js` — Engine-Bundle `dist/engine/sp-engine.cjs` (+ `engine-build.json` mit Git-Revision).
- `src/engine/{engine-api,engine-loader}.ts`, `src/projection/{model-map,projection-store,projector,projection-module,encryption-keys}.ts`.
- Verhalten: Nach jedem Upload holt der Projektor auf; nach Engine-Wechsel (Revision/Schema) automatischer Neuaufbau; `GET /api/v1/projection/status`, `POST /api/v1/projection/rebuild`, CLI `projection status|rebuild`.

### S5 – REST-API

- `src/api/{rest-api,server-writer,uuidv7}.ts` — `/api/v1/health|tasks|tasks/:id|tasks/:id/archive|restore|projects|tags` (+ 501 für Laufzeit-Endpunkte).

### Sonstige Repo-Dateien

- `packages/README.md` — Paket in Zuständigkeits- und Prüftabelle.
- `e2e/tests/sync/sqlite-server-roundtrip.spec.ts` — neuer E2E-Rundlauf (nur gegen den SQLite-Server, sonst skip).
- `sqlite-roadmap.md` — dieses Dokument.
- Keine Änderung an App-Code (`src/`), Electron, Mobile oder bestehenden Tests.

## 9. Tests und Prüfungen

### 9.1 Baseline (vor Änderungen, `71eb778`, 2026-10-09)

| Kommando                               | Ergebnis                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm ci`                               | ok                                                                                                                                         |
| `npm run packages:test`                | ok: sync-core 273/273, shared-schema 95/95, sync-providers 450/450                                                                         |
| `npm run release-notes:test`           | ok                                                                                                                                         |
| `npm run test:electron`                | ok: 329/329                                                                                                                                |
| `npm run test:fast` (Karma, TZ Berlin) | ok: 16858/16860, 2 skipped, 0 failed                                                                                                       |
| `npm ls --all`                         | 82 „invalid“-Meldungen schon im Upstream-Lockfile (z. B. `tsup` erwartet esbuild ^0.27, installiert 0.28.2); keine betrifft das neue Paket |

### 9.2 Neue Unit-/Integrationstests (`npm --prefix packages/sqlite-server test`, echte SQLite-Dateien unter `packages/sqlite-server/tests/.tmp`)

| Datei                           | Inhalt                                                                                                                                                                                                                                                                                                                                                                                       | Ergebnis     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `database.spec.ts`              | WAL/FK, Neustart, idempotente Migration, fehlgeschlagene + wiederholte Migration (Rollback), neuere DB verweigert, Transaktions-Rollback, async-Callback verweigert, Online-Backup + Rotation, Prozess-Sperre, Backup vor Migration                                                                                                                                                          | ok           |
| `tokens.spec.ts`                | Hash-Speicherung, Widerruf, Neustart, Scopes                                                                                                                                                                                                                                                                                                                                                 | ok           |
| `sync-service.spec.ts`          | Seq-Vergabe, Neustart, excludeClient/Paging, Duplikate, CONCURRENT/SUPERSEDED, Multi-Entity, Zeit-Deltas, Einzel-Validierung, 400/413, Gap-Erkennung, Full-State-Fast-Forward + Snapshot-Uhr, SYNC_IMPORT_EXISTS/idempotent, Clean-Slate ohne Seq-Wiederverwendung, Replacement-Fence, REPAIR, Request-Dedup, Rollback aller Ops bei Fehler, Nutzer-Isolation, Status/Devices/Restore-Points | ok           |
| `http.spec.ts`                  | Auth 401/403, gzip + Base64-gzip, 400/415/413 (Zip-Bombe), Neustart, zweite Instanz verweigert, CORS-Allowlist, replace-token, Test-Routen nur im Testmodus, Konfig-Sicherheit, CLI, Web-App-Auslieferung inkl. Traversal-Schutz, Token-Hinweisseite                                                                                                                                         | ok           |
| `websocket.spec.ts`             | Handshake, new_ops nur an andere Geräte, 4003 bei falschem Token, Presence-Relay + Late-Join + Producer-Disconnect                                                                                                                                                                                                                                                                           | ok           |
| `projection.spec.ts`            | Tasks/Subtasks/Projekt-Relationen, Neustart ohne Replay, Entschlüsselung + needs_key + falsches Passwort, Archiv (echter ArchiveOperationHandler), Import-Filter (SYNC_IMPORT-Semantik), Clean-Slate-Reset, Rebuild = inkrementell, Engine-Absturz ohne Teil-Schreiben                                                                                                                       | ok           |
| `rest-api.spec.ts`              | Scopes, Lesen verschlüsselter Handy-Daten, Anlegen/Ändern/Erledigen/Löschen inkl. Zustellung an das Gerät als verschlüsselte Op, Validierung wie Desktop-API, Subtasks, Archiv/Restore, Deadlines, 501, fehlendes Passwort → 503, Neustart                                                                                                                                                   | ok           |
| `projection-all-models.spec.ts` | Jede Datenart (Tasks, Subtasks, Tags, Projekte, Notizen, Sections, Wiederholungen, Counter, Issue-Provider, Metriken, Erinnerungen, Planer, Zeitaufzeichnung, Boards, Konfiguration, Plugin-Daten, Archiv inkl. Zeit) gespeichert → nach Neustart exakt geladen → geändert (App-Action) → durch Import gelöscht                                                                              | ok           |
| **Summe**                       |                                                                                                                                                                                                                                                                                                                                                                                              | **71/71 ok** |

Typprüfung `npm --prefix packages/sqlite-server run typecheck`: ok. Lint/Format `npm run checkFile` für alle neuen `.ts`/`.js`-Dateien: ok.

Gefundene und behobene Fehler: (1) Prozess-Sperre ließ eine zweite Instanz im selben Prozess zu. (2) Vektoruhr von API-Ops für **neue** Entitäten basierte nur auf dem letzten Import statt auf allen gespeicherten Ops und war damit nebenläufig zu Geräte-Ops (im E2E-Rundlauf gefunden) → Uhr = Merge aller Op-Uhren + eigener Zähler; Regressionstest in `rest-api.spec.ts`. (3) Fehlende Test-Endpunkte für die Upstream-E2E. Außerdem korrigierte Testannahmen (asynchrones Aufholen, Port nach Neustart, Titel-Präfix der Simulations-Clients, Today-Ansicht).

### 9.3 E2E gegen den SQLite-Server (unveränderte Upstream-Specs, Chromium, Client-Verschlüsselung aktiv)

Ablauf (reproduzierbar, alles unter `.local-cache/`):

```bash
npm --prefix packages/sqlite-server run build
SP_TEST_MODE=true SP_PORT=1901 SP_CORS_ORIGINS=http://localhost:4242 \
  SP_SQLITE_DB=.local-cache/e2e/e2e.sqlite \
  SP_TEST_DEFAULT_ENCRYPTION_PASSWORD=e2e-default-encryption-pw \
  node packages/sqlite-server/dist/src/index.js &
PLAYWRIGHT_BROWSERS_PATH=.local-cache/playwright E2E_REQUIRE_SUPERSYNC=true \
  npx playwright test --config e2e/playwright.config.ts --workers=3 --retries=0 <specs>
```

| Lauf                  | Specs                                                                                                                                                                                         | Ergebnis                                                                                                                                                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (nur Sync)          | `supersync.spec.ts`                                                                                                                                                                           | 10/10 ok                                                                                                                                                                                                                                                                                              |
| 2 (nur Sync)          | 12 Specs (models, lww-conflict, late-join, cascade-delete, import-clean-slate, lastseq-preservation, network-failure, encryption, archive-data-sync, planner, account-reset, backup-recovery) | 46/47; 1 Fehlschlag durch fehlenden Test-Endpunkt `/api/test/user/:id/ops` → ergänzt                                                                                                                                                                                                                  |
| 3 (Sync + Projektion) | 19 Specs (Lauf 1 + 2 + realtime-push, archive-subtasks, cross-entity, multi-select-bulk, plugin-user-data, import-other-client-ops)                                                           | **66 ok, 1 skipped** (Provider-Wechsel WebDAV→SuperSync braucht zusätzlich WebDAV), 0 failed. Projektor danach: 59 Nutzer `ok` mit 0 übersprungenen Ops; 8 Nutzer `needs_key` = genau die Tests mit eigenem Verschlüsselungspasswort (7× `supersync-encryption`, 1× `lww-conflict`) → korrekt erkannt |
| 4                     | `supersync-network-failure.spec.ts` (nach Ergänzung des Test-Endpunkts)                                                                                                                       | 9/9 ok                                                                                                                                                                                                                                                                                                |
| 5                     | `sqlite-server-roundtrip.spec.ts` (neu): UI → SQLite-Projektion → REST-API-Schreiben → UI → frisches Gerät                                                                                    | ok (nach Uhren-Fix, s. o.)                                                                                                                                                                                                                                                                            |

### 9.4 MCP-Kompatibilität

Unverändertes `superprod-mcp` (Python, eigenes venv, nur lesend ausgeführt, `PYTHONDONTWRITEBYTECODE=1`) gegen den Server (`SP_API_URL=http://127.0.0.1:1903/api/v1`, `api-write`-Token): `health`, `list_projects`, `create_task` (inkl. Subtask), `list_tasks(today=True)`, `update_task`, `complete_task`, `archive_task`, `list_tasks(source=archived)`, `restore_task`, `delete_task` → alle erfolgreich; `get_status` → erwartetes 501. In SQLite: 7 Ops des Server-Clients, Projektion `ok`, `applied_seq` 7. Skript: `.local-cache/mcp-test/drive.py`.

### 9.5 Abschlussprüfung (S8, 2026-10-09, gegen Baseline §9.1)

Logs unter `.local-cache/final/`. Kommandos wie in §9.1, nacheinander ohne parallele Last.

| Kommando                                                      | Ergebnis                                                           | Baseline  |
| ------------------------------------------------------------- | ------------------------------------------------------------------ | --------- |
| `npm run packages:test`                                       | ok: sync-core 273/273, shared-schema 95/95, sync-providers 450/450 | identisch |
| `npm run release-notes:test`                                  | ok                                                                 | identisch |
| `npm run test:electron`                                       | ok: 329/329                                                        | identisch |
| `npm run test:fast` (Karma, TZ Berlin)                        | ok: 16858/16860, 2 skipped, 0 failed                               | identisch |
| `npm --prefix packages/sqlite-server run typecheck` / `build` | ok                                                                 | –         |
| `npm --prefix packages/sqlite-server test`                    | 71/71 ok, 10 Läufe ohne Last alle grün                             | –         |
| `npm run checkFile` (geänderte Testdateien)                   | ok                                                                 | –         |

Nicht ausgeführt: `npm run lint` / Frontend-Build (kein App-Code geändert, neue Dateien per `checkFile` geprüft).

Hinweise:

- **`npm test` (ohne `test:fast`) bricht beim Karma-Bundle mit „JavaScript heap out of memory“ ab** (Default-Heap ~4 GB, mit Coverage/Source-Maps). Betrifft nur `src/**/*.spec.ts`, also unabhängig von diesem Branch; vermutlich Ursache des PC-Absturzes während des ersten S8-Laufs. Deshalb Vergleich über `test:fast` wie in der Baseline.
- **Behobener Test-Flake „bad port“:** Tests starten den Server auf `port: 0`; der dynamische Portbereich von Windows beginnt hier bei 1024 (`netsh int ipv4 show dynamicport tcp`), sodass das OS gelegentlich einen von `fetch` gesperrten Port (z. B. 6000, 6665–6669, 10080) vergab. Neuer Helfer `startTestServer` (`tests/helpers.ts`) startet in dem Fall neu. Produktiv irrelevant (fester Port).
- **Offen: seltener nativer Worker-Absturz unter Überlast** (Exit `0xC0000409`, ohne jede Ausgabe, Node v24.15.0, Windows). Tritt nur auf, wenn mehrere HTTP-Specs (`http`, `rest-api`, `websocket`) gemeinsam in stark überlasteten Läufen laufen (5–6 Suiten parallel oder parallel zum Karma-Build): ca. 5 % der Läufe. Nicht reproduzierbar: ohne Last (10/10 grün), je Datei einzeln unter gleicher Last (0/144), Server-Start/Fetch/Stop in reinem Node (1200 Zyklen, 8 Prozesse parallel). Gegenprobe `sync-core` unter gleicher Last: 0/36. Ursache unklar (Kandidaten: `node:sqlite`, Socket-Abbau beim Wechsel der Testdateien, Vitest-Worker unter Windows); auf dem Pi (Linux) noch nicht geprüft.

## 10. Migrationskonzept und Fehlerbehandlung

- **SQLite-Schema:** `schema_migrations(version, name, applied_at)`; Migrationen nummeriert, je in eigener `BEGIN IMMEDIATE`-Transaktion; Fehler → Rollback, Server startet nicht, nächster Start versucht dieselbe Version erneut. Vor dem Upgrade einer bestehenden DB: `VACUUM INTO <db>.pre-v<N>-<zeit>.sqlite`. Neuere DB als Server → Start verweigert (kein Downgrade).
- **Bestandsdaten (S6):** Übernahme über den **validierten Client-Pfad**: (a) Gerät mit den Daten zuerst verbinden – der erste Sync lädt den Gesamtstand als `SYNC_IMPORT` hoch (inkl. Archiv); (b) alternativ Backup-JSON in einer App importieren (`BackupService.importCompleteBackup`: Legacy-Migration, Typia-Validierung, Reparatur) und synchronisieren. Ein Server-CLI-Import wurde bewusst **nicht** gebaut: Validierung/Reparatur der App beruhen auf typia-Transformern, die im Server-Bundle nicht laufen; ungeprüfte Daten würden an alle Geräte verteilt (vgl. #8279).
- **Projektion:** Cursor `projection_status.applied_seq` + Tabellen-Diff in einer Transaktion; Absturz → nächster Lauf setzt am Cursor fort. Engine- oder Schemawechsel → automatischer Neuaufbau. Status `needs_key` (Passwort fehlt/falsch), `blocked` (Op mit neuerem Schema als der Server → Server aktualisieren), `error`. Vom Reducer abgelehnte Ops werden wie auf den Clients übersprungen und gezählt (`skipped_ops`).
- **Unterbrochener Upload:** gesamte Anfrage in einer Transaktion; Fehler → alle Ops `INTERNAL_ERROR`, Client wiederholt; nichts halb gespeichert.
- **Wiederherstellung:** Backup-Datei zurückkopieren (README); Geräte laden ihre späteren Ops erneut hoch.

## 11. Bekannte Einschränkungen und verbleibende Arbeiten

- **Server kennt das Sync-Passwort (ADR-9).** Schutz über Tailscale, Dateirechte (`chmod 600`), optional Festplattenverschlüsselung des Pi. Die Projektionstabellen enthalten Klartext (ggf. auch Zugangsdaten aus Issue-Provider-Konfigurationen).
- **Laufzeit-Endpunkte** (`/status`, `/focus`, `/task-control/*`, `/tasks/:id/start`) gibt es nur in einer laufenden App → 501.
- **Short-Syntax** (`#tag`, `+projekt`, `30m` im Titel) werten nur Client-Effects aus; API-Titel bleiben wörtlich. Neue API-Tasks landen im angegebenen bzw. Standard-Projekt statt im „aktiven Kontext“.
- **Effects laufen nicht auf dem Server.** Folgeaktionen, die Clients per Effect erzeugen (z. B. Wiederholungs-Tasks), entstehen weiterhin auf den Geräten und kommen per Sync.
- **`modified`-Zeitstempel** setzen die App-Reducer beim Anwenden (`task-shared-crud.reducer.ts:342/631`) – auf jedem Gerät und im Server leicht unterschiedlich (bestehendes App-Verhalten).
- **Server-seitige Wiederherstellung (`GET /api/sync/restore/:seq`)** antwortet wie der Referenzserver bei verschlüsselten Daten mit `ENCRYPTED_OPS_NOT_SUPPORTED`; Wiederherstellung erfolgt in der App.
- **Legacy-REPAIR ohne Basis-Cursor:** Clients verschieben nebenläufige Präfix-Ops eines Download-Batches hinter die Reparatur; der Projektor verarbeitet streng in Server-Reihenfolge (Randfall alter Clients).
- **Eingefügte Bilder (S-E):** liegen nur auf dem Gerät (`sp-clipboard-images` bzw. Electron-Dateien) und werden auch heute nicht synchronisiert; zentrale Ablage erfordert Client-Änderungen (URL-Schema + Upload) → offen.
- **KI-Dienste in der Cloud** (z. B. claude.ai-Connectors) erreichen den Pi nicht (kein öffentlicher Zugang); lokale MCP-Clients im Tailnet funktionieren.
- **Ein Prozess je Datenbank** (Sperrdatei); horizontale Skalierung ist kein Ziel.
- **Nicht ausgeführt:** volle Upstream-E2E-Suite (148 Sync-Specs; nur die genannte Auswahl), Tests auf echter Raspberry-Pi-Hardware, Android/iOS-Store-Apps gegen den Server (Protokoll identisch, aber nicht auf Geräten geprüft).
