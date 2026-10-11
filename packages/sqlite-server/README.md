# sp-sqlite-server

Self-hosted Super Productivity server. Every device syncs with it through the
existing **SuperSync** protocol (no app changes), and all data lives in one
**SQLite** database that is the authoritative store:

- `operations` — the complete, append-only change log (history),
- relational tables (`task`, `project`, `tag`, `note`, `time_tracking`, …)
  built from it by the server with the app's own reducers,
- a REST API (`/api/v1`) compatible with the desktop Local REST API, so
  [superprod-mcp](https://github.com/henrikherr/superprod-mcp) and other AI
  tools read and write the same data with the same rules as the UI.

Runs on Node.js ≥ 22.13 (built-in `node:sqlite`, no native modules → works on
a Raspberry Pi). Architecture, decisions and test evidence:
[`sqlite-roadmap.md`](../../sqlite-roadmap.md).

## Build

```bash
npm ci                                          # repository root
npm --prefix packages/sqlite-server run build   # server (tsc) + state engine bundle
npm --prefix packages/sqlite-server test
```

`dist/` is self-contained except for the workspace packages `@sp/shared-schema`
and `@sp/sync-core` (plain JS). Build the server from the **same commit** as the
apps you use: the state engine is bundled from the app sources (ADR-8/14).

## First start (local test)

```bash
cd packages/sqlite-server
export SP_SQLITE_DB=./data/superprod.sqlite
node dist/src/cli.js user add you@example.com
node dist/src/cli.js token issue you@example.com sync laptop     # for the apps
node dist/src/cli.js token issue you@example.com api-write mcp   # for MCP (or api-read)
echo 'you@example.com=<your SuperSync encryption password>' > ./data/keys.txt
chmod 600 ./data/keys.txt
SP_ENCRYPTION_KEY_FILE=./data/keys.txt node dist/src/index.js    # listens on 127.0.0.1:1902
```

Tokens are printed once; only their SHA-256 hash is stored.

## Configuration (environment)

| Variable                                        | Default                              | Meaning                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SP_SQLITE_DB`                                  | `./data/superprod.sqlite`            | Database file. **Local disk only** (WAL); never on SMB/NFS.                                                                                        |
| `SP_HOST` / `SP_PORT`                           | `127.0.0.1` / `1902`                 | Bind address. Non-loopback needs `SP_ALLOW_NON_LOOPBACK=true`.                                                                                     |
| `SP_ENCRYPTION_KEY_FILE`                        | –                                    | `<email>=<password>` lines. Needed because the apps always encrypt SuperSync data; the server decrypts for the tables/API and encrypts API writes. |
| `SP_BACKUP_DIR`                                 | –                                    | Periodic consistent backups (e.g. a mounted NAS share).                                                                                            |
| `SP_BACKUP_INTERVAL_MINUTES` / `SP_BACKUP_KEEP` | `60` / `48`                          | Backup schedule / rotation.                                                                                                                        |
| `SP_WEB_ROOT`                                   | –                                    | Serve a built web app (`npm run buildFrontend:prodWeb`, folder with `index.html`).                                                                 |
| `SP_CORS_ORIGINS`                               | `https://app.super-productivity.com` | Extra browser origins (not needed for the desktop/mobile apps or `SP_WEB_ROOT`).                                                                   |
| `SP_PROJECTION`                                 | `on`                                 | `off` = sync only (no tables/API).                                                                                                                 |
| `SP_TEST_MODE`                                  | –                                    | E2E test endpoints. Never in production.                                                                                                           |

## Raspberry Pi + Tailscale (recommended deployment)

1. Install Node.js 22 LTS or newer, `git`, and [Tailscale](https://tailscale.com/download/linux); `sudo tailscale up`.
2. Put the database on the Pi's local storage (a USB SSD is better than the SD card), e.g. `/srv/superprod`.
3. Build (on the Pi or copy the built repo), create user/tokens/key file as above.
4. systemd unit `/etc/systemd/system/sp-sqlite-server.service`:

   ```ini
   [Unit]
   Description=Super Productivity SQLite server
   After=network-online.target

   [Service]
   User=superprod
   WorkingDirectory=/opt/super-productivity/packages/sqlite-server
   Environment=SP_SQLITE_DB=/srv/superprod/superprod.sqlite
   Environment=SP_ENCRYPTION_KEY_FILE=/srv/superprod/keys.txt
   Environment=SP_BACKUP_DIR=/mnt/nas/superprod-backups
   Environment=SP_WEB_ROOT=/opt/super-productivity/dist/browser
   Environment=TZ=Europe/Berlin
   ExecStart=/usr/bin/node dist/src/index.js
   Restart=on-failure
   NoNewPrivileges=true
   ProtectSystem=strict
   ReadWritePaths=/srv/superprod /mnt/nas/superprod-backups

   [Install]
   WantedBy=multi-user.target
   ```

   `sudo systemctl enable --now sp-sqlite-server`

5. Publish it **inside your tailnet only** (HTTPS with an automatic certificate):

   ```bash
   sudo tailscale serve --bg --https=443 http://127.0.0.1:1902
   ```

   The server is now `https://<pi-name>.<tailnet>.ts.net`, reachable only by
   your Tailscale devices. Do not use `tailscale funnel` (that would make it
   public).

`TZ` matters: "today" filters use the server's local day (plus your
start-of-next-day setting).

### Backups to the Synology NAS

Mount a NAS share on the Pi (e.g. `/mnt/nas/superprod-backups` via NFS/SMB in
`/etc/fstab`) and set `SP_BACKUP_DIR`. The server writes a consistent copy
with SQLite's online backup API every interval (temp name + rename, rotation).
Version them further with Synology Snapshot Replication/Hyper Backup.
Manual backup: `node dist/src/cli.js backup /mnt/nas/superprod-backups`.

**Restore:** stop the service, copy a backup file over `SP_SQLITE_DB` (remove
`-wal`/`-shm` leftovers), start the service. Devices continue syncing; ops they
created after the backup are re-uploaded by them.

Before a schema upgrade the server automatically writes
`<db>.pre-v<N>-<time>.sqlite` next to the database.

## Connect the apps

In every app (desktop, Android, iOS, web): _Settings → Sync → SuperSync_,
"advanced"/custom server URL `https://<pi-name>.<tailnet>.ts.net`, paste a
`sync` token, keep encryption on with **the same password as in the key file**.

**Existing data:** connect the device that has your data first; its first sync
uploads everything (as a full-state import). Or import a backup file into an
app and sync. Then connect the other devices.

## Connect superprod-mcp

```powershell
$env:SP_API_URL = "https://<pi-name>.<tailnet>.ts.net/api/v1"
# token file ~/.sp-token/sp-token.txt or SP_API_TOKEN: an api-write (or api-read) token
```

No MCP code changes are needed. Not available on a server: timer/focus
endpoints (`/status`, `/focus`, `/task-control/*`, `start`) → HTTP 501.
Titles are stored literally (no `#tag`/`+project` short-syntax parsing). New
tasks without `projectId` go to your default project or the Inbox.

## Operations

```bash
node dist/src/cli.js projection status you@example.com
node dist/src/cli.js projection rebuild you@example.com   # rebuild tables from the op log
node dist/src/cli.js token list you@example.com
node dist/src/cli.js token revoke <id>
```

Read access to the tables with any SQLite tool is safe while the server runs
(WAL); never write to them — they are derived and get rewritten.
