'use strict';

/**
 * End-to-end push against a throwaway, unprivileged sshd on 127.0.0.1 that stands in for a Cloudways server.
 * A fake `wp` on the remote PATH records every WP-CLI call, so the whole files + database pipeline runs through
 * real ssh/rsync (Local's bundled binaries when Local is installed) without touching a real host.
 *
 * Run: node --test test/e2e/localSshd.e2e.js   (macOS/Linux, needs /usr/sbin/sshd)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const LOCAL_RESOURCES = '/Applications/Local.app/Contents/Resources/extraResources';
if (fs.existsSync(LOCAL_RESOURCES)) {
	process.electronPaths = { resourcesPath: LOCAL_RESOURCES };
}

const { SyncService } = require('../../lib/main/SyncService');
const { SshKeyStore } = require('../../lib/main/sshKey');
const { findBundledBinDir } = require('../../lib/main/transport');

const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => fs.existsSync(p));

const FAKE_WP = `#!/bin/sh
# Minimal WP-CLI stand-in: logs calls, emulates the handful of commands push and pull use.
LOG="$FAKE_WP_STATE/wp.log"
args=""
for a in "$@"; do case "$a" in --skip-plugins|--skip-themes) ;; *) args="$args $a" ;; esac; done
echo "wp$args" >> "$LOG"
set -- $args
case "$1 $2" in
  "config get") cat "$FAKE_WP_STATE/prefix" ;;
  "config set") printf '%s' "$4" > "$FAKE_WP_STATE/prefix" ;;
  "option get") echo "https://shop.example.com" ;;
  "db export") case "$3" in
      *local-pull-*) printf '%s\n' '/*M!999999\\- enable the sandbox mode */' \
        'CREATE TABLE \`wp_options\` (x int) COLLATE=utf8mb4_uca1400_ai_ci;' \
        "INSERT INTO \`wp_options\` VALUES ('siteurl','https://shop.example.com');" > "$3" ;;
      *) echo "-- remote backup" > "$3" ;;
    esac ;;
  "db reset") : ;;
  "db import") cp "$3" "$FAKE_WP_STATE/imported.sql" ;;
  "search-replace "*) : ;;
  *) : ;;
esac
exit 0
`;

const isLink = (p) => {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch (e) {
		return false;
	}
};

