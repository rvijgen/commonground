import { Server } from 'socket.io';

const CONNECT_LOG_DELAY_MS = 250;

/**
 * Typo-tolerant deviceId parser shared by server and dashboard tooling.
 * Accepts ?deviceId=, ?deviceid= and the historical ?deviced= variant.
 * Returns an integer device id or null.
 */
export function parseDeviceIdQuery(query) {
	const raw = query?.deviceId ?? query?.deviceid ?? query?.deviced ?? null;
	const parsed = Number(raw);
	return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Reverse proxies behind a path prefix sometimes forward //socket.io/...
 * Collapse the duplicate leading slashes before socket.io sees the request.
 */
export function normalizeSocketIoUrl(server) {
	server.prependListener('request', (req) => {
		if (typeof req.url !== 'string') return;
		if (!req.url.startsWith('//socket.io')) return;
		req.url = req.url.replace(/^\/+socket\.io/, '/socket.io');
	});
}

function getClientLabelFromSocket(socket, nextOrdinal) {
	const query = socket?.handshake?.query ?? {};
	const rawClientRole = query.clientRole ?? query.clientrole ?? null;
	const clientRole = rawClientRole == null ? '' : String(rawClientRole).trim().toLowerCase();
	if (clientRole) {
		return clientRole;
	}
	const deviceId = parseDeviceIdQuery(query);
	if (deviceId != null) {
		return `client ${deviceId}`;
	}
	return `client ${nextOrdinal()}`;
}

/**
 * Attaches socket.io to one or more HTTP(S) servers and relays events
 * between all of them, so clients connected over HTTP and HTTPS share
 * the same event stream.
 *
 *   const relay = attachSocketRelay(
 *     [{ server: httpServer, label: 'http' }, { server: httpsServer, label: 'https' }],
 *     { socketPath: '/socket.io/', quiet: false },
 *   );
 *
 * Returns a relay object:
 *   ioServers                        - all socket.io Server instances
 *   broadcast(event, message)        - emit on every ioServer
 *   broadcastExcept(socket, event, message) - emit to all but the sender
 *   coreStatus                       - { entries, get(deviceId) } for the built-in
 *                                      cg:status merge store
 *   presence                         - { get(deviceId) → { connectedAt } | null,
 *                                      keys() } for connected devices (handshake
 *                                      deviceId; screens are not tracked)
 *   registerRelayEvents(defs)        - declarative validate -> log -> broadcast
 *   registerStatusChannel(config)    - per-device status aggregation channel
 *
 * Options (besides socketPath/quiet):
 *   sync   - set false to disable the built-in cg.sync channel (default true)
 *   status - set false to disable the built-in cg.status channel (default true)
 *   onLog  - sink for structured log lines ([socket:...], [socket] ..., [status]
 *            ...); defaults to console.log. Pass an in-process dashboard's
 *            writeLogLine to feed it without child-process scraping.
 *
 * Relay event definition:
 *   {
 *     event: 'tileGrabSync',
 *     validate: (payload, socket) => message | null,  // null drops the event
 *     log: (message, socket) => summary | null,       // null silences the log line
 *     onEvent: (message, socket) => {},               // optional, after broadcast
 *   }
 * Events are logged as `[socket] <event> <summary>` (gated by quiet) and
 * broadcast to every ioServer.
 *
 * Status channel config:
 *   {
 *     event: 'statusEvent',                  // default
 *     createEntry: () => ({ state: {} }),    // per-device aggregate entry
 *     reduce: (entry, message) => {},        // merge message into entry
 *     summarize: (entry, message) => ({...}),// defaults to
 *                                            // { deviceId, action, state: entry.state, at }
 *     onStatus: (message, entry) => {},      // optional, after aggregation
 *   }
 * The message passed to reduce/summarize is normalized:
 *   { sourceSocketId, sourceId, deviceId, action, payload, state, at }
 * deviceId comes from payload.deviceId, falling back to the (typo-tolerant)
 * handshake query. Each aggregation is logged as `[status] <json summary>`
 * (unconditional — the dashboard scrapes these lines) and broadcast to
 * every ioServer. Device entries are dropped when the socket disconnects.
 */
export function attachSocketRelay(servers, options = {}) {
	const {
		socketPath = '/socket.io/',
		quiet = process.env.QUIET_LOGS === '1',
		sync = true,
		status = true,
		onLog = null,
		hasEnteredImmersion = (state) => Boolean(state?.enteredImmersion),
	} = options;

	const ioServers = [];
	const clientLabelBySocketId = new Map();
	const clientLogStateBySocketId = new Map();
	const deviceIdBySocketId = new Map();
	// Presence: deviceId (from the typo-tolerant handshake query) →
	// { connectedAt, socketIds }. A device stays present while any of its
	// sockets is connected (e.g. headset page + admin page share a deviceId).
	// Screen-role clients carry no deviceId and are never tracked.
	const presenceByDeviceId = new Map();
	// Immersion: deviceId → timestamp of the first cg:status update whose
	// merged state satisfies hasEnteredImmersion. Session-scoped like
	// presence: cleared when the device's last socket disconnects.
	const immersedAtByDeviceId = new Map();
	let nextClientOrdinal = 1;
	const statusChannels = [];
	const coreStatusStates = new Map();

	// Structured log lines ([socket:...], [socket] ..., [status] ...) go to the
	// onLog sink when provided (e.g. an in-process dashboard), else stdout.
	function logLine(line) {
		if (typeof onLog === 'function') {
			onLog(line);
			return;
		}
		console.log(line);
	}

	function broadcast(event, message) {
		for (const ioServer of ioServers) {
			ioServer.emit(event, message);
		}
	}

	// Broadcast to every connected client EXCEPT the sender socket (the sender
	// applies its own events locally; spectator clients still receive them).
	function broadcastExcept(senderSocket, event, message) {
		for (const ioServer of ioServers) {
			if (senderSocket && ioServer.sockets.sockets.has(senderSocket.id)) {
				senderSocket.broadcast.emit(event, message);
			} else {
				ioServer.emit(event, message);
			}
		}
	}

	function isScreenSocket(socket) {
		const rawClientRole = socket?.handshake?.query?.clientRole ?? socket?.handshake?.query?.clientrole ?? null;
		return rawClientRole != null && String(rawClientRole).trim().toLowerCase() === 'screen';
	}

	// cg.sync: generic cross-headset event channel. The server stamps deviceId
	// and timestamp onto the { type, payload } envelope and relays it to every
	// other client; screen-role clients receive but cannot emit.
	function attachCoreSyncChannel(socket) {
		socket.on('cg:sync', (envelope) => {
			if (isScreenSocket(socket)) return;
			const safeEnvelope = envelope && typeof envelope === 'object' ? envelope : {};
			if (typeof safeEnvelope.type !== 'string' || safeEnvelope.type.length === 0) return;
			const message = {
				type: safeEnvelope.type,
				payload: safeEnvelope.payload ?? null,
				deviceId: parseDeviceIdQuery(socket?.handshake?.query ?? {}),
				at: Date.now(),
			};
			broadcastExcept(socket, 'cg:sync', message);
		});
	}

	// cg.status: dumb per-device merge store. Each partial update is
	// shallow-merged into the device's last-known state, logged as a
	// [status] line (dashboard contract) and broadcast to all clients
	// (spectator screens listen). Disconnect clears the device entry.
	function attachCoreStatusChannel(socket) {
		socket.on('cg:status', (partial) => {
			if (isScreenSocket(socket)) return;
			if (!partial || typeof partial !== 'object' || Array.isArray(partial)) return;
			const deviceId = parseDeviceIdQuery(socket?.handshake?.query ?? {});
			const current = deviceId != null ? (coreStatusStates.get(deviceId) ?? {}) : {};
			const next = { ...current, ...partial };
			const at = Date.now();
			if (deviceId != null) {
				coreStatusStates.set(deviceId, next);
				if (!immersedAtByDeviceId.has(deviceId) && hasEnteredImmersion(next)) {
					immersedAtByDeviceId.set(deviceId, at);
				}
			}
			const summary = { deviceId, state: next, at };
			logLine(`[status] ${JSON.stringify(summary)}`);
			broadcast('cg:status', summary);
		});
	}

	function registerRelayEvents(socket, defs) {
		for (const def of defs) {
			if (!def || typeof def.event !== 'string' || typeof def.validate !== 'function') continue;
			socket.on(def.event, (payload) => {
				const message = def.validate(payload, socket);
				if (message == null) {
					return;
				}

				if (!quiet && typeof def.log !== 'undefined') {
					const summary = def.log === null ? null : def.log(message, socket);
					if (summary != null) {
						logLine(`[socket] ${def.event} ${JSON.stringify(summary)}`);
					}
				} else if (!quiet) {
					logLine(`[socket] ${def.event} ${JSON.stringify(message)}`);
				}

				broadcast(def.event, message);

				if (typeof def.onEvent === 'function') {
					def.onEvent(message, socket);
				}
			});
		}
	}

	function attachStatusChannels(socket, channels = statusChannels) {
		for (const channel of channels) {
			socket.on(channel.event, (payload) => {
				const safePayload = payload && typeof payload === 'object' ? payload : null;
				if (!safePayload) {
					return;
				}

				const payloadDeviceId = Number(safePayload.deviceId);
				const fallbackDeviceId = parseDeviceIdQuery(socket?.handshake?.query ?? {});
				const resolvedDeviceId = Number.isInteger(payloadDeviceId)
					? payloadDeviceId
					: fallbackDeviceId;
				const message = {
					sourceSocketId: socket.id,
					sourceId: safePayload.sourceId != null ? String(safePayload.sourceId) : null,
					deviceId: resolvedDeviceId,
					action: typeof safePayload.action === 'string' ? safePayload.action : 'unknown',
					payload: safePayload.payload && typeof safePayload.payload === 'object'
						? safePayload.payload
						: {},
					state: safePayload.state && typeof safePayload.state === 'object' ? safePayload.state : {},
					at: Number.isFinite(Number(safePayload.at)) ? Number(safePayload.at) : Date.now(),
				};

				const entry = Number.isInteger(message.deviceId)
					? (channel.entries.get(message.deviceId) ?? channel.createEntry())
					: channel.createEntry();
				channel.reduce(entry, message);
				if (Number.isInteger(message.deviceId)) {
					channel.entries.set(message.deviceId, entry);
				}

				const summary = channel.summarize(entry, message);
				logLine(`[status] ${JSON.stringify(summary)}`);

				broadcast(channel.event, message);

				if (typeof channel.onStatus === 'function') {
					channel.onStatus(message, entry);
				}
			});
		}
	}

	function setupSocketServer(server, label) {
		const io = new Server(server, {
			path: socketPath,
			cors: { origin: '*' },
		});
		ioServers.push(io);

		io.on('connection', (socket) => {
			const clientLabel = getClientLabelFromSocket(socket, () => nextClientOrdinal++);
			const deviceId = parseDeviceIdQuery(socket?.handshake?.query ?? {});
			clientLabelBySocketId.set(socket.id, clientLabel);
			if (deviceId != null) {
				deviceIdBySocketId.set(socket.id, deviceId);
				const presence = presenceByDeviceId.get(deviceId) ?? { connectedAt: Date.now(), socketIds: new Set() };
				presence.socketIds.add(socket.id);
				presenceByDeviceId.set(deviceId, presence);
			}
			const connectLogTimer = setTimeout(() => {
				const state = clientLogStateBySocketId.get(socket.id);
				if (!state) return;
				state.connectedLogged = true;
				logLine(`[socket:${label}] connected ${clientLabel}`);
			}, CONNECT_LOG_DELAY_MS);
			clientLogStateBySocketId.set(socket.id, {
				label,
				clientLabel,
				connectLogTimer,
				connectedLogged: false,
			});

			attachStatusChannels(socket);
			if (sync) attachCoreSyncChannel(socket);
			if (status) attachCoreStatusChannel(socket);

			socket.on('disconnect', () => {
				const disconnectedClientLabel = clientLabelBySocketId.get(socket.id) || 'client ?';
				const disconnectedDeviceId = deviceIdBySocketId.get(socket.id);
				const state = clientLogStateBySocketId.get(socket.id) || null;
				if (state?.connectLogTimer) {
					clearTimeout(state.connectLogTimer);
				}
				clientLabelBySocketId.delete(socket.id);
				clientLogStateBySocketId.delete(socket.id);
				deviceIdBySocketId.delete(socket.id);
				if (disconnectedDeviceId != null) {
					for (const channel of statusChannels) {
						channel.entries.delete(disconnectedDeviceId);
					}
					coreStatusStates.delete(disconnectedDeviceId);
					// Immersion ends with the socket, like the CLI dashboard's
					// session end on disconnect — a reloading page must not
					// keep the previous session's immersion timestamp.
					immersedAtByDeviceId.delete(disconnectedDeviceId);
					const presence = presenceByDeviceId.get(disconnectedDeviceId);
					if (presence) {
						presence.socketIds.delete(socket.id);
						if (presence.socketIds.size === 0) {
							presenceByDeviceId.delete(disconnectedDeviceId);
						}
					}
				}
				if (state?.connectedLogged) {
					logLine(`[socket:${label}] disconnected ${disconnectedClientLabel}`);
				}
			});
		});

		return io;
	}

	for (const entry of servers || []) {
		if (!entry || !entry.server) continue;
		normalizeSocketIoUrl(entry.server);
		setupSocketServer(entry.server, entry.label || 'socket');
	}

	return {
		ioServers,
		broadcast,
		broadcastExcept,
		// Connected-device presence keyed by handshake deviceId. get() returns
		// { connectedAt } while any socket for the device is connected, else
		// null; keys() lists the currently connected deviceIds.
		presence: {
			get: (deviceId) => {
				const entry = presenceByDeviceId.get(Number(deviceId));
				return entry ? { connectedAt: entry.connectedAt } : null;
			},
			keys: () => [...presenceByDeviceId.keys()],
		},
		// Immersion start timestamp per device (first cg:status whose merged
		// state satisfies hasEnteredImmersion), null while not immersed.
		immersion: {
			get: (deviceId) => immersedAtByDeviceId.get(Number(deviceId)) ?? null,
		},
		coreStatus: {
			entries: coreStatusStates,
			get: (deviceId) => coreStatusStates.get(deviceId) ?? null,
		},
		registerRelayEvents(defs) {
			const defsArray = Array.isArray(defs) ? defs : [defs];
			for (const ioServer of ioServers) {
				ioServer.on('connection', (socket) => registerRelayEvents(socket, defsArray));
			}
			for (const ioServer of ioServers) {
				for (const socket of ioServer.sockets.sockets.values()) {
					registerRelayEvents(socket, defsArray);
				}
			}
		},
		registerStatusChannel(config = {}) {
			const channel = {
				event: typeof config.event === 'string' ? config.event : 'statusEvent',
				createEntry: typeof config.createEntry === 'function' ? config.createEntry : () => ({ state: {} }),
				reduce: typeof config.reduce === 'function' ? config.reduce : () => {},
				summarize: typeof config.summarize === 'function'
					? config.summarize
					: (entry, message) => ({
						deviceId: message.deviceId,
						action: message.action,
						state: entry.state,
						at: message.at,
					}),
				onStatus: typeof config.onStatus === 'function' ? config.onStatus : null,
				entries: new Map(),
			};
			statusChannels.push(channel);
			for (const ioServer of ioServers) {
				for (const socket of ioServer.sockets.sockets.values()) {
					attachStatusChannels(socket, [channel]);
				}
			}
			return {
				event: channel.event,
				entries: channel.entries,
				getStatus: (deviceId) => channel.entries.get(deviceId)?.state ?? null,
			};
		},
	};
}
