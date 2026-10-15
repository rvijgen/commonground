import { PerspectiveCamera, Quaternion, Vector3, Vector4 } from 'three';
import { mapStreamPoseToWorld } from './StreamPose.js';

const STALE_POSE_MS = 1500;
const INTERPOLATE_PER_SECOND = 12;
const WINDOW_WIDTH = 480;
const WINDOW_HEIGHT = 270;
const HUD_FONT = '12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

/**
 * Converts a DOM rect (CSS pixels, viewport-relative — the mirror window's
 * body) into a WebGL scissor/viewport rect (drawing-buffer pixels, bottom-up
 * Y) on the renderer's canvas. Handles devicePixelRatio via the drawing
 * buffer vs. CSS size ratio, clips to the canvas, and returns null when the
 * rect is fully offscreen.
 */
export function divRectToCanvasScissor(divRect, canvasRect, canvasWidth, canvasHeight) {
	const scaleX = canvasRect.width > 0 ? canvasWidth / canvasRect.width : 1;
	const scaleY = canvasRect.height > 0 ? canvasHeight / canvasRect.height : 1;
	const left = Math.max(divRect.left, canvasRect.left);
	const right = Math.min(divRect.right, canvasRect.right);
	const top = Math.max(divRect.top, canvasRect.top);
	const bottom = Math.min(divRect.bottom, canvasRect.bottom);
	if (right <= left || bottom <= top) return null;
	return {
		x: (left - canvasRect.left) * scaleX,
		y: (canvasRect.bottom - bottom) * scaleY,
		width: (right - left) * scaleX,
		height: (bottom - top) * scaleY,
	};
}

/**
 * StreamMirrors — "view from headset" floating windows on the desktop page.
 * Each window renders the SAME three.js scene from a watched headset's point
 * of view, driven strictly by its streamed cg:pose (no video feed).
 *
 * Opening a window registers a cg:watch on that headset (the server
 * ref-counts watchers; a watched headset sends poses even while the shared
 * Stream toggle is off). The sceneStage-relative pose is mapped to world
 * space (shared StreamPose helper) and applied DIRECTLY to the mirror
 * camera — full orientation, not the yaw-only figure placement — smoothed
 * per frame (position lerp / quaternion slerp at ~12/s so 10 Hz updates
 * look continuous). The first pose snaps (no fly-in from the origin).
 *
 * Rendering reuses the main WebGLRenderer: per frame, each open window with
 * a fresh pose is rendered into the canvas rectangle behind its div via
 * setViewport/setScissor(+setScissorTest); the full-canvas viewport/scissor
 * state is restored afterwards so the main orbit view is unaffected. When
 * no pose has arrived for ~1.5 s the window shows a dim "not immersed"
 * placeholder instead of a frozen frame.
 */
export class StreamMirrors {
	constructor(cg, { scene, renderer, doc, fetchImpl } = {}) {
		this._cg = cg;
		this._scene = scene;
		this._renderer = renderer;
		this._doc = doc ?? (typeof document !== 'undefined' ? document : null);
		this._fetch = fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
		this._windows = new Map(); // deviceId -> window state
		this._headsetsPromise = null;
		this._unsubscribePose = null;
		this._lastFrameAt = 0;
		this._savedViewport = new Vector4();
		this._openCount = 0;
	}

	start() {
		if (!this._doc) return;
		if (typeof this._cg?.stream?.onPose === 'function') {
			this._unsubscribePose = this._cg.stream.onPose((message) => this._handlePose(message));
		}
	}

	isOpen(deviceId) {
		return this._windows.has(Number(deviceId));
	}

	async toggle(deviceId) {
		const id = Number(deviceId);
		if (this._windows.has(id)) {
			this.close(id);
			return;
		}
		await this.open(id);
	}

	async _headsets() {
		if (!this._headsetsPromise) {
			this._headsetsPromise = (async () => {
				if (!this._fetch) return [];
				try {
					const response = await this._fetch('api/client-config', { cache: 'no-store' });
					if (!response || !response.ok) return [];
					const config = await response.json();
					return Array.isArray(config?.headsets) ? config.headsets : [];
				} catch (_error) {
					return [];
				}
			})();
		}
		return this._headsetsPromise;
	}

