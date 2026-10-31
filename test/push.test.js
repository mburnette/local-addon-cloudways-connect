'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
	discoverRemoteScript, parseKeyValues, findExternalLinks, normalizeDumpForImport, urlReplacements, parseItemized, mergeComparison,
	SyncService, ShellAccessDisabledError,
} = require('../lib/main/SyncService');
const { SshKeyStore, fingerprint } = require('../lib/main/sshKey');
const { Store } = require('../lib/main/store');
const { shellQuote, describeSshFailure } = require('../lib/main/transport');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cw-connect-test-'));

test('generated public key is valid OpenSSH and fingerprints match ssh-keygen', { skip: process.platform === 'win32' }, () => {
	const dir = tmp();
	const store = new SshKeyStore(path.join(dir, 'ssh'));
	const pub = store.ensure('local-test@host');
	assert.match(pub, /^ssh-rsa AAAA[0-9A-Za-z+/=]+ local-test@host$/);

	const out = execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', store.publicKeyPath], { encoding: 'utf8' });
	assert.ok(out.includes(fingerprint(pub)), `ssh-keygen printed ${out}`);

	// The private key must be readable by OpenSSH and correspond to the public key.
	const derived = execFileSync('ssh-keygen', ['-y', '-f', store.privateKeyPath], { encoding: 'utf8' }).trim();
	assert.equal(derived.split(' ').slice(0, 2).join(' '), pub.split(' ').slice(0, 2).join(' '));
	assert.equal(fs.statSync(store.privateKeyPath).mode & 0o777, 0o600);

	// Idempotent: a second call keeps the same key.
	assert.equal(store.ensure('other'), pub);
});

test('discover script finds the Cloudways app-credential layout ($HOME/public_html)', { skip: process.platform === 'win32' }, () => {
	const home = tmp();
	fs.mkdirSync(path.join(home, 'public_html'));
	fs.writeFileSync(path.join(home, 'public_html', 'wp-config.php'), '<?php');
	const out = execFileSync('sh', ['-c', discoverRemoteScript({ sysUser: 'abcdefgh' })], {
		env: { ...process.env, HOME: home },
		encoding: 'utf8',
	});
	const info = parseKeyValues(out);
	assert.equal(info.webroot, fs.realpathSync(path.join(home, 'public_html')));
	assert.equal(info.private, fs.realpathSync(home));
	assert.ok(['yes', 'no'].includes(info.wpcli));
});

test('discover script honours an explicit remote path with spaces and quotes', { skip: process.platform === 'win32' }, () => {
	const home = tmp();
	const custom = path.join(home, "my 'site'", 'web');
	fs.mkdirSync(custom, { recursive: true });
	fs.writeFileSync(path.join(custom, 'wp-load.php'), '<?php');
	const out = execFileSync('sh', ['-c', discoverRemoteScript({ remotePath: custom })], {
		env: { ...process.env, HOME: home },
		encoding: 'utf8',
	});
	assert.equal(parseKeyValues(out).webroot, fs.realpathSync(custom));
});

test('discover script exits 3 when no WordPress is found', { skip: process.platform === 'win32' }, () => {
	const home = tmp();
	assert.throws(
		() => execFileSync('sh', ['-c', discoverRemoteScript({ sysUser: 'x; rm -rf /' })], { env: { ...process.env, HOME: home }, stdio: 'pipe' }),
		(e) => e.status === 3 && /home=/.test(e.stdout.toString()),
	);
});

test('finds symlinks that point outside the site, and broken ones, but not links within it', { skip: process.platform === 'win32' }, () => {
	const root = tmp();
	const web = path.join(root, 'public');
	fs.mkdirSync(path.join(web, 'wp-content', 'themes'), { recursive: true });
	fs.mkdirSync(path.join(web, 'wp-content', 'uploads', '2026'), { recursive: true });
	fs.mkdirSync(path.join(root, 'dev', 'theme'), { recursive: true });
	fs.symlinkSync(path.join(root, 'dev', 'theme'), path.join(web, 'wp-content', 'themes', 'mine'));
	fs.symlinkSync('../../dev/theme', path.join(web, 'wp-content', 'relative-out'));
	fs.symlinkSync('2026', path.join(web, 'wp-content', 'uploads', 'latest'));
	fs.symlinkSync(path.join(root, 'nope'), path.join(web, 'wp-content', 'themes', 'gone'));
	const links = findExternalLinks(web);
	assert.deepEqual(links.external.sort(), ['wp-content/relative-out', 'wp-content/themes/mine']);
	assert.deepEqual(links.broken, ['wp-content/themes/gone']);
	assert.deepEqual(findExternalLinks(path.join(root, 'missing')), { external: [], broken: [] });
});

