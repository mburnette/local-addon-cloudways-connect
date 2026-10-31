'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { SYNC_EXCLUDES, IGNORE_FILES } = require('../constants');
const { Transport, TransportError, describeSshFailure, shellQuote: q, toPosixPath } = require('./transport');

const WP = 'wp --skip-plugins --skip-themes';
const REMOTE_BACKUP_NAME = 'local-backup-before-push.sql';
const LOCAL_BACKUP_NAME = 'local-backup-before-pull.sql';
const SYS_USER_RE = /^[A-Za-z0-9_-]+$/;
const MARIADB_SANDBOX_LINE = /^\/\*M!999999\\- enable the sandbox mode \*\/\s*$/;

const DEFAULT_OPTIONS = {
	push: {
		files: true,
		database: true,
		backup: true,
		deleteRemote: true,
		purgeCache: true,
	},
	pull: {
		files: true,
		database: true,
		backupLocal: true,
		deleteLocal: true,
	},
};

const LABELS = {
	push: { status: 'pushing_v2', verb: 'push', gerund: 'pushing', preposition: 'to', done: 'pushed to' },
	pull: { status: 'pulling', verb: 'pull', gerund: 'pulling', preposition: 'from', done: 'pulled from' },
};

/**
 * Makes a dump importable on the other side. Local runs MySQL 8 and Cloudways runs MariaDB, and each side's
 * default collations (utf8mb4_0900_* / utf8mb4_uca1400_*) are unknown to the other. Newer MariaDB mysqldump also
 * writes a "sandbox mode" first line that the MySQL client rejects. Streams line by line so large dumps are not
 * loaded into memory.
 */
async function normalizeDumpForImport(file) {
	const tmp = `${file}.tmp`;
	const input = fs.createReadStream(file, { encoding: 'utf8' });
	const output = fs.createWriteStream(tmp, { encoding: 'utf8' });
	const rl = readline.createInterface({ input, crlfDelay: Infinity });
	for await (const line of rl) {
		if (MARIADB_SANDBOX_LINE.test(line)) continue;
		const fixed = line
			.replace(/utf8mb4_(?:0900|uca1400)_[a-z0-9_]+/g, 'utf8mb4_unicode_520_ci')
			.replace(/utf8mb3_uca1400_[a-z0-9_]+/g, 'utf8mb3_unicode_ci');
		if (!output.write(`${fixed}\n`)) {
			await new Promise((resolve) => output.once('drain', resolve));
		}
	}
	await new Promise((resolve, reject) => output.end((err) => (err ? reject(err) : resolve())));
	fs.renameSync(tmp, file);
}

/** Parses `key=value` lines printed by our remote helper commands. */
function parseKeyValues(stdout) {
	return stdout.split(/\r?\n/).reduce((acc, line) => {
		const i = line.indexOf('=');
		if (i > 0) acc[line.slice(0, i).trim()] = line.slice(i + 1).trim();
		return acc;
	}, {});
}

/** A webroot-relative path from a comparison: no absolute paths, no "..", no empty segments. */
const isSafeRelativePath = (p) => typeof p === 'string'
	&& p.length > 0
	&& !p.startsWith('/')
	&& !/^[A-Za-z]:/.test(p)
	&& !p.includes('\0')
	&& p.split(/[\\/]/).every((seg) => seg && seg !== '..' && seg !== '.');

/** "https://example.com/blog/" -> "//example.com/blog" */
const schemeless = (url) => String(url || '').trim().replace(/\/+$/, '').replace(/^https?:/i, '');

/**
 * Search/replace pairs that move a site from one base URL to another, the same scheme-relative replacement
 * Local Connect uses for WP Engine, plus the JSON-escaped form block editors and page builders store, plus a
 * final scheme fix when the destination's scheme differs.
 */
