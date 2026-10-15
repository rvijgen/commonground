#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, attachSocketRelay } from './server/index.js';
import { runDashboard, createStatusFromFields } from './dashboard/index.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) {
			args._.push(arg);
			continue;
		}
		const eq = arg.indexOf('=');
		if (eq !== -1) {
			args[arg.slice(2, eq)] = arg.slice(eq + 1);
		} else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
			args[arg.slice(2)] = argv[++i];
		} else {
			args[arg.slice(2)] = true;
		}
	}
	return args;
}

async function loadConfig(cwd, explicitPath) {
	const configPath = explicitPath
		? path.resolve(cwd, String(explicitPath))
		: path.join(cwd, 'commonground.config.js');
	if (!fs.existsSync(configPath)) {
		return {};
	}
	const configModule = await import(pathToFileURL(configPath).href);
	return configModule.default ?? configModule ?? {};
}

// Resolve the node_modules root that provides the client library's three/
// ratk/troika-three-text, robust to npm hoisting in consuming workspaces.
function resolveVendorNodeModulesDir() {
	const packageJsonPath = path.join(PACKAGE_ROOT, 'package.json');
	const commongroundRequire = createRequire(packageJsonPath);
	for (const packageName of ['three', 'ratk', 'troika-three-text']) {
		try {
			// <node_modules>/<package>/package.json → <node_modules>
			return path.dirname(path.dirname(commongroundRequire.resolve(`${packageName}/package.json`)));
		} catch (_error) {
			// try the next package
		}
	}
	return path.join(PACKAGE_ROOT, 'node_modules');
}

