'use strict';

const path = require('path');

const createComponents = require('./renderer/components');

const NEW_SITE_ROUTE = '/main/cloudways-pull';

module.exports = function CloudwaysConnectRenderer(context) {
	const { React, ReactRouter, hooks } = context;
	const h = React.createElement;
	const { CloudwaysPanel, HeaderButtons, NewSitePage } = createComponents(context);

	hooks.addContent('stylesheets', () => h('link', {
		key: 'cloudways-connect-styles',
		rel: 'stylesheet',
		href: path.join(__dirname, 'renderer', 'styles.css'),
	}));

	// A "Cloudways" entry under the site's Tools tab: account connection, linking, and push/pull options.
	hooks.addFilter('siteInfoToolsItem', (items, { routeChildrenProps } = {}) => [
		...items,
		{
			path: '/cloudways-connect',
			menuItem: 'Cloudways',
			render: () => h(CloudwaysPanel, {
				site: routeChildrenProps && routeChildrenProps.site,
				siteStatus: routeChildrenProps && routeChildrenProps.siteStatus,
			}),
		},
	]);

	// "Cloudways: Pull / Push" buttons in the site header, next to Local Connect's own push/pull buttons.
	hooks.addContent('SiteInfo_Top_TopRight', (site, siteStatus) => h(HeaderButtons, {
		key: 'cloudways-connect-buttons',
		site,
		siteStatus,
	}));

	// "Pull from Cloudways" in Local's Create a site wizard. The option key is the route Continue navigates to.
	hooks.addFilter('CreateSite:RadioOptions', (options) => ({
		...options,
		[NEW_SITE_ROUTE.replace(/^\/main\//, '')]: {
			label: 'Pull from Cloudways',
			content: 'Create a new Local site from a Cloudways WordPress app, files and database.',
		},
	}));

	hooks.addContent('routes[main]', () => h(ReactRouter.Route, {
		key: 'cloudways-connect-new-site',
		path: NEW_SITE_ROUTE,
		render: ({ history }) => h(NewSitePage, { history }),
	}));
};
