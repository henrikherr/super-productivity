# superprod-mcp – Roadmap: von überall für Claude und ChatGPT

Stand: 2026-10-10. Bezieht sich auf `superprod-mcp` @ `4d274f2` (`..\superprod-mcp`)
und den SQLite-Server in diesem Branch (`packages/sqlite-server`, Anleitung
[`readme_sqlite.md`](readme_sqlite.md)).

## 1. Ziel

Claude und ChatGPT sollen **auf jedem Gerät** – auch claude.ai/ChatGPT im Browser
und in den Handy-Apps – deine Super-Productivity-Daten lesen und ändern können,
**ohne** dass die Desktop-App laufen muss und **ohne** dass der Sync-Server
öffentlich wird.

**„Permanent von unterwegs“** heißt konkret:

- Der Connector hängt an deinem Claude- bzw. ChatGPT-**Konto**. Einmal auf claude.ai
  eingerichtet, steht er automatisch im Browser, in Claude Desktop und in den
  Handy-/Tablet-Apps bereit.
- Der MCP-Server läuft rund um die Uhr (systemd-Dienst, Neustart bei Fehler).
- Die Anmeldung bleibt bestehen: Claude erneuert sie selbst per Refresh-Token, du
  meldest dich nicht ständig neu an (siehe M5).

## 2. Ausgangslage (bestätigt)

| Baustein        | Stand                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite-Server   | REST-API `/api/v1` (Tasks, Projekte, Tags; anlegen/ändern/erledigen/archivieren/wiederherstellen/löschen), Tokens `api-read`/`api-write`, nur im Tailnet erreichbar |
| `superprod-mcp` | Python, MCP-SDK `mcp>=2`, 15 Tools. Standard-Transport **stdio** (lokal); `--transport http` bindet fest an `127.0.0.1`, **ohne Authentifizierung**                 |
| Getestet        | Unverändertes `superprod-mcp` gegen den SQLite-Server: alle Tools ok, `get_status` → 501 (Roadmap §9.4)                                                             |

**Was heute schon geht (ohne Änderung):** lokale MCP-Clients auf Rechnern im
Tailnet – Claude Desktop, Claude Code, ChatGPT Desktop/Codex – mit
`SP_API_URL=https://<pi>.<tailnet>.ts.net/api/v1` (siehe `readme_sqlite.md` §6.3).

**Was nicht geht:** claude.ai (Web/Handy) und ChatGPT (Web/Handy). Deren Connectors
laufen **in der Cloud von Anthropic bzw. OpenAI** und rufen deinen MCP-Server über das
**öffentliche Internet** auf. Ein lokaler stdio-Server oder ein nur im Tailnet
erreichbarer Server ist für sie unsichtbar.

## 3. Anforderungen der Cloud-Clients

Recherche 2026-10-10. Vor der Umsetzung gegen die aktuellen Herstellerdokus prüfen.

|                | claude.ai (Custom Connector)                                                                                      | ChatGPT (Developer Mode / Connectors)                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Erreichbarkeit | öffentliche HTTPS-URL                                                                                             | öffentliche HTTPS-URL                                                                                                                                                                                      |
| Transport      | Streamable HTTP                                                                                                   | Streamable HTTP (SSE veraltet)                                                                                                                                                                             |
| Auth           | OAuth 2.x mit **Dynamic Client Registration** oder **Client ID Metadata Document (CIMD)**; auch ohne Auth möglich | OAuth (bevorzugt CIMD, sonst DCR) oder ohne Auth                                                                                                                                                           |
| Besonderheiten | Discovery über `/.well-known/oauth-protected-resource` und `…/oauth-authorization-server`; PKCE                   | Tool-Liste wird beim Verbinden übernommen → nach Änderungen Connector aktualisieren; Tools ohne `readOnlyHint` gelten als schreibend (Bestätigung nötig); Developer Mode je nach Tarif bzw. Admin-Freigabe |