function urlReplacements(fromBases, toUrl) {
	const to = schemeless(toUrl);
	const pairs = [];
	fromBases.map(schemeless).filter((from) => from && from !== to).forEach((from) => {
		pairs.push([from, to]);
		pairs.push([from.replace(/\//g, '\\/'), to.replace(/\//g, '\\/')]);
	});
	const host = to.replace(/^\/\//, '');
	if (/^https:/i.test(toUrl)) pairs.push([`http://${host}`, `https://${host}`]);
	else if (/^http:/i.test(toUrl)) pairs.push([`https://${host}`, `http://${host}`]);
	return pairs;
}

/**
 * Shell snippet that finds the WordPress webroot for the SSH user and a writable directory outside it for
 * backups and temporary dumps (never inside the webroot, so a dump is never web-downloadable). Cloudways app credentials land in the app directory (…/<sys_user>/ with public_html inside);
 * master credentials land in /home/master with apps under applications/<sys_user>/public_html.
 */
function discoverRemoteScript({ remotePath, sysUser }) {
	const candidates = [];
	if (remotePath) candidates.push(q(remotePath));
	candidates.push('"$HOME/public_html"');
	if (sysUser && SYS_USER_RE.test(sysUser)) {
		candidates.push(`"/home/master/applications/${sysUser}/public_html"`);
		candidates.push(`"$HOME/applications/${sysUser}/public_html"`);
	}
	candidates.push('"$HOME"');
	return [
		`for d in ${candidates.join(' ')}; do`,
		'if [ -f "$d/wp-config.php" ] || [ -f "$d/wp-load.php" ]; then',
		'cd "$d" && W="$(pwd -P)"; A="$(dirname "$W")"; P="";',
		// Cloudways app users cannot write to the app folder itself, only to tmp/ and private_html/ beside the webroot.
		'for c in "$A/tmp" "$A/private_html" "$A" "$HOME/tmp" "$HOME"; do',
		'if [ -d "$c" ] && [ -w "$c" ] && [ "$c" != "$W" ]; then P="$c"; break; fi; done;',
		'[ -n "$P" ] || P="$(umask 077; mktemp -d 2>/dev/null)";',
		'echo "webroot=$W"; echo "private=$P";',
		'if command -v wp >/dev/null 2>&1; then echo "wpcli=yes"; else echo "wpcli=no"; fi;',
		'if command -v rsync >/dev/null 2>&1; then echo "rsync=yes"; else echo "rsync=no"; fi;',
		'exit 0; fi; done;',
		'echo "home=$HOME"; exit 3',
	].join(' ');
}

/**
 * Symlinks in a Local site that rsync treats as unsafe (absolute, or climbing out of the webroot): typically a theme
 * or plugin developed in another folder and linked into wp-content. Paths are webroot-relative with "/" separators.
 * `external` links are pushed as the files they point to (--copy-unsafe-links) but never pulled into, so a pull can
 * neither replace the link nor write into the folder it points to. `broken` ones have no target and are skipped.
 */
function findExternalLinks(webRoot) {
	const external = [];
	const broken = [];
	let root;
	try {
		root = fs.realpathSync(webRoot);
	} catch (e) {
		return { external, broken };
	}
	const walk = (dir, rel) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			return;
		}
		entries.forEach((entry) => {
			const full = path.join(dir, entry.name);
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) {
				const raw = fs.readlinkSync(full);
				const resolved = path.resolve(dir, raw);
				const unsafe = path.isAbsolute(raw) || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`));
				if (unsafe) (fs.existsSync(full) ? external : broken).push(relPath);
			} else if (entry.isDirectory()) {
				walk(full, relPath);
			}
		});
	};
	walk(root, '');
	return { external, broken };
}

const COMPARE_FORMAT = '--out-format=CW|%i|%l|%M|%n';

/** rsync prints %M as "YYYY/MM/DD-HH:MM:SS" in local time. Returns epoch seconds, or null. */
function parseRsyncTime(value) {
	const m = /^(\d{4})\/(\d{2})\/(\d{2})-(\d{2}):(\d{2}):(\d{2})$/.exec(value || '');
	if (!m) return null;
	return Math.round(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() / 1000);
}

/**
 * Parses dry-run output written with COMPARE_FORMAT into { op, type, size, mtime, path } items, where op is
 * 'create' (missing on the receiver), 'update' (differs) or 'delete' (only on the receiver). Directories and
 * attribute-only differences are dropped: the comparison is about file contents.
 */
function parseItemized(stdout) {
	const items = [];
	stdout.split(/\r?\n/).forEach((line) => {
		if (!line.startsWith('CW|')) return;
		const parts = line.split('|');
		if (parts.length < 5) return;
		const code = parts[1];
		const filePath = parts.slice(4).join('|');
		if (!filePath || filePath.endsWith('/')) return;
		if (code.startsWith('*deleting')) {
			items.push({ op: 'delete', type: 'file', size: null, mtime: null, path: filePath });
			return;
		}
		const [transfer, kind] = code;
		if (transfer === '.' || kind === 'd') return;
		items.push({
			op: code.slice(2).startsWith('+++') ? 'create' : 'update',
			type: kind === 'L' ? 'symlink' : 'file',
			size: Number(parts[2]),
			mtime: parseRsyncTime(parts[3]),
			path: filePath,
		});
	});
	return items;
}

/**
 * Merges a Local -> Cloudways dry run with a Cloudways -> Local dry run into one list of differing files. The two
 * passes complement each other: each reports the sender's size and mtime, so together they describe both sides.
 */
function mergeComparison(pushItems, pullItems) {
	const byPath = new Map();
	const entry = (p) => {
		if (!byPath.has(p)) byPath.set(p, { path: p, type: 'file', status: null, local: null, remote: null });
		return byPath.get(p);
	};
	pushItems.forEach((item) => {
		const e = entry(item.path);
		if (item.op === 'delete') {
			e.status = e.status || 'remote-only';
			return;
		}
		e.type = item.type;
		e.status = item.op === 'create' ? 'local-only' : 'changed';
		e.local = { size: item.size, mtime: item.mtime };
	});
	pullItems.forEach((item) => {
		const e = entry(item.path);
		if (item.op === 'delete') {
			e.status = e.status || 'local-only';
			return;
		}
		e.type = e.local ? e.type : item.type;
		e.status = item.op === 'create' ? 'remote-only' : 'changed';
		e.remote = { size: item.size, mtime: item.mtime };
	});
	return [...byPath.values()]
		.map((e) => {
			let newer = null;
			if (e.status === 'changed' && e.local && e.remote && e.local.mtime && e.remote.mtime) {
				newer = e.local.mtime > e.remote.mtime ? 'local' : e.remote.mtime > e.local.mtime ? 'remote' : 'same';
			}
			return { ...e, newer };
		})
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** What Cloudways prints, instead of running the command, for SFTP-only credentials. */
const SHELL_DISABLED_RE = /shell access is disabled/i;

class ShellAccessDisabledError extends Error {
	constructor() {
		super('Cloudways has SSH shell access turned off for this application (its credentials are SFTP-only), so '
			+ 'rsync and WP-CLI cannot run. Turn on SSH access under Applications → your app → Application Settings → SSH Access, '
			+ 'or link through the Cloudways API tab and the add-on will turn it on for you.');
		this.name = 'ShellAccessDisabledError';
	}
}

/** Pushes Local sites to, and pulls them from, a linked Cloudways application. */
class SyncService {
	constructor({ store, keys, workDir, getApi, services, sendIPCEvent, logger }) {
		this._store = store;
		this._keys = keys;
		this._workDir = workDir;
		this._getApi = getApi;
		this._siteData = services.siteData;
		this._siteDatabase = services.siteDatabase;
		this._siteProcessManager = services.siteProcessManager;
		this._wpCli = services.wpCli;
		this._send = sendIPCEvent;
		this._logger = logger;
		/** siteId -> 'push' | 'pull' | 'compare' */
		this._active = new Map();
		/** siteId -> Map(path -> status) from the latest comparison; selective transfers may only touch these. */
		this._compared = new Map();
	}

	activity(siteId) {
		return this._active.get(siteId) || null;
	}

	transportFor(link) {
		return new Transport({
			host: link.host,
			port: link.port,
			username: link.username,
			privateKeyPath: link.authType === 'password' ? null : this._keys.privateKeyPath,
			password: link.authType === 'password' ? link.password : null,
			workDir: this._workDir,
			logger: this._logger,
		});
	}

	/** Connects, finds the webroot, and checks the server has what a push or pull needs. */
	async discoverRemote(transport, { remotePath, sysUser } = {}) {
		const { code, stdout, stderr } = await transport.exec(discoverRemoteScript({ remotePath, sysUser }), { allowFailure: true });
		if (SHELL_DISABLED_RE.test(`${stdout}\n${stderr}`)) {
			throw new ShellAccessDisabledError();
		}
		// ssh itself exits 255 when it cannot connect or log in; report that, not a missing WordPress.
		if (code === 255 && !/^webroot=/m.test(stdout)) throw new TransportError(describeSshFailure(code, stderr, transport), code, stderr);
		const info = parseKeyValues(stdout);
		if (code === 3 || !info.webroot) {
			throw new Error(
				`Connected, but could not find a WordPress install under ${info.home || 'the home directory'}. ` +
				'Set the remote path to the folder containing wp-config.php (usually …/public_html).',
			);
		}
		if (code !== 0) {
			throw new Error(`Unexpected response from the server while locating WordPress (exit ${code}).`);
		}
		return {
			remotePath: info.webroot,
			privateDir: info.private,
			hasWpCli: info.wpcli === 'yes',
			hasRsync: info.rsync === 'yes',
		};
	}

	_message(siteId, label, progressText) {
		this._send('updateSiteMessage', siteId, {
			label,
			stripes: true,
			progressText,
			truncateProgressText: Boolean(progressText),
		});
	}

	/**
	 * Lists files that differ between Local and Cloudways without transferring anything, like MagicSync's
	 * preview. Uses rsync's quick check (size + modification time) unless `checksum` is set.
	 */
	async compare(siteId, { checksum = false } = {}) {
		const site = this._siteData.getSite(siteId);
		if (!site) throw new Error('Local site not found.');
		const link = this._store.getLink(siteId);
		if (!link) throw new Error('This site is not linked to Cloudways yet.');
		if (this._active.has(siteId)) {
			throw new Error(`A Cloudways ${this._active.get(siteId)} is already running for this site.`);
		}
		const transport = this.transportFor(link);
		this._active.set(siteId, 'compare');
		try {
			const remote = await this.discoverRemote(transport, { remotePath: link.remotePath, sysUser: link.sysUser });
			if (!remote.hasRsync) throw new Error('rsync was not found on the server, so files cannot be compared.');
			const args = [
				'--recursive',
				'--links',
				'--copy-unsafe-links',
				'--times',
				'--omit-dir-times',
				'--dry-run',
				'--delete',
				COMPARE_FORMAT,
				...(checksum ? ['--checksum'] : []),
			];
			const pushArgs = [...args, ...this._excludeArgs(site, ['push', 'pull'], 'push')];
			const pullArgs = [...args, ...this._excludeArgs(site, ['push', 'pull'], 'pull')];
			const pushOut = await transport.rsyncUp({ source: `${site.paths.webRoot}${path.sep}`, destination: `${remote.remotePath}/`, extraArgs: pushArgs });
			const pullOut = await transport.rsyncDown({ source: `${remote.remotePath}/`, destination: `${site.paths.webRoot}${path.sep}`, extraArgs: pullArgs });
			const entries = mergeComparison(parseItemized(pushOut), parseItemized(pullOut));
			this._compared.set(siteId, new Map(entries.map((e) => [e.path, e.status])));
			return { at: new Date().toISOString(), checksum, remotePath: remote.remotePath, entries };
		} finally {
			await transport.close();
			this._active.delete(siteId);
		}
	}

	push(siteId, options = {}) {
		return this._run(siteId, 'push', options, (ctx) => this._push(ctx));
	}

	pull(siteId, options = {}) {
		return this._run(siteId, 'pull', options, (ctx) => this._pull(ctx));
	}

	/**
	 * Shared lifecycle for both directions, mirroring Local Connect: site status overlay, progress messages,
	 * completion/error banners, one transfer per site at a time.
	 */
	async _run(siteId, direction, options, body) {
		const labels = LABELS[direction];
		const opts = { ...DEFAULT_OPTIONS[direction], ...options };
		const site = this._siteData.getSite(siteId);
		if (!site) throw new Error('Local site not found.');
		const link = this._store.getLink(siteId);
		if (!link) throw new Error('This site is not linked to Cloudways yet.');
		if (opts.fileList) {
			const compared = this._compared.get(siteId);
			if (!Array.isArray(opts.fileList) || !opts.fileList.length) throw new Error('Select at least one file.');
			if (!compared || opts.fileList.some((p) => !compared.has(p) || !isSafeRelativePath(p))) {
				throw new Error('The file list is out of date. Compare again, then choose files.');
			}
			// Files that exist only on the receiving side are deleted there rather than transferred.
			const onlyOnReceiver = direction === 'push' ? 'remote-only' : 'local-only';
			opts.selection = {
				transfer: opts.fileList.filter((p) => compared.get(p) !== onlyOnReceiver),
				remove: opts.fileList.filter((p) => compared.get(p) === onlyOnReceiver),
			};
			opts.files = true;
			opts.database = false;
		}
		if (!opts.files && !opts.database) throw new Error(`Choose files, database, or both to ${labels.verb}.`);
		if (this._active.has(siteId)) {
			throw new Error(`A Cloudways ${this._active.get(siteId)} is already running for this site.`);
		}

		const transport = this.transportFor(link);
		this._active.set(siteId, direction);
		this._send('updateSiteStatus', siteId, labels.status);
		const startedAt = Date.now();
		const warnings = [];
		const destination = link.appLabel || link.domain || link.host;

		try {
			this._message(siteId, 'Connecting to Cloudways');
			const remote = await this.discoverRemote(transport, { remotePath: link.remotePath, sysUser: link.sysUser });
			if (opts.database && !remote.hasWpCli) {
				throw new Error(`WP-CLI was not found on the server, so the database cannot be ${labels.done.split(' ')[0]}.`);
			}
			if (opts.files && !remote.hasRsync) {
				throw new Error(`rsync was not found on the server, so files cannot be ${labels.done.split(' ')[0]}.`);
			}

			await body({ site, link, opts, transport, remote, warnings });

			const summary = {
				at: new Date().toISOString(),
				files: opts.files,
				database: opts.database,
				selectedFiles: opts.fileList ? opts.fileList.length : undefined,
				seconds: Math.round((Date.now() - startedAt) / 1000),
			};
			this._store.updateLink(siteId, {
				[direction === 'push' ? 'lastPush' : 'lastPull']: summary,
				remotePath: remote.remotePath,
				privateDir: remote.privateDir,
			});

			this._send('clearConnectBanners', siteId);
			this._send('showSiteBanner', {
				siteID: siteId,
				id: `cloudways-site-${direction}ed`,
				title: `${direction === 'push' ? 'Push' : 'Pull'} complete!`,
				message: `${site.name} has been ${labels.done} Cloudways (${destination}).${warnings.length ? ` ${warnings.join(' ')}` : ''}`,
				variant: warnings.length ? 'warning' : 'success',
			});
			if (direction === 'pull') this._send('refreshSiteVersions');
			return { ok: true, summary, warnings };
		} catch (e) {
			this._logger.error(`Cloudways ${direction} failed: ${e.message}`, { stack: e.stack, stderr: e.stderr });
			this._send('clearConnectBanners', siteId);
			this._send('showSiteBanner', {
				siteID: siteId,
				id: `cloudways-${labels.gerund}-error`,
				title: `Uh-oh! We ran into an issue when ${labels.gerund} ${labels.preposition} Cloudways.`,
				message: e.message,
				variant: 'error',
			});
			throw e;
		} finally {
			await transport.close();
			this._active.delete(siteId);
			this._compared.delete(siteId);
			const status = this._siteProcessManager ? this._siteProcessManager.getSiteStatus(site) : 'running';
			this._send('updateSiteStatus', siteId, status === labels.status ? 'running' : status);
			this._send('getAttention');
		}
	}

	async _ensureLocalSiteRunning(site, direction) {
		if (this._siteProcessManager && this._siteProcessManager.getSiteStatus(site) !== 'running') {
			this._message(site.id, 'Starting the Local site to access its database');
			await this._siteProcessManager.start(site);
			this._send('updateSiteStatus', site.id, LABELS[direction].status);
		}
	}

	/** Excludes for a transfer in the `side` direction ('push' or 'pull'), plus the ignore files of `directions`. */
	_excludeArgs(site, directions, side) {
		const args = SYNC_EXCLUDES.map((pattern) => `--exclude=${pattern}`);
		const links = findExternalLinks(site.paths.webRoot);
		if (links.broken.length) this._logger.warn(`Skipping broken symlinks in ${site.name}: ${links.broken.join(', ')}`);
		(side === 'pull' ? [...links.external, ...links.broken] : links.broken).forEach((p) => args.push(`--exclude=/${p}`));
		directions.forEach((direction) => {
			const ignoreFile = path.join(site.paths.webRoot, IGNORE_FILES[direction]);
			if (fs.existsSync(ignoreFile)) args.push(`--exclude-from=${toPosixPath(ignoreFile)}`);
		});
		return args;
	}

	/**
	 * rsync flags for a transfer. With a file list (selective sync) only those paths move. Deletions for a
	 * selection are done separately (see _push/_pull): rsync 3.1's --delete-missing-args aborts when a listed
	 * file's parent folder is also missing on the sender. Returns a cleanup function for the temporary list file.
	 */
	_fileSyncArgs(site, direction, { deleteExtraneous, fileList }) {
		// --copy-unsafe-links: a symlink pointing outside the site (a theme or plugin developed in another folder and
		// linked into wp-content) is sent as the files it points to; the other side has no such folder. Links within the
		// site stay links.
		const args = [
			'--links',
			'--copy-unsafe-links',
			'--times',
			'--omit-dir-times',
			'--compress',
			'--perms',
			'--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r',
			'--verbose',
			'--out-format=Changed:%n',
		];
		let listFile = null;
		if (fileList) {
			listFile = path.join(os.tmpdir(), `cloudways-files-${site.id}-${crypto.randomBytes(6).toString('hex')}.txt`);
			fs.writeFileSync(listFile, fileList.join('\0'));
			args.push(`--files-from=${toPosixPath(listFile)}`, '--from0');
		} else {
			args.push('--recursive');
			if (deleteExtraneous) args.push('--delete');
		}
		args.push(...this._excludeArgs(site, [direction], direction));
		return { args, cleanup: () => listFile && fs.rmSync(listFile, { force: true }) };
	}

	_fileProgress(siteId, label) {
		let lastUpdate = 0;
		return (file) => {
			const now = Date.now();
			if (now - lastUpdate < 150) return;
			lastUpdate = now;
			this._message(siteId, label, file);
		};
	}

	async _rsyncFiles(site, direction, transport, remote, { deleteExtraneous, fileList }) {
		const { args, cleanup } = this._fileSyncArgs(site, direction, { deleteExtraneous, fileList });
		const localRoot = `${site.paths.webRoot}${path.sep}`;
		const remoteRoot = `${remote.remotePath}/`;
		try {
			if (direction === 'push') {
				await transport.rsyncUp({ source: localRoot, destination: remoteRoot, extraArgs: args, onFile: this._fileProgress(site.id, 'Uploading files') });
			} else {
				await transport.rsyncDown({ source: remoteRoot, destination: localRoot, extraArgs: args, onFile: this._fileProgress(site.id, 'Downloading files') });
			}
		} finally {
			cleanup();
		}
	}

	_tempName(site, kind) {
		const token = crypto.randomBytes(6).toString('hex');
		return { token, local: path.join(os.tmpdir(), `cloudways-${kind}-${site.id}-${token}.sql`) };
	}

	async _getLocalTablePrefix(site) {
		try {
			return await this._siteDatabase.getTablePrefix(site);
		} catch (e) {
			this._logger.warn(`Could not read the local table prefix: ${e.message}`);
			return null;
		}
	}

	// ---------------------------------------------------------------- push

	async _push({ site, link, opts, transport, remote, warnings }) {
		const api = link.mode === 'api' ? this._getApi() : null;

		if (opts.backup && api) {
			this._message(site.id, 'Creating an application backup on Cloudways');
			const operationId = await api.takeAppBackup(link.serverId, link.appId);
			await api.waitForOperation(operationId, {
				timeoutMs: 30 * 60 * 1000,
				onTick: (op) => this._message(site.id, 'Creating an application backup on Cloudways', op.message || op.status),
			});
		}

		if (opts.files && opts.selection) {
			const { transfer, remove } = opts.selection;
			this._message(site.id, `Syncing ${opts.fileList.length} selected file(s) to Cloudways`);
			if (transfer.length) await this._rsyncFiles(site, 'push', transport, remote, { fileList: transfer });
			for (let i = 0; i < remove.length; i += 200) {
				await transport.exec(`cd ${q(remote.remotePath)} && rm -f -- ${remove.slice(i, i + 200).map(q).join(' ')}`);
			}
		} else if (opts.files) {
			this._message(site.id, 'Uploading files to Cloudways');
			await this._rsyncFiles(site, 'push', transport, remote, { deleteExtraneous: opts.deleteRemote });
		}

		if (opts.database) {
			await this._pushDatabase(site, link, transport, remote, warnings);
		}

		if (opts.purgeCache) {
			this._message(site.id, 'Clearing caches on Cloudways');
			if (api) {
				try {
					await api.purgeAppCache(link.serverId, link.appId);
				} catch (e) {
					warnings.push(`Cache purge failed: ${e.message}`);
				}
			}
			await transport.exec(`cd ${q(remote.remotePath)} && (${WP} cache flush; wp breeze purge --cache=all) >/dev/null 2>&1; true`, {
				allowFailure: true,
			});
		}
	}

	async _pushDatabase(site, link, transport, remote, warnings) {
		const cd = `cd ${q(remote.remotePath)}`;
		await this._ensureLocalSiteRunning(site, 'push');

		this._message(site.id, 'Exporting the Local database');
		const { token, local: localDump } = this._tempName(site, 'push');
		const remoteDump = `${remote.privateDir}/local-push-${token}.sql`;
		const remoteBackup = `${remote.privateDir}/${REMOTE_BACKUP_NAME}`;

		try {
			await this._siteDatabase.dump(site, localDump);
			await normalizeDumpForImport(localDump);

			this._message(site.id, 'Backing up the Cloudways database');
			const state = parseKeyValues((await transport.exec(
				`${cd} && umask 077 && ${WP} db export ${q(remoteBackup)} --no-tablespaces=true >/dev/null && ` +
				`echo "table_prefix=$(${WP} config get table_prefix 2>/dev/null)" && ` +
				`echo "home=$(${WP} option get home 2>/dev/null)"`,
			)).stdout);
			const remotePrefix = state.table_prefix || null;
			const remoteHome = state.home || (link.domain ? `//${link.domain}` : '');

			this._message(site.id, 'Uploading the database');
			await transport.rsyncUp({ source: localDump, destination: remoteDump, extraArgs: ['--compress', '--times'] });

			this._message(site.id, 'Importing the database on Cloudways');
			try {
				await transport.exec(`${cd} && ${WP} db reset --yes && ${WP} db import ${q(remoteDump)}`);
			} catch (importError) {
				this._message(site.id, 'Import failed, restoring the previous Cloudways database');
				await transport.exec(`${cd} && ${WP} db reset --yes && ${WP} db import ${q(remoteBackup)}`, { allowFailure: true });
				throw new Error(`Database import failed and the previous database was restored. ${importError.message}`);
			}

			const localPrefix = await this._getLocalTablePrefix(site);
			if (localPrefix && localPrefix !== remotePrefix) {
				this._message(site.id, 'Updating the remote table prefix to match Local');
				await transport.exec(`${cd} && ${WP} config set table_prefix ${q(localPrefix)}`);
			}

			if (!site.domain || !remoteHome) {
				warnings.push('Could not determine the Cloudways URL, so Local URLs were not replaced.');
				return;
			}
			this._message(site.id, 'Replacing Local URLs with the Cloudways URL');
			for (const [from, to] of urlReplacements([`//${site.domain}`], remoteHome)) {
				await transport.exec(`${cd} && ${WP} search-replace ${q(from)} ${q(to)} --all-tables --precise --skip-columns=guid --report-changed-only`);
			}
		} finally {
			fs.rmSync(localDump, { force: true });
			fs.rmSync(`${localDump}.tmp`, { force: true });
			await transport.exec(`rm -f ${q(remoteDump)}`, { allowFailure: true }).catch(() => {});
		}
	}

	// ---------------------------------------------------------------- pull

	async _pull({ site, link, opts, transport, remote, warnings }) {
		if (opts.files && opts.selection) {
			const { transfer, remove } = opts.selection;
			this._message(site.id, `Syncing ${opts.fileList.length} selected file(s) from Cloudways`);
			if (transfer.length) await this._rsyncFiles(site, 'pull', transport, remote, { fileList: transfer });
			const root = path.resolve(site.paths.webRoot);
			remove.forEach((p) => {
				const target = path.resolve(root, p);
				if (target.startsWith(`${root}${path.sep}`)) fs.rmSync(target, { force: true });
			});
		} else if (opts.files) {
			this._message(site.id, 'Downloading files from Cloudways');
			fs.mkdirSync(site.paths.webRoot, { recursive: true });
			await this._rsyncFiles(site, 'pull', transport, remote, { deleteExtraneous: opts.deleteLocal });
		}

		if (opts.database) {
			await this._pullDatabase(site, link, transport, remote, opts, warnings);
		}
	}

	/** Runs WP-CLI against the Local site through Local's own WP-CLI service (right PHP, MySQL socket, config). */
	async _localWp(site, args) {
		const out = await this._wpCli.run(site, args);
		return String(out === null || out === undefined ? '' : (out.stdout !== undefined ? out.stdout : out)).trim();
	}

	async _pullDatabase(site, link, transport, remote, opts, warnings) {
		const cd = `cd ${q(remote.remotePath)}`;
		await this._ensureLocalSiteRunning(site, 'pull');

		const { token, local: localDump } = this._tempName(site, 'pull');
		const remoteDump = `${remote.privateDir}/local-pull-${token}.sql`;
		const localBackup = path.join(site.paths.sql || path.dirname(site.paths.webRoot), LOCAL_BACKUP_NAME);
		// Local's WP-CLI service runs through the Windows shell there, so quote paths ourselves.
		const cliPath = (p) => (process.platform === 'win32' ? `"${p}"` : p);

		try {
			this._message(site.id, 'Exporting the Cloudways database');
			const state = parseKeyValues((await transport.exec(
				`${cd} && umask 077 && ${WP} db export ${q(remoteDump)} --no-tablespaces=true --single-transaction --quick --lock-tables=false >/dev/null && ` +
				`echo "table_prefix=$(${WP} config get table_prefix 2>/dev/null)" && ` +
				`echo "home=$(${WP} option get home 2>/dev/null)"`,
			)).stdout);
			const remotePrefix = state.table_prefix || null;
			const remoteHome = state.home || (link.domain ? `//${link.domain}` : '');

			this._message(site.id, 'Downloading the database');
			await transport.rsyncDown({ source: remoteDump, destination: localDump, extraArgs: ['--compress', '--times'] });
			await normalizeDumpForImport(localDump);

			const localHome = (await this._localWp(site, ['option', 'get', 'home']).catch(() => '')) || `http://${site.domain}`;

			if (opts.backupLocal) {
				this._message(site.id, 'Backing up the Local database');
				fs.mkdirSync(path.dirname(localBackup), { recursive: true });
				await this._siteDatabase.dump(site, localBackup);
			}

			this._message(site.id, 'Importing the database into Local');
			try {
				await this._localWp(site, ['db', 'reset', '--yes']);
				await this._localWp(site, ['db', 'import', cliPath(localDump)]);
			} catch (importError) {
				if (opts.backupLocal) {
					this._message(site.id, 'Import failed, restoring the previous Local database');
					await this._localWp(site, ['db', 'reset', '--yes']).catch(() => {});
					await this._localWp(site, ['db', 'import', cliPath(localBackup)]).catch(() => {});
					throw new Error(`Database import failed and the previous Local database was restored. ${importError.message}`);
				}
				throw new Error(`Database import failed. ${importError.message}`);
			}

			const localPrefix = await this._getLocalTablePrefix(site);
			if (remotePrefix && localPrefix !== remotePrefix) {
				this._message(site.id, 'Updating the Local table prefix to match Cloudways');
				await this._localWp(site, ['config', 'set', 'table_prefix', remotePrefix]);
			}

			if (!remoteHome) {
				warnings.push('Could not determine the Cloudways URL, so its URLs were not replaced.');
				return;
			}
			this._message(site.id, 'Replacing Cloudways URLs with the Local URL');
			// The temporary *.cloudwaysapps.com address often lingers in content built before the domain went live.
			const fromBases = [remoteHome, link.appFqdn ? `//${link.appFqdn}` : null].filter(Boolean);
			for (const [from, to] of urlReplacements(fromBases, localHome)) {
				await this._localWp(site, ['search-replace', from, to, '--all-tables', '--precise', '--skip-columns=guid', '--report-changed-only']);
			}
			await this._localWp(site, ['cache', 'flush']).catch(() => {});
		} finally {
			fs.rmSync(localDump, { force: true });
			fs.rmSync(`${localDump}.tmp`, { force: true });
			await transport.exec(`rm -f ${q(remoteDump)}`, { allowFailure: true }).catch(() => {});
		}
	}
}

module.exports = {
	SyncService,
	ShellAccessDisabledError,
	DEFAULT_OPTIONS,
	discoverRemoteScript,
	parseKeyValues,
	normalizeDumpForImport,
	urlReplacements,
	parseItemized,
	mergeComparison,
	findExternalLinks,
};
