import express from 'express';
import cors from 'cors';
import compression from 'compression';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import { format } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { AnchorStore } from './AnchorStore.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The node_modules root that provides three/ratk for no-build import maps.
// Resolved through the package's own dependencies so it keeps working when
// commonground is installed as a dependency (hoisted or nested).
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

const TRANSIENT_LOG_SECONDS = Number.parseFloat(process.env.COMMONGROUND_LOG_CLEAR_SECONDS || '0');
const TRANSIENT_LOG_FORCE = process.env.COMMONGROUND_LOG_CLEAR_FORCE === '1';

let transientLogClearTimer = null;
let transientConsoleClearInstalled = false;

function canUseTransientClear() {
	return TRANSIENT_LOG_SECONDS > 0 && (TRANSIENT_LOG_FORCE || process.stdout.isTTY);
}

function scheduleTransientLogClear() {
	if (!canUseTransientClear()) return;
	if (transientLogClearTimer) {
		clearTimeout(transientLogClearTimer);
	}
	transientLogClearTimer = setTimeout(() => {
		process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
		transientLogClearTimer = null;
	}, TRANSIENT_LOG_SECONDS * 1000);
}

function installTransientConsoleClear() {
	if (transientConsoleClearInstalled || !canUseTransientClear()) return;
	transientConsoleClearInstalled = true;
	for (const method of ['log', 'warn', 'error']) {
		const original = console[method].bind(console);
		console[method] = (...args) => {
			original(...args);
			scheduleTransientLogClear();
		};
	}
}

function getLanIpv4Addresses() {
	const interfaces = os.networkInterfaces();
	const addresses = [];

	for (const interfaceName of Object.keys(interfaces || {})) {
		const networkInterfaces = interfaces[interfaceName] || [];
		for (const networkInterface of networkInterfaces) {
			if (networkInterface.family !== 'IPv4' || networkInterface.internal) continue;
			addresses.push(networkInterface.address);
		}
	}

	return [...new Set(addresses)];
}

function loadOrCreateHttpsCertificate(certDir) {
	const keyPath = path.join(certDir, 'dev-server.key.pem');
	const certPath = path.join(certDir, 'dev-server.cert.pem');
	const hasExistingCert = fsSync.existsSync(keyPath) && fsSync.existsSync(certPath);
	if (hasExistingCert) {
		return {
			key: fsSync.readFileSync(keyPath, 'utf8'),
			cert: fsSync.readFileSync(certPath, 'utf8'),
			source: 'disk',
			keyPath,
			certPath,
		};
	}

	const altNames = [
		{ type: 2, value: 'localhost' },
		{ type: 7, ip: '127.0.0.1' },
	];
	for (const ip of getLanIpv4Addresses()) {
		altNames.push({ type: 7, ip });
	}

	return import('selfsigned').then(({ default: selfsigned }) => {
		const pems = selfsigned.generate(
			[{ name: 'commonName', value: 'localhost' }],
			{
				days: 365,
				keySize: 2048,
				algorithm: 'sha256',
				extensions: [{
					name: 'subjectAltName',
					altNames,
				}],
			},
		);

		fsSync.mkdirSync(certDir, { recursive: true });
		fsSync.writeFileSync(keyPath, pems.private, 'utf8');
		fsSync.writeFileSync(certPath, pems.cert, 'utf8');

		return {
			key: pems.private,
			cert: pems.cert,
			source: 'generated',
			keyPath,
			certPath,
		};
	});
}

function withTrailingSlash(paths) {
	const result = [];
	for (const p of paths) {
		result.push(p, `${p}/`);
	}
	return result;
}