	async open(deviceId) {
		const id = Number(deviceId);
		if (!this._doc || this._windows.has(id)) return;
		const meta = (await this._headsets()).find((headset) => Number(headset?.id) === id) ?? {};
		const state = {
			deviceId: id,
			label: String(meta.label ?? `Headset ${id}`),
			color: typeof meta.color === 'string' ? meta.color : null,
			camera: new PerspectiveCamera(95, WINDOW_WIDTH / WINDOW_HEIGHT, 0.05, 100),
			targetPosition: new Vector3(),
			targetQuaternion: new Quaternion(),
			hasPose: false,
			lastPoseAt: 0,
			stale: true,
			el: null,
			bodyEl: null,
			placeholderEl: null,
		};
		state.el = this._buildWindow(state);
		this._windows.set(id, state);
		// Watch AFTER the window exists so a pose arriving immediately finds it.
		this._cg.stream.setWatching(id, true);
	}

	close(deviceId) {
		const id = Number(deviceId);
		const state = this._windows.get(id);
		if (!state) return;
		this._cg.stream.setWatching(id, false);
		if (state.el?.parentNode) {
			state.el.parentNode.removeChild(state.el);
		}
		this._windows.delete(id);
	}

	_buildWindow(state) {
		const doc = this._doc;
		const offset = 60 + (this._openCount++ % 6) * 28;

		const win = doc.createElement('div');
		win.className = 'commonground-stream-mirror';
		win.style.cssText = [
			'position:fixed',
			`left:${offset}px`,
			`top:${offset}px`,
			`width:${WINDOW_WIDTH}px`,
			'z-index:1200',
			'border-radius:8px',
			'overflow:hidden',
			'border:1px solid rgba(255,255,255,0.25)',
			'background:rgba(15,23,42,0.35)',
			'color:#fff',
			`font:${HUD_FONT}`,
			'pointer-events:auto',
		].join(';');

		const titleBar = doc.createElement('div');
		titleBar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;background:rgba(15,23,42,0.9);cursor:move;user-select:none;touch-action:none;';
		const dot = doc.createElement('span');
		dot.style.cssText = `width:8px;height:8px;border-radius:50%;display:inline-block;background:${state.color ?? '#5b6b8c'};`;
		const title = doc.createElement('span');
		title.textContent = state.label;
		title.style.cssText = 'font-weight:600;flex:1;';
		const closeButton = doc.createElement('button');
		closeButton.type = 'button';
		closeButton.textContent = '✕';
		closeButton.style.cssText = 'background:none;border:1px solid rgba(255,255,255,0.35);border-radius:6px;color:#fff;font:inherit;padding:0 6px;cursor:pointer;';
		closeButton.addEventListener('click', () => this.close(state.deviceId));
		titleBar.appendChild(dot);
		titleBar.appendChild(title);
		titleBar.appendChild(closeButton);
		win.appendChild(titleBar);

		const body = doc.createElement('div');
		body.style.cssText = `width:${WINDOW_WIDTH}px;height:${WINDOW_HEIGHT}px;position:relative;background:transparent;`;
		const placeholder = doc.createElement('div');
		placeholder.textContent = 'not immersed';
		placeholder.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,0.85);color:#5b6b8c;letter-spacing:0.5px;';
		body.appendChild(placeholder);
		win.appendChild(body);

		this._makeDraggable(win, titleBar, closeButton);

