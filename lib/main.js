'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LocalMain = require('@getflywheel/local/main');

const { IPC, WORDPRESS_APP_TYPES } = require('./constants');
const { CloudwaysApi, isAccessToken } = require('./main/CloudwaysApi');
const { SyncService, ShellAccessDisabledError } = require('./main/SyncService');
const { SshKeyStore } = require('./main/sshKey');
const { Store } = require('./main/store');
const { findBundledBinDir } = require('./main/transport');
const { Updater } = require('./main/updater');
const pkg = require('../package.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pause between SSH retries while Cloudways applies a key or permission change, and how long to wait for SSH access. */
let retryDelayMs = 5000;
let shellRetryTimeoutMs = 3 * 60 * 1000;

function randomString(length, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
	const bytes = crypto.randomBytes(length);
	return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * A password that passes strict "upper + lower + digit (+ symbol)" policies, which Cloudways enforces on
 * application credentials without documenting. Every required class is guaranteed, then the order is shuffled.
 */
function strongPassword({ symbols = true, length = 24 } = {}) {
	const classes = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789'];
	if (symbols) classes.push('!@#%^*_-+=');
	const chars = classes.map((set) => randomString(2, set)).join('').split('');
	chars.push(...randomString(length - chars.length, classes.join('')).split(''));
	for (let i = chars.length - 1; i > 0; i -= 1) {
		const j = crypto.randomInt(i + 1);
		[chars[i], chars[j]] = [chars[j], chars[i]];
	}
	return chars.join('');
}

/** Flattens the Cloudways server listing into the WordPress apps the renderer can link to. */
function toAppChoices(servers) {
	const apps = [];
	servers.forEach((server) => {
		(server.apps || []).forEach((app) => {
			apps.push({
				serverId: String(server.id),
				serverLabel: server.label,
				serverStatus: server.status,
				host: server.public_ip,
				appId: String(app.id),
				appLabel: app.label,
				application: app.application,
				isWordPress: WORDPRESS_APP_TYPES.includes(String(app.application).toLowerCase()),
				sysUser: app.sys_user,
				domain: app.cname || app.app_fqdn,
				appFqdn: app.app_fqdn,
			});
		});
	});
	return apps.sort((a, b) => Number(b.isWordPress) - Number(a.isWordPress)
		|| a.serverLabel.localeCompare(b.serverLabel)
		|| a.appLabel.localeCompare(b.appLabel));
}

module.exports = function CloudwaysConnectMain(context) {
	const { electron } = context;
	const container = LocalMain.getServiceContainer().cradle;
	const logger = container.localLogger.child({ thread: 'main', addon: 'cloudways-connect' });
	const { sendIPCEvent } = LocalMain;

	const workDir = path.join(context.environment.userDataPath, 'cloudways-connect');
	const store = new Store(workDir, electron.safeStorage);
	const keys = new SshKeyStore(path.join(workDir, 'ssh'));

	let api = null;
	const getApi = () => {
		if (api) return api;
		const account = store.getAccount();
		if (!account) throw new Error('Connect your Cloudways account first.');
		api = new CloudwaysApi({ email: account.email, apiKey: account.apiKey, logger });
		return api;
	};

	const syncService = new SyncService({
		store,
		keys,
		workDir,
		getApi,
		services: {
			siteData: container.siteData,
			siteDatabase: container.siteDatabase,
			siteProcessManager: container.siteProcessManager,
			wpCli: container.wpCli,
		},
		sendIPCEvent,
		logger,
	});

	const updater = new Updater({
		pkg,
		addonDir: path.resolve(__dirname, '..'),
		addonsDir: path.join(context.environment.userDataPath, 'addons'),
		ipcMain: electron.ipcMain,
		app: electron.app,
		logger,
		onChange: () => broadcast(),
	});
	if (electron.app) updater.start();

	const keyComment = () => `local-cloudways-connect@${os.hostname()}`.replace(/\s+/g, '-');

	const getState = (siteId) => {
		const account = store.getAccount();
		return {
			account: account ? { email: account.email || null, usesAccessToken: isAccessToken(account.apiKey) } : null,
			link: siteId ? store.getPublicLink(siteId) : null,
			activity: siteId ? syncService.activity(siteId) : null,
			publicKey: keys.getPublicKey(),
			passwordAuthSupported: process.platform !== 'win32',
			update: updater.state(),
		};
	};

	const broadcast = (siteId) => sendIPCEvent(IPC.STATE_CHANGED, siteId || null);

	/** Sends step-by-step linking progress to the form that started it (matched by its progressId). */
	const progressReporter = (progressId) => (message) => {
		logger.info(`Linking: ${message}`);
		if (progressId) sendIPCEvent(IPC.LINK_PROGRESS, progressId, message);
	};

	/** Broadcasts once a transfer has registered as active, and again when it settles. */
	const runAndBroadcast = async (siteId, transfer) => {
		broadcast(siteId);
		try {
			return await transfer;
		} finally {
			broadcast(siteId);
		}
	};

	/** Retries the first SSH login for a while: Cloudways applies newly added keys asynchronously. */
	const discoverWithRetry = async (transport, hints, { timeoutMs = 90 * 1000, retryShellDisabled = false, onAttempt } = {}) => {
		const deadline = Date.now() + timeoutMs;
		let lastError;
		let attempt = 0;
		while (Date.now() < deadline) {
			attempt += 1;
			if (onAttempt) onAttempt(attempt);
			try {
				return await syncService.discoverRemote(transport, hints);
			} catch (e) {
				lastError = e;
				const propagating = /refused the SSH key|Permission denied/i.test(e.message)
					|| (retryShellDisabled && e instanceof ShellAccessDisabledError);
				if (!propagating) throw e;
				await sleep(retryDelayMs);
			}
		}
		throw lastError;
	};

	const enableAppSsh = async (cw, serverId, appId) => {
		let operationId;
		try {
			operationId = await cw.enableAppSsh(serverId, appId);
		} catch (e) {
			if (/symlink/i.test(e.message)) {
				throw new Error('Cloudways will only turn on SSH access for this app after removing symlinks it shares with other apps. '
					+ 'Turn it on yourself under Applications → this app → Application Settings → SSH Access (Cloudways explains the trade-off there), then link again.');
			}
			throw e;
		}
		await cw.waitForOperation(operationId, { timeoutMs: 5 * 60 * 1000 });
	};

	/**
	 * Sets up SSH access to a Cloudways app through the API (SSH enabled, app credential, our key registered) and
	 * verifies it by locating WordPress. Returns the link to store; nothing is saved yet.
	 */
	const prepareApiLink = async ({ serverId, appId }, onProgress = () => {}) => {
		const cw = getApi();
		const choice = toAppChoices(await cw.getServers()).find((a) => a.serverId === String(serverId) && a.appId === String(appId));
		if (!choice) throw new Error('That Cloudways application could not be found.');

		const publicKey = keys.ensure(keyComment());

		let sshEnabled = true;
		try {
			sshEnabled = await cw.getAppSshEnabled(serverId, appId);
		} catch (e) {
			// Not fatal: the SSH login below reports a clear error if access really is off.
			logger.warn(`Could not read SSH access status for app ${appId}: ${e.message}`);
		}
		if (!sshEnabled) {
			onProgress('Turning on SSH access for the application…');
			await enableAppSsh(cw, serverId, appId);
		}

		let creds = await cw.getAppCredentials(serverId, appId);
		if (!creds.length) {
			// The password is never used (we log in with the SSH key) but must satisfy Cloudways' policy.
			const username = `local${randomString(8)}`;
			try {
				await cw.createAppCredential(serverId, appId, username, strongPassword());
			} catch (e) {
				if (!/password/i.test(e.message)) throw e;
				logger.warn(`Cloudways rejected the generated password (${e.message}); retrying without symbols.`);
				await cw.createAppCredential(serverId, appId, username, strongPassword({ symbols: false }));
			}
			creds = await cw.getAppCredentials(serverId, appId);
		}
		const cred = creds.find((c) => c.sys_user === choice.sysUser) || creds[0];
		if (!cred) throw new Error('Cloudways did not return any application credentials.');

		const keyName = `Local Connect ${os.hostname()} ${keys.getFingerprint().slice(7)}`
			.replace(/[^A-Za-z0-9 _-]/g, '')
			.slice(0, 50);
		const existingKey = (cred.ssh_keys || []).find((k) => k.label === keyName);
		const sshKeyId = existingKey
			? existingKey.ssh_key_id
			: await cw.addSshKey({ serverId, appId, appCredsId: cred.id, name: keyName, publicKey });

		const link = {
			mode: 'api',
			authType: 'key',
			serverId: choice.serverId,
			serverLabel: choice.serverLabel,
			appId: choice.appId,
			appLabel: choice.appLabel,
			sysUser: choice.sysUser,
			domain: choice.domain,
			appFqdn: choice.appFqdn,
			host: choice.host,
			port: 22,
			username: cred.sys_user,
			appCredId: String(cred.id),
			sshKeyId: sshKeyId ? String(sshKeyId) : null,
		};
		const transport = syncService.transportFor(link);
		let remote;
		try {
			remote = await discoverWithRetry(transport, { sysUser: choice.sysUser }, {
				onAttempt: (n) => onProgress(n === 1 ? 'Connecting over SSH…' : `Waiting for Cloudways to accept the SSH key (attempt ${n})…`),
			});
		} catch (e) {
			if (!(e instanceof ShellAccessDisabledError)) throw e;
			// The status endpoint can report SSH as on while the credential is still SFTP-only; trust the server.
			logger.info(`Shell access is disabled for app ${appId}; enabling SSH access through the API.`);
			onProgress('SSH shell access is off for this app. Turning it on…');
			await enableAppSsh(cw, serverId, appId);
			try {
				remote = await discoverWithRetry(transport, { sysUser: choice.sysUser }, {
					timeoutMs: shellRetryTimeoutMs,
					retryShellDisabled: true,
					onAttempt: (n) => onProgress(`Waiting for Cloudways to apply SSH access (attempt ${n})…`),
				});
			} catch (retryError) {
				if (!(retryError instanceof ShellAccessDisabledError)) throw retryError;
				throw new Error(`Cloudways accepted the request to turn on SSH access for ${choice.appLabel}, but the server still `
					+ 'says shell access is disabled after 3 minutes. In Cloudways, open Applications → '
					+ `${choice.appLabel} → Application Settings → SSH Access, make sure it is on, then click Link again.`);
			}
		}
		return { ...link, remotePath: remote.remotePath, privateDir: remote.privateDir };
	};

	/** Builds and verifies a link from SFTP/SSH credentials. Returns the link to store; nothing is saved yet. */
	const prepareManualLink = async ({ host, port, username, authType, password, remotePath, domain }) => {
		if (authType === 'password' && process.platform === 'win32') {
			throw new Error('Password authentication is not supported on Windows yet. Use the SSH key option instead.');
		}
		if (authType !== 'password') keys.ensure(keyComment());
		const link = {
			mode: 'manual',
			authType: authType === 'password' ? 'password' : 'key',
			host: String(host).trim(),
			port: Number(port) || 22,
			username: String(username).trim(),
			password: authType === 'password' ? password : null,
			domain: domain ? String(domain).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') : null,
		};
		const remote = await syncService.discoverRemote(syncService.transportFor(link), {
			remotePath: remotePath ? String(remotePath).trim() : null,
		});
		return { ...link, remotePath: remote.remotePath, privateDir: remote.privateDir };
	};

	/** Name, domain and folder for a new Local site, following Local's new-site defaults and avoiding clashes. */
	const newSiteLocation = (siteName) => {
		const defaults = {
			sitesPath: '~/Local Sites/',
			tld: '.local',
			environment: 'flywheel',
			adminEmail: 'dev-email@wpengine.local',
			...(LocalMain.UserData ? LocalMain.UserData.get('settings-new-site-defaults', {}) : {}),
		};
		const slug = String(siteName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'cloudways-site';
		const sites = Object.values(container.siteData.getSites());
		const tld = `.${String(defaults.tld).replace(/^\.+/, '')}`;
		const expand = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir());
		for (let i = 1; i < 1000; i += 1) {
			const candidate = i === 1 ? slug : `${slug}-${i}`;
			const domain = `${candidate}${tld}`;
			const sitePath = path.join(defaults.sitesPath, candidate);
			const taken = sites.some((s) => s.domain === domain || path.resolve(expand(s.path)) === path.resolve(expand(sitePath)));
			if (!taken && !fs.existsSync(expand(sitePath))) {
				return { siteName: String(siteName).trim(), domain, sitePath, defaults };
			}
		}
		throw new Error('Could not find a free folder for the new site.');
	};

	const handlers = {
		[IPC.GET_STATE]: (siteId) => getState(siteId),

		[IPC.GET_PUBLIC_KEY]: () => keys.ensure(keyComment()),

		[IPC.CHECK_UPDATE]: () => updater.check({ manual: true }),

		[IPC.INSTALL_UPDATE]: () => updater.install(),

		[IPC.RESTART_LOCAL]: () => updater.restart(),

		[IPC.CONNECT_ACCOUNT]: async ({ email, apiKey }) => {
			// Keys contain no whitespace; copy-paste can bring along spaces, line breaks or zero-width characters.
			const credentials = {
				email: String(email || '').trim() || null,
				apiKey: String(apiKey).replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, ''),
			};
			const candidate = new CloudwaysApi({ ...credentials, logger });
			await candidate.authenticate();
			store.setAccount(credentials);
			api = candidate;
			broadcast();
			return getState();
		},

		[IPC.DISCONNECT_ACCOUNT]: () => {
			store.clearAccount();
			api = null;
			broadcast();
			return getState();
		},

		[IPC.LIST_APPS]: async () => toAppChoices(await getApi().getServers()),

		[IPC.LINK_API_APP]: async ({ siteId, serverId, appId, progressId }) => {
			store.setLink(siteId, await prepareApiLink({ serverId, appId }, progressReporter(progressId)));
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.LINK_MANUAL]: async ({ siteId, ...credentials }) => {
			store.setLink(siteId, await prepareManualLink(credentials));
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.COMPARE]: ({ siteId, checksum }) => runAndBroadcast(siteId, syncService.compare(siteId, { checksum })),

		[IPC.NEW_SITE_LOCATION]: (siteName) => {
			const { domain, sitePath } = newSiteLocation(siteName);
			return { domain, sitePath };
		},

		/**
		 * "Pull to a new site": verifies the Cloudways connection first (so a bad credential never leaves an empty
		 * site behind), then creates a regular Local site with Local's own add-site service, links it and pulls.
		 * Resolves once the connection is verified; creation and the pull report progress in Local's site overlay.
		 */
		[IPC.PULL_NEW_SITE]: async ({ siteName, source }) => {
			if (!siteName || !String(siteName).trim()) throw new Error('Enter a name for the new site.');
			const link = source && source.kind === 'manual'
				? await prepareManualLink(source)
				: await prepareApiLink(source || {}, progressReporter(source && source.progressId));
			const location = newSiteLocation(siteName);

			(async () => {
				let site;
				try {
					site = await container.addSite.addSite({
						newSiteInfo: {
							siteName: location.siteName,
							siteDomain: location.domain,
							sitePath: location.sitePath,
							environment: location.defaults.environment,
							multiSite: '',
						},
						wpCredentials: {
							adminUsername: 'admin',
							adminPassword: randomString(20),
							adminEmail: location.defaults.adminEmail,
						},
						goToSite: true,
						installWP: true,
					});
				} catch (e) {
					// Local shows its own error dialog for failed site creation.
					logger.error(`Could not create the Local site for a Cloudways pull: ${e.message}`);
					return;
				}
				store.setLink(site.id, link);
				broadcast(site.id);
				try {
					await runAndBroadcast(site.id, syncService.pull(site.id, { deleteLocal: true, backupLocal: false }));
				} catch (e) {
					// Reported through the site banner.
				}
			})();

			return { domain: location.domain, sitePath: location.sitePath };
		},

		[IPC.UNLINK_SITE]: async ({ siteId, removeKey }) => {
			const link = store.getLink(siteId);
			if (link && link.mode === 'api' && link.sshKeyId && removeKey) {
				try {
					await getApi().deleteSshKey(link.serverId, link.sshKeyId);
				} catch (e) {
					logger.warn(`Could not remove the SSH key from Cloudways: ${e.message}`);
				}
			}
			store.removeLink(siteId);
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.TEST_CONNECTION]: async (siteId) => {
			const link = store.getLink(siteId);
			if (!link) throw new Error('This site is not linked to Cloudways yet.');
			const remote = await syncService.discoverRemote(syncService.transportFor(link), {
				remotePath: link.remotePath,
				sysUser: link.sysUser,
			});
			store.updateLink(siteId, { remotePath: remote.remotePath, privateDir: remote.privateDir });
			broadcast(siteId);
			return remote;
		},

		// Outcomes are reported through site banners like Local Connect; the IPC reply only signals completion.
		[IPC.PUSH]: ({ siteId, options }) => runAndBroadcast(siteId, syncService.push(siteId, options)),

		[IPC.PULL]: ({ siteId, options }) => runAndBroadcast(siteId, syncService.pull(siteId, options)),
	};

	Object.entries(handlers).forEach(([channel, handler]) => LocalMain.addIpcAsyncListener(channel, handler));

	logger.info(`ConnectLocal for Cloudways loaded (rsync/ssh from ${findBundledBinDir() || 'system PATH'})`);
};

/** Test hook: shorten SSH retry pauses and the wait for SSH access. */
module.exports.setRetryDelayForTests = (ms) => {
	retryDelayMs = ms;
	shellRetryTimeoutMs = ms * 50;
};
