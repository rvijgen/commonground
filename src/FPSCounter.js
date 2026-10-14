import {
	CanvasTexture,
	FrontSide,
	LinearFilter,
	Mesh,
	MeshBasicMaterial,
	PlaneGeometry,
	Quaternion,
	Vector3,
} from 'three';

const FPS_SAMPLE_WINDOW_MS = 250;
const FPS_CANVAS_WIDTH = 256;
const FPS_CANVAS_HEIGHT = 96;
const FPS_PLANE_WIDTH_M = 0.08;
const FPS_PLANE_HEIGHT_M = FPS_PLANE_WIDTH_M * (FPS_CANVAS_HEIGHT / FPS_CANVAS_WIDTH);
const FPS_HUD_OFFSET_X_M = 0;
const FPS_HUD_OFFSET_Y_M = 0.06;
const FPS_HUD_OFFSET_Z_M = -0.4;

/**
 * Resolves the fpsCounter option ('auto' | true | false) against the current
 * admin mode. 'auto' follows admin mode; explicit booleans win.
 */
export function resolveFpsCounterEnabled(mode, adminModeEnabled) {
	if (mode === 'auto' || mode == null) return !!adminModeEnabled;
	return mode === true;
}

/**
 * FPSCounter — small canvas-texture plane showing the measured frame rate,
 * sampled over 250 ms windows. The plane is attached to the active camera,
 * so it shows both in XR and in the desktop orbit view (consistent with the
 * DesktopHud living in the same corner of the desktop experience).
 *
 * CommonGround drives update() from its render loop while enabled; no
 * external frame bus required.
 */
export class FPSCounter {
	constructor(cg, options = {}) {
		this._cg = cg ?? null;
		this._label = options.label ?? 'FPS';
		this._enabled = false;
		this._lastFrameAtMs = null;
		this._sampleStartAtMs = 0;
		this._sampleFrameCount = 0;
		this._lastDisplayedFps = 0;
		this._activeCamera = null;
		this._loggedFirstVisiblePose = false;
		this._canvas = document.createElement('canvas');
		this._canvas.width = FPS_CANVAS_WIDTH;
		this._canvas.height = FPS_CANVAS_HEIGHT;
		this._ctx = this._canvas.getContext('2d');
		this._texture = new CanvasTexture(this._canvas);
		this._texture.minFilter = LinearFilter;
		this._texture.magFilter = LinearFilter;
		this._texture.generateMipmaps = false;
		this._mesh = this._createHudMesh();
		this._localHudOffset = new Vector3(FPS_HUD_OFFSET_X_M, FPS_HUD_OFFSET_Y_M, FPS_HUD_OFFSET_Z_M);
		this._viewerWorldPosition = new Vector3();
		this._viewerWorldQuaternion = new Quaternion();
		this._hudWorldOffset = new Vector3();

		this._drawLabel('--');
	}

	get enabled() {
		return this._enabled;
	}

	set enabled(value) {
		const next = Boolean(value);
		if (next === this._enabled) return;
		this._enabled = next;
		if (!next) {
			this._mesh.visible = false;
			this._activeCamera = null;
			// Reset sampling so a re-enable doesn't blend stale frames.
			this._lastFrameAtMs = null;
			// Re-log the first visible pose after a re-enable (device diagnostics).
			this._loggedFirstVisiblePose = false;
		}
	}

	get lastDisplayedFps() {
		return this._lastDisplayedFps;
	}

	_createHudMesh() {
		const geometry = new PlaneGeometry(FPS_PLANE_WIDTH_M, FPS_PLANE_HEIGHT_M);
		const material = new MeshBasicMaterial({
			map: this._texture,
			transparent: true,
			depthTest: false,
			depthWrite: false,
			side: FrontSide,
		});
		const mesh = new Mesh(geometry, material);
		mesh.position.set(FPS_HUD_OFFSET_X_M, FPS_HUD_OFFSET_Y_M, FPS_HUD_OFFSET_Z_M);
		mesh.renderOrder = 9999;
		mesh.frustumCulled = false;
		mesh.visible = false;
		return mesh;
	}