		state.bodyEl = body;
		state.placeholderEl = placeholder;
		doc.body.appendChild(win);
		return win;
	}

	_makeDraggable(win, handle, skipElement) {
		const doc = this._doc;
		let drag = null;
		handle.addEventListener('pointerdown', (event) => {
			if (skipElement.contains(event.target)) return;
			drag = {
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				left: Number.parseFloat(win.style.left) || 0,
				top: Number.parseFloat(win.style.top) || 0,
			};
			handle.setPointerCapture?.(event.pointerId);
			event.preventDefault();
		});
		handle.addEventListener('pointermove', (event) => {
			if (!drag || event.pointerId !== drag.pointerId) return;
			const width = win.offsetWidth || WINDOW_WIDTH;
			const height = win.offsetHeight || WINDOW_HEIGHT;
			const maxLeft = Math.max(0, (doc.defaultView?.innerWidth ?? width) - width);
			const maxTop = Math.max(0, (doc.defaultView?.innerHeight ?? height) - height);
			const left = Math.min(Math.max(0, drag.left + event.clientX - drag.startX), maxLeft);
			const top = Math.min(Math.max(0, drag.top + event.clientY - drag.startY), maxTop);
			win.style.left = `${left}px`;
			win.style.top = `${top}px`;
		});
		const endDrag = (event) => {
			if (drag && event.pointerId === drag.pointerId) {
				drag = null;
			}
		};
		handle.addEventListener('pointerup', endDrag);
		handle.addEventListener('pointercancel', endDrag);
	}

	_handlePose(message) {
		const state = this._windows.get(Number(message?.deviceId));
		if (!state) return;
		const sceneStage = this._cg?.sceneManager?.sceneStage ?? null;
		mapStreamPoseToWorld(sceneStage, message.position, message.quaternion, state.targetPosition, state.targetQuaternion);
		if (!state.hasPose) {
			// First pose: snap the camera — no fly-in from the origin.
			state.camera.position.copy(state.targetPosition);
			state.camera.quaternion.copy(state.targetQuaternion);
		}
		state.hasPose = true;
		state.lastPoseAt = Date.now();
	}

	_setStale(state, stale) {
		if (state.stale === stale) return;
		state.stale = stale;
		if (state.placeholderEl) {
			state.placeholderEl.style.display = stale ? 'flex' : 'none';
		}
	}

	/**
	 * Per-frame hook from CommonGround._render: interpolate each window's
	 * camera toward its latest pose, then scissor-render every window with a
	 * fresh pose into the canvas rectangle behind its div. Stale windows keep
	 * their "not immersed" placeholder and are skipped.
	 */
	render() {
		if (this._windows.size === 0 || !this._renderer) return;
		const now = Date.now();
		const dt = this._lastFrameAt > 0 ? Math.min(0.5, (now - this._lastFrameAt) / 1000) : 0;
		this._lastFrameAt = now;
		const canvas = this._renderer.domElement;
		const canvasRect = canvas.getBoundingClientRect();

		let rendering = false;
		for (const state of this._windows.values()) {
			const fresh = state.hasPose && now - state.lastPoseAt <= STALE_POSE_MS;
			this._setStale(state, !fresh);
			if (!fresh) continue;

			if (dt > 0) {
				const alpha = 1 - Math.exp(-INTERPOLATE_PER_SECOND * dt);
				state.camera.position.lerp(state.targetPosition, alpha);
				state.camera.quaternion.slerp(state.targetQuaternion, alpha);
			}

			const bodyRect = state.bodyEl.getBoundingClientRect();
			const scissor = divRectToCanvasScissor(bodyRect, canvasRect, canvas.width, canvas.height);
			if (!scissor) continue; // fully offscreen

			if (!rendering) {
				this._renderer.getViewport(this._savedViewport);
				this._renderer.setScissorTest(true);
				rendering = true;
			}
			state.camera.aspect = bodyRect.width > 0 && bodyRect.height > 0
				? bodyRect.width / bodyRect.height
				: WINDOW_WIDTH / WINDOW_HEIGHT;
			state.camera.updateProjectionMatrix();
			this._renderer.setViewport(scissor.x, scissor.y, scissor.width, scissor.height);
			this._renderer.setScissor(scissor.x, scissor.y, scissor.width, scissor.height);
			this._renderer.render(this._scene, state.camera);
		}

		if (rendering) {
			this._renderer.setScissorTest(false);
			this._renderer.setViewport(this._savedViewport);
		}
	}

	dispose() {
		if (typeof this._unsubscribePose === 'function') {
			this._unsubscribePose();
			this._unsubscribePose = null;
		}
		for (const deviceId of [...this._windows.keys()]) {
			this.close(deviceId);
		}
	}
}
