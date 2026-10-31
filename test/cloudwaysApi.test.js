'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CloudwaysApi, errorMessageFrom } = require('../lib/main/CloudwaysApi');

const silent = { warn() {}, info() {}, debug() {}, error() {} };

function jsonResponse(status, body, headers = {}) {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: { get: (k) => headers[k.toLowerCase()] },
		json: async () => body,
	};
}

/** fetch double that replays queued responses and records requests. */
function fakeFetch(responses) {
	const calls = [];
	const fn = async (url, init = {}) => {
		calls.push({ url, ...init });
		const next = responses.shift();
		if (!next) throw new Error(`Unexpected request to ${url}`);
		return typeof next === 'function' ? next(url, init) : next;
	};
	fn.calls = calls;
	return fn;
}

test('authenticates with email + api_key and sends the bearer token', async () => {
	const fetch = fakeFetch([
		jsonResponse(200, { access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 }),
		jsonResponse(200, { status: true, servers: [{ id: '1', apps: [] }] }),
	]);
	const api = new CloudwaysApi({ email: 'a@b.c', apiKey: 'key', fetchImpl: fetch, logger: silent });
	const servers = await api.getServers();

	assert.equal(servers.length, 1);
	assert.equal(fetch.calls[0].url, 'https://api.cloudways.com/api/v2/oauth/access_token');
	assert.equal(fetch.calls[0].body, 'email=a%40b.c&api_key=key');
	assert.equal(fetch.calls[1].url, 'https://api.cloudways.com/api/v2/server');
	assert.equal(fetch.calls[1].headers.Authorization, 'Bearer tok-1');
});

test('accepts the JWT-style auth response and forwards the device id', async () => {
	const fetch = fakeFetch([
		jsonResponse(200, { 'X-Device-Id': 'dev-9', jwt: { token: 'jwt-tok', refresh_token: 'r', token_expiry: 600 } }),
		jsonResponse(200, { app_creds: [] }),
	]);
	const api = new CloudwaysApi({ email: 'a@b.c', apiKey: 'key', fetchImpl: fetch, logger: silent });
	await api.getAppCredentials(1, 2);
	const { headers, url } = fetch.calls[1];
	assert.equal(headers.Authorization, 'Bearer jwt-tok');
	assert.equal(headers['X-Device-Id'], 'dev-9');
	assert.match(url, /\/app\/creds\?server_id=1&app_id=2$/);
});

test('falls back to the v1 API base when v2 auth is missing', async () => {
	const fetch = fakeFetch([
		jsonResponse(404, null),
		jsonResponse(200, { access_token: 'v1-tok', expires_in: 3600 }),
		jsonResponse(200, { servers: [] }),
	]);
	const api = new CloudwaysApi({ email: 'a@b.c', apiKey: 'key', fetchImpl: fetch, logger: silent });
	await api.getServers();
	assert.equal(fetch.calls[1].url, 'https://api.cloudways.com/api/v1/oauth/access_token');
	assert.equal(fetch.calls[2].url, 'https://api.cloudways.com/api/v1/server');
});

test('re-authenticates once on 401', async () => {
	const fetch = fakeFetch([
		jsonResponse(200, { access_token: 'old', expires_in: 3600 }),
		jsonResponse(401, { error: 'expired' }),
		jsonResponse(200, { access_token: 'new', expires_in: 3600 }),
		jsonResponse(200, { servers: [] }),
	]);
	const api = new CloudwaysApi({ email: 'a@b.c', apiKey: 'key', fetchImpl: fetch, logger: silent });
	await api.getServers();
	assert.equal(fetch.calls[3].headers.Authorization, 'Bearer new');
});