test('shellQuote survives a round trip through sh', { skip: process.platform === 'win32' }, () => {
	const nasty = `it's "quoted" $HOME \`date\` ; echo nope`;
	assert.equal(execFileSync('sh', ['-c', `printf %s ${shellQuote(nasty)}`], { encoding: 'utf8' }), nasty);
});

test('normalizes dumps in both directions: MySQL 8 -> MariaDB and MariaDB 11 -> MySQL', async () => {
	const file = path.join(tmp(), 'dump.sql');
	fs.writeFileSync(file, [
		'/*M!999999\\- enable the sandbox mode */ ',
		'CREATE TABLE `wp_posts` (x int) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
		'CREATE TABLE `wp_terms` (x int) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;',
		"INSERT INTO `wp_options` VALUES (1,'blogname','Hi','yes');",
		'`c` varchar(1) COLLATE utf8mb4_0900_as_cs NOT NULL,',
		'`d` varchar(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_uca1400_ai_ci NOT NULL',
	].join('\n'));
	await normalizeDumpForImport(file);
	const out = fs.readFileSync(file, 'utf8');
	assert.ok(!out.includes('sandbox mode'), 'MariaDB sandbox line breaks the MySQL client');
	assert.ok(!/0900|uca1400/.test(out));
	assert.equal((out.match(/utf8mb4_unicode_520_ci/g) || []).length, 3);
	assert.ok(out.includes('utf8mb3_unicode_ci'));
	assert.ok(out.startsWith('CREATE TABLE `wp_posts`'));
	assert.ok(out.includes("'blogname','Hi'"));
});

test('url replacements for push (Local -> https Cloudways)', () => {
	assert.deepEqual(urlReplacements(['//shop.local'], 'https://shop.example.com/'), [
		['//shop.local', '//shop.example.com'],
		['\\/\\/shop.local', '\\/\\/shop.example.com'],
		['http://shop.example.com', 'https://shop.example.com'],
	]);
});

test('url replacements for pull (Cloudways + temp domain -> http Local)', () => {
	assert.deepEqual(urlReplacements(['https://shop.example.com', '//wordpress-1-2.cloudwaysapps.com'], 'http://shop.local'), [
		['//shop.example.com', '//shop.local'],
		['\\/\\/shop.example.com', '\\/\\/shop.local'],
		['//wordpress-1-2.cloudwaysapps.com', '//shop.local'],
		['\\/\\/wordpress-1-2.cloudwaysapps.com', '\\/\\/shop.local'],
		['https://shop.local', 'http://shop.local'],
	]);
});

test('url replacements skip a source that already equals the destination', () => {
	assert.deepEqual(urlReplacements(['https://shop.local'], 'https://shop.local'), [['http://shop.local', 'https://shop.local']]);
});

test('store encrypts secrets and never exposes them to the renderer', () => {
	const dir = tmp();
	const fakeSafeStorage = {
		isEncryptionAvailable: () => true,
		encryptString: (s) => Buffer.from([...s].reverse().join('')),
		decryptString: (b) => [...b.toString()].reverse().join(''),
	};
	const store = new Store(dir, fakeSafeStorage);
	store.setAccount({ email: 'a@b.c', apiKey: 'secret-key' });
	store.setLink('site1', { mode: 'manual', host: 'h', username: 'u', password: 'pw' });

	const raw = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
	assert.ok(!raw.includes('secret-key'));
	assert.ok(!raw.includes('"pw"'));

	const reopened = new Store(dir, fakeSafeStorage);
	assert.equal(reopened.getAccount().apiKey, 'secret-key');
	assert.equal(reopened.getLink('site1').password, 'pw');
	const pub = reopened.getPublicLink('site1');
	assert.equal(pub.password, undefined);
	assert.equal(pub.hasPassword, true);
});

test('parses rsync itemized dry-run output, including odd file names', () => {
	const out = [
		'CW|*deleting  |0|1969/12/31-19:00:00|gone/f.txt',
		'CW|*deleting  |0|1969/12/31-19:00:00|gone/',
		'CW|<f.st......|14|2026/10/30-16:27:38|changed.txt',
		'CW|cL+++++++++|8|2026/10/30-16:27:38|link',
		'CW|<f+++++++++|4|2026/10/30-16:27:38|pipe|name.txt',
		'CW|cd+++++++++|0|2026/10/30-16:27:38|newdir/',
		'CW|.f...p.....|9|2026/10/30-16:27:38|perm-only.txt',
		'sending incremental file list',
	].join('\n');
	const items = parseItemized(out);
	assert.deepEqual(items.map((i) => [i.op, i.type, i.path]), [
		['delete', 'file', 'gone/f.txt'],
		['update', 'file', 'changed.txt'],
		['create', 'symlink', 'link'],
		['create', 'file', 'pipe|name.txt'],
	]);
	assert.equal(items[1].size, 14);
	assert.equal(items[1].mtime, Math.round(new Date(2026, 9, 30, 16, 27, 38).getTime() / 1000));
});

