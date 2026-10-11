# Super Productivity mit eigenem SQLite-Server – Anleitung Schritt für Schritt

Diese Anleitung erklärt ohne Vorwissen, wie du den eigenen Super-Productivity-Server
aufsetzt, deine Daten überträgst und ihn im Alltag betreibst.

> **Stand 2026-10-10.** Der Server ist fertig und automatisch getestet (Windows-PC).
> **Noch nicht auf einem echten Raspberry Pi und nicht mit den Handy-Apps ausprobiert.**
> Mach vor dem Umzug deiner echten Daten unbedingt ein Backup (Schritt 7.1) und
> einen Probelauf (Schritt 4).
> Technische Details: [`packages/sqlite-server/README.md`](packages/sqlite-server/README.md),
> Architektur und Testnachweise: [`sqlite-roadmap.md`](sqlite-roadmap.md).

---

## 1. Was ist das überhaupt?

Bisher liegen deine Aufgaben in jeder App einzeln (Desktop, Handy, Browser) und
werden über einen Sync-Dienst abgeglichen. Neu ist **ein eigener kleiner Server bei
dir zuhause** (Raspberry Pi), der alles in **einer Datenbank-Datei** speichert:

```
  Desktop-App ─┐
  Handy-App   ─┼── Sync (SuperSync) ──▶  Raspberry Pi: sqlite-server ── superprod.sqlite
  Browser     ─┘                              │                              │
                                              │                              └─ Backup ▶ NAS
  KI (Claude/ChatGPT über MCP) ── REST-API ───┘
```

- Die **Datenbank auf dem Pi ist das Original.** Die Apps halten nur eine Kopie
  (funktionieren also auch offline und gleichen danach ab).
- Die Apps brauchen **keine Änderung** – sie sprechen mit dem Pi so wie mit dem
  offiziellen „SuperSync“-Dienst.
- **KI-Werkzeuge** (`superprod-mcp`) lesen und ändern deine Aufgaben über den Pi –
  dafür muss die Desktop-App nicht laufen.
- Der Pi ist **nicht aus dem Internet erreichbar**, nur über dein privates
  Tailscale-Netz.

## 2. Was du brauchst

