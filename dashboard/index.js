import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const ANSI_RESET = '\x1b[0m';

/**
 * Maps a history of timestamped events to session-relative offsets.
 * Each event keeps its own fields; `at`/`timestamp`/`sessionMs` is
 * replaced by `sessionMs` (ms since session start, clamped >= 0).
 */
export function toSessionMsEvents(history, sessionStartMs) {
	if (!Array.isArray(history)) return [];
	return history.map((event) => {
		const at = Number(event?.at ?? event?.timestamp ?? event?.sessionMs ?? 0);
		const offsetMs = Number.isFinite(at) ? Math.max(0, at - sessionStartMs) : 0;
		const { at: _at, timestamp: _timestamp, ...rest } = (event && typeof event === 'object') ? event : {};
		return { ...rest, sessionMs: Math.max(0, offsetMs) };
	});
}

function fitToWidth(value, width) {
	const text = String(value);
	if (text.length <= width) {
		return text.padEnd(width, ' ');
	}
	// Truncated output must still fit: slice width - 3 and add the ellipsis.
	if (width <= 3) {
		return text.slice(0, Math.max(0, width));
	}
	return `${text.slice(0, width - 3)}...`;
}

function formatDuration(ms) {
	const safeMs = Math.max(0, Number(ms) || 0);
	const totalSeconds = Math.floor(safeMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getLanIpCandidates() {
	const interfaces = os.networkInterfaces();
	const ips = [];

	for (const networkName of Object.keys(interfaces || {})) {
		const network = interfaces[networkName] || [];
		for (const details of network) {
			if (details.family === 'IPv4' && !details.internal) {
				ips.push(details.address);
			}
		}
	}

	return [...new Set(ips)];
}

function defaultSummarizeSession({ sessionId, headsetId, connectedAt, immersedAt, endedAtMs, status }) {
	return {
		type: 'headset-session-ended',
		sessionId: sessionId ?? null,
		headsetId,
		connectedAt: Number.isFinite(connectedAt) ? new Date(connectedAt).toISOString() : null,
		immersedAt: Number.isFinite(immersedAt) ? new Date(immersedAt).toISOString() : null,
		endedAt: new Date(endedAtMs).toISOString(),
		connectedDurationMs: Number.isFinite(connectedAt) ? Math.max(0, endedAtMs - connectedAt) : null,
		immersedDurationMs: Number.isFinite(immersedAt) ? Math.max(0, endedAtMs - immersedAt) : null,
		status,
	};
}

/**
 * statusFields schema — a project declares its dashboard status shape once
 * and the framework derives the default status and the session-log entry:
 *
 *   {
 *     introductionStep: 'number',        // scalar: 'number' | 'boolean' | 'string'
 *     lastFloorplanHex: 'number?',       // nullable scalar ('number?' | 'string?')
 *     tileGrabHistory: [{ title: 'string' }],  // event array: one-element
 *                                          // array = entry schema
 *   }
 *
 * Derived default status: number → 0, boolean → false, string → 'none',
 * nullable → null, event array → []. The derived default also carries
 * `lastAction: 'none'` — the conventional client-stamped field of cg.status
 * updates — so dashboards can render it from the first frame.
 */
const SCALAR_STATUS_DEFAULTS = { number: 0, boolean: false, string: 'none' };

function isNullableFieldType(type) {
	return typeof type === 'string' && type.endsWith('?');
}

function baseFieldType(type) {
	return isNullableFieldType(type) ? type.slice(0, -1) : type;
}

function isPlainFieldSpec(spec) {
	return typeof spec === 'string';
}

/**
 * Builds a fresh default status object from a statusFields declaration.
 */
export function createStatusFromFields(statusFields) {
	const status = {};
	const fields = statusFields && typeof statusFields === 'object' ? statusFields : {};
	for (const [key, spec] of Object.entries(fields)) {
		if (Array.isArray(spec)) {
			status[key] = [];
		} else if (isNullableFieldType(spec)) {
			status[key] = null;
		} else {
			status[key] = SCALAR_STATUS_DEFAULTS[baseFieldType(spec)] ?? 'none';
		}
	}
	status.lastAction = 'none';
	return status;
}

// Session-entry coercion for top-level scalars: string → trimmed 'none'
// fallback, boolean → Boolean(v), number → finite number or 0, nullable →
// null for null/undefined else coerced ('number?' → integer-or-null,
// 'string?' → trimmed-or-null).
function coerceSessionScalar(value, spec) {
	if (isNullableFieldType(spec) && value == null) {
		return null;
	}
	switch (baseFieldType(spec)) {
		case 'number':
			if (isNullableFieldType(spec)) {
				return Number.isInteger(Number(value)) ? Number(value) : null;
			}
			return Number.isFinite(Number(value)) ? Number(value) : 0;
		case 'boolean':
			return Boolean(value);
		default: {
			if (isNullableFieldType(spec)) {
				return String(value).trim() || null;
			}
			return String(value ?? 'none').trim() || 'none';
		}
	}
}

// Same coercions for event-array entries, except plain numbers clamp like a
// count: Math.max(0, Number(v) || 0).
function coerceHistoryEntryValue(value, spec) {
	if (isNullableFieldType(spec) && value == null) {
		return null;
	}
	switch (baseFieldType(spec)) {
		case 'number':
			if (isNullableFieldType(spec)) {
				return Number.isInteger(Number(value)) ? Number(value) : null;
			}
			return Math.max(0, Number(value) || 0);
		case 'boolean':
			return Boolean(value);
		default: {
			if (isNullableFieldType(spec)) {
				return String(value).trim() || null;
			}
			return String(value ?? 'none').trim() || 'none';
		}
	}
}

/**
 * Builds a summarizeSession(ctx) hook from a statusFields declaration.
 * The entry always carries the standard envelope (type, sessionId,
 * headsetId, ISO connectedAt/immersedAt/endedAt, durations); the `status`
 * section holds exactly the declared fields — scalars coerced per type,
 * event arrays mapped through toSessionMsEvents with each entry normalized
 * to exactly the declared entry fields (declared order) plus sessionMs.
 */
export function summarizeSessionFromFields(statusFields) {
	const fields = statusFields && typeof statusFields === 'object' ? statusFields : {};
	return (ctx) => {
		const status = ctx?.status && typeof ctx.status === 'object' ? ctx.status : {};
		const section = {};
		for (const [key, spec] of Object.entries(fields)) {
			if (Array.isArray(spec)) {
				const entrySchema = spec[0] && typeof spec[0] === 'object' ? spec[0] : {};
				const history = Array.isArray(status[key]) ? status[key] : [];
				section[key] = toSessionMsEvents(history, ctx?.sessionStartMs).map((event) => {
					const entry = {};
					for (const [entryKey, entrySpec] of Object.entries(entrySchema)) {
						if (!isPlainFieldSpec(entrySpec)) continue;
						entry[entryKey] = coerceHistoryEntryValue(event?.[entryKey], entrySpec);
					}
					entry.sessionMs = event.sessionMs;
					return entry;
				});
			} else if (isPlainFieldSpec(spec)) {
				section[key] = coerceSessionScalar(status[key], spec);
			}
		}
		return defaultSummarizeSession({ ...ctx, status: section });
	};
}


function createHelperPage({ pageConfig, host, headsets }) {
	const safeHost = host || 'localhost';
	const fillHost = (href) => String(href).replaceAll('{host}', safeHost);

	const quickLinkItems = (pageConfig.links || [])
		.map((link) => `<li><a href="${fillHost(link.href)}" target="_blank" rel="noopener noreferrer">${link.label}</a></li>`)
		.join('\n');

	const headsetRows = headsets
		.map((headset) => {
			const headsetLabel = String(headset.label ?? `Headset ${headset.id}`);
			const fillPlaceholders = (text) => String(text)
				.replaceAll('{id}', String(headset.id))
				.replaceAll('{label}', headsetLabel);
			const links = typeof pageConfig.headsetLinks === 'function'
				? pageConfig.headsetLinks(headset, safeHost)
				: (pageConfig.headsetLinks || []).map((link) => ({
					label: fillPlaceholders(link.label),
					href: fillHost(fillPlaceholders(link.href)),
				}));
			// Color-code the buttons with the headset's configured hex color:
			// solid for launch, outline for Setup. Hex-only — anything else
			// falls back to the default dark button.
			const color = typeof headset.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(headset.color.trim())
				? headset.color.trim()
				: null;
			const cells = links
				.map((link, index) => {
					const style = color
						? (index === 0
							? ` style="background:${color};border:2px solid ${color};"`
							: ` style="background:#ffffff;color:${color};border:2px solid ${color};"`)
						: '';
					return `<td><a href="${link.href}" target="_blank" rel="noopener noreferrer"${style}>${link.label}</a></td>`;
				})
				.join('\n');
			return `<tr>${cells}</tr>`;
		})
		.join('\n');

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${pageConfig.title || 'Headset Launch'}</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(160deg, #e8f5ff, #f7fff5 45%, #fff9ec);
      min-height: 100vh;
      display: grid;
      place-items: center;
    }
    main {
      width: min(760px, 92vw);
      padding: 24px;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.88);
      border: 1px solid rgba(0, 0, 0, 0.08);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
    }
    h1 { margin: 0 0 12px 0; font-size: 28px; }
    p { margin: 0 0 16px 0; color: #334155; }
    ul { list-style: none; padding: 0; margin: 0 0 18px 0; display: grid; gap: 12px; }
    a {
      display: block;
      padding: 14px 16px;
      border-radius: 12px;
      background: #0f172a;
      color: #ffffff;
      text-decoration: none;
      font-weight: 600;
    }
    a:hover { background: #1e293b; }
    .headsetTable {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0 10px;
      margin: 0;
    }
    .headsetTable th,
    .headsetTable td {
      text-align: left;
      vertical-align: middle;
      padding: 0;
    }
    .headsetTable td {
      padding-left: 6px;
      padding-right: 6px;
    }
    .headsetTable td a {
      text-align: center;
    }
    code {
      background: #e2e8f0;
      padding: 2px 6px;
      border-radius: 6px;
    }
  </style>
</head>
<body>
  <main>
    <h1>${pageConfig.heading || pageConfig.title || 'Headset Launch'}</h1>
    <p>${pageConfig.description || ''}</p>
    <ul>
      ${quickLinkItems}
    </ul>
    <table class="headsetTable" aria-label="Headset launch links">
      <tbody>
        ${headsetRows}
      </tbody>
    </table>
    <p style="margin-top:16px;">Host: <code>${safeHost}</code></p>
  </main>
</body>
</html>`;
}

/**
 * Runs the terminal dashboard orchestrator: spawns the configured child
 * server processes, scrapes their log lines, renders an alt-screen status
 * table, appends NDJSON session summaries, and serves the headset launch
 * helper page.
 *
 * Config:
 *   title              - dashboard header title
 *   headsets           - [{ id, label, color }]; color is a hex string
 *                        ('#ff4902' or '#f40', translated to ANSI for the
 *                        TUI), an ANSI SGR escape string, or null
 *   columns            - extra status rows: [{ render(status, headset) => string }]
 *   statusFields       - declarative status shape (see createStatusFromFields);
 *                        derives the default status and the session-log entry
 *                        unless the hooks below are provided explicitly
 *   createDefaultStatus()          - initial per-headset status object
 *                        (default: derived from statusFields, else () => ({}))
 *   applyStatusState(status, state, payload) - merge a [status] payload's state
 *                        into the headset status (default: shallow merge)
 *   hasEnteredImmersion(state, payload)      - default: Boolean(state.enteredImmersion)
 *   summarizeSession(ctx)          - custom NDJSON session entry builder;
 *                        ctx: { sessionId, headsetId, connectedAt, immersedAt, endedAtMs, status }
 *                        (default: derived from statusFields, else the generic
 *                        envelope with the raw final status)
 *   processes          - [{ name, command, args?, cwd?, env? }] child servers
 *                        to spawn (command/args passed to spawn). Optional:
 *                        in-process mode (no children) feeds the dashboard by
 *                        wiring a socket relay's onLog to the returned
 *                        writeLogLine — the same [socket:...]/[status] lines
 *                        are parsed exactly as if scraped from a child.
 *   handleSignals      - install SIGINT/SIGTERM handlers (default true);
 *                        set false when the host process manages its own
 *                        shutdown (e.g. `commonground serve`)
 *   sessionLogFile     - NDJSON session log path
 *   connections        - extra non-headset connection labels to track and
 *                        display (default ['screen'])
 *   suppressLogPatterns- strings; matching lines are hidden from recent logs
 *   logWindowMs        - recent-log window (default 2000)
 *   refreshMs          - dashboard repaint interval (default 250); in TUI mode
 *                        all repaints happen on this cadence — log lines never
 *                        trigger a repaint, so event bursts cannot flood the
 *                        terminal. Frames always fit the visible screen: log
 *                        lines are truncated to the terminal width and the
 *                        recent-log area is capped to the remaining rows
 *                        (overflow shown as "... N older log line(s) hidden")
 *   enabled            - alt-screen TUI on/off (default: QUIET_LOGS=1 and a TTY);
 *                        when off, child logs pass through to stdout/stderr
 *   appHttpsPort       - the app's HTTPS port; injected by `commonground serve`
 *                        and used to build default helper-page links
 *   appRoutes          - top-level project routes [{ path, file, label? }];
 *                        routes with a `label` become helper-page quick links
 *   helperPage         - null to disable; true or {} for a fully generated
 *                        page, or:
 *                        { port = 80, fallbackPort = 3000, title, heading,
 *                          description, links: [{ label, href }],
 *                          headsetLinks: [{ label, href }] | (headset, host) => [{ label, href }] }
 *                        hrefs may contain {host} and {id} placeholders.
 *                        Without links/headsetLinks, defaults are generated:
 *                        CommonGround (/api/anchors), one link per labeled
 *                        appRoute, Session Logs (/commonground/logs), Desktop
 *                        (/), and per-headset 'Headset {id}' / 'Headset {id}
 *                        Admin' links — all against https://{host}:appHttpsPort.
 *
 * Scraped log-line formats (children must print these to stdout):
 *   [socket:<label>] connected client <id>     / connected <label>
 *   [socket:<label>] disconnected client <id>  / disconnected <label>
 *   [status] {"deviceId": <id>, "action": "...", "state": {...}, "at": <ms>}
 */
export function runDashboard(config = {}) {
	const {
		title = 'Dashboard',
		headsets = [],
		columns = [],
		statusFields = null,
		createDefaultStatus = null,
		applyStatusState = (status, state) => ({ ...status, ...state }),
		hasEnteredImmersion = (state) => Boolean(state?.enteredImmersion),
		summarizeSession = null,
		processes: processConfigs = [],
		sessionLogFile = path.join(process.cwd(), 'data', 'logs', 'headset-sessions.ndjson'),
		connections = ['screen'],
		suppressLogPatterns = [],
		logWindowMs = Math.max(250, Number(process.env.COMMONGROUND_DASHBOARD_LOG_WINDOW_MS || 2000)),
		refreshMs = 250,
		enabled = process.env.QUIET_LOGS === '1' && Boolean(process.stdout.isTTY),
		appHttpsPort = null,
		appRoutes = [],
		helperPage = null,
		handleSignals = true,
	} = config;

	// Explicit hooks win; otherwise derive from statusFields; otherwise the
	// generic defaults (empty status, envelope with raw final status).
	const hasStatusFields = Boolean(statusFields)
		&& typeof statusFields === 'object'
		&& Object.keys(statusFields).length > 0;
	const createDefault = typeof createDefaultStatus === 'function'
		? createDefaultStatus
		: (hasStatusFields ? () => createStatusFromFields(statusFields) : () => ({}));
	const buildSessionEntry = typeof summarizeSession === 'function'
		? summarizeSession
		: (hasStatusFields ? summarizeSessionFromFields(statusFields) : defaultSummarizeSession);

	const headsetIds = headsets.map((headset) => headset.id);
	const dashboardState = {
		headsetConnected: new Map(headsetIds.map((id) => [id, false])),
		headsetConnectedAt: new Map(headsetIds.map((id) => [id, null])),
		headsetSessionClosedAt: new Map(headsetIds.map((id) => [id, null])),
		headsetImmersedAt: new Map(headsetIds.map((id) => [id, null])),
		headsetSessionId: new Map(headsetIds.map((id) => [id, null])),
		headsetStatus: new Map(headsetIds.map((id) => [id, createDefault()])),
		extraConnections: new Map(connections.map((label) => [label, false])),
		// LAN addresses of this machine, shown as "Server IP:" in the TUI.
		// Detected at startup — independent of whether the helper page binds.
		serverIps: getLanIpCandidates(),
		recentLogs: [],
	};

	function readLastSessionIdFromLog() {
		try {
			const contents = fs.readFileSync(sessionLogFile, 'utf8');
			let lastSessionId = 0;
			for (const line of contents.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const entry = JSON.parse(trimmed);
					const sessionId = Number(entry?.sessionId);
					if (Number.isInteger(sessionId) && sessionId > lastSessionId) {
						lastSessionId = sessionId;
					}
				} catch (_error) {
					// ignore malformed lines
				}
			}
			return lastSessionId;
		} catch (_error) {
			return 0;
		}
	}

	let nextSessionId = readLastSessionIdFromLog() + 1;
	let dashboardRefreshTimer = null;
	let dashboardUsingAltScreen = false;

	function pruneRecentLogs(nowMs = Date.now()) {
		dashboardState.recentLogs = dashboardState.recentLogs.filter(
			(entry) => nowMs - entry.at <= logWindowMs
		);
	}

	function appendSessionLogEntry(headsetId, endedAtMs) {
		const connectedAt = dashboardState.headsetConnectedAt.get(headsetId);
		const immersedAt = dashboardState.headsetImmersedAt.get(headsetId);
		if (!Number.isFinite(immersedAt)) {
			return;
		}
		const status = dashboardState.headsetStatus.get(headsetId) || createDefault();
		const sessionId = dashboardState.headsetSessionId.get(headsetId) ?? null;

		const entry = buildSessionEntry({
			sessionId,
			headsetId,
			connectedAt,
			immersedAt,
			endedAtMs,
			sessionStartMs: Number.isFinite(connectedAt) ? connectedAt : endedAtMs,
			status,
		});
		if (entry == null) {
			return;
		}

		try {
			fs.mkdirSync(path.dirname(sessionLogFile), { recursive: true });
			fs.appendFileSync(sessionLogFile, `${JSON.stringify(entry)}\n`, 'utf8');
		} catch (error) {
			process.stderr.write(`[dashboard] Failed to write session log: ${error?.message || error}\n`);
		}
	}

	function updateConnectionStatusFromLine(line) {
		const match = line.match(
			/\[socket:[^\]]+\]\s+(connected|disconnected)\s+(client\s+(\d+)|(\w+))\b/i
		);
		if (!match) {
			return;
		}

		const isConnected = match[1].toLowerCase() === 'connected';
		const headsetId = Number(match[3]);
		const label = String(match[4] || '').toLowerCase();

		if (Number.isInteger(headsetId) && headsetIds.includes(headsetId)) {
			const wasConnected = dashboardState.headsetConnected.get(headsetId) === true;
			const nowMs = Date.now();
			dashboardState.headsetConnected.set(headsetId, isConnected);
			if (isConnected && !wasConnected) {
				dashboardState.headsetConnectedAt.set(headsetId, nowMs);
				dashboardState.headsetSessionClosedAt.set(headsetId, null);
			}
			if (!isConnected) {
				const sessionClosedAt = dashboardState.headsetSessionClosedAt.get(headsetId);
				if (wasConnected && !Number.isFinite(sessionClosedAt)) {
					appendSessionLogEntry(headsetId, nowMs);
					dashboardState.headsetSessionClosedAt.set(headsetId, nowMs);
				}
				dashboardState.headsetConnectedAt.set(headsetId, null);
				dashboardState.headsetImmersedAt.set(headsetId, null);
				dashboardState.headsetSessionId.set(headsetId, null);
				dashboardState.headsetStatus.set(headsetId, createDefault());
			}
			return;
		}

		if (label && dashboardState.extraConnections.has(label)) {
			dashboardState.extraConnections.set(label, isConnected);
		}
	}

	function updateStatusFromLine(line) {
		const statusIndex = line.indexOf('[status]');
		if (statusIndex < 0) {
			return;
		}

		const payloadText = line.slice(statusIndex + '[status]'.length).trim();
		if (!payloadText.startsWith('{')) {
			return;
		}

		let payload;
		try {
			payload = JSON.parse(payloadText);
		} catch (_error) {
			return;
		}

		const headsetId = Number(payload?.deviceId);
		if (!Number.isInteger(headsetId) || !headsetIds.includes(headsetId)) {
			return;
		}

		const state = payload?.state && typeof payload.state === 'object' ? payload.state : {};
		const currentStatus = dashboardState.headsetStatus.get(headsetId) || createDefault();
		const nextStatus = applyStatusState(currentStatus, state, payload) || currentStatus;
		dashboardState.headsetStatus.set(headsetId, nextStatus);

		const hasImmersionStartedAt = Number.isFinite(dashboardState.headsetImmersedAt.get(headsetId));
		if (!hasImmersionStartedAt && hasEnteredImmersion(state, payload)) {
			const eventAtMs = Number(payload?.at);
			dashboardState.headsetImmersedAt.set(
				headsetId,
				Number.isFinite(eventAtMs) ? eventAtMs : Date.now(),
			);

			const sessionId = nextSessionId++;
			dashboardState.headsetSessionId.set(headsetId, sessionId);
			writeLogLine(`[dashboard] Session #${sessionId} started for headset ${headsetId}`);
		}
	}

	// Headset colors are configured as hex ('#ff4902' or '#f40'); translate
	// to a truecolor SGR escape for the TUI. Strings that are already ANSI
	// escapes pass through unchanged.
	function headsetColorToAnsi(color) {
		if (typeof color !== 'string' || color.length === 0) return null;
		if (color.startsWith('\x1b[')) return color;
		const hex = color.trim().replace(/^#/, '');
		const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
		if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
		const r = parseInt(full.slice(0, 2), 16);
		const g = parseInt(full.slice(2, 4), 16);
		const b = parseInt(full.slice(4, 6), 16);
		return `\x1b[38;2;${r};${g};${b}m`;
	}

	function colorizeHeadsetHeader(headset, label) {
		const color = headsetColorToAnsi(headset.color);
		if (!color) {
			return label;
		}
		return `${color}${label}${ANSI_RESET}`;
	}

	function renderDashboard() {
		if (!enabled) {
			return;
		}

		pruneRecentLogs();

		const columnCount = Math.max(1, headsets.length);
		// Respect the real terminal width: padding lines wider than the actual
		// columns wraps them and makes the frame taller than the screen.
		const terminalWidth = Math.max(20, Number(process.stdout.columns) || 120);
		const terminalRows = Math.max(0, Number(process.stdout.rows) || 0);
		const colWidth = Math.max(12, Math.floor((terminalWidth - (columnCount * 3 - 1) - 4) / columnCount));
		const tableWidth = (colWidth * columnCount) + (columnCount * 3 - 1) + 4;
		const timestamp = new Date().toLocaleTimeString();
		const logWindowSeconds = (logWindowMs / 1000).toFixed(1);

		const statusOf = (headset) => dashboardState.headsetStatus.get(headset.id) || createDefault();

		const headerLine = headsets
			.map((headset) => colorizeHeadsetHeader(headset, fitToWidth(headset.label ?? `Headset ${headset.id}`, colWidth)))
			.join(' | ');
		const sessionLine = headsets
			.map((headset) => {
				const connected = dashboardState.headsetConnected.get(headset.id) === true;
				if (!connected) return fitToWidth('Session: --:--:--', colWidth);
				const sessionId = dashboardState.headsetSessionId.get(headset.id);
				const sessionLabel = Number.isInteger(sessionId) ? `#${sessionId} ` : '';
				const immersedAt = dashboardState.headsetImmersedAt.get(headset.id);
				if (!Number.isFinite(immersedAt)) return fitToWidth(`Session: ${sessionLabel}waiting XR`, colWidth);
				const elapsedMs = Date.now() - immersedAt;
				return fitToWidth(`Session: ${sessionLabel}${formatDuration(elapsedMs)}`, colWidth);
			})
			.join(' | ');
		const statusLine = headsets
			.map((headset) => {
				const connected = dashboardState.headsetConnected.get(headset.id) === true;
				if (!connected) {
					return fitToWidth('Not connected', colWidth);
				}
				const status = statusOf(headset);
				return fitToWidth(status.enteredImmersion ? 'Immersed' : 'Connected', colWidth);
			})
			.join(' | ');
		const tableDividerLine = '-'.repeat(Math.max(1, Math.min(tableWidth, terminalWidth - 1)));
		const columnLines = columns.map((column) => headsets
			.map((headset) => fitToWidth(column.render(statusOf(headset), headset), colWidth))
			.join(' | '));

		const connectionLines = [...dashboardState.extraConnections.entries()]
			.map(([label, connected]) => `${label[0].toUpperCase()}${label.slice(1)}: ${connected ? 'Connected' : 'Not connected'}`);
		const serverIpLine = fitToWidth(
			dashboardState.serverIps.length ? `Server IP: ${dashboardState.serverIps.join(', ')}` : 'Server IP: not detected',
			terminalWidth
		);

		const logLines = dashboardState.recentLogs
			.slice(-12)
			.map((entry) => {
				const ageSeconds = ((Date.now() - entry.at) / 1000).toFixed(1);
				return fitToWidth(`  [${ageSeconds}s] ${entry.line}`, terminalWidth);
			});

		const fixedLines = [
			`${title} (${timestamp})`,
			'',
			headerLine,
			sessionLine,
			statusLine,
			tableDividerLine,
			...columnLines,
			'',
			...connectionLines,
			serverIpLine,
			'',
			`Recent logs (${logWindowSeconds}s):`,
		];

		// Keep the whole frame within the visible screen: a frame taller than
		// the terminal scrolls the alt screen on every repaint, which looks
		// like frames appending/concatenating. The trailing newline written
		// after the frame needs one spare row, hence rows - 1.
		const rowBudget = terminalRows > 0 ? Math.max(0, terminalRows - 1) : Infinity;
		const visibleLogLines = logLines.length > 0 ? logLines : ['  (no recent logs)'];
		const availableLogRows = Math.max(0, rowBudget - fixedLines.length);
		let shownLogLines;
		if (visibleLogLines.length <= availableLogRows) {
			shownLogLines = visibleLogLines;
		} else if (availableLogRows <= 0) {
			shownLogLines = [];
		} else if (availableLogRows === 1) {
			shownLogLines = [fitToWidth(`  ... ${visibleLogLines.length} older log line(s) hidden`, terminalWidth)];
		} else {
			const keepCount = availableLogRows - 1;
			shownLogLines = [
				fitToWidth(`  ... ${visibleLogLines.length - keepCount} older log line(s) hidden`, terminalWidth),
				...visibleLogLines.slice(-keepCount),
			];
		}

		const lines = [
			...fixedLines,
			...shownLogLines,
		];

		process.stdout.write(`\x1b[2J\x1b[H${lines.join('\n')}\n`);
	}

	function enterDashboardScreen() {
		if (!enabled || !process.stdout.isTTY || dashboardUsingAltScreen) {
			return;
		}

		process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
		dashboardUsingAltScreen = true;
	}

	function exitDashboardScreen() {
		if (!dashboardUsingAltScreen) {
			return;
		}

		process.stdout.write('\x1b[?25h\x1b[?1049l');
		dashboardUsingAltScreen = false;
	}

	function writeLogLine(line, isError = false) {
		const normalizedLine = String(line).replace(/\r?\n$/, '');
		updateConnectionStatusFromLine(normalizedLine);
		updateStatusFromLine(normalizedLine);
		if (enabled) {
			if (suppressLogPatterns.some((pattern) => normalizedLine.includes(pattern))) {
				return;
			}
			dashboardState.recentLogs.push({ at: Date.now(), line: normalizedLine });
			// No immediate repaint: high-frequency status lines (e.g. per
			// pointer-move updates) would otherwise trigger a full-screen
			// rewrite per event. The refresh interval repaints at refreshMs.
			return;
		}

		const stream = isError ? process.stderr : process.stdout;
		stream.write(`${normalizedLine}\n`);
	}

	if (enabled) {
		enterDashboardScreen();
		renderDashboard();
		dashboardRefreshTimer = setInterval(() => {
			renderDashboard();
		}, refreshMs);
		dashboardRefreshTimer.unref?.();
	}

	function pipeWithPrefix(stream, prefix) {
		let buffer = '';

		stream.on('data', (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() || '';

			for (const line of lines) {
				writeLogLine(`${prefix} ${line}`);
			}
		});

		stream.on('end', () => {
			if (buffer.length > 0) {
				writeLogLine(`${prefix} ${buffer}`);
				buffer = '';
			}
		});
	}

	function startProcess(processConfig) {
		const args = Array.isArray(processConfig.args) ? processConfig.args : [];
		const child = spawn(processConfig.command, args, {
			cwd: processConfig.cwd || process.cwd(),
			env: processConfig.env || process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		pipeWithPrefix(child.stdout, `[${processConfig.name}]`);
		pipeWithPrefix(child.stderr, `[${processConfig.name}]`);

		return child;
	}

	function startHelperServer(resolvedPage) {
		const preferredPort = Number(resolvedPage.port ?? 80);
		const fallbackPort = Number(resolvedPage.fallbackPort ?? 3000);
		const portsToTry = Number.isFinite(preferredPort)
			? [preferredPort, fallbackPort]
			: [80, fallbackPort];

		const helperServer = http.createServer((req, res) => {
			const hostHeader = req.headers.host || '';
			const requestedHost = hostHeader.split(':')[0] || 'localhost';
			const page = createHelperPage({ pageConfig: resolvedPage, host: requestedHost, headsets });

			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(page);
		});

		function listenAtIndex(index) {
			if (index >= portsToTry.length) {
				writeLogLine('[helper] Could not start helper page server on any configured port.', true);
				return;
			}

			const port = portsToTry[index];

			helperServer.once('error', (error) => {
				if ((error.code === 'EACCES' || error.code === 'EADDRINUSE') && index + 1 < portsToTry.length) {
					writeLogLine(
						`[helper] Port ${port} unavailable (${error.code}), trying ${portsToTry[index + 1]}.`,
						true
					);
					listenAtIndex(index + 1);
					return;
				}

				writeLogLine(`[helper] Failed to start helper page: ${error.message}`, true);
			});

			helperServer.listen(port, '0.0.0.0', () => {
				const actualPort = helperServer.address() && helperServer.address().port;
				writeLogLine(`[helper] Permission page running on http://localhost:${actualPort}`);
				for (const ip of getLanIpCandidates()) {
					writeLogLine(
						`[helper] Open on Quest: http://${ip}${actualPort === 80 ? '' : `:${actualPort}`}`
					);
				}
			});
		}

		listenAtIndex(0);

		return helperServer;
	}

	// Default helper-page links, derived from the app's HTTPS port and the
	// labeled top-level project routes. Empty when no appHttpsPort is known
	// (e.g. standalone classic-mode dashboards) or no routes are labeled —
	// the headset links below are the point of the launch page.
	function helperBaseUrl() {
		const port = Number(appHttpsPort);
		return Number.isFinite(port) && port > 0 ? `https://{host}:${port}` : null;
	}

	function defaultHelperLinks() {
		const base = helperBaseUrl();
		if (!base) return [];
		return (Array.isArray(appRoutes) ? appRoutes : [])
			.filter((route) => route && route.path && typeof route.label === 'string' && route.label.trim())
			.map((route) => ({ label: String(route.label).trim(), href: `${base}${route.path}` }));
	}

	function defaultHelperHeadsetLinks() {
		const base = helperBaseUrl();
		if (!base) return [];
		return [
			{ label: '{label}', href: `${base}?deviceid={id}` },
			{ label: 'Setup {label}', href: `${base}?deviceid={id}&admin=1` },
		];
	}

	function resolveHelperPage(pageConfig) {
		if (!pageConfig) return null;
		const base = pageConfig === true ? {} : pageConfig;
		return {
			...base,
			// Default heading: "<dashboard title> Launch" so the page introduces
			// itself as the project, not the framework. Skip the generic
			// 'Dashboard' default — then the template's own fallback applies.
			heading: base.heading ?? (typeof title === 'string' && title && title !== 'Dashboard' ? `${title} Launch` : base.heading),
			links: Array.isArray(base.links) ? base.links : defaultHelperLinks(),
			headsetLinks: base.headsetLinks !== undefined ? base.headsetLinks : defaultHelperHeadsetLinks(),
		};
	}

	const resolvedHelperPage = resolveHelperPage(helperPage);
	const helperServer = resolvedHelperPage ? startHelperServer(resolvedHelperPage) : null;

	const processes = processConfigs.map((processConfig) => ({
		name: processConfig.name,
		child: startProcess(processConfig),
		exited: false,
	}));

	let shuttingDown = false;
	let exitCode = 0;

	function allExited() {
		return processes.every((entry) => entry.exited);
	}

	function shutdown(signal) {
		if (shuttingDown) {
			return;
		}

		shuttingDown = true;

		for (const entry of processes) {
			if (!entry.exited) {
				entry.child.kill(signal);
			}
		}

		if (helperServer?.listening) {
			helperServer.close();
		}

		if (dashboardRefreshTimer) {
			clearInterval(dashboardRefreshTimer);
			dashboardRefreshTimer = null;
		}

		exitDashboardScreen();

		setTimeout(() => {
			for (const entry of processes) {
				if (!entry.exited) {
					entry.child.kill('SIGKILL');
				}
			}
		}, 2000);
	}

	if (handleSignals) {
		for (const signal of ['SIGINT', 'SIGTERM']) {
			process.on(signal, () => shutdown(signal));
		}
	}

	for (const entry of processes) {
		entry.child.on('exit', (code, signal) => {
			entry.exited = true;

			if (typeof code === 'number' && code !== 0 && exitCode === 0) {
				exitCode = code;
			}

			if (!shuttingDown) {
				shutdown('SIGTERM');
			}

			if (allExited()) {
				if (signal && exitCode === 0) {
					exitDashboardScreen();
					process.exit(0);
				}
				exitDashboardScreen();
				process.exit(exitCode);
			}
		});

		entry.child.on('error', (error) => {
			entry.exited = true;
			if (exitCode === 0) {
				exitCode = 1;
			}

			writeLogLine(`[${entry.name}] Failed to start: ${error.message}`, true);
			shutdown('SIGTERM');

			if (allExited()) {
				exitDashboardScreen();
				process.exit(exitCode);
			}
		});
	}

	return {
		processes,
		helperServer,
		shutdown,
		state: dashboardState,
		writeLogLine,
	};
}