test('merges both dry runs into one comparison with sides and the newer copy', () => {
	const pushItems = [
		{ op: 'update', type: 'file', size: 10, mtime: 200, path: 'a.php' },
		{ op: 'update', type: 'file', size: 10, mtime: 100, path: 'b.php' },
		{ op: 'create', type: 'file', size: 5, mtime: 50, path: 'local.txt' },
		{ op: 'delete', type: 'file', size: null, mtime: null, path: 'remote.txt' },
	];
	const pullItems = [
		{ op: 'update', type: 'file', size: 12, mtime: 100, path: 'a.php' },
		{ op: 'update', type: 'file', size: 12, mtime: 300, path: 'b.php' },
		{ op: 'create', type: 'file', size: 7, mtime: 70, path: 'remote.txt' },
		{ op: 'delete', type: 'file', size: null, mtime: null, path: 'local.txt' },
	];
	const merged = mergeComparison(pushItems, pullItems);
	assert.deepEqual(merged.map((e) => [e.path, e.status, e.newer]), [
		['a.php', 'changed', 'local'],
		['b.php', 'changed', 'remote'],
		['local.txt', 'local-only', null],
		['remote.txt', 'remote-only', null],
	]);
	assert.deepEqual(merged[0].local, { size: 10, mtime: 200 });
	assert.deepEqual(merged[0].remote, { size: 12, mtime: 100 });
	assert.deepEqual(merged[2].local, { size: 5, mtime: 50 });
	assert.equal(merged[2].remote, null);
	assert.deepEqual(merged[3].remote, { size: 7, mtime: 70 });
});

test('recognizes Cloudways SFTP-only credentials instead of reporting a missing WordPress', async () => {
	const service = new SyncService({ services: {}, logger: {} });
	// Exactly what a Cloudways app credential with SSH access off prints on login (captured from a real server).
	const transport = { exec: async () => ({ code: 1, stdout: 'Shell access is disabled !\n', stderr: '' }) };
	await assert.rejects(service.discoverRemote(transport, {}), (e) => e instanceof ShellAccessDisabledError && /Application Settings → SSH Access/.test(e.message));
});

test('discover script picks the app tmp folder when Cloudways makes the app folder read-only', { skip: process.platform === 'win32' }, () => {
	// Mirrors a real Cloudways app user: $HOME is the app folder (not writable), with public_html, tmp and private_html inside.
	const home = tmp();
	fs.mkdirSync(path.join(home, 'public_html'));
	fs.mkdirSync(path.join(home, 'tmp'));
	fs.mkdirSync(path.join(home, 'private_html'));
	fs.writeFileSync(path.join(home, 'public_html', 'wp-config.php'), '<?php');
	fs.chmodSync(home, 0o555);
	try {
		const out = execFileSync('sh', ['-c', discoverRemoteScript({ sysUser: 'abcxyz' })], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
		assert.equal(parseKeyValues(out).private, path.join(fs.realpathSync(home), 'tmp'));
	} finally {
		fs.chmodSync(home, 0o755);
	}
});

test('never picks the webroot itself for dumps', { skip: process.platform === 'win32' }, () => {
	const home = tmp();
	fs.writeFileSync(path.join(home, 'wp-config.php'), '<?php');
	const out = execFileSync('sh', ['-c', discoverRemoteScript({})], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
	const info = parseKeyValues(out);
	assert.equal(info.webroot, fs.realpathSync(home));
	assert.notEqual(info.private, info.webroot);
	assert.ok(info.private && !info.private.startsWith(`${info.webroot}/`));
});

test('only real SSH login failures are reported as a refused key', () => {
	const t = { username: 'u', host: 'h', port: 22, password: null, knownHostsPath: '/k' };
	assert.match(describeSshFailure(255, 'u@h: Permission denied (publickey,password).', t), /refused the SSH key/);
	// Exactly what the Cloudways server printed when the backup folder was not writable:
	const remote = "mariadb-dump: Can't create/write to file '/home/1.cloudwaysapps.com/app/local-backup-before-push.sql' (Errcode: 13 \"Permission denied\")";
	const msg = describeSshFailure(1, remote, t);
	assert.doesNotMatch(msg, /refused the SSH key/);
	assert.match(msg, /A command failed on the Cloudways server \(exit 1\).*Can't create\/write/);
});
