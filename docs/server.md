# Server

Anchors and room meshes are stored per **physical space**:

```
<dataDir>/spaces/<spaceId>/anchors.json
<dataDir>/spaces/<spaceId>/mesh.json
```

The CLI starts in the `default` space unless `--space <id>` or
`config.space` says otherwise; the desktop HUD's Spaces tab can switch
the active space at runtime:

```bash
node server/server.js --space adrie            # also --data-dir, --http-port, --https-port
```

HTTP runs on port 3001 and HTTPS (self-signed dev certificate in `server/.certs`) on 3002.

## API endpoints

All endpoints are mounted at `/`, `/commonground/`, and any caller-provided aliases:

- `GET/POST/DELETE /api/anchors` (legacy alias `/anchors`) — persistent anchor references; `?device=N` scopes keys as `device_<id>_<key>`
- `GET/POST /api/mesh` (legacy alias `/mesh`) — room mesh export
- `POST /api/roommesh`, `GET /api/roommesh[/:sessionId]` — legacy per-session room meshes
- `GET /api/client-config` — client runtime config (`{ syncDefault, headsets: [{ id, label, color? }] }`;
  `color` passes through only when DOM-safe — ANSI SGR escape strings are stripped)
- `GET /api/headsets` — live per-headset overview for the desktop HUD:
  `[{ id, label, connected, connectedDurationMs (null when disconnected),
  immersedAt, immersedDurationMs (null until immersion enter), status
  (merged cg:status state or null), columns: string[] (only when columns
  are configured), anchor: 'anchored' | 'no-anchor' | 'unknown' }]`.
  Presence and immersion come from the socket relay (handshake deviceId —
  headset pages only; desktop pages deliberately connect without a
  deviceId, so spectators never show up as headsets); anchor state refers
  to the currently selected space.
- `GET /api/spaces` — `{ current, spaces: string[] }` (subdirs of
  `<dataDir>/spaces/`, always including the current space)
- `POST /api/spaces` `{ name }` — create a space (1–64 chars: letters,
  digits, space, `- . _`); does not switch to it
- `POST /api/spaces/select` `{ name }` — switch the runtime space: the
  AnchorStore re-points at `<dataDir>/spaces/<name>/` and the server
  broadcasts `cg:space`, so connected clients re-run their anchor
  fetch/apply path without a reload (404 for unknown spaces)
- `GET /commonground/logs` — integrated session log viewer (HTML)
- `GET /commonground/api/session-logs` — raw NDJSON session log contents (empty when no sessions yet)

## Embedding the server

```js
import { createServer } from 'commonground/server';

const { app, httpServer, httpsServer, store, listen } = await createServer({
	spaceId: 'adrie',                 // default 'default'
	dataDir: '/path/to/data',         // default <package>/server/data
	httpPort: 3001,
	httpsPort: 3002,
	apiAliases: ['/sites/ADRIE/XR'],  // extra prefixes for the anchor/mesh API
	syncDefault: true,                // client sync participation default (client-config endpoint)
	headsets: [{ id: 1, label: 'Headset 1' }],  // project headsets for the HUD overview
	                                    // (DOM-safe fields only; terminal colors stripped)
	headsetColumns: [{ render: (status) => `Intro step: ${status.introductionStep ?? 0}` }],
	                                    // dashboard columns rendered per headset in
	                                    // GET api/headsets — must return PLAIN TEXT
	                                    // (ANSI escapes show raw in the browser)
	headsetDefaultStatus: {},           // merged under the cg:status state before
	                                    // rendering columns (CLI passes the project's
	                                    // createDefaultStatus()/statusFields default)
	getRelayRuntime: () => relay,       // lazy relay accessor for presence/status/
	                                    // broadcast (the relay attaches after
	                                    // createServer; cli.js wires this)
	sessionLogFile: '/path/to/data/logs/headset-sessions.ndjson',  // default <dataDir>/logs/...
	sessionLogTitle: 'Session Logs',  // log viewer page title
	extraRoutes: (app, { store, spaceId }) => {
		app.get('/test-video', (req, res) => res.sendFile('/path/to/video.mp4'));
	},
	apps: [
		{ path: '/my-app', staticDir: '/path/to/app/dist', indexFile: 'index.html' },
	],
	serveExample: false,              // true serves the bundled example app
});

listen(); // or call httpServer.listen(...) yourself
```

Environment variables: `HTTP_PORT`, `HTTPS_PORT`, `QUIET_LOGS=1`, `COMMONGROUND_HTTPS_CERT_DIR`, `COMMONGROUND_LOG_CLEAR_SECONDS`, `COMMONGROUND_LOG_CLEAR_FORCE=1`.