test('reports rejected credentials clearly', async () => {
	const fetch = fakeFetch([jsonResponse(422, { error: 'invalid_credentials', error_description: 'The user credentials were incorrect.' })]);
	const api = new CloudwaysApi({ email: 'a@b.c', apiKey: 'bad', fetchImpl: fetch, logger: silent });
	await assert.rejects(api.authenticate(), /didn't accept this email and API key/);
});

test('treats the 403 Cloudways actually returns for bad credentials as a credentials error', async () => {
	// Captured from api.cloudways.com with a made-up email/key: HTTP 403 + this body, on both v1 and v2.
	const fetch = fakeFetch([jsonResponse(403, { error: 'invalid_credentials', error_description: 'The user credentials were incorrect.' })]);
	const api = new CloudwaysApi({ email: 'a@b.c', apiKey: 'bad', fetchImpl: fetch, logger: silent });
	await assert.rejects(api.authenticate(), /didn't accept this email and API key together.*API Integration/);
	assert.equal(fetch.calls.length, 1, 'no pointless retry on another API version');
});

test('explains a Cloudflare firewall block instead of blaming the credentials', async () => {
	const htmlResponse = { status: 403, ok: false, headers: { get: () => null }, json: async () => { throw new SyntaxError('Unexpected token <'); } };
	const api = new CloudwaysApi({ email: 'a@b.c', apiKey: 'k', fetchImpl: fakeFetch([htmlResponse]), logger: silent });
	await assert.rejects(api.authenticate(), /firewall blocked the request/);
});

test('posts form-encoded SSH key requests', async () => {
	const fetch = fakeFetch([
		jsonResponse(200, { access_token: 't', expires_in: 3600 }),
		jsonResponse(200, { id: 77 }),
	]);
	const api = new CloudwaysApi({ email: 'a@b.c', apiKey: 'key', fetchImpl: fetch, logger: silent });
	const id = await api.addSshKey({ serverId: 1, appId: 2, appCredsId: 3, name: 'Local', publicKey: 'ssh-rsa AAA x' });
	assert.equal(id, 77);
	const body = new URLSearchParams(fetch.calls[1].body);
	assert.equal(fetch.calls[1].method, 'POST');
	assert.equal(body.get('app_creds_id'), '3');
	assert.equal(body.get('ssh_key'), 'ssh-rsa AAA x');
});

test('waitForOperation resolves on completion and rejects on failure', async () => {
	const fetch = fakeFetch([
		jsonResponse(200, { access_token: 't', expires_in: 3600 }),
		jsonResponse(200, { operation: { is_completed: '0', message: 'working' } }),
		jsonResponse(200, { operation: { is_completed: '1', message: 'done' } }),
		jsonResponse(200, { operation: { is_completed: '-1', message: 'disk full' } }),
	]);
	const api = new CloudwaysApi({ email: 'a@b.c', apiKey: 'key', fetchImpl: fetch, logger: silent });
	const ticks = [];
	const op = await api.waitForOperation(5, { intervalMs: 1, onTick: (o) => ticks.push(o.message) });
	assert.equal(op.message, 'done');
	assert.deepEqual(ticks, ['working', 'done']);
	await assert.rejects(api.waitForOperation(6, { intervalMs: 1 }), /disk full/);
});

test('extracts readable error messages', () => {
	assert.equal(errorMessageFrom({ message: 'Nope' }, 400), 'Nope');
	assert.equal(errorMessageFrom({ errors: { app_id: ['App not found'] } }, 422), 'App not found');
	assert.match(errorMessageFrom(null, 500), /HTTP 500/);
});

test('cw_ access tokens go straight into the Bearer header, with no login exchange', async () => {
	const fetch = fakeFetch([
		jsonResponse(200, { servers: [{ id: '1', apps: [] }] }),
		jsonResponse(200, { app_creds: [] }),
	]);
	const api = new CloudwaysApi({ apiKey: 'cw_abc123', fetchImpl: fetch, logger: silent });
	await api.authenticate();
	await api.getAppCredentials(1, 2);
	assert.equal(fetch.calls[0].url, 'https://api.cloudways.com/api/v2/server', 'validated with a real call');
	assert.ok(!fetch.calls.some((c) => c.url.includes('oauth')));
	fetch.calls.forEach((c) => {
		assert.equal(c.headers.Authorization, 'Bearer cw_abc123');
		assert.equal(c.headers['X-Access-Token'], undefined, 'Cloudways ignores this header for access tokens');
	});
});

test('a rejected access token is reported once, without retries', async () => {
	// Captured from api.cloudways.com: Bearer cw_dummy -> 401 access_denied.
	const fetch = fakeFetch([jsonResponse(401, { error: 'access_denied', error_description: 'The resource owner or authorization server denied the request.' })]);
	const api = new CloudwaysApi({ apiKey: 'cw_revoked', fetchImpl: fetch, logger: silent });
	await assert.rejects(api.authenticate(), /rejected this access token.*expired or been revoked/);
	assert.equal(fetch.calls.length, 1);
});

test('a Limited Access token missing a permission names the call and what to grant', async () => {
	const fetch = fakeFetch([
		jsonResponse(200, { servers: [] }),
		jsonResponse(403, { error: 'forbidden', error_description: 'Insufficient permissions.' }),
	]);
	const api = new CloudwaysApi({ apiKey: 'cw_limited', fetchImpl: fetch, logger: silent });
	await api.authenticate();
	await assert.rejects(api.addSshKey({ serverId: 1, appId: 2, appCredsId: 3, name: 'x', publicKey: 'ssh-rsa A' }), /isn't allowed to POST \/ssh_key.*SSH keys/);
});

test('legacy API keys still need the account email', () => {
	assert.throws(() => new CloudwaysApi({ apiKey: 'legacykey', logger: silent }), /also need the account email/);
	assert.doesNotThrow(() => new CloudwaysApi({ apiKey: 'cw_token', logger: silent }));
});

test('reads the operation id Cloudways nests under "response" when enabling SSH access', async () => {
	const fetch = fakeFetch([
		jsonResponse(200, { servers: [] }),
		jsonResponse(200, { response: { status: true, operation_id: 'ec7a2d1a-0a3d-4ed9-9523-315875618f54' } }),
	]);
	const api = new CloudwaysApi({ apiKey: 'cw_t', fetchImpl: fetch, logger: silent });
	await api.authenticate();
	assert.equal(await api.enableAppSsh(1, 2), 'ec7a2d1a-0a3d-4ed9-9523-315875618f54');
});

test('surfaces a nested status:false instead of treating it as success', async () => {
	const fetch = fakeFetch([
		jsonResponse(200, { servers: [] }),
		jsonResponse(200, { response: { status: false, message: 'Cross application symlinks found.' } }),
	]);
	const api = new CloudwaysApi({ apiKey: 'cw_t', fetchImpl: fetch, logger: silent });
	await api.authenticate();
	await assert.rejects(api.enableAppSsh(1, 2), /could not turn on SSH access: Cross application symlinks found/);
});

test('stops waiting quietly when Cloudways cannot look up an operation id', async () => {
	const fetch = fakeFetch([
		jsonResponse(200, { servers: [] }),
		jsonResponse(404, { message: 'Operation not found' }),
	]);
	const api = new CloudwaysApi({ apiKey: 'cw_t', fetchImpl: fetch, logger: silent });
	await api.authenticate();
	assert.equal(await api.waitForOperation('ec7a2d1a-uuid', { intervalMs: 1 }), null);
});
