/**
 * cg.stream — shared "stream headset poses" toggle plus the pose fan-out.
 *
 *   cg.stream.setEnabled(true);
 *   cg.stream.enabled;                          // last state from the server
 *   cg.stream.onEnabledChange((enabled) => {});
 *   cg.stream.onPose(({ deviceId, position, quaternion, at }) => {});
 *
 * One toggle per server: any non-screen client may set it, the new state is
 * broadcast to every client (sender included), and late joiners receive the
 * current state on connect. While enabled, immersed pages send their camera
 * pose (~10 Hz, driven by CommonGround's render loop via sendPose); the
 * server stamps deviceId/at and relays to every OTHER client. Screen-role
 * clients receive state and poses but cannot emit either.
 */
export class StreamChannel {
	constructor(socketProvider) {
		this._socketProvider = socketProvider;
		this._socket = null;
		this._attachPromise = null;
		this._enabled = false;
		this._enabledListeners = new Set();
		this._poseListeners = new Set();
	}

	get enabled() {
		return this._enabled;
	}

	setEnabled(value) {
		this._attach();
		if (this._socket?.connected) {
			this._socket.emit('cg:stream', { enabled: Boolean(value) });
		}
	}

	onEnabledChange(listener) {
		if (typeof listener !== 'function') return () => {};
		this._enabledListeners.add(listener);
		this._attach();
		return () => this._enabledListeners.delete(listener);
	}

	onPose(listener) {
		if (typeof listener !== 'function') return () => {};
		this._poseListeners.add(listener);
		this._attach();
		return () => this._poseListeners.delete(listener);
	}

	/**
	 * Lazily open the socket and subscribe to the server-pushed state. Called
	 * by CommonGround at init so `enabled` tracks the server even before any
	 * listener registers (headset pages send poses without any subscriber).
	 */
	attach() {
		if (this._attachPromise) return this._attachPromise;
		this._attachPromise = Promise.resolve(this._socketProvider())
			.then((socket) => {
				if (!socket) return;
				this._socket = socket;
				socket.on('cg:stream', (payload) => this._applyEnabled(payload?.enabled));
				socket.on('cg:pose', (message) => this._dispatchPose(message));
			});
		return this._attachPromise;
	}

	_attach() {
		this.attach();
	}

	_applyEnabled(value) {
		const next = Boolean(value);
		if (next === this._enabled) return;
		this._enabled = next;
		for (const listener of this._enabledListeners) {
			listener(next);
		}
	}

	_dispatchPose(message) {
		if (!message || typeof message !== 'object') return;
		for (const listener of this._poseListeners) {
			listener(message);
		}
	}

	/**
	 * Internal sender, driven by CommonGround's render loop (which throttles
	 * to ~10 Hz and only calls while streaming + immersed). No queueing:
	 * poses are ephemeral, dropping them while offline is correct.
	 */
	sendPose(pose) {
		if (!this._enabled) return;
		if (this._socket?.connected) {
			this._socket.emit('cg:pose', pose);
		}
	}
}