## Socket relay + status channel

`commonground/server` also exports socket.io plumbing that attaches to the
factory's HTTP and HTTPS servers and relays events between them, so clients
on either protocol share one event stream. Two generic channels are built in
(on by default; disable with `sync: false` / `status: false`):

- **`cg:sync`** — cross-headset event channel. Clients emit `{ type, payload }`;
  the server stamps `deviceId` (typo-tolerant handshake query) and `at`, and
  relays `{ type, payload, deviceId, at }` to every OTHER client. The sender
  never gets its own echo. Spectator clients (handshake `clientRole=screen`)
  receive broadcasts but their emits are ignored.
- **`cg:status`** — dumb per-device merge store. Clients emit partial state
  objects; the server shallow-merges into the device's last-known state,
  logs `[status] {"deviceId":N,"state":{...},"at":ms}` (dashboard contract),
  and broadcasts `{ deviceId, state, at }` to all clients. Disconnect clears
  the device entry.

```js
import { createServer, attachSocketRelay } from 'commonground/server';

const server = await createServer({ spaceId: 'adrie' });
const relay = attachSocketRelay(
	[
		{ server: server.httpServer, label: 'http' },
		{ server: server.httpsServer, label: 'https' },
	],
	{
		socketPath: '/socket.io/',
		quiet: false,          // gates [socket] <event> relay logs
		sync: true,            // built-in cg:sync channel
		status: true,          // built-in cg:status channel
		onLog: (line) => {},   // sink for structured lines ([socket:...]/[status]...);
		                       // pass dashboard.writeLogLine for in-process dashboards
		hasEnteredImmersion: (state) => Boolean(state?.enteredImmersion),  // default;
		                       // marks relay.immersion when the merged state first passes
	},
);

relay.coreStatus.get(3); // -> merged cg:status state for device 3 (null after disconnect)
relay.presence.get(3);   // -> { connectedAt } while device 3 is connected, else null
relay.presence.keys();   // -> currently connected deviceIds (handshake deviceId;
                         //    multiple sockets per device ref-count; screens untracked)
relay.immersion.get(3);  // -> immersion-enter timestamp (ms) for device 3, else null

// Declarative validate -> log -> broadcast event relay (custom protocols)
relay.registerRelayEvents([{
	event: 'tileGrabSync',
	validate: (payload, socket) => {
		if (!payload || !Array.isArray(payload.matrix)) return null; // null drops the event
		return { sourceSocketId: socket.id, payload, at: Date.now() };
	},
	log: (message) => ({ sourceSocketId: message.sourceSocketId }), // optional
	onEvent: (message, socket) => {},                               // optional
}]);

// Custom per-device status aggregation (legacy protocols)
const status = relay.registerStatusChannel({
	createEntry: () => ({ state: { enteredImmersion: false } }),
	reduce: (entry, message) => {
		if (message.state.enteredImmersion) entry.state.enteredImmersion = true;
	},
});
status.getStatus(3); // -> aggregated state for device 3 (null after disconnect)
server.listen();
```

Connection lifecycle is logged in a dashboard-scrapable format:
`[socket:<label>] connected|disconnected client <id>` (or a custom label from
the `clientRole` handshake query, e.g. `screen`).

Also exported: `parseDeviceIdQuery(query)` — typo-tolerant deviceId parsing
(`deviceId`/`deviceid`/`deviced`) — and `normalizeSocketIoUrl(server)` which
collapses `//socket.io` URLs seen behind some reverse proxies.

## `commonground serve` (CLI)

The package ships a config-driven CLI (`"bin": { "commonground": "cli.js" }`).
In any app directory:

```bash
npx commonground serve [--space <id>] [--config <path>] [--http-port <port>] [--https-port <port>]
```

With **no config at all** it serves the current directory at `/`, the
anchors/mesh API, and the cg.sync/cg.status socket channels — no dashboard.
It always also mounts the client library for no-build import maps:
`/commonground/src` → the package's `src/`, `/commonground/node_modules` →
the node_modules root providing three/ratk (hoisting-safe).

All settings are optional and come from `commonground.config.js` in the
current directory (default export); `--space` overrides `config.space`:

