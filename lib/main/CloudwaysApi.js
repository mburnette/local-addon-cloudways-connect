'use strict';

const { CLOUDWAYS_API_BASES } = require('../constants');

class CloudwaysApiError extends Error {
	constructor(message, status, body) {
		super(message);
		this.name = 'CloudwaysApiError';
		this.status = status;
		this.body = body;
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pulls the most useful human-readable message out of a Cloudways error body. */
function errorMessageFrom(body, status) {
	if (!body || typeof body !== 'object') {
		return `Cloudways API request failed (HTTP ${status})`;
	}
	if (body.error_description) return body.error_description;
	if (typeof body.message === 'string' && body.message) return body.message;
	if (typeof body.error === 'string' && body.error) return body.error;
	if (body.errors) {
		const flat = Object.values(body.errors)
			.flat()
			.map((e) => (typeof e === 'string' ? e : e && (e.message || e.code)))
			.filter(Boolean);
		if (flat.length) return flat.join(' ');
	}
	return `Cloudways API request failed (HTTP ${status})`;
}

/**
 * Some endpoints wrap their payload as { response: { status, operation_id, … } } and report failure with
 * status: false inside a 200. Unwraps it and turns that into an error.
 */
function unwrapResponse(json, failurePrefix) {
	const inner = json && json.response && typeof json.response === 'object' ? json.response : json;
	if (inner && inner.status === false) {
		const detail = inner.message || inner.error_description || inner.error || 'Cloudways reported a failure.';
		throw new CloudwaysApiError(`${failurePrefix}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, 200, json);
	}
	return inner || {};
}

/** Access Tokens from Account → API Integration start with "cw_"; anything else is a legacy API key. */
const isAccessToken = (credential) => /^cw_/i.test(String(credential || ''));

const PERMISSION_HINT = 'Create a token with Full Access, or Limited Access that includes servers and applications, '
	+ 'application credentials and SSH access, SSH keys, backups, cache and operations.';

/**
 * Thin client for the Cloudways Platform API.
 *
 * Auth, two kinds:
 * - Access Token ("cw_…", created under Account → API Integration): sent as-is in `Authorization: Bearer` on
 *   every request. This replaces API keys, which Cloudways retires on 2026-10-15.
 * - Legacy API key: POST /oauth/access_token with the account email exchanges it for a short-lived bearer token,
 *   refreshed transparently by re-authenticating.
 */
class CloudwaysApi {
	constructor({ email, apiKey, fetchImpl = globalThis.fetch, bases = CLOUDWAYS_API_BASES, logger = console }) {
		if (!apiKey) {
			throw new CloudwaysApiError('A Cloudways access token is required.', 0);
		}
		this._usesAccessToken = isAccessToken(apiKey);
		if (!this._usesAccessToken && !email) {
			throw new CloudwaysApiError('Legacy Cloudways API keys also need the account email.', 0);
		}
		this._email = email;
		this._apiKey = apiKey;
		this._fetch = fetchImpl;
		this._bases = bases;
		this._logger = logger;
		this._base = null;
		this._token = null;
		this._deviceId = null;
		this._expiresAt = 0;
	}

	async authenticate() {
		if (this._usesAccessToken) {
			// Nothing to exchange: prove the token works (and can list servers) with a real call.
			this._base = this._bases[0];
			this._token = this._apiKey;
			this._expiresAt = Infinity;
			await this.request('GET', '/server');
			return;
		}
		let lastError = null;
		for (const base of this._bases) {
			const res = await this._fetch(`${base}/oauth/access_token`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Accept: 'application/json',
				},
				body: new URLSearchParams({ email: this._email, api_key: this._apiKey }).toString(),
			});
			const body = await res.json().catch(() => null);
			if (!body && res.status === 403) {
				// Non-JSON 403 = Cloudflare's firewall page in front of the API, not a credentials answer.
				throw new CloudwaysApiError('Cloudways\' firewall blocked the request. Check your network or VPN and try again.', 403, null);
			}
			if (res.status === 404) {
				lastError = new CloudwaysApiError('Cloudways authentication endpoint not found.', 404, body);
				continue;
			}
			if (!res.ok) {
				const message = [401, 403, 422].includes(res.status)
					? 'Cloudways didn\'t accept this email and API key together. Use the email you sign in to Cloudways with for the '
						+ 'account the key was generated in, and the key currently shown under Account → API Integration '
						+ '(generating a new key replaces the old one).'
					: errorMessageFrom(body, res.status);
				throw new CloudwaysApiError(message, res.status, body);
			}
			const token = body && (body.access_token || (body.jwt && body.jwt.token));
			if (!token) {
				throw new CloudwaysApiError('Cloudways did not return an access token.', res.status, body);
			}
			const expiresInSec = Number(body.expires_in) || 600;
			this._base = base;
			this._token = token;
			this._deviceId = body['X-Device-Id'] || body.device_id || null;
			// Refresh a minute early so long pushes never race an expiring token.
			this._expiresAt = Date.now() + Math.max(expiresInSec - 60, 30) * 1000;
			return;
		}
		throw lastError || new CloudwaysApiError('Unable to authenticate with Cloudways.', 0);
	}

	async _ensureToken() {
		if (!this._token || Date.now() >= this._expiresAt) {
			await this.authenticate();
		}
	}

	async request(method, path, { query, form } = {}, attempt = 0) {
		await this._ensureToken();
		const url = new URL(`${this._base}${path}`);
		if (query) {
			Object.entries(query).forEach(([k, v]) => {
				if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
			});
		}
		const headers = {
			Authorization: `Bearer ${this._token}`,
			Accept: 'application/json',
		};
		if (this._deviceId) {
			headers['X-Device-Id'] = this._deviceId;
			headers['X-Access-Token'] = this._token;
		}
		let body;
		if (form) {
			headers['Content-Type'] = 'application/x-www-form-urlencoded';
			body = new URLSearchParams(
				Object.fromEntries(Object.entries(form).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])),
			).toString();
		}

		const res = await this._fetch(url.toString(), { method, headers, body });
		const json = await res.json().catch(() => null);

		if (this._usesAccessToken && (res.status === 401 || res.status === 403)) {
			if (!json && res.status === 403) {
				throw new CloudwaysApiError('Cloudways\' firewall blocked the request. Check your network or VPN and try again.', 403, null);
			}
			throw new CloudwaysApiError(res.status === 401
				? 'Cloudways rejected this access token. It may have expired or been revoked; create a new one under Account → API Integration.'
				: `This access token isn't allowed to ${method} ${path}. ${PERMISSION_HINT}`, res.status, json);
		}
		if (res.status === 401 && attempt === 0) {
			this._token = null;
			return this.request(method, path, { query, form }, attempt + 1);
		}
		if (res.status === 429 && attempt < 4) {
			const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 2 ** attempt * 5;
			this._logger.warn(`Cloudways API rate limited; retrying in ${retryAfter}s`);
			await sleep(retryAfter * 1000);
			return this.request(method, path, { query, form }, attempt + 1);
		}
		if (!res.ok || (json && json.status === false)) {
			throw new CloudwaysApiError(errorMessageFrom(json, res.status), res.status, json);
		}
		return json;
	}

	/** Servers with their nested apps. Uses the legacy listing because it is the only one that embeds apps. */
	async getServers() {
		const json = await this.request('GET', '/server');
		return (json && json.servers) || [];
	}

	async getAppCredentials(serverId, appId) {
		const json = await this.request('GET', '/app/creds', { query: { server_id: serverId, app_id: appId } });
		return (json && json.app_creds) || [];
	}

	async createAppCredential(serverId, appId, username, password) {
		const json = await this.request('POST', '/app/creds', {
			form: { server_id: serverId, app_id: appId, username, password },
		});
		return json && json.app_cred_id;
	}

	async addSshKey({ serverId, appId, appCredsId, name, publicKey }) {
		const json = await this.request('POST', '/ssh_key', {
			form: {
				server_id: serverId,
				app_id: appId,
				app_creds_id: appCredsId,
				ssh_key_name: name,
				ssh_key: publicKey,
			},
		});
		return json && json.id;
	}

	async deleteSshKey(serverId, sshKeyId) {
		return this.request('DELETE', `/ssh_key/${encodeURIComponent(sshKeyId)}`, { form: { server_id: serverId } });
	}

	/** Resolves true when SSH/SFTP access is enabled for the application's credentials. */
	async getAppSshEnabled(serverId, appId) {
		const json = await this.request('GET', '/app/getAppSshPerms', { query: { server_id: serverId, app_id: appId } });
		const status = json && json.response && json.response.ssh_status;
		if (status && typeof status === 'object') {
			return Object.values(status).some((v) => v === true || v === 1 || v === '1' || v === 'true');
		}
		return Boolean(status);
	}

	/** Same switch as Application Settings → SSH Access in Cloudways. Resolves the operation id, if any. */
	async enableAppSsh(serverId, appId) {
		const json = await this.request('POST', '/app/updateAppSshPerms', {
			form: { server_id: serverId, app_id: appId, update_perms_action: 'enable' },
		});
		this._logger.info(`Cloudways updateAppSshPerms response: ${JSON.stringify(json)}`);
		return unwrapResponse(json, 'Cloudways could not turn on SSH access').operation_id || null;
	}

	async takeAppBackup(serverId, appId) {
		const json = await this.request('POST', '/app/manage/takeBackup', { form: { server_id: serverId, app_id: appId } });
		return unwrapResponse(json, 'Cloudways could not start a backup').operation_id || null;
	}

	async purgeAppCache(serverId, appId) {
		return unwrapResponse(await this.request('POST', '/app/cache/purge', { form: { server_id: serverId, app_id: appId } }), 'Cloudways could not purge the cache');
	}

	async getOperation(operationId) {
		const json = await this.request('GET', `/operation/${encodeURIComponent(operationId)}`);
		return json && (json.operation || (json.response && json.response.operation));
	}

	/** Polls a background operation until Cloudways reports it complete (is_completed 1) or failed (-1). */
	async waitForOperation(operationId, { timeoutMs = 15 * 60 * 1000, intervalMs = 5000, onTick } = {}) {
		if (!operationId) return null;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			let op;
			try {
				op = await this.getOperation(operationId);
			} catch (e) {
				// Some operations (UUID ids) are not served by /operation/{id}; callers verify the outcome another way.
				if ([400, 404, 422].includes(e.status)) {
					this._logger.warn(`Cannot track Cloudways operation ${operationId}: ${e.message}`);
					return null;
				}
				throw e;
			}
			const state = op ? Number(op.is_completed) : 0;
			if (onTick && op) onTick(op);
			if (state === 1) return op;
			if (state === -1) {
				throw new CloudwaysApiError(`Cloudways operation failed: ${op.message || op.status || operationId}`, 0, op);
			}
			await sleep(intervalMs);
		}
		throw new CloudwaysApiError(`Timed out waiting for Cloudways operation ${operationId}.`, 0);
	}
}

module.exports = { CloudwaysApi, CloudwaysApiError, errorMessageFrom, isAccessToken };