Quellen: [Anthropic – Custom Connectors via Remote MCP](https://support.claude.com/en/articles/11503834),
[claude.com – Connector-Authentifizierung](https://claude.com/docs/connectors/building/authentication),
[Zuplo – ChatGPT Connectors](https://zuplo.com/learn/mcp/compatibility/clients/chatgpt-connectors.md),
[Vercel – MCP-Server als ChatGPT-Connector](https://vercel.com/kb/guide/mcp-server-chatgpt-connector),
[Tailscale Funnel – Beispiele](https://tailscale.com/kb/1247/funnel-examples).

**Folgerung:** „Ohne Auth“ ist technisch möglich, kommt aber **nicht in Frage**:
Wer die URL kennt, könnte dann deine Aufgaben lesen und löschen. Pflicht ist
deshalb **OAuth mit DCR und/oder CIMD**.

## 4. Zielarchitektur

```
claude.ai / ChatGPT (Cloud)
        │ HTTPS, OAuth-Bearer
        ▼
Tailscale Funnel  :8443  (öffentlich, NUR dieser Port)
        │
        ▼
Pi: superprod-mcp  (HTTP, 127.0.0.1:8765, prüft OAuth-Token)
        │ api-write-Token (liegt nur auf dem Pi)
        ▼
Pi: sqlite-server  (127.0.0.1:1902)  ◀── tailscale serve :443 (nur Tailnet) ── Apps
        │
OAuth-Anbieter (Identity Provider) ◀── Login-Seite, die Claude/ChatGPT beim Verbinden öffnen
```

Grundsätze:

1. **Der Sync-Server bleibt privat.** Öffentlich ist nur der MCP-Endpunkt. Er kann
   nur das, was die MCP-Tools anbieten (kein Sync, kein Rohzugriff auf die Datenbank).
2. **Der MCP-Server läuft auf dem Pi** neben dem SQLite-Server. Den `api-write`-Token
   kennt nur er; Claude und ChatGPT sehen ihn nie.
3. **Login über einen fertigen OAuth-Anbieter, nichts selbst gebaut.** Nur dein Konto
   ist zugelassen (Allowlist).
4. **Lokale Clients im Tailnet** nutzen weiterhin stdio – unverändert und ohne OAuth.

### 4.1 Hosting-Varianten: Pi zuhause oder Cloud-VPS

Server und MCP können statt auf dem Pi auch auf einem gemieteten Linux-Server (VPS)
laufen. Der Aufbau bleibt gleich, nur der öffentliche Zugang zum MCP ändert sich.

**Kein „Serverless“** (Vercel, Netlify, Cloudflare Workers, AWS Lambda). Der
SQLite-Server braucht drei Dinge, die diese Dienste nicht bieten:

- eine echte, dauerhafte Festplatte für die SQLite-Datei,
- einen dauerhaft laufenden Prozess (WebSocket-Push an die Geräte),
- genau eine Instanz (Prozess-Sperre).

| Variante                                                       | Kosten/Monat (ca., Preise prüfen) | Aufwand                                                    | Bewertung                                                                                              |
| -------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Raspberry Pi zuhause                                           | Strom                             | Hardware einrichten                                        | Daten bleiben zuhause; Stromausfall, SD-Karte und Heim-Internet als Risiken                            |
| **VPS bei Hetzner** (z. B. CX-Reihe, 2 vCPU/4 GB, Standort DE) | 4–6 €                             | Ubuntu statt Raspberry Pi OS, sonst wie `readme_sqlite.md` | **Empfehlung für die Cloud**: billig, EU/DSGVO, volle Kontrolle, öffentliche IP                        |
| Netcup, Contabo, IONOS VPS                                     | 3–6 €                             | gleich                                                     | ähnlich                                                                                                |
| Fly.io / Railway (Container + Volume)                          | 3–10 €                            | Dockerfile nötig (gibt es noch nicht)                      | bequemer Betrieb, aber erst Arbeit; US-Anbieter                                                        |
| Oracle Cloud „Always Free“ (ARM)                               | 0 €                               | wie VPS                                                    | Konten und Instanzen werden gelegentlich gesperrt bzw. abgeräumt → nicht für das Original deiner Daten |

**VPS-Einrichtung in Kurzform:**

1. Ubuntu 24.04 anlegen. In der Hetzner-Firewall eingehend nur **443/TCP** erlauben
   (für den MCP), SSH nur über Tailscale.
2. Tailscale installieren. Danach `readme_sqlite.md` ab §5.1 Punkt 3 befolgen. Der
   Sync-Server bleibt per `tailscale serve` **nur im Tailnet** erreichbar.
3. Backups:
   - Hetzner-Backups (ca. +20 %) und/oder eine Hetzner Storage Box (`SP_BACKUP_DIR`),
   - oder das NAS zieht die Backup-Dateien regelmäßig über Tailscale.

**Zielarchitektur auf dem VPS** (statt Funnel ein normaler Reverse-Proxy):

```
claude.ai / ChatGPT (Cloud)
        │ HTTPS, OAuth-Bearer
        ▼
mcp.deinedomain.de :443  ── Caddy (automatisches HTTPS-Zertifikat)
        │ nur /mcp und /.well-known/oauth-protected-resource
        ▼
VPS: superprod-mcp (127.0.0.1:8765) ──▶ VPS: sqlite-server (127.0.0.1:1902)
                                                 ▲
                                  tailscale serve (nur Tailnet) ── Apps
```

**Abwägung:** Der Server kennt das Sync-Passwort, und die Tabellen sind Klartext. In
der Cloud liegen deine Daten damit lesbar auf fremder Hardware. Vertretbar mit
EU-Anbieter, Zugang nur per Tailscale bzw. OAuth und Dateirechten nur für den
Dienstnutzer – aber bewusst entscheiden (M0).

## 5. Schritte

### M0 – Entscheidungen (vor Beginn)

| Frage                       | Empfehlung                                                                                                                                                                  | Alternativen                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Wo läuft alles?             | Pi zuhause **oder** Hetzner-VPS (§4.1) – Datenhaltung in fremder Cloud bewusst entscheiden                                                                                  | –                                       |
| Öffentlicher Zugang         | Pi: **Tailscale Funnel** auf Port 8443 (kein Router-Portforwarding). VPS: **eigene (Sub-)Domain + Caddy** auf 443                                                           | Cloudflare Tunnel (+ Cloudflare Access) |
| OAuth-Anbieter              | Selbst gehosteter IdP mit DCR/CIMD auf dem Pi (z. B. Pocket ID, Authentik, Keycloak) **oder** gehosteter Dienst mit MCP-Unterstützung (z. B. Auth0, WorkOS AuthKit, Stytch) | –                                       |
| Schreibrechte für Cloud-KIs | erst nur lesen (M1–M4 mit `api-read`), schreiben nach einer Testphase                                                                                                       | sofort `api-write`                      |

Bei der Auswahl des OAuth-Anbieters prüfen: DCR (RFC 7591) und/oder CIMD, PKCE,
Metadaten-Discovery (RFC 8414), Zugang auf ein Konto beschränkbar, Passkey/2FA.

### M1 – `superprod-mcp` für den Serverbetrieb anpassen (Code)

| #   | Änderung                                                                                                                           | Datei                 | Grund                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------- |
| 1.1 | `--host` als Parameter statt fest `127.0.0.1`; Standard bleibt `127.0.0.1`                                                         | `server.py` `main()`  | Betrieb hinter Funnel/Proxy auf dem Pi                               |
| 1.2 | Fehlertexte neutral formulieren („Server unter … nicht erreichbar“) statt „läuft die Desktop-App?“                                 | `client.py`           | Server-Betrieb                                                       |
| 1.3 | Server-Modus `SP_BACKEND=server`: Laufzeit-Tools (`get_status`, `get_focus`, `start_task`, `stop_tracking`) **nicht registrieren** | `server.py`           | Liefern am Server immer 501; die KI soll sie gar nicht erst anbieten |
| 1.4 | Lesemodus `SP_MCP_READONLY=true`: nur Tools mit `readOnlyHint` registrieren                                                        | `server.py`           | Stufenweise Freigabe (M0)                                            |
| 1.5 | `instructions` anpassen („lokale Instanz“ → „deine Super-Productivity-Daten“); Hinweis, dass Short-Syntax nicht ausgewertet wird   | `server.py`           | Richtige Erwartungen der KI                                          |
| 1.6 | `trust_env=False` beibehalten; Zeitlimits und eine verständliche Meldung bei 503 `PROJECTION_NEEDS_KEY`                            | `client.py`           | Robustheit                                                           |
| 1.7 | Tests (pytest) für Tool-Registrierung je Modus und Fehlerabbildung; README um den Server-Modus ergänzen                            | `tests/`, `README.md` | heute keine Tests vorhanden                                          |

### M2 – OAuth im MCP-Server (Code)

| #   | Änderung                                                                                                                                                                                                 | Hinweis                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | MCP-Server als **OAuth Resource Server**: jede HTTP-Anfrage braucht `Authorization: Bearer <Access-Token>` vom IdP; ohne Token → 401 mit `WWW-Authenticate`-Verweis auf die Protected-Resource-Metadaten | Auth-Unterstützung des MCP-Python-SDK nutzen (Token-Verifier + Auth-Einstellungen); genaue API von `mcp>=2` bei Umsetzung prüfen |
| 2.2 | `/.well-known/oauth-protected-resource` ausliefern (Resource-URL, Authorization-Server = IdP)                                                                                                            | Discovery für Claude/ChatGPT                                                                                                     |
| 2.3 | Token-Prüfung: Signatur (JWKS des IdP) oder Introspection, `iss`, `aud` = MCP-URL, Ablaufzeit, **Allowlist** (nur dein `sub`/E-Mail)                                                                     | Schutz vor fremden Konten desselben IdP                                                                                          |
| 2.4 | Scopes: `sp.read` → nur lesende Tools; `sp.write` → schreibende Tools; `delete_task` zusätzlich nur bei `sp.write`                                                                                       | Feinere Rechte je Connector                                                                                                      |
| 2.5 | Stateless Streamable HTTP; Endpunkt `/mcp`                                                                                                                                                               | Kompatibel mit den neueren MCP-Spezifikationen                                                                                   |
| 2.6 | Audit-Log jeder Tool-Ausführung (Zeit, Client, Tool, Task-ID – keine Inhalte) auf stderr bzw. journald                                                                                                   | Nachvollziehbarkeit                                                                                                              |
| 2.7 | Einfache Ratenbegrenzung (z. B. 60 Anfragen/Minute)                                                                                                                                                      | Schutz bei Missbrauch oder Endlosschleifen                                                                                       |
| 2.8 | stdio-Modus bleibt **ohne** OAuth (lokal, vertraut)                                                                                                                                                      | Rückwärtskompatibel                                                                                                              |

### M3 – OAuth-Anbieter einrichten (Betrieb)

1. IdP gemäß M0 einrichten. Bei Selbsthosting muss die Login-Seite ebenfalls
   öffentlich per HTTPS erreichbar sein: auf dem Pi z. B. als zweiter Funnel-Port,
   auf dem VPS als eigene Subdomain in Caddy (z. B. `auth.deinedomain.de`).
2. Dein Konto anlegen, **Passkey oder 2FA** aktivieren, Selbstregistrierung **aus**.
3. DCR und/oder CIMD aktivieren. Erlaubte Redirect-URIs auf die von Anthropic/OpenAI
   dokumentierten Callback-Adressen beschränken, falls der IdP das unterstützt.
4. Scopes `sp.read`, `sp.write` anlegen; Audience = öffentliche MCP-URL.
5. Kurze Laufzeiten: Access-Token ≤ 1 h, Refresh-Token mit Rotation.

### M4 – Betrieb auf dem Server (Pi oder VPS)

Gemeinsam für beide Varianten (Pfade wie in `readme_sqlite.md`):

1. Python 3.11+ und `uv` installieren; `superprod-mcp` nach `/opt/superprod-mcp`
   klonen; `uv sync`.
2. Eigenen Token nur für den MCP-Server ausstellen (erst `api-read`, später `api-write`):
   `node dist/src/cli.js token issue du@example.com api-read cloud-mcp` → in
   `/srv/superprod-mcp/token.txt` (`chmod 600`, Besitzer: Dienstnutzer).
3. systemd-Dienst `sp-mcp.service`, analog zu `sp-sqlite-server.service`:
   - `ExecStart=… uv run sp-mcp --transport http --host 127.0.0.1 --port 8765`
   - `Environment=SP_API_URL=http://127.0.0.1:1902/api/v1`
   - `Environment=SP_API_TOKEN_FILE=/srv/superprod-mcp/token.txt`
   - `Environment=SP_BACKEND=server`, OAuth-Einstellungen (Issuer, Audience, Allowlist)
   - `After=sp-sqlite-server.service`, `Restart=always`, Hardening wie beim Sync-Dienst

**M4a – Pi: öffentlich per Tailscale Funnel (nur dieser Port)**

1. `sudo tailscale funnel --bg --https=8443 http://127.0.0.1:8765`
2. In der Tailscale-Policy Funnel nur für diesen einen Knoten erlauben.
3. Öffentliche MCP-URL: `https://<pi>.<tailnet>.ts.net:8443/mcp`

**M4b – VPS: öffentlich per Domain + Caddy**

1. DNS: A-Eintrag (und ggf. AAAA) `mcp.deinedomain.de` → öffentliche IP des VPS.
   Eine Domain kostet ca. 1 €/Monat; eine vorhandene Domain mit Subdomain genügt.
2. Caddy installieren (`apt install caddy`), `/etc/caddy/Caddyfile`:

   ```
   mcp.deinedomain.de {
       @mcp path /mcp /mcp/* /.well-known/oauth-protected-resource*
       handle @mcp {
           reverse_proxy 127.0.0.1:8765
       }
       handle {
           respond 404
       }
   }
   ```

   `sudo systemctl reload caddy`. Das Zertifikat holt und erneuert Caddy automatisch.

3. Firewall: eingehend nur 443 (und 80 für die Zertifikatsausstellung, falls
   nötig). **Port 1902 nie öffentlich.**
4. Öffentliche MCP-URL: `https://mcp.deinedomain.de/mcp`

**Prüfen (beide Varianten):**

- Sync-Server ist weiterhin **nur** im Tailnet erreichbar – z. B. vom Handy
  **ohne** Tailscale testen.
- Die öffentliche MCP-URL antwortet ohne Token mit 401.
- Andere Pfade (z. B. `/api/v1/tasks`) sind öffentlich **nicht** erreichbar.

### M5 – Clients verbinden

**claude.ai** (wirkt danach auch in den Claude-Apps auf Handy und Desktop):

1. _Settings → Connectors → Add custom connector_.
2. Name „Super Productivity“, öffentliche MCP-URL aus M4a/M4b.
3. Felder für Client-ID und Secret leer lassen (DCR/CIMD).
4. _Connect_ → Login beim IdP → Zugriff erlauben.

**ChatGPT:**

1. _Settings → Apps & Connectors → Advanced → Developer mode_ einschalten, falls dein
   Tarif es anbietet.
2. Neuen Connector anlegen: gleiche URL, Authentifizierung OAuth.
3. Login beim IdP → Zugriff erlauben.
4. Nach jeder Tool-Änderung (M1/M6) den Connector aktualisieren.

**Abnahmetest je Client:**

- „Was steht heute an?“ → `list_tasks(today=True)`.
- „Leg eine Aufgabe ‚Test MCP‘ an“ → die Aufgabe erscheint nach dem Sync auf allen
  Geräten.
- Löschen → die KI fragt vorher nach.
- Fremdes Konto beim IdP → Zugriff verweigert.
- Dieselben Fragen in der Claude-App auf dem Handy, **ohne** WLAN und ohne Tailscale.

**Damit der Zugriff dauerhaft bleibt:**

| Punkt                     | Umsetzung                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dienste laufen immer      | `sp-sqlite-server` und `sp-mcp` als systemd-Dienste mit `Restart=always`, `enable` (Start beim Booten)                                                      |
| Anmeldung läuft nicht ab  | IdP: Refresh-Token mit Rotation und langer Gültigkeit (z. B. 30–90 Tage, bei Nutzung verlängert); Access-Token kurz (≤ 1 h). Claude/ChatGPT erneuern selbst |
| Zertifikat läuft nicht ab | Funnel bzw. Caddy erneuern automatisch                                                                                                                      |
| Ausfälle bemerken         | externer Uptime-Check (z. B. Uptime Kuma oder ein kostenloser Monitoring-Dienst) auf `https://…/mcp` (erwartet 401)                                         |
| Nach Tool-Änderungen      | Connector in claude.ai/ChatGPT aktualisieren bzw. neu verbinden                                                                                             |

Fällt die Anmeldung doch aus (IdP-Neustart, widerrufene Sessions), genügt in
claude.ai _Connectors → Super Productivity → Connect_ erneut.

### M6 – Mehr Funktionen (optional, Code im SQLite-Server und im MCP)

Die REST-API kann heute nur Tasks, Projekte und Tags. Sinnvolle Erweiterungen, jeweils
erst in `packages/sqlite-server/src/api/rest-api.ts` (über die echten Reducer, wie die
bestehenden Schreibpfade), dann als Tool in `superprod-mcp`:

| Priorität     | Funktion                                                        | Nutzen                                 |
| ------------- | --------------------------------------------------------------- | -------------------------------------- |
| hoch          | Volltextsuche über Tasks inkl. Archiv                           | „Wann habe ich X erledigt?“            |
| hoch          | Zeiterfassung lesen (pro Tag/Projekt)                           | Auswertungen, Wochenrückblick          |
| mittel        | Notizen lesen/anlegen                                           | Notizen per KI                         |
| mittel        | Projekte/Tags anlegen                                           | vollständige Planung per KI            |
| mittel        | Short-Syntax (`#tag`, `+projekt`, `30m`) serverseitig auswerten | gleiche Eingabe wie in der App         |
| niedrig       | Wiederholungs-Tasks lesen/anlegen                               | –                                      |
| bewusst nicht | Timer starten/stoppen                                           | Läuft nur in einer App (Gerätezustand) |

### M7 – Sicherheit und Betrieb (laufend)

- **Risiko:** Der Server (Pi oder VPS) kennt das Sync-Passwort, die Tabellen sind
  Klartext. Ein öffentlicher Endpunkt erhöht die Angriffsfläche. Deshalb nur der
  MCP-Endpunkt öffentlich, OAuth mit Allowlist, Ratenbegrenzung, automatische
  Sicherheitsupdates (`unattended-upgrades`) sowie Updates für Node, Python,
  `superprod-mcp` und den IdP.
- **Prompt-Injection:** Aufgabeninhalte (z. B. aus importierten Issues) werden von der
  KI gelesen und können Anweisungen enthalten. Darum:
  - Lösch- und Schreib-Tools brauchen eine Bestätigung (Annotationen sind gesetzt).
  - Für reine Abfragen genügt ein Connector mit `sp.read`.
- **Notfall:** öffentlichen Zugang abschalten – Pi: `sudo tailscale funnel --https=8443 off`
  bzw. `tailscale funnel reset`; VPS: `sudo systemctl stop caddy` oder Port 443 in der
  Firewall schließen. Danach Cloud-Token des MCP-Servers widerrufen
  (`token revoke`), Sessions im IdP beenden.
- **Monitoring:** `journalctl -u sp-mcp`, Audit-Log regelmäßig ansehen.

## 6. Reihenfolge und Aufwand (grob)

| Schritt                                                       | Abhängig von                                                   | Aufwand               |
| ------------------------------------------------------------- | -------------------------------------------------------------- | --------------------- |
| M0 Entscheidungen                                             | –                                                              | 1 h                   |
| M1 Server-Modus im MCP                                        | –                                                              | 0,5–1 Tag             |
| M2 OAuth im MCP                                               | M0, M1                                                         | 1–2 Tage              |
| M3 IdP                                                        | M0                                                             | 0,5–1 Tag             |
| M4 Betrieb + öffentlicher Zugang (Funnel bzw. Domain + Caddy) | SQLite-Server läuft (`readme_sqlite.md`, ggf. auf VPS), M2, M3 | 0,5 Tag               |
| M5 Clients + Abnahme                                          | M4                                                             | 1–2 h                 |
| M6 Erweiterungen                                              | M5                                                             | je Funktion 0,5–1 Tag |
| M7 Sicherheit                                                 | laufend                                                        | –                     |

**Übergangslösung, sofort und ohne Code-Änderung:** Auf dem Laptop Tailscale
aktivieren und `superprod-mcp` lokal (stdio) in Claude Desktop bzw. Claude Code
nutzen (`readme_sqlite.md` §6.3). Das funktioniert von überall, wo der Laptop Internet
hat, aber **nicht** in der Claude-App auf dem Handy und nicht auf claude.ai im
Browser. Mit M1 wird es sauberer (keine 501-Tools mehr).

Den Hauptaufwand für „permanent von überall“ machen M2 und M3 (OAuth) aus, zusammen
ca. 2–3 Tage. Der Rest ist Konfiguration.

## 7. Offene Punkte und Prüfaufgaben

- Aktuelle Anforderungen von claude.ai und ChatGPT (DCR vs. CIMD, Spec-Version,
  Tarif-Freigaben) direkt vor M2/M3 in den Herstellerdokus nachlesen.
- Prüfen, ob `tailscale serve` (443, nur Tailnet) und `tailscale funnel` (8443,
  öffentlich) auf demselben Knoten wie geplant getrennt bleiben. Test von außen ohne
  Tailscale.
- Genaue Auth-API des MCP-Python-SDK `mcp>=2` (Resource-Server-Modus).
- VPS-Preise und Tarifnamen (Hetzner u. a.) beim Anbieter aktuell nachsehen; die
  Angaben in §4.1 sind Richtwerte.
- Caddy-Pfadfilter gegen die tatsächlichen Pfade des MCP-SDK prüfen (Discovery-Pfade
  können je nach Version ein Suffix tragen).
- Optional: Dockerfile für Container-Hosting (Fly.io/Railway) – existiert noch nicht.
- Der SQLite-Server selbst ist auf echter Pi-Hardware noch nicht getestet
  (`sqlite-roadmap.md` §11).