```js
export default {
	space: 'myspace',                 // CLI startup space (default 'default'); --space overrides
	httpPort: 3001,
	httpsPort: 3002,
	dataDir: 'data',                  // resolved against cwd
	certDir: '.certs',                // resolved against cwd
	sync: true,                       // built-in cg:sync channel
	status: true,                     // built-in cg:status channel
	syncDefault: true,                // client sync participation default (--sync/--no-sync override)
	sessionLogTitle: 'Session Logs',  // title of the /commonground/logs viewer
	routes: [{ path: '/screen', file: 'screen.html', label: 'Screen' }],  // label → helper-page quick link
	staticDirs: [{ path: '/assets', dir: 'public/assets', indexFile: null }],
	extraRoutes: (app, { store, spaceId }) => {},  // escape hatch
	setupRelay: (relay) => {},                     // escape hatch (registerRelayEvents etc.)
	dashboard: {                      // presence enables the in-process dashboard
		enabled: true,
		headsets: [{ id: 1, label: 'Headset 1', color: '#ff4902' }],  // hex → ANSI in the TUI
		columns: [{ render: (status, headset) => `...` }],
		statusFields: {                 // declares the status shape once; derives
			introductionStep: 'number',           // the default status and the
			enteredImmersion: 'boolean',          // session-log entry (see below)
			lastTileDraggedTitle: 'string',
			lastFloorplanHex: 'number?',          // nullable
			tileGrabHistory: [{ title: 'string' }],  // event array: entry schema
		},
		createDefaultStatus: null,      // optional override (derived from statusFields)
		applyStatusState: (status, state, payload) => ({ ...status, ...state }),
		hasEnteredImmersion: (state) => Boolean(state.enteredImmersion),
		summarizeSession: null,         // optional override (derived from statusFields)
		sessionLogFile: 'data/logs/headset-sessions.ndjson',
		helperPage: {},                 // fully generated page; or override:
		// helperPage: {
		// 	port: 80, fallbackPort: 3000,
		// 	title: 'Quest Links', heading: 'Headset Launch', description: '...',
		// 	links: [{ label: 'Screen', href: 'https://{host}:3002/screen' }],
		// 	headsetLinks: [{ label: 'Headset {id}', href: 'https://{host}:3002?deviceid={id}' }],
		// },
	},
};
```

With `dashboard` present, server and dashboard run in ONE process: the
relay's structured log lines feed the dashboard directly (`onLog`), no child
processes or stdout scraping involved. Session NDJSON logging, the helper
page, and the alt-screen TUI (when `QUIET_LOGS=1` and a TTY) all work. The
CLI also injects two things the dashboard cannot know on its own —
`appHttpsPort` (the serve HTTPS port) and `appRoutes` (the top-level
`routes`) — used to generate the default helper-page links; a project's
dashboard section may override both.

## Status fields (`statusFields`)

Declare the project's status shape once; the framework derives both the
default status and the session-log entry from it. Field types: `'number'`,
`'boolean'`, `'string'`, nullable `'number?'`/`'string?'`, and event arrays
written as a one-element array holding the entry schema
(`[{ title: 'string', box: 'string' }]`).

Derived default status: number → `0`, boolean → `false`, string → `'none'`,
nullable → `null`, event array → `[]`. The derived default also carries
`lastAction: 'none'` (the conventional client-stamped field of cg.status
updates). Derived session entry: always the standard envelope
(`type: 'headset-session-ended'`, `sessionId`, `headsetId`, ISO
`connectedAt`/`immersedAt`/`endedAt`, `connectedDurationMs`,
`immersedDurationMs`) plus a `status` section with exactly the declared
fields — scalars coerced per type (string → trimmed `'none'` fallback;
boolean → `!!v`; number → finite-or-`0`; nullable → `null` for
null/undefined, else integer-or-`null` / trimmed-or-`null`), event arrays
mapped through `toSessionMsEvents` with each entry normalized to exactly the
declared entry fields (declared order) plus `sessionMs`.

Override hierarchy: an explicit `createDefaultStatus` / `summarizeSession`
hook always wins over the derived version; without `statusFields` the
framework falls back to an empty default status and the generic envelope
with the raw final status. `columns` is unaffected. The derived builders are
exported as `createStatusFromFields(statusFields)` and
`summarizeSessionFromFields(statusFields)` for projects that want to wrap
them.

## Helper page defaults

With `helperPage: {}` (or `true`) the launch page is fully generated:
`CommonGround` → `/api/anchors` (certificate accept), one quick link per
top-level route that has a `label` (routes without `label` are skipped),
`Session Logs` → `/commonground/logs`, `Desktop` → `/`, and per-headset
`Headset {id}` / `Headset {id} Admin` links (`?deviceid={id}[&admin=1]`) —
all against `https://{host}:<appHttpsPort>`. `port`/`fallbackPort` and the
cosmetic `title`/`heading`/`description` keep their meaning; explicit
`links`/`headsetLinks` replace the generated lists entirely. Without an
`appHttpsPort` (standalone classic-mode dashboards) the generated lists are
empty.
