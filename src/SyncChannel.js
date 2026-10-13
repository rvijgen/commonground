/**
 * cg.sync — generic cross-headset event channel.
 *
 *   cg.sync.emit('tileGrab', payload);
 *   cg.sync.on('tileGrab', (payload, { deviceId, at }) => { ... });
 *
 * Every OTHER connected client receives the event (the sender applies its own
 * events locally and gets no echo); spectator clients (clientRole=screen)
 * receive but cannot emit. Emits made before the socket connects are queued
 * and flushed on connect.
 *
 * `enabled` (get/set) controls runtime participation: while false, emit() is
 * a silent no-op (messages are dropped, not queued; any queued pre-connect
 * messages are discarded) and incoming events are not delivered to handlers.
 * Subscribe to changes with onEnabledChange(fn).
 */
export class SyncChannel {
	constructor(socketProvider, { resolveEnabled } = {}) {
		this._socketProvider = socketProvider;
		this._socket = null;
		this._handlers = new Map();
		this._queue = [];
		this._attachPromise = null;
		this._enabled = true;
		this._enabledListeners = new Set();

		if (typeof resolveEnabled === 'function') {
			Promise.resolve()
				.then(resolveEnabled)
				.then((value) => {
					if (typeof value === 'boolean') this.enabled = value;
				})
				.catch(() => {});
		}
	}

	get enabled() {
		return this._enabled;
	}

	set enabled(value) {
		const next = Boolean(value);
		if (next === this._enabled) return;
		this._enabled = next;
		if (!next) {
			this._queue.length = 0;
		}
		for (const listener of this._enabledListeners) {
			listener(next);
		}
	}

	onEnabledChange(listener) {
		if (typeof listener !== 'function') return () => {};
		this._enabledListeners.add(listener);
		return () => this._enabledListeners.delete(listener);
	}

	_attach() {
		if (this._attachPromise) return this._attachPromise;
		this._attachPromise = Promise.resolve(this._socketProvider())
			.then((socket) => {
				if (!socket) return;
				this._socket = socket;
				socket.on('cg:sync', (envelope) => this._dispatch(envelope));
				socket.on('connect', () => this._flush());
				this._flush();
			});
		return this._attachPromise;
	}

	_flush() {
		if (!this._socket || !this._socket.connected) return;
		while (this._queue.length > 0) {
			const message = this._queue.shift();
			this._socket.emit('cg:sync', message);
		}
	}

	_dispatch(envelope) {
		if (!this._enabled) return;
		if (!envelope || typeof envelope.type !== 'string') return;
		const handlers = this._handlers.get(envelope.type);
		if (!handlers) return;
		const meta = { deviceId: envelope.deviceId ?? null, at: envelope.at ?? null };
		for (const handler of handlers) {
			handler(envelope.payload, meta);
		}
	}

	emit(type, payload) {
		if (!this._enabled) return;
		const message = { type: String(type), payload: payload ?? null };
		if (this._socket?.connected) {
			this._socket.emit('cg:sync', message);
			return;
		}
		this._queue.push(message);
		this._attach();
	}

	on(type, handler) {
		if (typeof handler !== 'function') return () => {};
		const key = String(type);
		if (!this._handlers.has(key)) {
			this._handlers.set(key, new Set());
		}
		this._handlers.get(key).add(handler);
		this._attach();
		return () => this.off(key, handler);
	}

	off(type, handler) {
		const handlers = this._handlers.get(String(type));
		if (!handlers) return;
		handlers.delete(handler);
		if (handlers.size === 0) {
			this._handlers.delete(String(type));
		}
	}
}
