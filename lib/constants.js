'use strict';

/** IPC channels shared by the main and renderer halves of the add-on. */
const IPC = {
	GET_STATE: 'cloudwaysConnect:getState',
	CONNECT_ACCOUNT: 'cloudwaysConnect:connectAccount',
	DISCONNECT_ACCOUNT: 'cloudwaysConnect:disconnectAccount',
	LIST_APPS: 'cloudwaysConnect:listApps',
	LINK_API_APP: 'cloudwaysConnect:linkApiApp',
	LINK_MANUAL: 'cloudwaysConnect:linkManual',
	UNLINK_SITE: 'cloudwaysConnect:unlinkSite',
	TEST_CONNECTION: 'cloudwaysConnect:testConnection',
	PUSH: 'cloudwaysConnect:push',
	PULL: 'cloudwaysConnect:pull',
	COMPARE: 'cloudwaysConnect:compare',
	NEW_SITE_LOCATION: 'cloudwaysConnect:newSiteLocation',
	PULL_NEW_SITE: 'cloudwaysConnect:pullNewSite',
	/** main -> renderer: (progressId, message) while linking. */
	LINK_PROGRESS: 'cloudwaysConnect:linkProgress',
	GET_PUBLIC_KEY: 'cloudwaysConnect:getPublicKey',
	CHECK_UPDATE: 'cloudwaysConnect:checkUpdate',
	INSTALL_UPDATE: 'cloudwaysConnect:installUpdate',
	RESTART_LOCAL: 'cloudwaysConnect:restartLocal',
	/** main -> renderer broadcast whenever stored state changes. */
	STATE_CHANGED: 'cloudwaysConnect:stateChanged',
};

const CLOUDWAYS_API_BASES = [
	'https://api.cloudways.com/api/v2',
	'https://api.cloudways.com/api/v1',
];

/** Cloudways application types that are WordPress installs. */
const WORDPRESS_APP_TYPES = ['wordpress', 'wordpressmu', 'woocommerce', 'wordpressdefault'];

/**
 * Paths never synced in either direction. rsync --exclude also protects them from --delete, so each side keeps
 * its own environment files: Cloudways keeps wp-config.php (its DB credentials) and .htaccess (Apache stack), and
 * Local never receives Cloudways' Redis/Varnish/Breeze drop-ins, which would break the local site.
 */
const SYNC_EXCLUDES = [
	// Environment-specific config
	'/wp-config.php',
	'/.htaccess',
	'/.user.ini',
	// Cloudways-managed caching drop-ins and cache output
	'wp-content/object-cache.php',
	'wp-content/advanced-cache.php',
	'wp-content/cache/',
	'wp-content/breeze-config/',
	// VCS and tooling
	'.git/',
	'.svn/',
	'node_modules/.bin/',
	'vendor/bin/',
	'.DS_Store',
	// Stray dumps in the webroot and Local helpers
	'/*.sql',
	'/*.sql.gz',
	'wp-content/mysql.sql',
	'local-phpinfo.php',
	'local-xdebuginfo.php',
	'wp-content/mu-plugins/local-by-flywheel-demo-urls.php',
	'wp-content/mu-plugins/local-by-flywheel-live-link-helper.php',
	// Ignore files for other hosts and for this add-on
	'.wpe-push-ignore',
	'.wpe-pull-ignore',
	'.cloudways-push-ignore',
	'.cloudways-pull-ignore',
	'.bluehost-push-ignore',
	'.bluehost-pull-ignore',
	'.kinsta-push-ignore',
	'.kinsta-pull-ignore',
];

/** Optional per-site ignore files in the site's webroot, same idea as .wpe-push-ignore / .wpe-pull-ignore. */
const IGNORE_FILES = {
	push: '.cloudways-push-ignore',
	pull: '.cloudways-pull-ignore',
};

module.exports = {
	IPC,
	CLOUDWAYS_API_BASES,
	WORDPRESS_APP_TYPES,
	SYNC_EXCLUDES,
	IGNORE_FILES,
};
