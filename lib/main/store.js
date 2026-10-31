'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Persists the Cloudways account and per-site links in <Local userData>/cloudways-connect/settings.json.
 *
 * Secrets (API key, SFTP password) are encrypted with Electron's safeStorage (macOS Keychain / Windows DPAPI /
 * libsecret). Local's own context.storage is not used because its getter does not return the stored value.
 */
class Store {
	constructor(dir, safeStorage) {
		this.dir = dir;
		this.file = path.join(dir, 'settings.json');
		this._safeStorage = safeStorage;
		this._data = this._read();
	}

	_read() {
		try {
			const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			return { account: data.account || null, sites: data.sites || {} };
		} catch (e) {
			return { account: null, sites: {} };
		}
	}

	_write() {
		fs.mkdirSync(this.dir, { recursive: true });
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(this._data, null, '\t'), { mode: 0o600 });
		fs.renameSync(tmp, this.file);
	}

	encrypt(value) {
		if (value === undefined || value === null || value === '') return null;
		const ss = this._safeStorage;
		if (ss && ss.isEncryptionAvailable()) {
			return `enc:${ss.encryptString(String(value)).toString('base64')}`;
		}
		return `b64:${Buffer.from(String(value), 'utf8').toString('base64')}`;
	}

	decrypt(stored) {
		if (!stored) return null;
		if (stored.startsWith('enc:')) {
			return this._safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
		}
		if (stored.startsWith('b64:')) {
			return Buffer.from(stored.slice(4), 'base64').toString('utf8');
		}
		return stored;
	}

	getAccount() {
		const { account } = this._data;
		if (!account) return null;
		return { email: account.email, apiKey: this.decrypt(account.apiKey) };
	}

	setAccount({ email, apiKey }) {
		this._data.account = { email, apiKey: this.encrypt(apiKey) };
		this._write();
	}

	clearAccount() {
		this._data.account = null;
		this._write();
	}

	getLink(siteId) {
		const link = this._data.sites[siteId];
		if (!link) return null;
		return { ...link, password: this.decrypt(link.password) };
	}

	setLink(siteId, link) {
		const { password, ...rest } = link;
		this._data.sites[siteId] = { ...rest, password: this.encrypt(password), updatedAt: new Date().toISOString() };
		this._write();
	}

	updateLink(siteId, patch) {
		if (!this._data.sites[siteId]) return;
		this._data.sites[siteId] = { ...this._data.sites[siteId], ...patch };
		this._write();
	}

	removeLink(siteId) {
		delete this._data.sites[siteId];
		this._write();
	}

	/** Link data that is safe to hand to the renderer. */
	getPublicLink(siteId) {
		const link = this._data.sites[siteId];
		if (!link) return null;
		const { password, ...rest } = link;
		return { ...rest, hasPassword: Boolean(password) };
	}
}

module.exports = { Store };