function printHelp() {
	console.log('Usage: commonground serve [--space <id>] [--config <path>] [--http-port <port>] [--https-port <port>] [--sync|--no-sync]');
	console.log('');
	console.log('Serves the current directory plus the CommonGround anchor/mesh API, the');
	console.log('cg.sync/cg.status socket channels, and (when configured) the dashboard.');
	console.log('Settings come from commonground.config.js in the current directory; all');
	console.log('optional. Without any config the current directory is served at / with the');
	console.log('API and socket channels on and no dashboard.');
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'serve';

if (args.help || command === 'help') {
	printHelp();
	process.exit(0);
}

if (command !== 'serve') {
	console.error(`Unknown command: ${command}`);
	printHelp();
	process.exit(1);
}

const cwd = process.cwd();
const config = await loadConfig(cwd, args.config);

// Startup space selection: --space flag > project config > 'default'.
// This is only the initial AnchorStore target — the desktop HUD's Spaces
// tab can switch the active space at runtime.
const spaceId = (args.space && String(args.space)) || config.space || 'default';
const httpPort = args['http-port'] ? Number(args['http-port']) : (Number(config.httpPort) || 3001);
const httpsPort = args['https-port'] ? Number(args['https-port']) : (Number(config.httpsPort) || 3002);
const dataDir = config.dataDir ? path.resolve(cwd, config.dataDir) : path.join(cwd, 'data');
const certDir = config.certDir ? path.resolve(cwd, config.certDir) : path.join(cwd, '.certs');

// Server-provided default for client sync participation: --sync / --no-sync
// flags win over commonground.config.js, default true.
const syncDefault = args['no-sync'] ? false
	: (args.sync === true || args.sync === '1' || args.sync === 'true') ? true
	: config.syncDefault !== false;

// One session log path shared by the dashboard (writer) and the server's
// log viewer/API (reader).
const sessionLogFile = config.dashboard && typeof config.dashboard.sessionLogFile === 'string'
	? path.resolve(cwd, config.dashboard.sessionLogFile)
	: path.join(dataDir, 'logs', 'headset-sessions.ndjson');

const vendorNodeModulesDir = resolveVendorNodeModulesDir();

let dashboard = null;
// Informational lines go through the dashboard's log sink once it exists, so
// nothing writes raw to stdout while its alt screen is active. Lines emitted
// before the dashboard is created (and all lines when no dashboard is
// configured) print to stdout exactly as before.
const logLine = (line) => {
	if (dashboard) {
		dashboard.writeLogLine(line);
		return;
	}
	console.log(line);
};

const routes = Array.isArray(config.routes) ? config.routes : [];
const staticDirs = Array.isArray(config.staticDirs) ? config.staticDirs : [];

// The relay is attached after createServer; server endpoints that need
// presence/status/broadcast reach it through this lazy accessor.
let relay = null;

// Default status used when rendering dashboard columns for the headsets API:
// the project's hook when provided, else derived from its statusFields —
// mirroring the CLI dashboard, which always renders from a full status.
const dashboardSection = config.dashboard && typeof config.dashboard === 'object' ? config.dashboard : {};
const headsetDefaultStatus = typeof dashboardSection.createDefaultStatus === 'function'
	? dashboardSection.createDefaultStatus()
	: (dashboardSection.statusFields ? createStatusFromFields(dashboardSection.statusFields) : {});

const server = await createServer({
	spaceId,
	dataDir,
	certDir,
	httpPort,
	httpsPort,
	syncDefault,
	serveExample: config.serveExample || false,
	onLog: logLine,
	headsets: config.dashboard && Array.isArray(config.dashboard.headsets) ? config.dashboard.headsets : [],
	headsetColumns: Array.isArray(dashboardSection.columns) ? dashboardSection.columns : [],
	headsetDefaultStatus,
	getRelayRuntime: () => relay,
	sessionLogFile,
	sessionLogTitle: config.sessionLogTitle || 'Session Logs',
	extraRoutes: (app, context) => {
		for (const route of routes) {
			if (!route || !route.path || !route.file) continue;
			app.get(route.path, (req, res) => {
				res.sendFile(path.resolve(cwd, route.file));
			});
		}
		if (typeof config.extraRoutes === 'function') {
			config.extraRoutes(app, context);
		}
	},
	apps: [
		// No-build import-map mounts for the commonground client library.
		{ path: '/commonground/src', staticDir: path.join(PACKAGE_ROOT, 'src') },
		{ path: '/commonground/node_modules', staticDir: vendorNodeModulesDir },
		// Bundled assets (desktop reference figure, …).
		{ path: '/commonground/assets', staticDir: path.join(PACKAGE_ROOT, 'assets') },
		// The app itself.
		{ path: '/', staticDir: cwd },
		...staticDirs
			.filter((entry) => entry && entry.path && (entry.staticDir || entry.dir))
			.map((entry) => ({
				path: entry.path,
				staticDir: path.resolve(cwd, entry.staticDir || entry.dir),
				indexFile: entry.indexFile,
			})),
	],
});

if (config.dashboard && config.dashboard.enabled !== false) {
	const { enabled: _enabled, processes = [], sessionLogFile: _ignoredSessionLogFile, ...dashboardConfig } = config.dashboard;
	dashboard = runDashboard({
		sessionLogFile,
		// Injected app knowledge the dashboard cannot see on its own: the
		// app's HTTPS port (default helper-page links) and the top-level
		// project routes (labeled ones become helper-page quick links).
		// A project's dashboard section may still override either.
		appHttpsPort: httpsPort,
		appRoutes: routes,
		...dashboardConfig,
		processes,
		handleSignals: false,
	});
}

relay = attachSocketRelay(
	[
		{ server: server.httpServer, label: 'http' },
		...(server.httpsServer ? [{ server: server.httpsServer, label: 'https' }] : []),
	],
	{
		sync: config.sync !== false,
		status: config.status !== false,
		onLog: dashboard ? (line) => dashboard.writeLogLine(line) : undefined,
		// Same immersion predicate as the CLI dashboard, so relay-tracked
		// immersion times (api/headsets, desktop HUD) match the TUI.
		...(typeof dashboardSection.hasEnteredImmersion === 'function'
			? { hasEnteredImmersion: dashboardSection.hasEnteredImmersion }
			: {}),
	},
);

if (typeof config.setupRelay === 'function') {
	config.setupRelay(relay);
}

server.listen();
logLine(`Serving ${cwd} (space: ${server.spaceId})`);
logLine(`Client library mounts: /commonground/src, /commonground/node_modules (${vendorNodeModulesDir})`);

let shuttingDown = false;
function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const ioServer of relay.ioServers) {
		ioServer.close();
	}
	server.httpServer.close();
	server.httpsServer?.close();
	dashboard?.shutdown('SIGTERM');
	process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, shutdown);
}
