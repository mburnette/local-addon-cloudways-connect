'use strict';

/**
 * Loads the add-on's main entry with Local's main-process API mocked, then drives its IPC handlers. SSH is
 * stubbed at SyncService.discoverRemote / pull; the Cloudways API runs against a fake fetch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IPC } = require('../lib/constants');
const { SyncService, ShellAccessDisabledError } = require('../lib/main/SyncService');

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-main-test-'));
test.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));

const calls = [];
const handlers = {};
const existingSites = {
	a1: { id: 'a1', name: 'Shop Copy', domain: 'shop-copy.local', path: '~/Local Sites/shop-copy' },
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const cradle = {
	localLogger: { child: () => logger },
	siteData: { getSites: () => existingSites, getSite: (id) => existingSites[id] },
	siteDatabase: {},
	siteProcessManager: {},
	wpCli: {},
	addSite: {
		addSite: async (args) => {
			calls.push(['addSite', args]);
			const site = { id: 'new1', name: args.newSiteInfo.siteName, domain: args.newSiteInfo.siteDomain };
			existingSites.new1 = site;
			return site;
		},
	},
};
const localMain = {
	getServiceContainer: () => ({ cradle }),
	addIpcAsyncListener: (channel, fn) => { handlers[channel] = fn; },
	sendIPCEvent: (...args) => calls.push(['ipc', ...args]),
	UserData: { get: () => ({}) },
};
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
	if (request === '@getflywheel/local/main') return localMain;
	return originalLoad.call(this, request, ...rest);
};

let discoverBehaviour = async () => ({ remotePath: '/home/app/public_html', privateDir: '/home/app', hasWpCli: true, hasRsync: true });
SyncService.prototype.discoverRemote = function discoverRemote(transport, hints) {
	calls.push(['discover', transport.username, transport.host, hints]);
	return discoverBehaviour(transport, hints);
};
SyncService.prototype.pull = async function pull(siteId, options) {
	calls.push(['pull', siteId, options]);
	return { ok: true };
};

const fakeSafeStorage = {
	isEncryptionAvailable: () => true,
	encryptString: (v) => Buffer.from(v),
	decryptString: (b) => b.toString(),
};
const addonMain = require('../lib/main');
addonMain({ electron: { safeStorage: fakeSafeStorage }, environment: { userDataPath } });
addonMain.setRetryDelayForTests(1);

const waitFor = async (predicate, timeoutMs = 2000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error('timed out');
};
const names = () => calls.map((c) => c[0]);

test('suggests a non-clashing domain and folder from Local defaults', () => {
	assert.deepEqual(handlers[IPC.NEW_SITE_LOCATION]('Shop Copy!'), { domain: 'shop-copy-2.local', sitePath: path.join('~/Local Sites/', 'shop-copy-2') });
	assert.equal(handlers[IPC.NEW_SITE_LOCATION]('Brand New').domain, 'brand-new.local');
});

test('pull to new site verifies the connection, creates the site, links it, then pulls', async () => {
	calls.length = 0;
	const res = await handlers[IPC.PULL_NEW_SITE]({
		siteName: 'Shop Copy',
		source: { kind: 'manual', host: '203.0.113.5', port: '22', username: 'appuser', authType: 'key', remotePath: '', domain: 'shop.example.com' },
	});
	assert.equal(res.domain, 'shop-copy-2.local');
	assert.equal(names()[0], 'discover', 'connection is checked before anything is created');

	await waitFor(() => names().includes('pull'));
	const addSite = calls.find((c) => c[0] === 'addSite')[1];
	assert.deepEqual(addSite.newSiteInfo, {
		siteName: 'Shop Copy',
		siteDomain: 'shop-copy-2.local',
		sitePath: path.join('~/Local Sites/', 'shop-copy-2'),
		environment: 'flywheel',
		multiSite: '',
	});
	assert.equal(addSite.installWP, true);
	assert.equal(addSite.goToSite, true);
	assert.equal(addSite.wpCredentials.adminUsername, 'admin');
	assert.ok(addSite.wpCredentials.adminPassword.length >= 16);

	assert.deepEqual(calls.find((c) => c[0] === 'pull').slice(1), ['new1', { deleteLocal: true, backupLocal: false }]);
	assert.ok(names().indexOf('addSite') < names().indexOf('pull'));

	const state = await handlers[IPC.GET_STATE]('new1');
	assert.equal(state.link.host, '203.0.113.5');
	assert.equal(state.link.remotePath, '/home/app/public_html');
});

test('pull to new site creates nothing when the connection fails', async () => {
	calls.length = 0;
	discoverBehaviour = async () => { throw new Error('Cloudways refused the password'); };
	await assert.rejects(handlers[IPC.PULL_NEW_SITE]({
		siteName: 'Broken',
		source: { kind: 'manual', host: 'h', username: 'u', authType: 'password', password: 'nope' },
	}), /refused the password/);
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(!names().includes('addSite'));
	discoverBehaviour = async () => ({ remotePath: '/home/app/public_html', privateDir: '/home/app', hasWpCli: true, hasRsync: true });
});

test('pull to new site via the Cloudways API sets up SSH access and registers the key first', async () => {
	const requests = [];
	let lastAuthBody = null;
	const json = (body, status = 200) => ({ status, ok: status < 300, headers: { get: () => null }, json: async () => body });
	globalThis.fetch = async (url, init = {}) => {
		const u = new URL(url);
		requests.push(`${init.method || 'GET'} ${u.pathname.replace('/api/v2', '')}`);
		if (u.pathname.endsWith('/oauth/access_token')) {
			lastAuthBody = init.body;
			return json({ access_token: 't', expires_in: 3600 });
		}
		if (u.pathname.endsWith('/server')) {
			return json({
				servers: [{
					id: '9', label: 'Prod', public_ip: '198.51.100.7',
					apps: [{ id: '42', label: 'Shop', application: 'wordpress', sys_user: 'abcxyz', cname: 'shop.example.com', app_fqdn: 'wordpress-9-42.cloudwaysapps.com' }],
				}],
			});
		}
		if (u.pathname.endsWith('/app/getAppSshPerms')) return json({ response: { ssh_status: { abcxyz: false } } });
		if (u.pathname.endsWith('/app/updateAppSshPerms')) return json({ operation_id: 5 });
		if (u.pathname.endsWith('/operation/5')) return json({ operation: { is_completed: '1' } });
		if (u.pathname.endsWith('/app/creds')) return json({ app_creds: [{ id: '77', sys_user: 'abcxyz', ssh_keys: [] }] });
		if (u.pathname.endsWith('/ssh_key')) return json({ id: 1234 });
		throw new Error(`unexpected ${url}`);
	};

	// Pasted with a trailing newline and a zero-width space; only the bare key is sent and stored.
	await handlers[IPC.CONNECT_ACCOUNT]({ email: ' me@example.com ', apiKey: 'k\u200B\n' });
	assert.equal(new URLSearchParams(lastAuthBody).get('api_key'), 'k');
	assert.equal(new URLSearchParams(lastAuthBody).get('email'), 'me@example.com');
	calls.length = 0;
	existingSites.new1 = undefined;
	delete existingSites.new1;
	await handlers[IPC.PULL_NEW_SITE]({ siteName: 'Shop', source: { kind: 'api', serverId: '9', appId: '42' } });
	await waitFor(() => names().includes('pull'));

	assert.deepEqual(requests, [
		'POST /oauth/access_token',
		'GET /server',
		'GET /app/getAppSshPerms',
		'POST /app/updateAppSshPerms',
		'GET /operation/5',
		'GET /app/creds',
		'POST /ssh_key',
	]);
	const discover = calls.find((c) => c[0] === 'discover');
	assert.deepEqual(discover.slice(1, 3), ['abcxyz', '198.51.100.7']);
	assert.ok(names().indexOf('discover') < names().indexOf('addSite'));

	const state = await handlers[IPC.GET_STATE]('new1');
	assert.equal(state.link.mode, 'api');
	assert.equal(state.link.sshKeyId, '1234');
	assert.equal(state.link.appFqdn, 'wordpress-9-42.cloudwaysapps.com');
	// The API key never reaches the renderer.
	assert.ok(!JSON.stringify(state).includes('"k"'));
});

test('connecting with an access token needs no email and is remembered as token auth', async () => {
	const seen = [];
	globalThis.fetch = async (url, init = {}) => {
		seen.push([url, init.headers && init.headers.Authorization]);
		return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ servers: [] }) };
	};
	const state = await handlers[IPC.CONNECT_ACCOUNT]({ email: null, apiKey: ' cw_secret123\n' });
	assert.deepEqual(state.account, { email: null, usesAccessToken: true });
	assert.deepEqual(seen, [['https://api.cloudways.com/api/v2/server', 'Bearer cw_secret123']]);
	assert.ok(!JSON.stringify(state).includes('cw_secret123'), 'token never reaches the renderer');
});

test('creates a policy-compliant app credential when the app has none', async () => {
	const posted = [];
	let created = false;
	const json = (body, status = 200) => ({ status, ok: status < 300, headers: { get: () => null }, json: async () => body });
	globalThis.fetch = async (url, init = {}) => {
		const u = new URL(url);
		if (u.pathname.endsWith('/server')) {
			return json({ servers: [{ id: '9', label: 'Prod', public_ip: '198.51.100.7', apps: [{ id: '42', label: 'Shop', application: 'wordpress', sys_user: 'abcxyz', cname: '', app_fqdn: 'wordpress-9-42.cloudwaysapps.com' }] }] });
		}
		if (u.pathname.endsWith('/app/getAppSshPerms')) return json({ response: { ssh_status: { abcxyz: true } } });
		if (u.pathname.endsWith('/app/creds') && (init.method || 'GET') === 'GET') {
			return json({ app_creds: created ? [{ id: '88', sys_user: 'localnew', ssh_keys: [] }] : [] });
		}
		if (u.pathname.endsWith('/app/creds')) {
			const password = new URLSearchParams(init.body).get('password');
			posted.push(password);
			// Mimic Cloudways' validator (message captured from the platform), plus a no-symbols rule to exercise the retry.
			if (!/[A-Z]/.test(password)) return json({ message: 'The password must contain at least one uppercase letter.' }, 422);
			if (/[^A-Za-z0-9]/.test(password)) return json({ message: 'The password may only contain letters and numbers.' }, 422);
			created = true;
			return json({ app_cred_id: 88 });
		}
		if (u.pathname.endsWith('/ssh_key')) return json({ id: 5678 });
		throw new Error(`unexpected ${url}`);
	};
	await handlers[IPC.CONNECT_ACCOUNT]({ apiKey: 'cw_token' });
	const state = await handlers[IPC.LINK_API_APP]({ siteId: 'a1', serverId: '9', appId: '42' });

	assert.equal(posted.length, 2, 'retried once without symbols');
	posted.forEach((p) => {
		assert.equal(p.length, 24);
		assert.match(p, /[A-Z]/);
		assert.match(p, /[a-z]/);
		assert.match(p, /[0-9]/);
	});
	assert.match(posted[0], /[^A-Za-z0-9]/, 'first attempt includes a symbol');
	assert.match(posted[1], /^[A-Za-z0-9]+$/);
	assert.equal(state.link.username, 'localnew');
	assert.equal(state.link.sshKeyId, '5678');
});

test('turns SSH access on through the API when the server says the shell is disabled', async () => {
	const requests = [];
	const json = (body, status = 200) => ({ status, ok: status < 300, headers: { get: () => null }, json: async () => body });
	globalThis.fetch = async (url, init = {}) => {
		const u = new URL(url);
		requests.push(`${init.method || 'GET'} ${u.pathname.replace('/api/v2', '')}`);
		if (u.pathname.endsWith('/server')) {
			return json({ servers: [{ id: '9', label: 'Prod', public_ip: '198.51.100.7', apps: [{ id: '42', label: 'Shop', application: 'wordpress', sys_user: 'abcxyz', cname: '', app_fqdn: 'wordpress-9-42.cloudwaysapps.com' }] }] });
		}
		// The status endpoint claims SSH is on, but the credential is still SFTP-only.
		if (u.pathname.endsWith('/app/getAppSshPerms')) return json({ response: { ssh_status: { abcxyz: true } } });
		if (u.pathname.endsWith('/app/updateAppSshPerms')) {
			assert.equal(new URLSearchParams(init.body).get('update_perms_action'), 'enable');
			return json({ operation_id: 7 });
		}
		if (u.pathname.endsWith('/operation/7')) return json({ operation: { is_completed: '1' } });
		if (u.pathname.endsWith('/app/creds')) return json({ app_creds: [{ id: '88', sys_user: 'locala4nblvam', ssh_keys: [] }] });
		if (u.pathname.endsWith('/ssh_key')) return json({ id: 99 });
		throw new Error(`unexpected ${url}`);
	};
	let attempts = 0;
	discoverBehaviour = async () => {
		attempts += 1;
		// Disabled before the API call, and for one more attempt while Cloudways applies the change.
		if (attempts <= 2) throw new ShellAccessDisabledError();
		return { remotePath: '/home/1.cloudwaysapps.com/abcxyz/public_html', privateDir: '/home/1.cloudwaysapps.com/abcxyz', hasWpCli: true, hasRsync: true };
	};
	await handlers[IPC.CONNECT_ACCOUNT]({ apiKey: 'cw_token' });
	requests.length = 0;
	const state = await handlers[IPC.LINK_API_APP]({ siteId: 'a1', serverId: '9', appId: '42' });

	assert.equal(attempts, 3);
	assert.deepEqual(requests.filter((r) => /SshPerms|operation/.test(r)), [
		'GET /app/getAppSshPerms',
		'POST /app/updateAppSshPerms',
		'GET /operation/7',
	]);
	assert.equal(state.link.remotePath, '/home/1.cloudwaysapps.com/abcxyz/public_html');
	discoverBehaviour = async () => ({ remotePath: '/home/app/public_html', privateDir: '/home/app', hasWpCli: true, hasRsync: true });
});

test('reports progress while linking and gives exact steps when SSH access never turns on', async () => {
	const json = (body, status = 200) => ({ status, ok: status < 300, headers: { get: () => null }, json: async () => body });
	globalThis.fetch = async (url) => {
		const u = new URL(url);
		if (u.pathname.endsWith('/server')) {
			return json({ servers: [{ id: '9', label: 'Prod', public_ip: '198.51.100.7', apps: [{ id: '42', label: 'Shop', application: 'wordpress', sys_user: 'abcxyz', cname: '', app_fqdn: 'x.cloudwaysapps.com' }] }] });
		}
		if (u.pathname.endsWith('/app/getAppSshPerms')) return json({ response: { ssh_status: { abcxyz: true } } });
		if (u.pathname.endsWith('/app/updateAppSshPerms')) return json({ response: { status: true, operation_id: 'uuid-1' } });
		if (u.pathname.endsWith('/operation/uuid-1')) return json({ message: 'not found' }, 404);
		if (u.pathname.endsWith('/app/creds')) return json({ app_creds: [{ id: '88', sys_user: 'locala4nblvam', ssh_keys: [] }] });
		if (u.pathname.endsWith('/ssh_key')) return json({ id: 99 });
		throw new Error(`unexpected ${url}`);
	};
	discoverBehaviour = async () => { throw new ShellAccessDisabledError(); };
	await handlers[IPC.CONNECT_ACCOUNT]({ apiKey: 'cw_token' });
	calls.length = 0;
	await assert.rejects(
		handlers[IPC.LINK_API_APP]({ siteId: 'a1', serverId: '9', appId: '42', progressId: 'p1' }),
		/still says shell access is disabled.*Shop → Application Settings → SSH Access/,
	);
	const progress = calls.filter((c) => c[0] === 'ipc' && c[1] === IPC.LINK_PROGRESS).map((c) => c[3]);
	assert.equal(progress[0], 'Connecting over SSH…');
	assert.ok(progress.includes('SSH shell access is off for this app. Turning it on…'));
	assert.ok(progress.some((m) => /Waiting for Cloudways to apply SSH access \(attempt \d+\)/.test(m)));
	assert.ok(calls.filter((c) => c[1] === IPC.LINK_PROGRESS).every((c) => c[2] === 'p1'), 'progress goes to the requesting form only');
	discoverBehaviour = async () => ({ remotePath: '/home/app/public_html', privateDir: '/home/app', hasWpCli: true, hasRsync: true });
});
