/**
 * cg.status — client-computed, server-remembered status.
 *
 *   cg.status.update({ enteredImmersion: true, tileDraggedCount: 3 });
 *   cg.status.onStatus(({ deviceId, state, at }) => { ... });  // spectator pages
 *
 * Each update is a plain partial-state object that the server shallow-merges
 * into the per-device last-known state, broadcasts to all clients, and logs
 * for the dashboard. The server forgets a device's state on disconnect.
 */
export class StatusChannel {
	constructor(socketProvider) {
		this._socketProvider = socketProvider;
		this._socket = null;
		this._listeners = new Set();
		this._queue = [];
		this._attachPromise = null;
	}

	_attach() {
		if (this._attachPromise) return this._attachPromise;
		this._attachPromise = Promise.resolve(this._socketProvider())
			.then((socket) => {
				if (!socket) return;
				this._socket = socket;
				socket.on('cg:status', (summary) => {
					for (const listener of this._listeners) {
						listener(summary);
					}
				});
				socket.on('connect', () => this._flush());
				this._flush();
			});
		return this._attachPromise;
	}

	_flush() {
		if (!this._socket || !this._socket.connected) return;
		while (this._queue.length > 0) {
			const partial = this._queue.shift();
			this._socket.emit('cg:status', partial);
		}
	}

	update(partialState) {
		if (!partialState || typeof partialState !== 'object' || Array.isArray(partialState)) return;
		if (this._socket?.connected) {
			this._socket.emit('cg:status', partialState);
			return;
		}
		this._queue.push(partialState);
		this._attach();
	}

	onStatus(listener) {
		if (typeof listener !== 'function') return () => {};
		this._listeners.add(listener);
		this._attach();
		return () => this._listeners.delete(listener);
	}
}