/**
 * Creates the CommonGround Express app for one physical space.
 *
 * Options:
 *   spaceId      - namespace for stored data (default 'default'); data lives
 *                  at <dataDir>/spaces/<spaceId>/
 *   dataDir      - root data directory (default <package>/server/data)
 *   httpPort     - HTTP listen port used by listen() (default env HTTP_PORT or 3001)
 *   httpsPort    - HTTPS listen port used by listen() (default env HTTPS_PORT or 3002)
 *   certDir      - where the self-signed dev certificate lives
 *                  (default env COMMONGROUND_HTTPS_CERT_DIR or <package>/server/.certs)
 *   https        - set false to skip the HTTPS server entirely
 *   quiet        - suppress per-request logging (default env QUIET_LOGS === '1')
 *   onLog        - sink for informational log lines (listen banners, mount
 *                  notices, anchor/mesh save confirmations); defaults to
 *                  console.log. Pass an in-process dashboard's writeLogLine
 *                  to keep raw writes off its alt-screen TUI.
 *   apiAliases   - extra URL prefixes that also expose the anchor/mesh API,
 *                  e.g. ['/sites/ADRIE/XR'] (default []; '' and '/commonground'
 *                  are always mounted)
 *   extraRoutes  - optional (app, { store, spaceId }) => {} for caller routes
 *   syncDefault  - server-provided default for client sync participation,
 *                  exposed at GET <prefix>/api/client-config (default true)
 *   headsets     - project headsets for the desktop HUD overview, exposed at
 *                  GET <prefix>/api/client-config as DOM-safe
 *                  [{ id, label }] (default []; terminal-only fields such as
 *                  ANSI colors are stripped)
 *   headsetColumns - dashboard column renderers [{ render(status, headset) }]
 *                  applied per headset in GET <prefix>/api/headsets; must
 *                  return plain text (ANSI escapes show raw in the browser)
 *   headsetDefaultStatus - status object merged under the merged cg:status
 *                  state before rendering headsetColumns (mirrors the CLI
 *                  dashboard, which always renders from a full status)
 *   getRelayRuntime - lazy accessor () => relay | null for the socket relay
 *                  attached after createServer (cli.js wiring); provides
 *                  presence/coreStatus for GET api/headsets and broadcast
 *                  for POST api/spaces/select
 *   sessionLogFile - NDJSON session log served at
 *                  GET <prefix>/commonground/api/session-logs
 *                  (default <dataDir>/logs/headset-sessions.ndjson)
 *   sessionLogTitle - title of the session log viewer page served at
 *                  GET <prefix>/commonground/logs (default 'Session Logs')
 *   serveExample - serve the bundled example app: /src, /examples, /assets,
 *                  /node_modules, dist/ at /, and the no-build page at / and /dev
 *                  (default false; pass true to use the package's own example)
 *   apps         - additional apps to mount:
 *                  [{ path: '/my-app', staticDir: '/abs/dir', indexFile: 'index.html' }]
 *
 * Returns { app, httpServer, httpsServer, store, spaceId, listen }.
 * Nothing listens until listen() (or your own server.listen()) is called.
 */