| Was                                                  | Wofür                                          | Hinweis                                                            |
| ---------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| Raspberry Pi 4 oder 5 (empfohlen ≥ 4 GB RAM)         | läuft 24/7 als Server                          | Pi 3 o. ä. nicht empfohlen (Bauen braucht viel Speicher)           |
| USB-SSD (oder gute SD-Karte)                         | Speicherort der Datenbank                      | SSD ist deutlich haltbarer                                         |
| Raspberry Pi OS (64 Bit)                             | Betriebssystem                                 | per „Raspberry Pi Imager“ installieren                             |
| Kostenloses [Tailscale](https://tailscale.com)-Konto | sicheres privates Netz zwischen deinen Geräten | auf Pi, PC und Handy installieren                                  |
| Synology-NAS (optional)                              | automatische Backups                           |                                                                    |
| Dein Windows-PC                                      | Probelauf, Verwaltung                          | Node.js ≥ 22.13 (getestet mit 24)                                  |
| Dein **Sync-Passwort**                               | Verschlüsselung                                | Die Apps verschlüsseln immer; der Server braucht dasselbe Passwort |

**Begriffe kurz erklärt**

- **Token** = langes Zufalls-Passwort für ein Gerät oder Programm. Es wird nur
  **einmal** angezeigt – sofort sicher notieren (z. B. Passwortmanager).
  - `sync`-Token: für die Apps (je Gerät eins).
  - `api-write`-Token: für KI/MCP (lesen + ändern); `api-read`: nur lesen.
- **Key-Datei** (`keys.txt`) = Datei auf dem Server mit deinem Sync-Passwort, damit
  er die verschlüsselten Daten lesen und in Tabellen ablegen kann.
- **Terminal** = auf dem Pi die Kommandozeile (per SSH); auf Windows „PowerShell“.

## 3. Code bereitstellen (einmalig, am PC)

Der neue Server liegt im Branch `feature/sqlite-persistence` deines Forks
`github.com/henrikherr/super-productivity`. Damit der Pi ihn herunterladen kann,
muss er **committet und auf GitHub gepusht** sein (aktuell noch nicht passiert):

```powershell
cd C:\Users\henrik.herr\source\repos\henrikherr\superprod\superprod-sqlite
git add packages/sqlite-server packages/README.md package-lock.json e2e/tests/sync/sqlite-server-roundtrip.spec.ts sqlite-roadmap.md readme_sqlite.md superprod_mcp_roadmap.md
git commit -m "feat(sqlite-server): self-hosted SQLite server"
git push -u origin feature/sqlite-persistence
```

> **Wichtig:** Server und Apps sollten zum **selben Versionsstand** passen. Der
> Server enthält die Rechenlogik der App (für die Tabellen). Wenn du die Apps auf eine
> neue Super-Productivity-Version aktualisierst, baue den Server danach neu
> (Schritt 5.4 / 8.3).

## 4. Probelauf auf dem Windows-PC (empfohlen, ca. 20 Minuten)

So siehst du ohne Risiko, ob alles funktioniert – mit einer **Test-Datenbank**.

1. **Bauen** (PowerShell, im Projektordner):

   ```powershell
   cd C:\Users\henrik.herr\source\repos\henrikherr\superprod\superprod-sqlite
   npm ci                                          # lädt alle Bausteine (dauert)
   npm --prefix packages/sqlite-server run build   # baut den Server
   npm --prefix packages/sqlite-server test        # optional: Selbsttest, sollte "71 passed" zeigen
   ```

2. **Test-Nutzer und Tokens anlegen:**

   ```powershell
   cd packages\sqlite-server
   $env:SP_SQLITE_DB = ".\probe\superprod.sqlite"
   node dist/src/cli.js user add test@example.com
   node dist/src/cli.js token issue test@example.com sync pc        # Token notieren!
   node dist/src/cli.js token issue test@example.com api-write mcp  # Token notieren!
   Set-Content .\probe\keys.txt "test@example.com=MeinTestPasswort123"
   ```

3. **Server starten** (Fenster offen lassen; Beenden mit `Strg+C`):

   ```powershell
   $env:SP_ENCRYPTION_KEY_FILE = ".\probe\keys.txt"
   node dist/src/index.js
   ```

   Im Browser `http://127.0.0.1:1902` öffnen → eine Infoseite erscheint.

4. **Mit einer Test-App verbinden:** Am einfachsten die Web-App
   (`https://app.super-productivity.com`) in einem **privaten Browserfenster** öffnen
   (damit deine echten Daten unberührt bleiben) → _Einstellungen → Sync_ →
   **SuperSync** → eigene Server-URL `http://127.0.0.1:1902`, `sync`-Token einfügen,
   Verschlüsselungspasswort `MeinTestPasswort123`. Ein paar Aufgaben anlegen,
   synchronisieren.

5. **Prüfen**, ob die Aufgaben im Server angekommen sind (zweites PowerShell-Fenster):

   ```powershell
   cd C:\Users\henrik.herr\source\repos\henrikherr\superprod\superprod-sqlite\packages\sqlite-server
   $env:SP_SQLITE_DB = ".\probe\superprod.sqlite"
   node dist/src/cli.js projection status test@example.com      # erwartet: status ok
   curl.exe -H "Authorization: Bearer <api-write-Token>" http://127.0.0.1:1902/api/v1/tasks
   ```

6. Aufräumen: Server mit `Strg+C` stoppen, Ordner `probe` löschen.

## 5. Raspberry Pi einrichten (einmalig, ca. 1–2 Stunden)

### 5.1 Grundsystem

1. Mit dem **Raspberry Pi Imager** „Raspberry Pi OS Lite (64-bit)“ auf die SD-Karte
   schreiben. In den Imager-Einstellungen: Hostname (z. B. `superprod-pi`), Benutzer,
   WLAN/LAN und **SSH aktivieren**.
2. Pi starten, vom PC verbinden: `ssh <benutzer>@superprod-pi.local`
3. System aktualisieren:

   ```bash
   sudo apt update && sudo apt full-upgrade -y
   sudo apt install -y git curl sqlite3
   ```

4. **Node.js 24** installieren (die Version aus Raspberry Pi OS ist zu alt):

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt install -y nodejs
   node -v      # muss v22.13 oder höher zeigen
   ```

5. **USB-SSD** einhängen (falls vorhanden) und einen Datenordner anlegen. Ohne SSD
   einfach den Ordner auf der SD-Karte anlegen:

   ```bash
   sudo useradd --system --create-home --home-dir /srv/superprod superprod
   sudo chmod 700 /srv/superprod
   ```

   (Mit SSD: SSD z. B. nach `/srv/superprod` mounten, dann die beiden Befehle.)

### 5.2 Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up            # Link im Browser öffnen und mit deinem Konto anmelden
```

Installiere Tailscale auch auf **PC und Handy** und melde dich mit demselben Konto an.
Im Tailscale-Admin-Panel (_DNS_) **MagicDNS** und **HTTPS-Zertifikate** aktivieren.
Danach heißt dein Pi z. B. `superprod-pi.<dein-tailnet>.ts.net`.

### 5.3 Server herunterladen und bauen

```bash
sudo mkdir -p /opt && sudo chown $USER /opt
cd /opt
git clone --branch feature/sqlite-persistence https://github.com/henrikherr/super-productivity.git
cd super-productivity
npm ci                                          # dauert auf dem Pi lange (10–40 min)
npm --prefix packages/sqlite-server run build
```

> **Ungetestet auf dem Pi:** `npm ci` installiert alle Bausteine des gesamten
> Projekts (auch Electron/Angular). Bricht es mangels Speicher ab, eine Auslagerungs-
> datei vergrößern (`sudo dphys-swapfile swapoff`, in `/etc/dphys-swapfile`
> `CONF_SWAPSIZE=2048`, `sudo dphys-swapfile setup && sudo dphys-swapfile swapon`)
> und erneut versuchen.

### 5.4 Nutzer, Tokens und Key-Datei anlegen

Ersetze `du@example.com` durch deine E-Mail (dient nur als Kontoname) und
`<Sync-Passwort>` durch das Verschlüsselungspasswort, das du in den Apps verwendest
bzw. verwenden wirst.

```bash
cd /opt/super-productivity/packages/sqlite-server
export SP_SQLITE_DB=/srv/superprod/superprod.sqlite
sudo -E -u superprod node dist/src/cli.js user add du@example.com
sudo -E -u superprod node dist/src/cli.js token issue du@example.com sync desktop
sudo -E -u superprod node dist/src/cli.js token issue du@example.com sync handy
sudo -E -u superprod node dist/src/cli.js token issue du@example.com api-write mcp
echo 'du@example.com=<Sync-Passwort>' | sudo -u superprod tee /srv/superprod/keys.txt >/dev/null
sudo chmod 600 /srv/superprod/keys.txt
```

Alle angezeigten Tokens **sofort notieren** – sie werden nie wieder angezeigt
(verloren? einfach neues ausstellen, altes widerrufen, s. Schritt 8.2).

### 5.5 Backups aufs NAS (optional, empfohlen)

1. Auf der Synology einen freigegebenen Ordner `superprod-backups` anlegen und für den
   Pi per NFS (oder SMB) freigeben.
2. Auf dem Pi einhängen, z. B. NFS:

   ```bash
   sudo apt install -y nfs-common
   sudo mkdir -p /mnt/nas/superprod-backups
   echo '<NAS-IP>:/volume1/superprod-backups /mnt/nas/superprod-backups nfs defaults,_netdev 0 0' | sudo tee -a /etc/fstab
   sudo mount -a
   sudo chown superprod /mnt/nas/superprod-backups
   ```

> **Nie die Live-Datenbank selbst auf das NAS legen** – nur die Backups. SQLite
> braucht lokalen Speicher.

### 5.6 Als Dienst einrichten (startet automatisch mit dem Pi)

```bash
sudo nano /etc/systemd/system/sp-sqlite-server.service
```

Inhalt (ohne NAS: die beiden Zeilen mit `/mnt/nas/...` weglassen bzw. kürzen):

```ini
[Unit]
Description=Super Productivity SQLite server
After=network-online.target
Wants=network-online.target

[Service]
User=superprod
WorkingDirectory=/opt/super-productivity/packages/sqlite-server
Environment=SP_SQLITE_DB=/srv/superprod/superprod.sqlite
Environment=SP_ENCRYPTION_KEY_FILE=/srv/superprod/keys.txt
Environment=SP_BACKUP_DIR=/mnt/nas/superprod-backups
Environment=TZ=Europe/Berlin
ExecStart=/usr/bin/node dist/src/index.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/superprod /mnt/nas/superprod-backups

[Install]
WantedBy=multi-user.target
```

Speichern (`Strg+O`, `Enter`, `Strg+X`), dann:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sp-sqlite-server
systemctl status sp-sqlite-server        # sollte "active (running)" zeigen
```

`TZ` ist wichtig: „Heute“ wird nach der Uhrzeit des Servers berechnet.

### 5.7 Im privaten Netz freigeben (HTTPS)

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:1902
```

Test vom PC (Tailscale an): `https://superprod-pi.<dein-tailnet>.ts.net` im Browser
öffnen → Infoseite. **Niemals `tailscale funnel` für diesen Port verwenden** – das
würde den Server öffentlich ins Internet stellen.

## 6. Geräte verbinden und alte Daten übernehmen

### 6.1 Erstes Gerät = das mit deinen aktuellen Daten

1. **Backup** in dieser App machen: _Einstellungen → Sync & Backup → Export_ (JSON-Datei
   sicher ablegen).
2. _Einstellungen → Sync_ → Anbieter **SuperSync** → eigene/erweiterte Server-URL
   `https://superprod-pi.<dein-tailnet>.ts.net` → `sync`-Token einfügen →
   Verschlüsselung **an**, Passwort **genau wie in `keys.txt`**.
3. Synchronisieren. Der erste Sync lädt **alles** (inkl. Archiv) auf den Server.
4. Prüfen (auf dem Pi):

   ```bash
   cd /opt/super-productivity/packages/sqlite-server
   sudo -u superprod SP_SQLITE_DB=/srv/superprod/superprod.sqlite node dist/src/cli.js projection status du@example.com
   ```

   `ok` = alles gut. `needs_key` = Passwort in `keys.txt` passt nicht zur App.

### 6.2 Weitere Geräte

Jedes Gerät: gleiche URL, **eigenes** `sync`-Token, **gleiches** Passwort. Die
Geräte laden den Stand vom Server. Handy: Tailscale-App muss verbunden sein.

**Ohne das alte Gerät?** Die Backup-JSON in einer App importieren
(_Einstellungen → Sync & Backup → Import_) und dann wie 6.1 ab Punkt 2 verbinden.

**Wichtig:** Nicht mehrere Geräte mit unterschiedlichen alten Daten gleichzeitig
verbinden – immer erst das eine „führende“ Gerät, dann die anderen.

### 6.3 KI / MCP verbinden (`superprod-mcp`)

Auf dem PC (Tailscale an):

1. Den `api-write`-Token in `C:\Users\<du>\.sp-token\sp-token.txt` speichern.
2. Die Server-Adresse setzen – dauerhaft für deinen Windows-Benutzer:

   ```powershell
   [Environment]::SetEnvironmentVariable("SP_API_URL", "https://superprod-pi.<dein-tailnet>.ts.net/api/v1", "User")
   ```

3. Claude Desktop / Claude Code / ChatGPT Desktop **neu starten** (Einrichtung des
   MCP-Servers wie in der README von `superprod-mcp`).

Die Desktop-App muss dafür **nicht** laufen. Nicht verfügbar über den Server: Timer
starten/stoppen, Fokus, aktueller Status (Fehler 501). Zugriff „von überall“ (claude.ai,
ChatGPT im Browser/Handy): siehe [`superprod_mcp_roadmap.md`](superprod_mcp_roadmap.md).

## 7. Betrieb im Alltag

### 7.1 Backups

- **Automatisch:** stündlich auf das NAS, die letzten 48 bleiben (einstellbar mit
  `SP_BACKUP_INTERVAL_MINUTES` / `SP_BACKUP_KEEP` in der Dienst-Datei).
- **Manuell:**

  ```bash
  cd /opt/super-productivity/packages/sqlite-server
  sudo -u superprod SP_SQLITE_DB=/srv/superprod/superprod.sqlite node dist/src/cli.js backup /mnt/nas/superprod-backups
  ```

- Zusätzlich auf der Synology „Snapshot Replication“ oder „Hyper Backup“ für den Ordner
  einschalten (Versionen über längere Zeit).
- Vor Updates legt der Server automatisch eine Kopie `superprod.sqlite.pre-v<N>-…`
  neben der Datenbank an.

### 7.2 Wiederherstellen

```bash
sudo systemctl stop sp-sqlite-server
sudo -u superprod cp /mnt/nas/superprod-backups/<backup-datei>.sqlite /srv/superprod/superprod.sqlite
sudo rm -f /srv/superprod/superprod.sqlite-wal /srv/superprod/superprod.sqlite-shm
sudo systemctl start sp-sqlite-server
```

Die Geräte laden danach Änderungen, die sie seit dem Backup gemacht haben, selbst
wieder hoch.

### 7.3 Läuft alles?

```bash
systemctl status sp-sqlite-server                    # läuft der Dienst?
journalctl -u sp-sqlite-server -n 100                # letzte Meldungen
curl -s http://127.0.0.1:1902/health                 # Antwort = Server lebt
```

## 8. Wartung

### 8.1 Neustarten

`sudo systemctl restart sp-sqlite-server` – keine Daten gehen verloren.

### 8.2 Tokens verwalten (z. B. Handy verloren)

```bash
cd /opt/super-productivity/packages/sqlite-server
export SP_SQLITE_DB=/srv/superprod/superprod.sqlite
sudo -E -u superprod node dist/src/cli.js token list du@example.com
sudo -E -u superprod node dist/src/cli.js token revoke <id>      # sperrt sofort
sudo -E -u superprod node dist/src/cli.js token issue du@example.com sync neues-handy
```

### 8.3 Updates einspielen

```bash
cd /opt/super-productivity
git pull
npm ci
npm --prefix packages/sqlite-server run build
sudo systemctl restart sp-sqlite-server
```

Danach baut der Server seine Tabellen bei Bedarf automatisch neu auf. Manuell:
`node dist/src/cli.js projection rebuild du@example.com` (mit `SP_SQLITE_DB` und
`SP_ENCRYPTION_KEY_FILE` wie oben).

### 8.4 Sync-Passwort ändern

Passwort in der App ändern **und** `/srv/superprod/keys.txt` anpassen, dann
`sudo systemctl restart sp-sqlite-server`.

## 9. Häufige Probleme

| Problem                                      | Ursache / Lösung                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| App: „Server nicht erreichbar“               | Tailscale auf dem Gerät aus? Dienst läuft (`systemctl status`)? `tailscale serve` eingerichtet (5.7)? |
| App: „401 / ungültiges Token“                | Token falsch kopiert oder widerrufen → neues ausstellen (8.2)                                         |
| `projection status` zeigt `needs_key`        | Passwort in `keys.txt` ≠ Passwort in der App → angleichen, Dienst neu starten                         |
| `projection status` zeigt `blocked`          | App ist neuer als der Server → Server updaten (8.3)                                                   |
| MCP: „nicht erreichbar“                      | `SP_API_URL` gesetzt (mit `/api/v1` am Ende)? Tailscale an? Client neu gestartet?                     |
| MCP: Fehler 501                              | Timer/Fokus/Status gibt es nur in der laufenden Desktop-App                                           |
| Dienst startet nicht: „already used“         | Ein zweiter Server-Prozess nutzt dieselbe Datenbank → `sudo systemctl stop …`, alte Prozesse beenden  |
| Bilder in Notizen fehlen auf anderen Geräten | Bekannte Einschränkung: eingefügte Bilder werden (wie bisher) nicht synchronisiert                    |

## 10. Sicherheit in einem Satz je Punkt

- Der Server ist nur im Tailscale-Netz erreichbar – lass es so.
- Der Server kennt dein Sync-Passwort (`keys.txt`) und speichert die Tabellen
  unverschlüsselt → Pi-Zugang schützen, `keys.txt` nur für `superprod` lesbar.
- Tokens wie Passwörter behandeln; je Gerät ein eigenes, Verlorenes sofort widerrufen.
- In die Datenbank-Tabellen nie selbst hineinschreiben (Lesen mit SQLite-Tools ist ok).
