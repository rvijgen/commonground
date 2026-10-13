const DEFAULT_SOCKET_PATH = '/socket.io/';

function loadScript(src) {
	return new Promise((resolve, reject) => {
		const existing = document.querySelector(`script[data-src="${src}"]`);
		if (existing) {
			existing.addEventListener('load', resolve, { once: true });
			existing.addEventListener('error', reject, { once: true });
			return;
		}
		const script = document.createElement('script');
		script.src = src;
		script.async = true;
		script.dataset.src = src;
		script.addEventListener('load', resolve, { once: true });
		script.addEventListener('error', reject, { once: true });
		document.head.appendChild(script);
	});
}

/**
 * Typo-tolerant deviceId parsing for the page URL, matching the server-side
 * parseDeviceIdQuery: ?deviceId= / ?deviceid= / ?deviced= (plus ?device=).
 */
export function parseDeviceIdFromLocation(search) {
	if (typeof window === 'undefined' && search === undefined) return null;
	const params = new URLSearchParams(search ?? window.location.search);
	const raw = params.get('deviceId')
		?? params.get('deviceid')
		?? params.get('deviced')
		?? params.get('device');
	if (raw == null || String(raw).trim() === '') return null;
	const parsed = Number.parseInt(String(raw).trim(), 10);
	return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Parses ?sync=1/0 (also true/false/on/off, any casing of the key) from the
 * page URL. Returns true/false, or null when no usable param is present.
 */
export function parseSyncParamFromLocation(search) {
	if (typeof window === 'undefined' && search === undefined) return null;
	const params = new URLSearchParams(search ?? window.location.search);
	let raw = null;
	for (const [key, value] of params.entries()) {
		if (key.toLowerCase() === 'sync') {
			raw = value;
			break;
		}
	}
	if (raw == null) return null;
	const normalized = String(raw).trim().toLowerCase();
	if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
	if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
	return null;
}

/**
 * Resolves the initial cg.sync.enabled value. Resolution order:
 *   1. the page's own ?sync=1/0 URL param
 *   2. the server-provided default (GET api/client-config, relative so it
 *      works for pages served at a subpath with an API alias)
 *   3. true
 */
export async function resolveSyncEnabled({ search, fetchImpl } = {}) {
	const fromUrl = parseSyncParamFromLocation(search);
	if (fromUrl != null) return fromUrl;
	try {
		const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
		if (!doFetch) return true;
		const response = await doFetch('api/client-config', { cache: 'no-store' });
		if (response && response.ok) {
			const json = await response.json();
			return json?.syncDefault !== false;
		}
	} catch (_error) {
		// fall through to the default
	}
	return true;
}

/**
 * Lazily loads the socket.io client script from the same origin
 * (<socketPath>socket.io.js) and opens a connection. Resolves to null when
 * sockets are unavailable, so apps can run standalone without a server.
 */
export async function createSocketConnection({ socketPath = DEFAULT_SOCKET_PATH, deviceId, clientRole } = {}) {
	try {
		if (typeof window === 'undefined' || typeof document === 'undefined') {
			return null;
		}
		if (typeof window.io !== 'function') {
			await loadScript(`${socketPath}socket.io.js`);
		}
		if (typeof window.io !== 'function') {
			throw new Error('Socket.IO client failed to load');
		}
		const query = {};
		const resolvedDeviceId = deviceId ?? parseDeviceIdFromLocation();
		if (resolvedDeviceId != null) {
			query.deviceId = String(resolvedDeviceId);
		}
		if (clientRole != null && String(clientRole).trim() !== '') {
			query.clientRole = String(clientRole).trim();
		}
		const socketOptions = { path: socketPath };
		if (Object.keys(query).length > 0) {
			socketOptions.query = query;
		}
		return window.io(socketOptions);
	} catch (err) {
		console.warn('[CommonGround] socket not available:', err);
		return null;
	}
}