	_drawLabel(value) {
		if (!this._ctx) return;
		this._ctx.clearRect(0, 0, FPS_CANVAS_WIDTH, FPS_CANVAS_HEIGHT);
		this._ctx.fillStyle = 'rgba(0, 0, 0, 0.68)';
		this._ctx.fillRect(0, 0, FPS_CANVAS_WIDTH, FPS_CANVAS_HEIGHT);
		this._ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
		this._ctx.lineWidth = 2;
		this._ctx.strokeRect(1, 1, FPS_CANVAS_WIDTH - 2, FPS_CANVAS_HEIGHT - 2);
		this._ctx.fillStyle = '#ffffff';
		this._ctx.font = 'bold 34px monospace';
		this._ctx.textAlign = 'left';
		this._ctx.textBaseline = 'middle';
		this._ctx.fillText(`${this._label}: ${value}`, 18, FPS_CANVAS_HEIGHT / 2);
		this._texture.needsUpdate = true;
	}

	_getActiveCamera() {
		const renderer = this._cg?.getRenderer?.();
		if (renderer?.xr?.isPresenting) {
			return renderer.xr.getCamera?.() ?? this._cg?.getCamera?.() ?? null;
		}
		return this._cg?.getCamera?.() ?? renderer?.camera ?? null;
	}

	_attachHudToCamera(camera) {
		if (!camera) return;
		if (this._activeCamera === camera && this._mesh.parent === camera) return;
		camera.add(this._mesh);
		this._mesh.position.copy(this._localHudOffset);
		this._mesh.rotation.set(0, 0, 0);
		this._activeCamera = camera;
	}

	_attachHudToScene() {
		const scene = this._cg?.getScene?.();
		if (!scene || this._mesh.parent === scene) return;
		// scene.add() also removes the mesh from its previous parent — required
		// when transitioning from the camera-attached (desktop) pose, because
		// the XR branch writes world-space transforms into position/quaternion.
		scene.add(this._mesh);
		this._activeCamera = null;
	}

	_syncHudPose() {
		const camera = this._getActiveCamera();
		if (!camera) {
			this._mesh.visible = false;
			this._activeCamera = null;
			return;
		}

		const renderer = this._cg?.getRenderer?.();
		if (renderer?.xr?.isPresenting) {
			this._attachHudToScene();
			camera.updateWorldMatrix?.(true, false);
			camera.getWorldPosition(this._viewerWorldPosition);
			camera.getWorldQuaternion(this._viewerWorldQuaternion);
			this._hudWorldOffset.copy(this._localHudOffset).applyQuaternion(this._viewerWorldQuaternion);
			this._mesh.position.copy(this._viewerWorldPosition).add(this._hudWorldOffset);
			this._mesh.quaternion.copy(this._viewerWorldQuaternion);
			this._activeCamera = null;
			this._mesh.visible = true;
			if (!this._loggedFirstVisiblePose) {
				this._loggedFirstVisiblePose = true;
				const p = this._mesh.position;
				console.log(`[FPSCounter] XR HUD visible at world (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`);
			}
			return;
		}

		this._attachHudToCamera(camera);
		this._mesh.visible = true;
	}

	update(nowMs) {
		if (!this._enabled) return;
		this._syncHudPose();

		if (this._lastFrameAtMs == null) {
			this._lastFrameAtMs = nowMs;
			this._sampleStartAtMs = nowMs;
			this._sampleFrameCount = 0;
			return;
		}

		this._sampleFrameCount += 1;
		const sampleElapsedMs = nowMs - this._sampleStartAtMs;
		if (sampleElapsedMs >= FPS_SAMPLE_WINDOW_MS) {
			this._lastDisplayedFps = Math.round((this._sampleFrameCount * 1000) / sampleElapsedMs);
			this._drawLabel(String(this._lastDisplayedFps));
			this._sampleStartAtMs = nowMs;
			this._sampleFrameCount = 0;
		}

		this._lastFrameAtMs = nowMs;
	}

	dispose() {
		this._enabled = false;
		if (this._mesh?.parent) {
			this._mesh.parent.remove(this._mesh);
		}
		this._mesh?.geometry?.dispose?.();
		this._mesh?.material?.dispose?.();
		this._texture?.dispose?.();
		this._mesh = null;
		this._texture = null;
		this._ctx = null;
		this._canvas = null;
		this._localHudOffset = null;
		this._viewerWorldPosition = null;
		this._viewerWorldQuaternion = null;
		this._hudWorldOffset = null;
		this._activeCamera = null;
		this._loggedFirstVisiblePose = false;
	}
}