export async function createServer(options = {}) {
	const {
		spaceId = 'default',
		dataDir = path.join(PACKAGE_ROOT, 'server', 'data'),
		httpPort = Number(process.env.HTTP_PORT) || 3001,
		httpsPort = Number(process.env.HTTPS_PORT) || 3002,
		certDir = process.env.COMMONGROUND_HTTPS_CERT_DIR || path.join(PACKAGE_ROOT, 'server', '.certs'),
		https: enableHttps = true,
		quiet = process.env.QUIET_LOGS === '1',
		apiAliases = [],
		extraRoutes = null,
		syncDefault = true,
		headsets = [],
		headsetColumns = [],
		headsetDefaultStatus = {},
		getRelayRuntime = null,
		sessionLogFile = null,
		sessionLogTitle = 'Session Logs',
		serveExample = false,
		apps = [],
		onLog = null,
		helperPage = null,
	} = options;
	const resolvedSessionLogFile = sessionLogFile
		? path.resolve(sessionLogFile)
		: path.join(dataDir, 'logs', 'headset-sessions.ndjson');

	// Informational lines (listen banners, mount notices, anchor/mesh save
	// confirmations) go to the onLog sink when provided — an in-process
	// dashboard uses this to keep raw writes off its alt screen. util.format
	// keeps multi-argument call sites byte-identical to console.log output.
	const logInfo = typeof onLog === 'function'
		? (...args) => onLog(format(...args))
		: (...args) => console.log(...args);

	installTransientConsoleClear();
	if (TRANSIENT_LOG_SECONDS > 0) {
		if (canUseTransientClear()) {
			logInfo(`Transient log clear enabled: ${TRANSIENT_LOG_SECONDS}s (force=${TRANSIENT_LOG_FORCE ? 'on' : 'off'})`);
		} else {
			logInfo('Transient log clear requested but disabled because stdout is not a TTY (set COMMONGROUND_LOG_CLEAR_FORCE=1 to override).');
		}
	}

	const store = new AnchorStore({ dataDir, spaceId });
	const app = express();

	// Middleware
	app.use(cors({
		origin: true, // Allow all origins for development
		credentials: true,
		methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
		allowedHeaders: ['Content-Type', 'Authorization']
	}));
	app.use(compression());
	app.use(express.json({ limit: '50mb' }));

	// Middleware to log all incoming requests
	app.use((req, res, next) => {
		if (!quiet) {
			console.log(`${req.method} ${req.url}`);
		}
		next();
	});

	// Anchor + mesh API, mounted at '', '/commonground', and any caller aliases
	const apiPrefixes = ['', '/commonground', ...apiAliases];
	const anchorPaths = withTrailingSlash(apiPrefixes.flatMap(p => [`${p}/api/anchors`, `${p}/anchors`]));
	const meshPaths = withTrailingSlash(apiPrefixes.flatMap(p => [`${p}/api/mesh`, `${p}/mesh`]));

	app.get(anchorPaths, async (req, res) => {
		const anchors = await store.getAnchors(req.query.device);
		res.json(anchors);
	});

	app.post(anchorPaths, async (req, res) => {
		try {
			const anchors = await store.saveAnchors(req.body || {}, req.query.device);
			if (req.query.device != null && req.query.device !== '') {
				logInfo(`Anchor references saved to anchors.json for device ${req.query.device} (space: ${store.spaceId})`);
			} else {
				logInfo(`Anchor references saved to anchors.json (space: ${store.spaceId})`);
			}
			res.json({ success: true, anchors });
		} catch (error) {
			console.error('Anchor save error:', error);
			res.status(500).json({ error: 'Failed to save anchor references' });
		}
	});

	app.delete(anchorPaths, async (req, res) => {
		try {
			const anchors = await store.clearAnchors(req.query.device ?? null);
			res.json({ success: true, anchors });
		} catch (error) {
			console.error('Anchor clear error:', error);
			res.status(500).json({ error: 'Failed to clear anchor references' });
		}
	});

	app.post(meshPaths, async (req, res) => {
		try {
			await store.saveMesh(req.body);
			logInfo(`Room mesh saved to mesh.json (space: ${store.spaceId})`);
			res.json({ success: true, message: 'Mesh exported to mesh.json' });
		} catch (error) {
			console.error('Save error:', error);
			res.status(500).json({ error: 'Failed to save room mesh' });
		}
	});

	app.get(meshPaths, async (req, res) => {
		try {
			res.json(await store.getMesh());
		} catch (error) {
			console.error('Load error:', error);
			res.status(500).json({ error: 'Failed to load room mesh' });
		}
	});

	// Legacy per-session room mesh endpoints
	app.post('/api/roommesh', async (req, res) => {
		try {
			const roomMeshData = req.body;
			if (!roomMeshData.sessionId) {
				return res.status(400).json({ error: 'Session ID required' });
			}

			await store.saveRoomMesh(roomMeshData);
			logInfo(`Room mesh saved: ${roomMeshData.sessionId} (space: ${store.spaceId})`);
			res.json({ success: true, sessionId: roomMeshData.sessionId });
		} catch (error) {
			console.error('Save error:', error);
			res.status(500).json({ error: 'Failed to save room mesh' });
		}
	});

	app.get('/api/roommesh/:sessionId', async (req, res) => {
		const mesh = await store.getRoomMesh(req.params.sessionId);
		if (mesh == null) {
			res.status(404).json({ error: 'Room mesh not found' });
			return;
		}
		res.json(mesh);
	});

	app.get('/api/roommesh', async (req, res) => {
		res.json({ sessions: await store.listRoomMeshSessions() });
	});

	// Client runtime config (sync participation default etc.), plus the
	// integrated session log viewer. Mounted under every API prefix so pages
	// served at a subpath can use relative URLs.
	const clientConfigPaths = apiPrefixes.map(p => `${p}/api/client-config`);
	const sessionLogPaths = apiPrefixes.map(p => `${p}/commonground/api/session-logs`);
	const sessionLogViewerPaths = apiPrefixes.flatMap(p => [`${p}/commonground/logs`, `${p}/commonground/logs/`]);

	app.get(clientConfigPaths, (req, res) => {
		res.json({
			syncDefault: syncDefault !== false,
			// Where the headset launch (helper) page lives, for the desktop
			// HUD's "open this on your Quest" hint. Null when the project runs
			// no helper page. Mirrors the dashboard's preferred port — if that
			// port was unavailable the dashboard falls back silently, so prefer
			// the exact URLs printed in the TUI when in doubt.
			helperUrl: (() => {
				if (!helperPage) return null;
				const ip = getLanIpv4Addresses()[0];
				if (!ip) return null;
				const port = Number(helperPage.port) || 80;
				return `http://${ip}${port === 80 ? '' : `:${port}`}/`;
			})(),
			headsets: (Array.isArray(headsets) ? headsets : [])
				.filter((headset) => headset && headset.id != null)
				.map((headset) => {
					const entry = {
						id: headset.id,
						label: String(headset.label ?? `Headset ${headset.id}`),
					};
					// DOM-safe color only (hex/rgb/CSS strings); legacy ANSI SGR
					// escape strings contain control chars and are stripped.
					if (typeof headset.color === 'string' && /^[^\x00-\x1F]{1,64}$/.test(headset.color)) {
						entry.color = headset.color;
					}
					return entry;
				}),
		});
	});

	// Live per-headset overview for the desktop HUD: presence + merged status
	// from the socket relay (via the lazy getRelayRuntime accessor — the relay
	// is attached after createServer), dashboard column strings, and the
	// anchor state of the currently selected space.
	const headsetPaths = apiPrefixes.map(p => `${p}/api/headsets`);
	app.get(headsetPaths, async (req, res) => {
		const relay = typeof getRelayRuntime === 'function' ? getRelayRuntime() : null;
		const columns = (Array.isArray(headsetColumns) ? headsetColumns : [])
			.filter((column) => column && typeof column.render === 'function');
		const list = [];
		for (const headset of (Array.isArray(headsets) ? headsets : [])) {
			if (!headset || headset.id == null) continue;
			const deviceId = Number(headset.id);
			const presence = relay?.presence?.get?.(deviceId) ?? null;
			const connected = Boolean(presence);
			const state = relay?.coreStatus?.get?.(deviceId) ?? null;
			const immersedAt = relay?.immersion?.get?.(deviceId) ?? null;
			const entry = {
				id: headset.id,
				label: String(headset.label ?? `Headset ${headset.id}`),
				connected,
				connectedDurationMs: connected ? Math.max(0, Date.now() - presence.connectedAt) : null,
				immersedAt,
				immersedDurationMs: immersedAt != null ? Math.max(0, Date.now() - immersedAt) : null,
				status: state && typeof state === 'object' ? state : null,
				anchor: await store.getAnchorStatus(deviceId),
			};
			if (columns.length > 0) {
				// Render from a full status, like the CLI dashboard: declared
				// defaults underneath the merged cg:status state.
				const renderStatus = { ...(headsetDefaultStatus || {}), ...(entry.status || {}) };
				entry.columns = columns.map((column) => {
					try {
						return String(column.render(renderStatus, headset) ?? '');
					} catch (_) {
						return '';
					}
				});
			}
			list.push(entry);
		}
		res.json(list);
	});

	// Spaces: list/create/select the runtime space. Storage is one directory
	// per space under <dataDir>/spaces/; selecting a space re-points the
	// AnchorStore and broadcasts cg:space so connected clients refetch.
	const spacePaths = apiPrefixes.map(p => `${p}/api/spaces`);
	const spaceSelectPaths = apiPrefixes.map(p => `${p}/api/spaces/select`);

	function isValidSpaceName(name) {
		return typeof name === 'string'
			&& /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(name)
			&& !name.includes('..');
	}

	async function spacesPayload() {
		const spaces = [...new Set([...(await store.listSpaces()), store.spaceId])].sort();
		return { current: store.spaceId, spaces };
	}

	app.get(spacePaths, async (req, res) => {
		res.json(await spacesPayload());
	});

	app.post(spacePaths, async (req, res) => {
		const name = String(req.body?.name ?? '').trim();
		if (!isValidSpaceName(name)) {
			res.status(400).json({ error: 'Invalid space name (1-64 chars: letters, digits, space, - . _)' });
			return;
		}
		try {
			await store.createSpace(name);
			logInfo(`Space created: ${name}`);
			res.json({ success: true, ...(await spacesPayload()) });
		} catch (error) {
			console.error('Space create error:', error);
			res.status(500).json({ error: 'Failed to create space' });
		}
	});

	app.post(spaceSelectPaths, async (req, res) => {
		const name = String(req.body?.name ?? '').trim();
		if (!isValidSpaceName(name)) {
			res.status(400).json({ error: 'Invalid space name (1-64 chars: letters, digits, space, - . _)' });
			return;
		}
		if (!(await store.spaceExists(name))) {
			res.status(404).json({ error: `Space not found: ${name}` });
			return;
		}
		if (name !== store.spaceId) {
			store.setSpace(name);
			logInfo(`Space switched to: ${name}`);
			const relay = typeof getRelayRuntime === 'function' ? getRelayRuntime() : null;
			relay?.broadcast?.('cg:space', { space: name, at: Date.now() });
		}
		res.json({ success: true, ...(await spacesPayload()) });
	});

	app.get(sessionLogPaths, async (req, res) => {
		res.type('application/x-ndjson');
		try {
			res.send(await fs.readFile(resolvedSessionLogFile, 'utf8'));
		} catch (error) {
			if (error && error.code === 'ENOENT') {
				// No sessions recorded yet — an empty log, not an error.
				res.send('');
				return;
			}
			console.error('Session log read error:', error);
			res.status(500).json({ error: 'Failed to read session log' });
		}
	});

	let sessionLogViewerHtml = null;
	app.get(sessionLogViewerPaths, (req, res) => {
		if (sessionLogViewerHtml == null) {
			const template = fsSync.readFileSync(path.join(PACKAGE_ROOT, 'server', 'session-log.html'), 'utf8');
			sessionLogViewerHtml = template.replaceAll('{{SESSION_LOG_TITLE}}', sessionLogTitle);
		}
		res.type('html').send(sessionLogViewerHtml);
	});

	// Caller-provided routes (deployment aliases, video routes, relays, ...)
	if (typeof extraRoutes === 'function') {
		extraRoutes(app, { store, spaceId: store.spaceId });
	}

	// Client library no-build mounts — always on, so any import-map page can
	// use /commonground/src and /commonground/node_modules no matter how the
	// server was started (CLI, createServer, bare example server).
	const vendorNodeModulesDir = resolveVendorNodeModulesDir();
	const defaultApps = [
		{ path: '/commonground/src', staticDir: path.join(PACKAGE_ROOT, 'src') },
		{ path: '/commonground/node_modules', staticDir: vendorNodeModulesDir },
		{ path: '/commonground/assets', staticDir: path.join(PACKAGE_ROOT, 'assets') },
	];

	// Additional apps mounted at subpaths
	for (const mounted of [...defaultApps, ...apps]) {
		if (!mounted || !mounted.path || !mounted.staticDir) continue;
		const staticDir = path.resolve(mounted.staticDir);
		app.use(mounted.path, express.static(staticDir));
		if (mounted.indexFile) {
			app.get([mounted.path, `${mounted.path}/`], (req, res) => {
				res.sendFile(path.join(staticDir, mounted.indexFile));
			});
		}
		logInfo(`Serving app at ${mounted.path} from:`, staticDir);
	}

	// The bundled example app (framework development)
	if (serveExample) {
		const exampleRoot = serveExample.root || PACKAGE_ROOT;
		const distDir = path.join(exampleRoot, 'dist');
		const devIndex = path.join(exampleRoot, 'examples', 'test-cube', 'index.html');

		// Serve static files from the assets directory using an absolute path
		app.use('/assets', express.static(path.join(exampleRoot, 'assets')));

		// No-build frontend mode: serve source files and node_modules directly
		app.use('/src', express.static(path.join(exampleRoot, 'src')));
		app.use('/examples', express.static(path.join(exampleRoot, 'examples')));
		app.use('/node_modules', express.static(path.join(exampleRoot, 'node_modules')));

		// No-build dev page at the root and at /dev
		app.get('/', (req, res) => {
			res.sendFile(devIndex);
		});
		app.get(['/dev', '/dev/'], (req, res) => {
			res.sendFile(devIndex);
		});

		// The example dir itself at / so the page's relative script
		// (./index.js) resolves; falls through to dist/ for built files.
		app.use(express.static(path.join(exampleRoot, 'examples', 'test-cube')));

		// Serve the built example from dist/
		app.use(express.static(distDir));

		logInfo('Serving assets from:', path.join(exampleRoot, 'assets'));
		logInfo('Serving source files from:', exampleRoot);
		logInfo('Serving frontend from:', distDir);
	}

	const httpServer = http.createServer(app);

	let httpsServer = null;
	if (enableHttps) {
		try {
			const certBundle = await loadOrCreateHttpsCertificate(certDir);
			httpsServer = https.createServer({ key: certBundle.key, cert: certBundle.cert }, app);
			httpsServer.certSource = certBundle.source;
			httpsServer.certPaths = { key: certBundle.keyPath, cert: certBundle.certPath };
		} catch (error) {
			logInfo('HTTPS server not started (selfsigned module not available):', error.message);
			logInfo('Install selfsigned: npm install selfsigned');
		}
	}

	const handleListenError = (label, port) => (error) => {
		if (error && error.code === 'EADDRINUSE') {
			console.error(`${label} port ${port} is already in use.`);
			console.error('Stop the existing process first, then retry.');
			process.exit(1);
		}
		console.error(`${label} server failed to start:`, error);
		process.exit(1);
	};

	function listen() {
		httpServer.on('error', handleListenError('HTTP', httpPort));
		httpServer.listen(httpPort, () => {
			logInfo(`CommonGround HTTP server running on port ${httpPort} (space: ${store.spaceId})`);
		});

		if (httpsServer) {
			httpsServer.on('error', handleListenError('HTTPS', httpsPort));
			httpsServer.listen(httpsPort, () => {
				logInfo(`CommonGround HTTPS server running on port ${httpsPort} (space: ${store.spaceId})`);
				logInfo(`HTTPS certificate loaded from: ${httpsServer.certSource}`);
				logInfo(`Certificate files: ${httpsServer.certPaths.key} and ${httpsServer.certPaths.cert}`);
				logInfo('Note: You may need to accept the self-signed certificate once in your browser');
			});
		}

		return { httpServer, httpsServer };
	}

	return { app, httpServer, httpsServer, store, spaceId: store.spaceId, sessionLogFile: resolvedSessionLogFile, listen };
}

export { AnchorStore } from './AnchorStore.js';
export { attachSocketRelay, parseDeviceIdQuery, normalizeSocketIoUrl } from './relay.js';
