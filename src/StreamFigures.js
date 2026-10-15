import { Color, Quaternion, Vector3 } from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadFigureTemplate } from './FigureLoader.js';
import { mapStreamPoseToWorld } from './StreamPose.js';

const POSE_TIMEOUT_MS = 1000;
const CAMERA_FORWARD = new Vector3(0, 0, -1);

/**
 * StreamFigures — one tinted human figure per configured headset on the
 * desktop page, driven by cg.stream.
 *
 * While the shared stream toggle is on, one figure is ensured per headset
 * from GET api/client-config (ids/labels/colors); when it turns off, all
 * figures are removed. The FBX template is loaded once (shared with the
 * origin reference figure via loadFigureTemplate) and cloned per headset
 * with SkeletonUtils.clone in case it is rigged; each clone's materials are
 * cloned and tinted with the headset's hex color.
 *
 * A pose arrives RELATIVE to the sender's sceneStage and is mapped back
 * through this desktop's sceneStage world transform (position through
 * matrixWorld, orientation composed as stageWorldQuat * relQuat), then the
 * figure is placed with feet at (x, 0, z) of that world position and
 * yaw-only orientation (transformed camera forward projected onto XZ — a
 * standing figure doesn't pitch/roll with the head). Figures stay hidden
 * until their first pose, and are hidden again when no pose arrives for ~1s
 * (poses stop when immersion ends, the page reloads, or the headset
 * disconnects — no parking positions). The origin reference figure from
 * loadReferenceFigure is a separate object and is left untouched.
 */
export class StreamFigures {
	constructor(cg, { scene, figureUrl, fetchImpl } = {}) {
		this._cg = cg;
		this._scene = scene;
		this._figureUrl = figureUrl ?? null;
		this._fetch = fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
		this._templatePromise = null;
		this._buildPromise = null;
		this._figures = new Map(); // deviceId -> { group, lastPoseAt }
		this._enabled = false;
		this._unsubscribes = [];
		this._poseQuaternion = new Quaternion();
		this._posePosition = new Vector3();
		this._poseForward = new Vector3();
	}

	start() {
		if (typeof this._cg?.stream?.onEnabledChange !== 'function') return;
		this._unsubscribes.push(this._cg.stream.onEnabledChange((enabled) => this._setEnabled(enabled)));
		this._unsubscribes.push(this._cg.stream.onPose((message) => this._handlePose(message)));
		if (this._cg.stream.enabled) {
			this._setEnabled(true);
		}
	}

	_setEnabled(enabled) {
		this._enabled = Boolean(enabled);
		if (this._enabled) {
			this._ensureFigures();
		} else {
			this._removeAllFigures();
		}
	}

	_template() {
		if (!this._figureUrl) return Promise.resolve(null);
		if (!this._templatePromise) {
			this._templatePromise = loadFigureTemplate(this._figureUrl).catch((error) => {
				console.warn('Stream figure template failed to load:', error);
				return null;
			});
		}
		return this._templatePromise;
	}

	async _headsets() {
		if (!this._fetch) return [];
		try {
			const response = await this._fetch('api/client-config', { cache: 'no-store' });
			if (!response || !response.ok) return [];
			const config = await response.json();
			return Array.isArray(config?.headsets) ? config.headsets : [];
		} catch (_error) {
			return [];
		}
	}

	// Idempotent + concurrency-safe: repeated calls share one build pass and
	// only add figures that are missing.
	_ensureFigures() {
		if (this._buildPromise) return this._buildPromise;
		this._buildPromise = this._buildFigures().finally(() => {
			this._buildPromise = null;
		});
		return this._buildPromise;
	}

	async _buildFigures() {
		const [template, headsets] = await Promise.all([this._template(), this._headsets()]);
		if (!this._enabled || !template) return; // toggled off (or load failed) meanwhile
		for (const headset of headsets) {
			const deviceId = Number(headset?.id);
			if (!Number.isInteger(deviceId) || this._figures.has(deviceId)) continue;
			const group = SkeletonUtils.clone(template);
			this._tint(group, headset.color);
			group.visible = false; // hidden until the first pose arrives
			this._scene.add(group);
			this._figures.set(deviceId, { group, lastPoseAt: 0 });
		}
	}

	_tint(group, color) {
		if (color == null || color === '') return;
		let tint;
		try {
			tint = new Color(color);
		} catch (_error) {
			return;
		}
		group.traverse((obj) => {
			if (!obj.isMesh || !obj.material) return;
			const materials = (Array.isArray(obj.material) ? obj.material : [obj.material]).map((material) => {
				const cloned = material.clone();
				if (cloned.color) cloned.color.set(tint);
				return cloned;
			});
			obj.material = Array.isArray(obj.material) ? materials : materials[0];
		});
	}

	_handlePose(message) {
		const deviceId = Number(message?.deviceId);
		if (!Number.isInteger(deviceId)) return;
		const figure = this._figures.get(deviceId);
		if (!figure) {
			// Pose for a configured headset whose figure isn't built yet (race
			// with the async build); unknown headsets never get a figure.
			if (this._enabled) this._ensureFigures();
			return;
		}
		// Poses arrive RELATIVE to the sender's sceneStage (its anchor frame);
		// map them back through THIS desktop's sceneStage world transform so
		// the figure lands where the user stands relative to the content,
		// regardless of each side's anchor offset.
		const sceneStage = this._cg?.sceneManager?.sceneStage ?? null;
		mapStreamPoseToWorld(sceneStage, message.position, message.quaternion, this._posePosition, this._poseQuaternion);
		figure.group.position.set(this._posePosition.x, 0, this._posePosition.z);
		this._poseForward.copy(CAMERA_FORWARD).applyQuaternion(this._poseQuaternion);
		this._poseForward.y = 0;
		if (this._poseForward.lengthSq() > 1e-6) {
			figure.group.rotation.set(0, Math.atan2(this._poseForward.x, this._poseForward.z), 0);
		}
		figure.group.visible = true;
		figure.lastPoseAt = Date.now();
	}

	/**
	 * Per-frame update from CommonGround's render loop: hide figures whose
	 * headset stopped posing (immersion ended / page reloaded / disconnected).
	 */
	update() {
		if (this._figures.size === 0) return;
		const now = Date.now();
		for (const figure of this._figures.values()) {
			if (figure.group.visible && now - figure.lastPoseAt > POSE_TIMEOUT_MS) {
				figure.group.visible = false;
			}
		}
	}

	_removeAllFigures() {
		for (const { group } of this._figures.values()) {
			this._scene.remove(group);
		}
		this._figures.clear();
	}

	/** The scene group for a headset's figure, or null when not built yet. */
	getFigureGroup(deviceId) {
		return this._figures.get(Number(deviceId))?.group ?? null;
	}

	dispose() {
		for (const unsubscribe of this._unsubscribes.splice(0)) {
			unsubscribe();
		}
		this._removeAllFigures();
	}
}