function freePort() {
	return new Promise((resolve) => {
		const srv = net.createServer().listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

async function waitForPort(port, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const ok = await new Promise((resolve) => {
			const s = net.connect(port, '127.0.0.1', () => { s.end(); resolve(true); }).on('error', () => resolve(false));
		});
		if (ok) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`sshd did not start on ${port}`);
}

test('pushes to and pulls from a stand-in server over ssh/rsync', { skip: !SSHD || process.platform === 'win32', timeout: 120000 }, async (t) => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-e2e-')));
	const dirs = Object.fromEntries(['sshd', 'state', 'bin', 'work', 'local', 'remote'].map((d) => [d, path.join(root, d)]));
	Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	// "Local" site
	const webRoot = path.join(dirs.local, 'app', 'public');
	fs.mkdirSync(path.join(webRoot, 'wp-content', 'themes', 'mine'), { recursive: true });
	fs.writeFileSync(path.join(webRoot, 'wp-config.php'), '<?php // LOCAL creds');
	fs.writeFileSync(path.join(webRoot, 'index.php'), '<?php // local index');
	fs.writeFileSync(path.join(webRoot, 'wp-content', 'themes', 'mine', 'style.css'), '/* theme */');
	fs.writeFileSync(path.join(webRoot, 'wp-content', 'object-cache.php'), '<?php // local cache dropin');
	fs.writeFileSync(path.join(webRoot, '.cloudways-push-ignore'), 'secret-notes.txt\n');
	fs.writeFileSync(path.join(webRoot, 'secret-notes.txt'), 'do not push');
	// A child theme developed in another folder and symlinked into the site, plus a link whose target is gone.
	const devTheme = path.join(root, 'dev', 'mytheme');
	fs.mkdirSync(path.join(devTheme, 'assets'), { recursive: true });
	fs.writeFileSync(path.join(devTheme, 'style.css'), '/* Theme Name: Mine Child */');
	fs.writeFileSync(path.join(devTheme, 'assets', 'app.css'), 'body{color:#196cdf}');
	fs.symlinkSync(devTheme, path.join(webRoot, 'wp-content', 'themes', 'mine-child'));
	fs.symlinkSync(path.join(root, 'dev', 'deleted-plugin'), path.join(webRoot, 'wp-content', 'themes', 'gone'));

	// "Cloudways" app directory: <app>/public_html with its own wp-config.php and a stale file
	const appDir = path.join(dirs.remote, 'appuser');
	const remoteWeb = path.join(appDir, 'public_html');
	fs.mkdirSync(remoteWeb, { recursive: true });
	fs.writeFileSync(path.join(remoteWeb, 'wp-config.php'), '<?php // CLOUDWAYS creds');
	fs.writeFileSync(path.join(remoteWeb, '.htaccess'), '# cloudways rules');
	fs.writeFileSync(path.join(remoteWeb, 'stale.php'), '<?php // stale');
	fs.writeFileSync(path.join(dirs.state, 'prefix'), 'wp_');

	fs.writeFileSync(path.join(dirs.bin, 'wp'), FAKE_WP, { mode: 0o755 });

	// Key the add-on would register with Cloudways
	const keys = new SshKeyStore(path.join(dirs.work, 'ssh'));
	fs.writeFileSync(path.join(dirs.sshd, 'authorized_keys'), `${keys.ensure('e2e')}\n`, { mode: 0o600 });

	const port = await freePort();
	const hostKey = path.join(dirs.sshd, 'host_ed25519');
	execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
	const remotePath = [dirs.bin, findBundledBinDir(), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':');
	fs.writeFileSync(path.join(dirs.sshd, 'sshd_config'), [
		`Port ${port}`,
		'ListenAddress 127.0.0.1',
		`HostKey ${hostKey}`,
		`PidFile ${path.join(dirs.sshd, 'sshd.pid')}`,
		`AuthorizedKeysFile ${path.join(dirs.sshd, 'authorized_keys')}`,
		'PasswordAuthentication no',
		'KbdInteractiveAuthentication no',
		'UsePAM no',
		'StrictModes no',
		`SetEnv PATH=${remotePath} FAKE_WP_STATE=${dirs.state}`,
		'',
	].join('\n'));
	const sshd = spawn(SSHD, ['-D', '-e', '-f', path.join(dirs.sshd, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
	let sshdLog = '';
	sshd.stderr.on('data', (d) => { sshdLog += d; });
	t.after(() => sshd.kill());
	await waitForPort(port);

	const events = [];
	const site = { id: 'site1', name: 'Shop', domain: 'shop.local', paths: { webRoot, sql: path.join(dirs.local, 'app', 'sql') } };
	const localWpCalls = [];
	const link = {
		mode: 'manual',
		authType: 'key',
		host: '127.0.0.1',
		port,
		username: os.userInfo().username,
		remotePath: remoteWeb,
		domain: 'shop.example.com',
		appFqdn: 'wordpress-1-2.cloudwaysapps.com',
	};
	let storedLink = { ...link };
	const service = new SyncService({
		store: {
			getLink: () => storedLink,
			updateLink: (id, patch) => { storedLink = { ...storedLink, ...patch }; },
		},
		keys,
		workDir: dirs.work,
		getApi: () => { throw new Error('API not used in manual mode'); },
		services: {
			siteData: { getSite: () => site },
			siteDatabase: {
				dump: async (_site, dest) => fs.writeFileSync(dest, [
					'CREATE TABLE `wp_options` (x int) COLLATE=utf8mb4_0900_ai_ci;',
					"INSERT INTO `wp_options` VALUES ('siteurl','http://shop.local');",
				].join('\n')),
				getTablePrefix: async () => 'wplocal_',
			},
			siteProcessManager: { getSiteStatus: () => 'running', start: async () => {} },
			// Stand-in for Local's WpCliService.run(site, args)
			wpCli: {
				run: async (_site, args) => {
					localWpCalls.push(args.join(' '));
					if (args.join(' ') === 'option get home') return 'http://shop.local\n';
					if (args[0] === 'db' && args[1] === 'import') fs.copyFileSync(args[2], path.join(dirs.state, 'local-imported.sql'));
					return '';
				},
			},
		},
		sendIPCEvent: (...args) => events.push(args),
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	});

	let result;
	try {
		result = await service.push('site1', { backup: false });
	} catch (e) {
		assert.fail(`${e.message}\n--- sshd ---\n${sshdLog}`);
	}
	assert.equal(result.ok, true);
	// The whole push (discovery, rsync, a dozen WP-CLI calls) logs in once and shares that connection.
	await new Promise((r) => setTimeout(r, 200));
	assert.equal((sshdLog.match(/Accepted publickey/g) || []).length, 1, sshdLog);

	// Files: pushed, excludes respected, remote-only config preserved, stale files deleted
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'index.php'), 'utf8'), '<?php // local index');
	assert.ok(fs.existsSync(path.join(remoteWeb, 'wp-content', 'themes', 'mine', 'style.css')));
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'wp-config.php'), 'utf8'), '<?php // CLOUDWAYS creds');
	assert.ok(fs.existsSync(path.join(remoteWeb, '.htaccess')), '.htaccess must survive --delete');
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'stale.php')), 'stale remote file should be deleted');
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'wp-content', 'object-cache.php')));
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'secret-notes.txt')), '.cloudways-push-ignore should apply');
	// A theme symlinked from outside the site arrives as real files; a broken link is skipped, not fatal.
	const remoteChild = path.join(remoteWeb, 'wp-content', 'themes', 'mine-child');
	assert.ok(!fs.lstatSync(remoteChild).isSymbolicLink(), 'linked theme must be copied, not sent as a dangling link');
	assert.equal(fs.readFileSync(path.join(remoteChild, 'assets', 'app.css'), 'utf8'), 'body{color:#196cdf}');
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'wp-content', 'themes', 'gone')) && !isLink(path.join(remoteWeb, 'wp-content', 'themes', 'gone')));

	// Database: backup outside the webroot, collations rewritten, temp dump cleaned up
	assert.ok(fs.existsSync(path.join(appDir, 'local-backup-before-push.sql')));
	const imported = fs.readFileSync(path.join(dirs.state, 'imported.sql'), 'utf8');
	assert.ok(imported.includes('utf8mb4_unicode_520_ci') && !imported.includes('0900'));
	assert.deepEqual(fs.readdirSync(appDir).filter((f) => f.startsWith('local-push-')), []);

	const wpLog = fs.readFileSync(path.join(dirs.state, 'wp.log'), 'utf8');
	assert.match(wpLog, /wp db reset --yes/);
	assert.match(wpLog, /wp search-replace \/\/shop\.local \/\/shop\.example\.com/);
	assert.match(wpLog, /wp search-replace \\\/\\\/shop\.local \\\/\\\/shop\.example\.com/);
	assert.match(wpLog, /wp search-replace http:\/\/shop\.example\.com https:\/\/shop\.example\.com/);
	assert.equal(fs.readFileSync(path.join(dirs.state, 'prefix'), 'utf8'), 'wplocal_');

	// Site overlay lifecycle mirrors Local Connect
	const statuses = events.filter(([name]) => name === 'updateSiteStatus').map(([, , s]) => s);
	assert.equal(statuses[0], 'pushing_v2');
	assert.equal(statuses[statuses.length - 1], 'running');
	assert.ok(events.some(([name, banner]) => name === 'showSiteBanner' && banner.id === 'cloudways-site-pushed'));
	assert.equal(storedLink.privateDir, appDir);

	// ---------------------------------------------------------------- pull
	fs.mkdirSync(path.join(remoteWeb, 'wp-content', 'uploads'), { recursive: true });
	fs.writeFileSync(path.join(remoteWeb, 'wp-content', 'uploads', 'photo.jpg'), 'jpeg');
	fs.writeFileSync(path.join(remoteWeb, 'wp-content', 'object-cache.php'), '<?php // redis on cloudways');
	fs.writeFileSync(path.join(webRoot, 'local-only.php'), '<?php // only in local');
	fs.writeFileSync(path.join(remoteChild, 'server-edit.css'), '/* edited on the server */');
	events.length = 0;

	try {
		result = await service.pull('site1');
	} catch (e) {
		assert.fail(`${e.message}\n--- sshd ---\n${sshdLog}`);
	}
	assert.equal(result.ok, true);

	// Files: remote uploads arrive, Local keeps its own wp-config.php, server cache drop-ins stay on the server
	assert.equal(fs.readFileSync(path.join(webRoot, 'wp-content', 'uploads', 'photo.jpg'), 'utf8'), 'jpeg');
	assert.equal(fs.readFileSync(path.join(webRoot, 'wp-config.php'), 'utf8'), '<?php // LOCAL creds');
	assert.equal(fs.readFileSync(path.join(webRoot, 'wp-content', 'object-cache.php'), 'utf8'), '<?php // local cache dropin');
	assert.ok(!fs.existsSync(path.join(webRoot, 'local-only.php')), 'local-only file should be deleted');
	// The linked theme is Local-owned: the link stays, and nothing is written into or deleted from its real folder.
	assert.ok(fs.lstatSync(path.join(webRoot, 'wp-content', 'themes', 'mine-child')).isSymbolicLink());
	assert.deepEqual(fs.readdirSync(devTheme).sort(), ['assets', 'style.css']);
	assert.ok(isLink(path.join(webRoot, 'wp-content', 'themes', 'gone')), 'broken link left alone');
	fs.rmSync(path.join(remoteChild, 'server-edit.css'));

	// Database: Local backed up first, MariaDB dump normalized for MySQL, URLs rewritten to the .local domain
	assert.ok(fs.existsSync(path.join(dirs.local, 'app', 'sql', 'local-backup-before-pull.sql')));
	const pulledSql = fs.readFileSync(path.join(dirs.state, 'local-imported.sql'), 'utf8');
	assert.ok(!pulledSql.includes('sandbox mode') && !pulledSql.includes('uca1400'));
	assert.ok(pulledSql.includes("'siteurl','https://shop.example.com'"));
	assert.deepEqual(localWpCalls.slice(0, 2), ['option get home', 'db reset --yes']);
	assert.match(localWpCalls[2], /^db import .+cloudways-pull-site1-[0-9a-f]+\.sql$/);
	assert.ok(localWpCalls.includes('search-replace //shop.example.com //shop.local --all-tables --precise --skip-columns=guid --report-changed-only'));
	assert.ok(localWpCalls.includes('search-replace //wordpress-1-2.cloudwaysapps.com //shop.local --all-tables --precise --skip-columns=guid --report-changed-only'));
	assert.ok(localWpCalls.includes('search-replace https://shop.local http://shop.local --all-tables --precise --skip-columns=guid --report-changed-only'));
	assert.ok(!localWpCalls.some((c) => c.startsWith('config set')), 'prefixes already match after the push');
	assert.deepEqual(fs.readdirSync(appDir).filter((f) => f.startsWith('local-pull-')), [], 'remote export cleaned up');

	const pullStatuses = events.filter(([name]) => name === 'updateSiteStatus').map(([, , st]) => st);
	assert.equal(pullStatuses[0], 'pulling');
	assert.equal(pullStatuses[pullStatuses.length - 1], 'running');
	assert.ok(events.some(([name, banner]) => name === 'showSiteBanner' && banner.id === 'cloudways-site-pulled'));
	assert.ok(events.some(([name]) => name === 'refreshSiteVersions'));
	assert.ok(storedLink.lastPull && storedLink.lastPush);

	// ---------------------------------------------------------------- compare & selective sync
	const later = new Date(Date.now() + 120000);
	fs.writeFileSync(path.join(webRoot, 'wp-content', 'themes', 'mine', 'style.css'), '/* theme v2, edited locally */');
	fs.utimesSync(path.join(webRoot, 'wp-content', 'themes', 'mine', 'style.css'), later, later);
	fs.mkdirSync(path.join(webRoot, 'wp-content', 'plugins', 'p'), { recursive: true });
	fs.writeFileSync(path.join(webRoot, 'wp-content', 'plugins', 'p', 'new.php'), '<?php // new plugin');
	fs.writeFileSync(path.join(remoteWeb, 'wp-content', 'uploads', 'remote only.jpg'), 'jpeg2');

	let comparison = await service.compare('site1');
	const summary = (c) => c.entries.map((e) => [e.path, e.status, e.newer]);
	assert.deepEqual(summary(comparison), [
		['wp-content/plugins/p/new.php', 'local-only', null],
		['wp-content/themes/mine/style.css', 'changed', 'local'],
		['wp-content/uploads/remote only.jpg', 'remote-only', null],
	], 'excluded files (wp-config.php, object-cache.php, ignore-listed) never appear');
	const styleEntry = comparison.entries[1];
	assert.equal(styleEntry.local.size, '/* theme v2, edited locally */'.length);
	assert.equal(styleEntry.remote.size, '/* theme */'.length);

	await assert.rejects(service.push('site1', { fileList: ['wp-config.php'] }), /out of date/);
	comparison = await service.compare('site1');

	// Push two of the three: the edited stylesheet goes up, the remote-only upload is deleted on the server
	await service.push('site1', { fileList: ['wp-content/themes/mine/style.css', 'wp-content/uploads/remote only.jpg'], backup: false });
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'wp-content', 'themes', 'mine', 'style.css'), 'utf8'), '/* theme v2, edited locally */');
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'wp-content', 'uploads', 'remote only.jpg')));
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'wp-content', 'plugins', 'p', 'new.php')), 'unselected file stays put');
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'wp-config.php'), 'utf8'), '<?php // CLOUDWAYS creds');
	assert.equal(storedLink.lastPush.selectedFiles, 2);

	comparison = await service.compare('site1');
	assert.deepEqual(summary(comparison), [['wp-content/plugins/p/new.php', 'local-only', null]]);

	// Pull the remaining one: it does not exist on Cloudways, so pulling it removes the local copy
	await service.pull('site1', { fileList: ['wp-content/plugins/p/new.php'] });
	assert.ok(!fs.existsSync(path.join(webRoot, 'wp-content', 'plugins', 'p', 'new.php')));
	assert.deepEqual((await service.compare('site1')).entries, []);

	// Checksum mode catches same-size, same-mtime edits that the quick check cannot see
	const remoteIndex = path.join(remoteWeb, 'index.php');
	const stamp = fs.statSync(remoteIndex).mtime;
	fs.writeFileSync(remoteIndex, '<?php // LOCAL index'); // same length as the original
	fs.utimesSync(remoteIndex, stamp, stamp);
	assert.deepEqual((await service.compare('site1')).entries, []);
	assert.deepEqual(summary(await service.compare('site1', { checksum: true })), [['index.php', 'changed', 'same']]);
});

