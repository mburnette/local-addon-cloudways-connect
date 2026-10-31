# Host Connect for Cloudways

A [Local](https://localwp.com) add-on that connects Local to [Cloudways](https://www.cloudways.com) WordPress applications. It works the way Local Connect does for WP Engine and Flywheel. You can:

- **push** a site's files, database, or both to Cloudways;
- **pull** them back into an existing Local site;
- **pull a Cloudways app into a brand-new Local site**;
- **compare** files on both sides and push or pull only the ones you pick, like MagicSync.

It reuses Local Connect's approach (see `WPEPushService` and `WPEPullService` in Local 10.1.2):

| Step | WP Engine (built in) | Host Connect for Cloudways |
| --- | --- | --- |
| Auth | WP Engine account + Local's SSH key registered via CAPI | A Cloudways access token (`cw_…`), and the add-on's own SSH key registered on an app credential via `POST /ssh_key`. Plain SFTP/SSH credentials also work. |
| Backup | CAPI backup before push | `POST /app/manage/takeBackup`, polled with `GET /operation/{id}` (optional) |
| Files | Local's bundled `rsync` over SSH, `--delete`, excludes `wp-config.php` | Same binaries, same flags. Excludes `wp-config.php`, `.htaccess`, cache drop-ins and anything in `.cloudways-push-ignore`. |
| Database | `wp db export` backup → `wp db reset` → import → `search-replace //local //remote` → match table prefix | Same, plus collation fixes between MySQL and MariaDB in both directions and automatic restore if an import fails |
| Pull | rsync down, export remote DB, import through Local's importer, `search-replace //remote //local` | rsync down with the same excludes. The remote DB export is imported through Local's own WP-CLI service, after a backup of the Local DB. |
| Cache | Purge CDN/object/page cache | `POST /app/cache/purge` + `wp cache flush` + Breeze purge |
| Pull to new site | "Create a site → Pull from WP Engine" | "Create a site → Pull from Cloudways". It verifies the connection, creates the site with Local's own `addSite` service, links it, then pulls. |
| MagicSync | rsync dry run, itemized changes, file tree with checkboxes, `--files-from` | rsync dry runs in both directions, merged into one list with both sides' size and date. Ticked files move with `--files-from`. |
| UI | Site status `pushing_v2` / `pulling` overlay, progress and banners | Same overlay, progress and banners |

## Requirements

- Local 6 or newer. Built and tested against **Local 10.1.2 on macOS**.
- A Cloudways **WordPress** application. Cloudways servers ship with WP-CLI and rsync.
- For API mode: a Cloudways **access token** (starts with `cw_`) from **Account → API Integration** (https://platform.cloudways.com/api).
  - Pick **Full Access**, or **Limited Access** that covers servers and applications, application credentials and SSH access, SSH keys, backups, cache and operations.
  - Legacy API keys (with your account email) still work until Cloudways retires them on October 15, 2026.
- For SFTP/SSH mode: the application's **Application Credentials** (Applications → your app → Access Details), with SSH access enabled.

## Install

### From source (development)

```bash
npm install
```

```bash
npm run install-addon
```

This symlinks the folder into Local's add-ons directory (`~/Library/Application Support/Local/addons` on macOS) and enables it. **Restart Local** to load it. To remove it, run `npm run install-addon -- --remove`.

### From a release

Download the `.tgz` from the [latest release](../../releases/latest). In Local, go to **Add-ons → Install from disk**, choose the file, enable the add-on and restart Local.

### Updates

The add-on checks this repository's releases when Local starts and every 12 hours after that. You can also check right away from **Check for updates** at the bottom of the add-on's panel. When a new version is out, the panel shows an **Update** button. It installs the update through Local's own add-on installer, then offers to restart Local. Your linked sites and saved credentials are kept.

To build a package yourself, run `npm run package`, or use `npm run release -- patch --dry-run` (see [RELEASING.md](RELEASING.md)).

## Use

1. Open a site in Local and go to **Tools → Cloudways**.
2. Connect in one of two ways:
   - **Cloudways API (recommended):** paste your access token, pick the application (grouped by server) and click **Link**. The add-on then:
     - turns on SSH access for the app if it is off;
     - uses the app's credential, or creates one if none exists;
     - registers its SSH key on that credential;
     - waits for the key to work and finds the WordPress webroot.
   - **SFTP/SSH credentials:** enter the server IP, the app credential's username and either its password or the add-on's public key. If you use the key, add it under Application Credentials → SSH Keys in Cloudways first.
3. Push or pull from the panel's **Push to Cloudways** / **Pull from Cloudways** tabs. Once the site is linked, you can also use the **Cloudways: Pull / Push** buttons in the site header.
   - Push options:
     - Files and/or Database
     - Take a Cloudways application backup first (API mode)
     - Delete files on Cloudways that aren't in Local (on by default, like WP Engine)
     - Purge Cloudways caches afterwards
   - Pull options:
     - Files and/or Database
     - Back up the Local database first
     - Delete Local files that aren't on Cloudways (on by default, like WP Engine)

Progress appears in Local's site overlay. When the transfer finishes, a banner reports success or the error.

### Pull a Cloudways site into a new Local site

1. Click **+** (Create a site) in Local and choose **Pull from Cloudways**.
2. Pick the Cloudways app (API) or enter SFTP/SSH credentials. Name the Local site; it defaults to the app's name. The page previews the `.local` domain and folder, which follow your Local new-site defaults and avoid existing sites.
3. Click **Create site & pull**.
   - The connection is checked **first**, so a wrong password or key never leaves an empty site behind.
   - Local then creates a normal site (its default PHP, MySQL and web server), the add-on links it, and pulls the files and database.

### Compare & sync files (selective sync)

Go to **Tools → Cloudways → Compare & sync files** and click **Compare with Cloudways**. Nothing changes until you choose files. The result lists every differing file in three groups:

- **Different on each side:** shows Local's and Cloudways' size and modification time, and which copy is newer.
- **Only in Local**
- **Only on Cloudways**

Filter by path, tick individual files or whole groups, then click **Push selected** or **Pull selected**. The confirmation tells you what will be uploaded, downloaded or deleted.

- **What moves:** only the ticked files. The database is never touched, and Cloudways caches are purged after a selective push.
- **Deletions:** a ticked file that exists only on the receiving side is **deleted** there, so both sides end up matching. For example, pushing a file that is only on Cloudways removes it from Cloudways.
- **How differences are found:** by default, rsync compares size + modification time, which is fast. Tick **Compare file contents (slower)** to compare checksums. That catches edits that kept the same size and date, but it reads every file on both sides.
- **Exclusions:** the push/pull exclusions below apply here too, so `wp-config.php`, `.htaccess` and cache drop-ins never show up as differences.

### What a database push does

1. Exports the Local database and rewrites MySQL 8 `utf8mb4_0900_*` collations to MariaDB-compatible ones.
2. On Cloudways, saves the current database to `local-backup-before-push.sql` in the app's `tmp/` folder (or `private_html/`), **outside** `public_html` and readable only by the app user. It also reads the current `home` URL and `table_prefix`.
3. Uploads the dump outside the webroot, then runs `wp db reset` and `wp db import`. If the import fails, it restores the backup automatically. The uploaded dump is always deleted afterwards.
4. Sets `table_prefix` to match Local if the two differ.
5. Runs `wp search-replace` across all tables (`--precise`, `guid` skipped) for:
   - `//site.local` → the URL WordPress had on Cloudways;
   - the JSON-escaped form `\/\/site.local`, which block editors and page builders store;
   - `http://` → `https://` when the Cloudways site was on HTTPS.

### What a database pull does

1. On Cloudways, exports the database with `--single-transaction`, so the live site isn't locked. It also reads `home` and `table_prefix`.
2. Downloads the export and deletes it from the server. Then it makes the dump importable by Local's MySQL:
   - removes the `/*M!999999\- enable the sandbox mode */` line that newer MariaDB writes;
   - rewrites MariaDB 11 `uca1400` collations.
3. Saves the Local database to `app/sql/local-backup-before-pull.sql` (optional).
4. Runs `wp db reset` and `wp db import` through Local's own WP-CLI service, which uses the site's PHP and MySQL. If the import fails, it restores the backup.
5. Sets the local `table_prefix` to Cloudways' if the two differ.
6. Runs `search-replace` (`--precise`, `guid` skipped) from the Cloudways URL to the Local URL. It also covers:
   - the app's temporary `*.cloudwaysapps.com` address (API mode);
   - the JSON-escaped forms;
   - fixing `https://site.local` back to `http://` when the Local site doesn't use HTTPS.

### What is never transferred

These are excluded in both directions. Excluded paths are also protected from `--delete`, so each side keeps its own copy. Cloudways keeps its `wp-config.php` and `.htaccess`, and Local keeps its own. Cloudways' Redis/Breeze drop-ins never reach Local, where they'd break the site.

- Environment config: `wp-config.php`, `.htaccess`, `.user.ini`
- Cache drop-ins and output: `object-cache.php`, `advanced-cache.php`, `wp-content/cache/`, Breeze config
- VCS and tool binaries: `.git/`, `node_modules/.bin`, `vendor/bin`
- Root-level `*.sql` dumps
- Local's helper files

To skip more, add rsync patterns (one per line) to `app/public/.cloudways-push-ignore` or `.cloudways-pull-ignore`. These work like `.wpe-push-ignore` and `.wpe-pull-ignore`.

### Themes and plugins symlinked from elsewhere

A theme or plugin that you develop in another folder and symlink into the Local site (for example `wp-content/themes/mytheme → ~/code/mytheme`) is **pushed as real files**, because the server has no such folder to point to. It is **never pulled into**: a pull leaves the symlink and the folder it points to untouched, so server copies can't overwrite or delete your working files. Symlinks within the site stay symlinks, and broken symlinks are skipped (and logged).

## Security notes

- **Secrets:** the access token (or legacy API key) and any SFTP password are encrypted with Electron `safeStorage` (Keychain on macOS, DPAPI on Windows). They are stored in `<Local data>/cloudways-connect/settings.json` and never sent to the renderer.
- **SSH key and known hosts:** the add-on keeps its own RSA key in `<Local data>/cloudways-connect/ssh/`, separate from Local's WP Engine key. It also keeps its own `known_hosts` file, which pins each server's host key on first connect.
- **Passwords:** SSH passwords go to `ssh` through `SSH_ASKPASS` and an environment variable. They are never put in argv or written to disk.
- **Shared SSH connection:** on macOS and Linux, a push, pull or compare logs in once and runs every `ssh` and `rsync` command over that one connection (OpenSSH multiplexing). Its control socket is `/tmp/cwc-<hash>`, which only your user can use, and the connection is closed when the transfer ends (or after 120 idle seconds if the add-on quits mid-transfer). Windows opens a connection per command.
- **Token scope:** prefer a Limited Access token with just the permissions above; a Full Access token or legacy API key controls the whole account. If a Limited token lacks a permission, the add-on names the call it was refused. Unlinking a site can also delete its SSH key from Cloudways.

## Limitations and what is not verified

- **Not yet run against a live Cloudways account or inside Local itself.** The API calls follow Cloudways' published OpenAPI spec (`developers.cloudways.com/api.yaml`) and are covered by unit tests with recorded response shapes. Pull's local import goes through Local's `wpCli` service, which the end-to-end test stubs. Do the first real link, push and pull on a staging app.
- **Inside Local, the new-site and compare screens are untested.** The "Pull from Cloudways" wizard option and page use Local's `CreateSite:RadioOptions` and `routes[main]` hooks and its `addSite` service. These are confirmed against Local 10.1.2's source and covered by tests, but haven't been clicked through in a running Local.
- **Selective sync is files only.** Pick database transfers from the Push/Pull tabs.
- **App listing:** apps are listed with the deprecated `GET /server` endpoint, because it is the only listing that includes each server's apps. If Cloudways removes it, switch to `/servers` + `/servers/{id}`.
- **Multisite:** the domain columns in `wp_blogs` and `wp_site` are not rewritten.
- **Windows:** password auth is not supported (use the SSH key option), and nothing has been tested on Windows.

## Development

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run lint
```

- `npm test` runs the unit, main-process and renderer tests. They cover:
  - the API client against fake responses;
  - the SSH key format (checked with `ssh-keygen`);
  - the remote discovery script and quoting;
  - dump normalization and URL replacement pairs;
  - rsync itemize parsing and merging;
  - encrypted storage;
  - the main-process IPC handlers with Local's API mocked, including the full pull-to-new-site sequence;
  - the React UI mounted in jsdom with the real `@getflywheel/local-components`.
- `npm run test:e2e` starts an unprivileged `sshd` on 127.0.0.1 with a fake `wp` binary. It then runs, through Local's bundled `rsync`/`ssh`:
  - a full files + database push, checking it logs in only once (the shared SSH connection);
  - a full pull;
  - a comparison, a selective push and a selective pull (including deletions);
  - a checksum compare.

```
lib/
  main.js                 add-on main process: IPC handlers, linking flow
  main/CloudwaysApi.js    Cloudways REST client (auth, servers, creds, SSH keys, backups, cache, operations)
  main/SyncService.js     push and pull orchestration (files, database, search-replace, cache)
  main/transport.js       rsync/ssh runner using Local's bundled binaries, key or password auth
  main/sshKey.js          RSA key pair in OpenSSH format
  main/store.js           settings + encrypted secrets
  main/updater.js         checks GitHub releases and installs updates through Local's add-on installer
  renderer.js             hooks: Tools → Cloudways tab, header pull/push buttons, stylesheet
  renderer/components.js  React UI (plain React.createElement, no build step)
```

### Cloudways endpoints used

| Purpose | Endpoint |
| --- | --- |
| Auth | Access token: `Authorization: Bearer cw_…` on every call. Legacy key: `POST /oauth/access_token` (`email`, `api_key`) |
| Servers + apps | `GET /server` |
| SSH access | `GET /app/getAppSshPerms`, `POST /app/updateAppSshPerms` |
| App credentials | `GET /app/creds`, `POST /app/creds` |
| SSH keys | `POST /ssh_key`, `DELETE /ssh_key/{id}` |
| Backup | `POST /app/manage/takeBackup` |
| Cache | `POST /app/cache/purge` |
| Operations | `GET /operation/{id}` |

The base URL is `https://api.cloudways.com/api/v2`, with a fallback to `/api/v1`.

## Releasing

See [RELEASING.md](RELEASING.md). In short: commit to `main`, then run `npm run release -- patch` (or `minor`/`major`).
