#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer, attachSocketRelay } from './server/index.js';
import { startStreamRecorder } from './server/recorder.js';
import { startStreamReplay } from './server/replay.js';
import { runDashboard, createStatusFromFields } from './dashboard/index.js';

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

function printHelp() {
	console.log('Usage: commonground serve [--space <id>] [--config <path>] [--http-port <port>] [--https-port <port>] [--sync|--no-sync] [--open] [--save [name]] [--replay <files>]');
	console.log('');
	console.log('Serves the current directory plus the CommonGround anchor/mesh API, the');
	console.log('cg.sync/cg.status socket channels, and (when configured) the dashboard.');
	console.log('Settings come from commonground.config.js in the current directory; all');
	console.log('optional. Without any config the current directory is served at / with the');
	console.log('API and socket channels on and no dashboard.');
	console.log('');
	console.log('--save [name]    record the headset pose/status stream to');
	console.log('                 data/recordings/<name>.ndjson (default: timestamped name)');
	console.log('--replay <files> comma-separated recordings replayed as headsets 1..N');
	console.log('                 (names resolve against data/recordings/, .ndjson optional)');
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
// enteredImmersion is framework-stamped (XR session start), so it is part of
// every project's status shape; projects declare their own fields on top.
const dashboardSection = config.dashboard && typeof config.dashboard === 'object' ? config.dashboard : {};
const statusFields = {
	enteredImmersion: 'boolean',
	...(dashboardSection.statusFields && typeof dashboardSection.statusFields === 'object' ? dashboardSection.statusFields : {}),
};
const headsetDefaultStatus = typeof dashboardSection.createDefaultStatus === 'function'
	? dashboardSection.createDefaultStatus()
	: createStatusFromFields(statusFields);

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
	// The helper (quicklaunch) page is on by default; helperPage: false in
	// the project config disables it. Also lets GET api/client-config
	// advertise the helper page URL (desktop HUD hint); null when disabled.
	helperPage: (() => {
		const hp = config.dashboard && typeof config.dashboard === 'object' ? config.dashboard.helperPage : undefined;
		if (hp === false || hp === null) return null;
		return { port: hp && hp !== true ? hp.port : undefined };
	})(),
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
		// The app itself (/commonground/src, /commonground/node_modules and
		// /commonground/assets are always-on mounts inside createServer).
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
		// Merged status shape: framework-stamped enteredImmersion plus the
		// project's own statusFields (explicit createDefaultStatus /
		// summarizeSession hooks in dashboardConfig still win downstream).
		statusFields,
		processes,
		handleSignals: false,
	});
}

// --save [name] (or record: true|'name' in config): record the headset
// pose/status stream to <dataDir>/recordings/<name>.ndjson so the session
// can be replayed later with --replay. The recorder is created before the
// relay — its taps are relay options.
const recordOption = args.save !== undefined ? args.save : config.record;
let recorder = null;
if (recordOption) {
	const recordingsDir = path.join(dataDir, 'recordings');
	const name = recordOption === true || recordOption === '1'
		? `recording-${new Date().toISOString().replace(/[:.]/g, '-')}`
		: String(recordOption);
	const fileName = name.endsWith('.ndjson') ? name : `${name}.ndjson`;
	recorder = startStreamRecorder({ filePath: path.join(recordingsDir, fileName), logLine });
}

relay = attachSocketRelay(
	[
		{ server: server.httpServer, label: 'http' },
		...(server.httpsServer ? [{ server: server.httpsServer, label: 'https' }] : []),
	],
	{
		sync: config.sync !== false,
		status: config.status !== false,
		streamDefault: config.streamDefault !== false,
		onLog: dashboard ? (line) => dashboard.writeLogLine(line) : undefined,
		...(recorder ? { onPose: recorder.onPose, onStatus: recorder.onStatus } : {}),
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

// --open flag (or openBrowser: true in config): launch the desktop view in
// the default browser once the HTTP server is up. Plain HTTP — a local
// spectator page shouldn't hit the self-signed certificate prompt.
if (args.open === true || args.open === '1' || args.open === 'true' || config.openBrowser === true) {
	server.httpServer.once('listening', () => {
		const url = `http://localhost:${httpPort}/`;
		const opener = process.platform === 'darwin' ? 'open'
			: process.platform === 'win32' ? 'cmd' : 'xdg-open';
		const openerArgs = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
		spawn(opener, openerArgs, { detached: true, stdio: 'ignore' }).unref();
		logLine(`Desktop view opened at ${url}`);
	});
}

server.listen();
logLine(`Serving ${cwd} (space: ${server.spaceId})`);

// --replay <files> (or replay: [...] in config): replay recordings as
// simulated headsets 1..N. Names resolve against <dataDir>/recordings/
// when not found as given; the .ndjson extension is optional.
const replayOption = args.replay !== undefined ? args.replay : config.replay;
let replay = null;
if (replayOption && replayOption !== true) {
	const recordingsDir = path.join(dataDir, 'recordings');
	const names = Array.isArray(replayOption) ? replayOption : String(replayOption).split(',');
	const files = names
		.map((name) => String(name).trim())
		.filter(Boolean)
		.map((name) => {
			const candidates = [
				path.resolve(cwd, name),
				path.join(recordingsDir, name),
				path.join(recordingsDir, `${name}.ndjson`),
			];
			const found = candidates.find((candidate) => fs.existsSync(candidate));
			if (!found) logLine(`[replay] recording not found: ${name}`);
			return found;
		})
		.filter(Boolean);
	if (files.length > 0) {
		replay = startStreamReplay({ relay, files, logLine });
	}
}

let shuttingDown = false;
function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	replay?.stop();
	recorder?.close();
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
