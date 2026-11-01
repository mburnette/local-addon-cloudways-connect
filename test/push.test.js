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
const posixOnly = { skip: process.platform === 'win32' };
const runSh = (script, { home, env = {} } = {}) => execFileSync('sh', ['-c', script], { env: { ...process.env, ...env, HOME: home }, encoding: 'utf8' });
/** Matches a per-site private folder: <base>/.cloudways-connect/<slug>-<checksum>. */
const privateIn = (base, slug) => new RegExp(`^${fs.realpathSync(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.cloudways-connect/${slug.replace(/\./g, '\\.')}-\\d+$`);

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
	assert.match(info.private, privateIn(home, 'public_html'));
	assert.equal(fs.statSync(info.private).mode & 0o777, 0o700);
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
		assert.match(parseKeyValues(out).private, privateIn(path.join(home, 'tmp'), 'public_html'));
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

test('a WordPress in a subfolder of the app gets its own private folder, never one inside the main site\'s public_html', posixOnly, () => {
	const home = tmp();
	const web = path.join(home, 'public_html');
	const blog = path.join(web, 'blog');
	fs.mkdirSync(blog, { recursive: true });
	fs.mkdirSync(path.join(home, 'tmp'));
	fs.writeFileSync(path.join(web, 'wp-config.php'), '<?php');
	fs.writeFileSync(path.join(blog, 'wp-config.php'), '<?php');
	fs.chmodSync(home, 0o555);
	try {
		const main = parseKeyValues(runSh(discoverRemoteScript({}), { home })).private;
		// Beside the subfolder webroot are public_html/tmp, public_html/private_html and public_html itself: all served.
		const sub = parseKeyValues(runSh(discoverRemoteScript({ remotePath: blog }), { home })).private;
		assert.match(main, privateIn(path.join(home, 'tmp'), 'public_html'));
		assert.match(sub, privateIn(path.join(home, 'tmp'), 'public_html_blog'));
		assert.notEqual(main, sub);
	} finally {
		fs.chmodSync(home, 0o755);
	}
	assert.ok(!fs.existsSync(path.join(web, '.cloudways-connect')));
});

test('apps reached through the master user\'s home never share a private folder', posixOnly, () => {
	const home = path.join(tmp(), 'master');
	const apps = ['abcxyz', 'defuvw'];
	apps.forEach((app) => {
		fs.mkdirSync(path.join(home, 'applications', app, 'public_html'), { recursive: true });
		fs.writeFileSync(path.join(home, 'applications', app, 'public_html', 'wp-config.php'), '<?php');
		// No tmp/ or private_html/ and an app folder the user can't write to: both fall back to ~/tmp.
		fs.chmodSync(path.join(home, 'applications', app), 0o555);
	});
	fs.mkdirSync(path.join(home, 'tmp'));
	try {
		const privates = apps.map((app) => parseKeyValues(runSh(discoverRemoteScript({ sysUser: app }), { home })).private);
		assert.match(privates[0], privateIn(path.join(home, 'tmp'), 'applications_abcxyz_public_html'));
		assert.match(privates[1], privateIn(path.join(home, 'tmp'), 'applications_defuvw_public_html'));
	} finally {
		apps.forEach((app) => fs.chmodSync(path.join(home, 'applications', app), 0o755));
	}
});

test('rsync sends remote paths through the protocol, so a folder with a space is not split by the server\'s shell', async () => {
	const { Transport } = require('../lib/main/transport');
	const transport = new Transport({ host: '203.0.113.7', username: 'abcxyz', privateKeyPath: '/k', workDir: tmp(), logger: {} });
	const runs = [];
	transport._bin = () => '/fake/rsync-3.1.3';
	transport._spawn = async (cmd, args) => {
		if (args[0] === '--version') return { code: 0, stdout: 'rsync  version 3.1.3  protocol version 31\n', stderr: '' };
		runs.push(args);
		return { code: 0, stdout: '', stderr: '' };
	};
	await transport.rsyncUp({ source: '/local/', destination: '/home/1.cloudwaysapps.com/abcxyz/public_html/old site/', extraArgs: ['--delete'] });
	await transport.rsyncDown({ source: '/home/1.cloudwaysapps.com/abcxyz/public_html/old site/', destination: '/local/' });
	runs.forEach((args) => assert.ok(args.includes('--protect-args'), args.join(' ')));
	assert.equal(runs[0][runs[0].length - 1], 'abcxyz@203.0.113.7:/home/1.cloudwaysapps.com/abcxyz/public_html/old site/');
});

