'use strict';

const { ipcRenderer, shell } = require('electron');
const { ipcAsync, confirm } = require('@getflywheel/local/renderer');
const {
	Button,
	Checkbox,
	BasicInput,
	FlyModal,
	PrimaryButton,
	Spinner,
	TextButton,
	Title,
} = require('@getflywheel/local-components');

const { IPC } = require('../constants');

const API_KEY_URL = 'https://platform.cloudways.com/api';

const errorText = (e) => (e && (e.messageMain || e.message)) || String(e);

module.exports = function createComponents({ React }) {
	const h = React.createElement;
	const { useCallback, useEffect, useState } = React;

	/** Loads add-on state for a site and keeps it fresh when the main process reports changes. */
	function useCloudwaysState(siteId) {
		const [state, setState] = useState(null);
		const refresh = useCallback(() => ipcAsync(IPC.GET_STATE, siteId).then(setState).catch(() => {}), [siteId]);
		useEffect(() => {
			refresh();
			const onChange = (_event, changedSiteId) => {
				if (!changedSiteId || changedSiteId === siteId) refresh();
			};
			ipcRenderer.on(IPC.STATE_CHANGED, onChange);
			return () => ipcRenderer.removeListener(IPC.STATE_CHANGED, onChange);
		}, [siteId, refresh]);
		return [state, refresh];
	}

	/** Wraps an async action with busy + error state. */
	function useAction() {
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState(null);
		const run = useCallback(async (fn) => {
			setBusy(true);
			setError(null);
			try {
				return await fn();
			} catch (e) {
				setError(errorText(e));
				return undefined;
			} finally {
				setBusy(false);
			}
		}, []);
		return { busy, error, setError, run };
	}

	const isChecked = (value, previous) => (typeof value === 'boolean' ? value : !previous);

	function Field({ label, help, children }) {
		return h('label', { className: 'CWConnect_Field' },
			h('span', { className: 'CWConnect_FieldLabel' }, label),
			children,
			help ? h('span', { className: 'CWConnect_Help' }, help) : null);
	}

	function TextInput({ value, onChange, type = 'text', placeholder, disabled }) {
		return h(BasicInput, {
			type,
			value: value || '',
			placeholder,
			disabled,
			onChange: (e) => onChange(e.target.value),
		});
	}

	function ErrorNote({ error }) {
		return error ? h('div', { className: 'CWConnect_Error', role: 'alert' }, error) : null;
	}

	function BusyNote({ busy, children }) {
		return busy ? h('div', { className: 'CWConnect_Busy' }, h(Spinner, null), h('span', null, children)) : null;
	}

	function Tabs({ value, onChange, tabs, className = 'CWConnect_Tabs' }) {
		return h('div', { className, role: 'tablist' },
			tabs.map(([key, label]) => h('button', {
				key,
				type: 'button',
				role: 'tab',
				'aria-selected': value === key,
				className: `CWConnect_Tab${value === key ? ' is-active' : ''}`,
				onClick: () => onChange(key),
			}, label)));
	}

	function PublicKeyBox() {
		const [publicKey, setPublicKey] = useState('');
		const [copied, setCopied] = useState(false);
		useEffect(() => {
			ipcAsync(IPC.GET_PUBLIC_KEY).then(setPublicKey).catch(() => {});
		}, []);
		const copy = () => {
			navigator.clipboard.writeText(publicKey).then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			});
		};
		return h('div', { className: 'CWConnect_KeyBox' },
			h('textarea', { readOnly: true, value: publicKey, rows: 4, className: 'CWConnect_KeyText' }),
			h(TextButton, { onClick: copy, disabled: !publicKey }, copied ? 'Copied' : 'Copy public key'));
	}

	/** Options, wording and channel for each direction. */
	const DIRECTIONS = {
		push: {
			channel: IPC.PUSH,
			verb: 'Push',
			gerund: 'Pushing',
			button: 'Push to Cloudways',
			defaults: (link) => ({ files: true, database: true, backup: link.mode === 'api', deleteRemote: true, purgeCache: true }),
			checkboxes: (link, options) => [
				['files', 'Files (everything in app/public except wp-config.php)'],
				['database', 'Database (with URL search & replace)'],
				link.mode === 'api' && ['backup', 'Take a Cloudways application backup first'],
				options.files && ['deleteRemote', 'Delete files on Cloudways that are not in Local'],
				['purgeCache', 'Purge Cloudways caches afterwards'],
			],
			consequences: ({ what, where, site, options }) => [
				`This overwrites the ${what} on ${where} with ${site.name} from Local.`,
				options.database && 'The Cloudways database is replaced; the previous one is saved as local-backup-before-push.sql in the app\'s tmp folder (outside public_html).',
				options.files && options.deleteRemote && 'Files on Cloudways that do not exist locally will be deleted.',
			],
		},
		pull: {
			channel: IPC.PULL,
			verb: 'Pull',
			gerund: 'Pulling',
			button: 'Pull from Cloudways',
			defaults: () => ({ files: true, database: true, backupLocal: true, deleteLocal: true }),
			checkboxes: (link, options) => [
				['files', 'Files (everything in public_html except wp-config.php and server caches)'],
				['database', 'Database (with URL search & replace)'],
				options.database && ['backupLocal', 'Back up the Local database first'],
				options.files && ['deleteLocal', 'Delete Local files that are not on Cloudways'],
			],
			consequences: ({ what, where, site, options }) => [
				`This overwrites the ${what} of ${site.name} in Local with ${where}.`,
				options.database && (options.backupLocal
					? 'The Local database is replaced; the previous one is saved in app/sql/local-backup-before-pull.sql.'
					: 'The Local database is replaced without a backup.'),
				options.files && options.deleteLocal && 'Local files that do not exist on Cloudways will be deleted.',
			],
		},
	};

	/**
	 * Push or pull options, shared by the Tools panel and the header modal. Inside the modal the modal itself is the
	 * confirmation and it closes as soon as the transfer starts (progress shows in the site overlay, like Local Connect).
	 */
	function TransferForm({ direction, site, link, activity, inModal = false, onStarted }) {
		const config = DIRECTIONS[direction];
		const [options, setOptions] = useState(() => config.defaults(link));
		const { busy, error, run } = useAction();
		const toggle = (key) => (value) => setOptions((o) => ({ ...o, [key]: isChecked(value, o[key]) }));
		const nothingSelected = !options.files && !options.database;
		const where = `${link.domain || link.host}${link.appLabel ? ` (${link.appLabel})` : ''}`;
		const what = options.files && options.database ? 'files and database' : options.files ? 'files' : 'database';
		const consequences = config.consequences({ what, where, site, options }).filter(Boolean);
		const running = busy || activity === direction;

		const start = async () => {
			if (!inModal) {
				await confirm({
					title: `${config.verb} ${what} ${direction === 'push' ? 'to' : 'from'} Cloudways?`,
					message: h('div', null, consequences.map((text) => h('p', { key: text }, text))),
					buttonText: config.verb,
				});
			}
			const request = ipcAsync(config.channel, { siteId: site.id, options });
			if (onStarted) {
				onStarted();
				// Failures surface as a site banner, as with Local Connect.
				request.catch(() => {});
				return;
			}
			await run(() => request);
		};

		return h('div', { className: 'CWConnect_TransferForm' },
			h('div', { className: 'CWConnect_Options' },
				config.checkboxes(link, options).filter(Boolean).map(([key, label]) => h(Checkbox, {
					key,
					label,
					checked: options[key],
					onChange: toggle(key),
				}))),
			inModal ? h('ul', { className: 'CWConnect_Consequences' }, consequences.map((text) => h('li', { key: text }, text))) : null,
			h(ErrorNote, { error }),
			h('div', { className: 'CWConnect_Actions' },
				h(PrimaryButton, { onClick: start, disabled: running || Boolean(activity) || nothingSelected }, running ? `${config.gerund}…` : config.button)));
	}

	const describeLast = (last) => `${new Date(last.at).toLocaleString()} (${[last.files && 'files', last.database && 'database'].filter(Boolean).join(' + ')}, ${last.seconds}s)`;

	function LinkedView({ site, state }) {
		const { link } = state;
		const test = useAction();
		const unlink = useAction();
		const [testResult, setTestResult] = useState(null);
		const [removeKey, setRemoveKey] = useState(true);
		const [direction, setDirection] = useState('push');

		const rows = [
			link.serverLabel && ['Server', link.serverLabel],
			link.appLabel && ['Application', link.appLabel],
			link.domain && ['Domain', link.domain],
			['SSH', `${link.username}@${link.host}${Number(link.port) !== 22 ? `:${link.port}` : ''}`],
			['Remote path', link.remotePath],
			['Authentication', link.mode === 'api' ? 'Local Connect SSH key (managed through the Cloudways API)' : link.authType === 'password' ? 'SFTP/SSH password' : 'Local Connect SSH key'],
			link.lastPush && ['Last push', describeLast(link.lastPush)],
			link.lastPull && ['Last pull', describeLast(link.lastPull)],
		].filter(Boolean);

		return h('div', null,
			h('table', { className: 'CWConnect_Table' },
				h('tbody', null, rows.map(([k, v]) => h('tr', { key: k }, h('th', null, k), h('td', null, v))))),
			h(Tabs, {
				value: direction,
				onChange: setDirection,
				tabs: [['push', 'Push to Cloudways'], ['pull', 'Pull from Cloudways'], ['compare', 'Compare & sync files']],
				className: 'CWConnect_Tabs CWConnect_Tabs--Transfer',
			}),
			direction === 'compare'
				? h(CompareView, { site, activity: state.activity })
				: h(TransferForm, { key: direction, direction, site, link, activity: state.activity }),
			h('div', { className: 'CWConnect_Secondary' },
				h(TextButton, {
					disabled: test.busy,
					onClick: () => test.run(async () => {
						setTestResult(null);
						const remote = await ipcAsync(IPC.TEST_CONNECTION, site.id);
						setTestResult(`Connected. WordPress found at ${remote.remotePath}${remote.hasWpCli ? '' : ' (WP-CLI missing: database transfers will fail)'}.`);
					}),
				}, test.busy ? 'Testing…' : 'Test connection'),
				h(TextButton, {
					intent: 'destructive',
					disabled: unlink.busy || Boolean(state.activity),
					onClick: () => unlink.run(() => ipcAsync(IPC.UNLINK_SITE, { siteId: site.id, removeKey })),
				}, 'Unlink from Cloudways'),
				link.mode === 'api'
					? h(Checkbox, { label: 'Also remove the SSH key from Cloudways', checked: removeKey, onChange: (v) => setRemoveKey((p) => isChecked(v, p)) })
					: null),
			testResult ? h('div', { className: 'CWConnect_Success' }, testResult) : null,
			h(ErrorNote, { error: test.error || unlink.error }));
	}

	/**
	 * Picks a Cloudways app through the API. `onSubmit({ kind: 'api', serverId, appId })` links it (or, on the
	 * new-site page, creates a site and pulls it).
	 */
	function ApiSetup({ state, submitLabel, canSubmit = true, onSubmit, onAppSelected }) {
		const [email, setEmail] = useState('');
		const [apiKey, setApiKey] = useState('');
		const [showKey, setShowKey] = useState(false);
		const [apps, setApps] = useState(null);
		const [selected, setSelected] = useState('');
		const [progress, setProgress] = useState(null);
		const progressIdRef = React.useRef(null);
		const action = useAction();

		useEffect(() => {
			const onProgress = (_event, id, message) => {
				if (id && id === progressIdRef.current) setProgress(message);
			};
			ipcRenderer.on(IPC.LINK_PROGRESS, onProgress);
			return () => ipcRenderer.removeListener(IPC.LINK_PROGRESS, onProgress);
		}, []);

		const loadApps = useCallback(() => action.run(async () => {
			const list = await ipcAsync(IPC.LIST_APPS);
			setApps(list);
			const firstWp = list.find((a) => a.isWordPress);
			if (firstWp) setSelected(`${firstWp.serverId}:${firstWp.appId}`);
		}), [action.run]);

		useEffect(() => {
			if (state.account && apps === null) loadApps();
		}, [state.account]);

		const [serverId, appId] = selected.split(':');
		const choice = apps && apps.find((a) => a.serverId === serverId && a.appId === appId);

		useEffect(() => {
			if (choice && onAppSelected) onAppSelected(choice);
		}, [choice && choice.appId]);

		const legacyKey = apiKey.trim().length > 0 && !/^cw_/i.test(apiKey.trim());

		if (!state.account) {
			return h('div', { className: 'CWConnect_Form' },
				h('p', { className: 'CWConnect_Intro' },
					'Connect with a Cloudways access token. Local Connect then adds its own SSH key to the application for you, takes backups and purges caches through the API.'),
				h(Field, {
					label: 'Access token',
					help: h('span', null,
						'Create one under ',
						h('a', { href: '#', onClick: (e) => { e.preventDefault(); shell.openExternal(API_KEY_URL); } }, 'Account → API Integration'),
						' (it starts with cw_). Choose Full Access, or Limited Access covering servers and applications, application credentials, SSH keys and SSH access, backups, cache and operations.'),
				}, h('div', { className: 'CWConnect_SecretInput' },
					h(TextInput, { value: apiKey, onChange: setApiKey, type: showKey ? 'text' : 'password', placeholder: 'cw_…' }),
					h(TextButton, { onClick: () => setShowKey((v) => !v) }, showKey ? 'Hide' : 'Show'))),
				legacyKey
					? h(Field, { label: 'Cloudways email', help: 'This looks like a legacy API key, which also needs your account email. Cloudways retires legacy keys on October 15, 2026; prefer an access token.' },
						h(TextInput, { value: email, onChange: setEmail, placeholder: 'you@example.com' }))
					: null,
				h(ErrorNote, { error: action.error }),
				h('div', { className: 'CWConnect_Actions' },
					h(PrimaryButton, {
						disabled: action.busy || !apiKey.trim() || (legacyKey && !email.trim()),
						onClick: () => action.run(() => ipcAsync(IPC.CONNECT_ACCOUNT, { email: legacyKey ? email : null, apiKey })),
					}, action.busy ? 'Connecting…' : 'Connect account')));
		}

		const groups = (apps || []).reduce((acc, app) => {
			(acc[app.serverLabel] = acc[app.serverLabel] || []).push(app);
			return acc;
		}, {});

		return h('div', { className: 'CWConnect_Form' },
			h('div', { className: 'CWConnect_Account' },
				state.account.email
					? h('span', null, 'Connected as ', h('strong', null, state.account.email))
					: h('span', null, 'Connected with a Cloudways access token'),
				h(TextButton, { onClick: () => action.run(() => ipcAsync(IPC.DISCONNECT_ACCOUNT)) }, 'Disconnect')),
			apps === null
				? h(BusyNote, { busy: true }, 'Loading your Cloudways servers…')
				: apps.length === 0
					? h('p', null, 'No applications were found on this Cloudways account.')
					: h(Field, { label: 'Cloudways application' },
						h('select', { className: 'CWConnect_Select', value: selected, onChange: (e) => setSelected(e.target.value) },
							Object.entries(groups).map(([serverLabel, list]) => h('optgroup', { key: serverLabel, label: serverLabel },
								list.map((app) => h('option', { key: app.appId, value: `${app.serverId}:${app.appId}` },
									`${app.appLabel} — ${app.domain}${app.isWordPress ? '' : ` (${app.application})`}`)))))),
			choice && !choice.isWordPress
				? h('div', { className: 'CWConnect_Warning' }, 'This application is not a WordPress app; transfers may not work as expected.')
				: null,
			h(BusyNote, { busy: action.busy && apps !== null }, progress || 'Setting up SSH access on Cloudways (this can take a minute)…'),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'CWConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !choice || !canSubmit,
					onClick: () => {
						progressIdRef.current = `link-${Date.now()}-${Math.random().toString(36).slice(2)}`;
						setProgress(null);
						action.run(() => onSubmit({ kind: 'api', serverId, appId, progressId: progressIdRef.current }));
					},
				}, submitLabel),
				h(TextButton, { disabled: action.busy, onClick: loadApps }, 'Refresh list')));
	}

	/** SFTP/SSH credentials form. `onSubmit({ kind: 'manual', host, port, … })`. */
	function ManualSetup({ state, submitLabel, canSubmit = true, onSubmit }) {
		const [form, setForm] = useState({ host: '', port: '22', username: '', authType: state.passwordAuthSupported ? 'password' : 'key', password: '', remotePath: '', domain: '' });
		const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
		const action = useAction();
		const complete = form.host && form.username && (form.authType === 'key' || form.password);

		return h('div', { className: 'CWConnect_Form' },
			h('p', { className: 'CWConnect_Intro' },
				'Use the Application Credentials from Cloudways (Applications → your app → Access Details). SSH access must be enabled for the application.'),
			h('div', { className: 'CWConnect_Row' },
				h(Field, { label: 'Host (server public IP)' }, h(TextInput, { value: form.host, onChange: set('host'), placeholder: '203.0.113.10' })),
				h(Field, { label: 'Port' }, h(TextInput, { value: form.port, onChange: set('port') }))),
			h(Field, { label: 'Username' }, h(TextInput, { value: form.username, onChange: set('username') })),
			h('div', { className: 'CWConnect_AuthChoice' },
				state.passwordAuthSupported
					? h('label', null, h('input', { type: 'radio', checked: form.authType === 'password', onChange: () => set('authType')('password') }), ' Password')
					: null,
				h('label', null, h('input', { type: 'radio', checked: form.authType === 'key', onChange: () => set('authType')('key') }), ' SSH key')),
			form.authType === 'password'
				? h(Field, { label: 'Password', help: 'Stored encrypted with your system keychain.' }, h(TextInput, { value: form.password, onChange: set('password'), type: 'password' }))
				: h(Field, { label: 'Public key', help: 'Add this key under Application Credentials → SSH Keys in Cloudways first.' }, h(PublicKeyBox)),
			h(Field, { label: 'Remote path (optional)', help: 'Defaults to the public_html folder that holds wp-config.php.' },
				h(TextInput, { value: form.remotePath, onChange: set('remotePath'), placeholder: 'auto-detect' })),
			h(Field, { label: 'Site domain (optional)', help: 'Only used if the Cloudways database has no home URL yet.' },
				h(TextInput, { value: form.domain, onChange: set('domain'), placeholder: 'example.com' })),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'CWConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !complete || !canSubmit,
					onClick: () => action.run(() => onSubmit({ kind: 'manual', ...form })),
				}, action.busy ? 'Connecting…' : submitLabel)));
	}

	function SetupView(props) {
		const [mode, setMode] = useState('api');
		return h('div', null,
			h(Tabs, { value: mode, onChange: setMode, tabs: [['api', 'Cloudways API (recommended)'], ['manual', 'SFTP / SSH credentials']] }),
			mode === 'api' ? h(ApiSetup, props) : h(ManualSetup, props));
	}

	// ---------------------------------------------------------------- updates

	/** Announces a newer release and installs it through Local's add-on installer. */
	function UpdateNotice({ update }) {
		const action = useAction();
		if (!update) return null;
		const error = action.error || update.error;
		if (update.installed) {
			return h('div', { className: 'CWConnect_Update', role: 'status' },
				h('span', null, `${update.name} ${update.latest} is installed. Restart Local to start using it.`),
				h('div', { className: 'CWConnect_UpdateActions' },
					h(PrimaryButton, { onClick: () => action.run(() => ipcAsync(IPC.RESTART_LOCAL)) }, 'Restart Local')));
		}
		if (!update.latest) return error && !update.checking ? h(ErrorNote, { error }) : null;
		const busy = action.busy || update.installing;
		return h('div', { className: 'CWConnect_Update', role: 'status' },
			h('span', null, `${update.name} ${update.latest} is available. You have ${update.current}.`),
			update.devInstall
				? h('span', { className: 'CWConnect_Help' }, 'This copy is linked from a development folder, so update that folder instead.')
				: null,
			h('div', { className: 'CWConnect_UpdateActions' },
				update.devInstall
					? null
					: h(PrimaryButton, { disabled: busy, onClick: () => action.run(() => ipcAsync(IPC.INSTALL_UPDATE)) }, busy ? 'Updating…' : 'Update'),
				update.releaseUrl ? h(TextButton, { onClick: () => shell.openExternal(update.releaseUrl) }, 'What\'s new') : null),
			error ? h(ErrorNote, { error }) : null);
	}

	/** Version line with a manual "Check for updates". */
	function VersionFooter({ update }) {
		const [checked, setChecked] = useState(false);
		if (!update) return null;
		const check = () => ipcAsync(IPC.CHECK_UPDATE).then(() => setChecked(true)).catch(() => {});
		const upToDate = checked && !update.checking && !update.latest && !update.error;
		return h('div', { className: 'CWConnect_Version' },
			h('span', null, `${update.name} ${update.current}`),
			update.checking
				? h('span', null, 'Checking for updates…')
				: upToDate
					? h('span', null, 'You have the latest version.')
					: update.latest ? null : h(TextButton, { onClick: check }, 'Check for updates'));
	}

	const linkSite = (siteId) => (source) => (source.kind === 'api'
		? ipcAsync(IPC.LINK_API_APP, { siteId, serverId: source.serverId, appId: source.appId, progressId: source.progressId })
		: ipcAsync(IPC.LINK_MANUAL, { siteId, ...source }));

	function CloudwaysPanel({ site }) {
		const [state] = useCloudwaysState(site && site.id);
		if (!site) return null;
		return h('div', { className: 'CWConnect' },
			h(Title, { size: 'm', className: 'CWConnect_Title' }, 'Cloudways'),
			state ? h(UpdateNotice, { update: state.update }) : null,
			!state
				? h(BusyNote, { busy: true }, 'Loading…')
				: state.link
					? h(LinkedView, { site, state })
					: h(SetupView, { state, submitLabel: `Link ${site.name}`, onSubmit: linkSite(site.id) }),
			state ? h(VersionFooter, { update: state.update }) : null);
	}

	// ---------------------------------------------------------------- compare & selective sync

	const formatSize = (bytes) => {
		if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	};
	const formatTime = (sec) => (sec ? new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
	const describeSide = (side) => (side ? [formatSize(side.size), formatTime(side.mtime)].filter(Boolean).join(' · ') : '');

	const GROUPS = [
		['changed', 'Different on each side'],
		['local-only', 'Only in Local'],
		['remote-only', 'Only on Cloudways'],
	];
	const NEWER = { local: 'Newer in Local', remote: 'Newer on Cloudways', same: 'Same date' };
	const ROW_LIMIT = 200;

	function CompareRow({ entry, checked, onToggle }) {
		return h('label', { className: 'CWConnect_FileRow' },
			h('input', { type: 'checkbox', checked, onChange: onToggle }),
			h('span', { className: 'CWConnect_FilePath', title: entry.path }, entry.path, entry.type === 'symlink' ? ' (link)' : ''),
			entry.status === 'changed'
				? h('span', { className: 'CWConnect_FileMeta' },
					h('span', null, `Local: ${describeSide(entry.local)}`),
					h('span', null, `Cloudways: ${describeSide(entry.remote)}`),
					entry.newer ? h('span', { className: `CWConnect_Badge CWConnect_Badge--${entry.newer}` }, NEWER[entry.newer]) : null)
				: h('span', { className: 'CWConnect_FileMeta' }, describeSide(entry.status === 'local-only' ? entry.local : entry.remote)));
	}

	/**
	 * MagicSync-style comparison: lists files that differ between Local and Cloudways, lets you tick files, and
	 * pushes or pulls only those. A ticked file missing on the sending side is deleted on the receiving side.
	 */
	function CompareView({ site, activity }) {
		const [result, setResult] = useState(null);
		const [checksum, setChecksum] = useState(false);
		const [filter, setFilter] = useState('');
		const [selected, setSelected] = useState(() => new Set());
		const compareAction = useAction();
		const syncAction = useAction();

		const compare = () => compareAction.run(async () => {
			const res = await ipcAsync(IPC.COMPARE, { siteId: site.id, checksum });
			setResult(res);
			setSelected(new Set());
		});

		const entries = result ? result.entries : [];
		const needle = filter.trim().toLowerCase();
		const visible = needle ? entries.filter((e) => e.path.toLowerCase().includes(needle)) : entries;
		const toggle = (p) => setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(p)) next.delete(p);
			else next.add(p);
			return next;
		});
		const setGroup = (list, on) => setSelected((prev) => {
			const next = new Set(prev);
			list.forEach((e) => (on ? next.add(e.path) : next.delete(e.path)));
			return next;
		});

		const chosen = entries.filter((e) => selected.has(e.path));
		const count = (statuses) => chosen.filter((e) => statuses.includes(e.status)).length;

		const sync = async (direction) => {
			const send = direction === 'push' ? count(['changed', 'local-only']) : count(['changed', 'remote-only']);
			const remove = direction === 'push' ? count(['remote-only']) : count(['local-only']);
			const there = direction === 'push' ? 'on Cloudways' : 'in Local';
			await confirm({
				title: `${direction === 'push' ? 'Push' : 'Pull'} ${chosen.length} selected file${chosen.length === 1 ? '' : 's'}?`,
				message: h('div', null,
					send ? h('p', null, `${send} file${send === 1 ? '' : 's'} will be ${direction === 'push' ? 'uploaded to Cloudways' : 'downloaded to Local'}, replacing the copy ${there}.`) : null,
					remove ? h('p', null, `${remove} file${remove === 1 ? '' : 's'} that only exist${remove === 1 ? 's' : ''} ${there} will be deleted ${there}.`) : null,
					h('p', null, 'The database is not changed.')),
				buttonText: direction === 'push' ? 'Push' : 'Pull',
			});
			await syncAction.run(async () => {
				const fileList = chosen.map((e) => e.path);
				const options = direction === 'push' ? { fileList, backup: false, purgeCache: true } : { fileList };
				await ipcAsync(direction === 'push' ? IPC.PUSH : IPC.PULL, { siteId: site.id, options });
				await compare();
			});
		};

		const busy = compareAction.busy || syncAction.busy || Boolean(activity);

		return h('div', { className: 'CWConnect_Compare' },
			h('p', { className: 'CWConnect_Intro' },
				'See which files differ between Local and Cloudways, then push or pull only the ones you pick. Nothing changes until you choose.'),
			h('div', { className: 'CWConnect_Actions CWConnect_Actions--Top' },
				h(PrimaryButton, { onClick: compare, disabled: busy }, compareAction.busy || activity === 'compare' ? 'Comparing…' : result ? 'Compare again' : 'Compare with Cloudways'),
				h(Checkbox, { label: 'Compare file contents (slower)', checked: checksum, onChange: (v) => setChecksum((p) => isChecked(v, p)) })),
			h(ErrorNote, { error: compareAction.error || syncAction.error }),
			result
				? h('div', null,
					h('p', { className: 'CWConnect_Summary', role: 'status' },
						entries.length === 0
							? 'Local and Cloudways have the same files.'
							: GROUPS.map(([key, label]) => `${entries.filter((e) => e.status === key).length} ${label.toLowerCase()}`).join(' · ')),
					entries.length
						? h(React.Fragment, null,
							h('div', { className: 'CWConnect_Filter' },
								h(TextInput, { value: filter, onChange: setFilter, placeholder: 'Filter by path, e.g. wp-content/themes' })),
							GROUPS.map(([key, label]) => {
								const list = visible.filter((e) => e.status === key);
								if (!list.length) return null;
								const allOn = list.every((e) => selected.has(e.path));
								return h('section', { key, className: 'CWConnect_Group' },
									h('label', { className: 'CWConnect_GroupHeader' },
										h('input', { type: 'checkbox', checked: allOn, onChange: () => setGroup(list, !allOn) }),
										h('span', null, `${label} (${list.length})`)),
									list.slice(0, ROW_LIMIT).map((entry) => h(CompareRow, {
										key: entry.path,
										entry,
										checked: selected.has(entry.path),
										onToggle: () => toggle(entry.path),
									})),
									list.length > ROW_LIMIT
										? h('p', { className: 'CWConnect_Help' }, `${list.length - ROW_LIMIT} more not shown. Narrow the list with the filter; the group checkbox still selects all ${list.length}.`)
										: null);
							}),
							h('div', { className: 'CWConnect_Actions CWConnect_SyncBar' },
								h('span', null, `${chosen.length} selected`),
								h(Button, { disabled: busy || !chosen.length, onClick: () => sync('pull') }, syncAction.busy && activity === 'pull' ? 'Pulling…' : 'Pull selected'),
								h(PrimaryButton, { disabled: busy || !chosen.length, onClick: () => sync('push') }, syncAction.busy && activity === 'push' ? 'Pushing…' : 'Push selected')))
						: null)
				: null);
	}

	// ---------------------------------------------------------------- pull to a new site

	/** Page behind Local's "Create a site → Pull from Cloudways" option. */
	function NewSitePage({ history }) {
		const [state] = useCloudwaysState(null);
		const [siteName, setSiteName] = useState('');
		const [nameTouched, setNameTouched] = useState(false);
		const [location, setLocation] = useState(null);
		const [started, setStarted] = useState(null);

		useEffect(() => {
			const name = siteName.trim();
			if (!name) {
				setLocation(null);
				return undefined;
			}
			const timer = setTimeout(() => {
				ipcAsync(IPC.NEW_SITE_LOCATION, name).then(setLocation).catch(() => setLocation(null));
			}, 200);
			return () => clearTimeout(timer);
		}, [siteName]);

		const onAppSelected = (choice) => {
			if (!nameTouched) setSiteName(choice.appLabel);
		};

		const submit = async (source) => {
			const res = await ipcAsync(IPC.PULL_NEW_SITE, { siteName: siteName.trim(), source });
			setStarted(res);
		};

		return h('div', { className: 'CWConnect CWConnect_NewSite' },
			h('div', { className: 'CWConnect_NewSiteHeader' },
				h(TextButton, { onClick: () => history.push('/main/create-site') }, '← Back'),
				h(Title, { size: 'l', className: 'CWConnect_Title' }, 'Pull from Cloudways')),
			h('p', { className: 'CWConnect_Intro' },
				'Creates a new Local site, then pulls the files and database of a Cloudways WordPress app into it. Your Cloudways site is not changed.'),
			state ? h(UpdateNotice, { update: state.update }) : null,
			started
				? h('div', { className: 'CWConnect_Success', role: 'status' },
					`Creating ${siteName.trim()} at ${started.domain}. Progress continues in the site's overlay.`)
				: h(React.Fragment, null,
					h(Field, {
						label: 'Local site name',
						help: location ? `${location.domain} · ${location.sitePath}` : 'Defaults to the Cloudways application name.',
					}, h(TextInput, { value: siteName, onChange: (v) => { setNameTouched(true); setSiteName(v); }, placeholder: 'My Cloudways site' })),
					!state
						? h(BusyNote, { busy: true }, 'Loading…')
						: h(SetupView, {
							state,
							submitLabel: 'Create site & pull',
							canSubmit: Boolean(siteName.trim()),
							onSubmit: submit,
							onAppSelected,
						})));
	}

	function HeaderButtons({ site }) {
		const [state] = useCloudwaysState(site && site.id);
		const [open, setOpen] = useState(null);
		if (!site || !state || !state.link) return null;
		const { link, activity } = state;
		const button = (direction) => h(Button, {
			key: direction,
			className: 'CWConnect_HeaderButton',
			disabled: Boolean(activity),
			onClick: () => setOpen(direction),
			title: `${DIRECTIONS[direction].button} (${link.domain || link.host})`,
		}, activity === direction ? `${DIRECTIONS[direction].gerund}…` : DIRECTIONS[direction].verb);

		return h('span', { className: 'CWConnect_HeaderButtons' },
			h('span', { className: 'CWConnect_HeaderLabel' }, 'Cloudways'),
			button('pull'),
			button('push'),
			open
				? h(FlyModal, { isOpen: true, contentLabel: DIRECTIONS[open].button, onRequestClose: () => setOpen(null) },
					h('div', { className: 'CWConnect CWConnect_Modal' },
						h(Title, { size: 'l', className: 'CWConnect_Title' }, DIRECTIONS[open].button),
						h('p', { className: 'CWConnect_Intro' }, open === 'push'
							? `${site.name} → ${link.appLabel ? `${link.appLabel} · ` : ''}${link.domain || link.host}`
							: `${link.appLabel ? `${link.appLabel} · ` : ''}${link.domain || link.host} → ${site.name}`),
						h(TransferForm, { direction: open, site, link, activity, inModal: true, onStarted: () => setOpen(null) })))
				: null);
	}

	return { CloudwaysPanel, HeaderButtons, TransferForm, CompareView, NewSitePage };
};