test('an rsync without --protect-args (macOS openrsync) is asked once, and refuses remote paths the shell could split', async () => {
	const { Transport } = require('../lib/main/transport');
	const transport = new Transport({ host: '203.0.113.7', username: 'abcxyz', privateKeyPath: '/k', workDir: tmp(), logger: {} });
	transport._bin = () => '/fake/openrsync';
	const runs = [];
	transport._spawn = async (cmd, args) => {
		runs.push(args);
		if (args[0] === '--version') return { code: 0, stdout: 'openrsync: protocol version 29\nrsync version 2.6.9 compatible\n', stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	};
	await transport.rsyncUp({ source: '/local/', destination: '/home/1.cloudwaysapps.com/abcxyz/public_html/', extraArgs: ['--delete'] });
	await transport.rsyncDown({ source: '/home/1.cloudwaysapps.com/abcxyz/public_html/', destination: '/local/' });
	await assert.rejects(transport.rsyncUp({ source: '/local/', destination: '/home/1.cloudwaysapps.com/abcxyz/public_html/old site/' }), /too old/);
	assert.equal(runs.filter((a) => a[0] === '--version').length, 1);
	runs.filter((a) => a[0] !== '--version').forEach((args) => assert.ok(!args.includes('--protect-args'), args.join(' ')));
	assert.equal(runs.length, 3);
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

const WEBROOT = '/home/1.cloudwaysapps.com/abcxyz/public_html/blog';
const PRIVATE = '/home/1.cloudwaysapps.com/abcxyz/tmp/.cloudways-connect/public_html_blog-123';
const WP = 'wp --skip-plugins --skip-themes';

/** Records every ssh command and rsync call; `respond(command)` gives a command's stdout. */
function fakeTransport({ respond = () => '' } = {}) {
	const calls = [];
	return {
		calls,
		execs: () => calls.filter(([kind]) => kind === 'exec').map(([, c]) => c),
		async exec(command) {
			calls.push(['exec', command]);
			if (command.startsWith('for d in ')) {
				return { code: 0, stdout: `webroot=${WEBROOT}\nprivate=${PRIVATE}\nwpcli=yes\nrsync=yes\n`, stderr: '' };
			}
			return { code: 0, stdout: respond(command) || '', stderr: '' };
		},
		async rsyncUp(args) {
			calls.push(['up', args]);
			return '';
		},
		async rsyncDown(args) {
			calls.push(['down', args]);
			if (!args.source.endsWith('/')) fs.writeFileSync(args.destination, 'CREATE TABLE `wp_options` (x int);\n');
			return '';
		},
		async close() {},
	};
}

/** A SyncService wired to stand-ins for Local's services and a stored (manual) link. */
function makeService({ transport, localPrefix = 'wp_' }) {
	const webRoot = path.join(tmp(), 'app', 'public');
	fs.mkdirSync(webRoot, { recursive: true });
	const site = { id: 'site1', name: 'Shop', domain: 'shop.local', paths: { webRoot, sql: path.join(webRoot, '..', 'sql') } };
	let stored = { mode: 'manual', host: '203.0.113.7', port: 22, username: 'abcxyz', authType: 'key', domain: 'shop.example.com', remotePath: WEBROOT };
	const service = new SyncService({
		store: { getLink: () => stored, updateLink: (id, patch) => { stored = { ...stored, ...patch }; } },
		keys: { privateKeyPath: '/nonexistent/key' },
		workDir: tmp(),
		getApi: () => null,
		services: {
			siteData: { getSite: () => site },
			siteDatabase: {
				dump: async (_site, dest) => fs.writeFileSync(dest, 'CREATE TABLE `wp_options` (x int);\n'),
				getTablePrefix: async () => localPrefix,
			},
			siteProcessManager: { getSiteStatus: () => 'running', start: async () => {} },
			wpCli: { run: async (_site, args) => (args.join(' ') === 'option get home' ? 'http://shop.local\n' : '') },
		},
		sendIPCEvent: () => {},
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	});
	service.transportFor = () => transport;
	return service;
}

const PUSH_DB_ONLY = { files: false, backup: false, purgeCache: false };

test('a database push on its own database still resets it and keeps the backup in the site\'s private folder', async () => {
	const transport = fakeTransport({ respond: (c) => (/db export/.test(c) ? 'table_prefix=wp_\ntables=wp_options wp_posts \nhome=https://shop.example.com/blog\n' : '') });
	await makeService({ transport }).push('site1', PUSH_DB_ONLY);
	const execs = transport.execs();
	const exportCmd = execs.find((c) => /db export/.test(c));
	assert.ok(exportCmd.includes(`${WP} db export '${PRIVATE}/local-backup-before-push.sql' \${o:+--tables="$o"}`), exportCmd);
	assert.ok(execs.some((c) => c.includes(`${WP} db reset --yes && ${WP} db import '${PRIVATE}/local-push-`)));
	assert.ok(execs.filter((c) => /search-replace/.test(c)).every((c) => c.includes(' --all-tables ')));
});

test('the push backup and the pull export hold only the site\'s own tables (run with sh and a stand-in wp)', posixOnly, async () => {
	const bin = tmp();
	fs.writeFileSync(path.join(bin, 'wp'), `#!/bin/sh\ncase "$*" in *"config get table_prefix"*) echo blog_;; *"db query SHOW TABLES"*) printf 'wp_options\\nblog_options\\nblog_posts\\n';; *"db export"*) echo "$*" > "$OUT";; esac\n`, { mode: 0o755 });
	const out = path.join(tmp(), 'export-args');
	for (const direction of ['push', 'pull']) {
		const transport = fakeTransport();
		await makeService({ transport })[direction]('site1', direction === 'push' ? PUSH_DB_ONLY : { files: false }).catch(() => {});
		// The real command, run in a scratch folder with the stand-in wp.
		const exportCmd = transport.execs().find((c) => /db export/.test(c)).replace(`cd '${WEBROOT}'`, 'cd /');
		const state = parseKeyValues(runSh(exportCmd, { home: tmp(), env: { OUT: out, PATH: `${bin}${path.delimiter}${process.env.PATH}` } }));
		assert.equal(state.table_prefix, 'blog_');
		assert.match(fs.readFileSync(out, 'utf8'), / --tables=blog_options,blog_posts --no-tablespaces=true/);
		if (direction === 'push') assert.equal(state.tables, 'wp_options blog_options blog_posts');
	}
});

test('a database shared with another site: push replaces only its own tables, and never writes over the other site\'s', async () => {
	const state = (prefix) => `table_prefix=${prefix}\ntables=wp_options wp_posts blog_options blog_posts \nhome=https://shop.example.com/blog\n`;
	const run = async (remotePrefix, localPrefix) => {
		const transport = fakeTransport({ respond: (c) => (/db export/.test(c) ? state(remotePrefix) : '') });
		const result = await makeService({ transport, localPrefix }).push('site1', PUSH_DB_ONLY).then(() => null, (e) => e);
		return { error: result, execs: transport.execs(), uploads: transport.calls.filter(([kind]) => kind === 'up') };
	};

	// Same prefix as the remote site: its own tables are dropped instead of the whole database.
	const same = await run('blog_', 'blog_');
	assert.equal(same.error, null);
	const importCmd = same.execs.find((c) => /db import/.test(c));
	assert.ok(importCmd.includes(`db query 'DROP TABLE IF EXISTS \`blog_options\`, \`blog_posts\`' && ${WP} db import`), importCmd);
	assert.ok(!same.execs.some((c) => /db reset/.test(c)), 'the other site\'s tables are never dropped');
	assert.ok(same.execs.filter((c) => /search-replace/.test(c)).every((c) => c.includes('--all-tables-with-prefix')));

	// Local's wp_ tables would overwrite the main site's: nothing is uploaded or changed.
	const clash = await run('blog_', 'wp_');
	assert.match(clash.error.message, /Cloudways database also holds tables of another site \(wp_options, wp_posts\).*prefix \(wp_\) would overwrite wp_options, wp_posts.*Change the Local site's table prefix to blog_/);
	assert.equal(clash.uploads.length, 0);
	assert.ok(!clash.execs.some((c) => /db import|db reset|DROP TABLE/.test(c)));
});
