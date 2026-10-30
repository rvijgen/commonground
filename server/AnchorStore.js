import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY_ANCHORS = {
	scene_anchor_transform: null,
	control_panel_anchor_transform: null,
};

const EMPTY_MESH = {
	planes: [],
	meshes: [],
	serverTimestamp: null,
};

export function parseDeviceId(value) {
	if (value === undefined || value === null || value === '') return null;
	const parsed = Number.parseInt(String(value), 10);
	return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Anchor status of one headset from its device-scoped anchors view: anchored
 * when the scoped view has a centroid_transform (the saved reference frame
 * every placement is expressed in). Mirrors the client-side predicate in
 * src/DesktopHud.js (string form differs: 'no-anchor' here).
 */
export function anchorStatusFromScopedView(view) {
	if (!view || typeof view !== 'object') return 'unknown';
	if (view.centroid_transform != null) return 'anchored';
	return 'no-anchor';
}

function anchorDeviceKey(deviceId, id) {
	return `device_${deviceId}_${id}`;
}

function pickAnchorValue(source, deviceId, id) {
	if (!source || typeof source !== 'object') return null;
	if (deviceId != null) {
		const scoped = source[anchorDeviceKey(deviceId, id)];
		if (scoped !== undefined) return scoped;
	}
	return source[id] ?? null;
}

function scopedAnchorView(source, deviceId) {
	return {
		scene_anchor_transform: pickAnchorValue(source, deviceId, 'scene_anchor_transform'),
		control_panel_anchor_transform: pickAnchorValue(source, deviceId, 'control_panel_anchor_transform'),
		centroid_transform: pickAnchorValue(source, deviceId, 'centroid_transform'),
		serverTimestamp: source?.serverTimestamp ?? null,
	};
}

function applyScopedAnchorPatch(target, incoming, deviceId) {
	const result = { ...target };
	for (const [key, value] of Object.entries(incoming || {})) {
		if (key === 'serverTimestamp') continue;
		if (deviceId != null && !key.startsWith('device_')) {
			result[anchorDeviceKey(deviceId, key)] = value;
			continue;
		}
		result[key] = value;
	}
	return result;
}

/**
 * File-backed per-space persistence for placement transforms and room meshes.
 * Data lives at <dataDir>/spaces/<spaceId>/{anchors.json,mesh.json}.
 */
export class AnchorStore {
	constructor({ dataDir, spaceId = 'default' } = {}) {
		if (!dataDir) throw new Error('AnchorStore requires a dataDir');
		this.dataDir = dataDir;
		this.setSpace(spaceId || 'default');
	}

	/**
	 * Points the store at another space. Storage paths are recomputed; space
	 * directories are still created lazily on first write.
	 */
	setSpace(spaceId) {
		this.spaceId = spaceId || 'default';
		this.spaceDir = path.join(this.dataDir, 'spaces', this.spaceId);
		this.anchorsFile = path.join(this.spaceDir, 'anchors.json');
		this.meshFile = path.join(this.spaceDir, 'mesh.json');
	}

	spacesRoot() {
		return path.join(this.dataDir, 'spaces');
	}

	/** Names of existing spaces (subdirectories of <dataDir>/spaces/). */
	async listSpaces() {
		try {
			const entries = await fs.readdir(this.spacesRoot(), { withFileTypes: true });
			return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		} catch (_) {
			return [];
		}
	}

	async spaceExists(spaceId) {
		try {
			const stats = await fs.stat(path.join(this.spacesRoot(), spaceId));
			return stats.isDirectory();
		} catch (_) {
			return false;
		}
	}

	async createSpace(spaceId) {
		await fs.mkdir(path.join(this.spacesRoot(), spaceId), { recursive: true });
	}

	/**
	 * 'anchored' | 'no-anchor' | 'unknown' for one device, from the same
	 * scoped view GET api/anchors?device=N returns.
	 */
	async getAnchorStatus(deviceQuery) {
		try {
			return anchorStatusFromScopedView(await this.getAnchors(deviceQuery));
		} catch (_) {
			return 'unknown';
		}
	}

	async ensureSpaceDir() {
		await fs.mkdir(this.spaceDir, { recursive: true });
	}

	/**
	 * Mirrors the legacy GET /api/anchors semantics: returns the parsed file,
	 * a per-device scoped view when deviceId is set, or empty defaults when
	 * the file is missing or unreadable.
	 */
	async getAnchors(deviceQuery) {
		const deviceId = parseDeviceId(deviceQuery);
		try {
			const data = await fs.readFile(this.anchorsFile, 'utf8');
			const parsed = JSON.parse(data);
			if (deviceId == null) return parsed;
			return scopedAnchorView(parsed, deviceId);
		} catch (_) {
			const empty = { ...EMPTY_ANCHORS };
			if (deviceId != null) empty.centroid_transform = null;
			return empty;
		}
	}

	/**
	 * Mirrors the legacy POST /api/anchors semantics: merges the incoming
	 * patch (device-scoped when deviceId is set), stamps serverTimestamp,
	 * persists, and returns what the client should see.
	 */
	async saveAnchors(incoming, deviceQuery) {
		const deviceId = parseDeviceId(deviceQuery);
		let current = { ...EMPTY_ANCHORS };
		try {
			const existing = await fs.readFile(this.anchorsFile, 'utf8');
			current = { ...current, ...JSON.parse(existing) };
		} catch (_) {
			// File may not exist yet; defaults are fine.
		}

		const updated = applyScopedAnchorPatch(current, incoming, deviceId);
		updated.serverTimestamp = Date.now();

		await this.ensureSpaceDir();
		await fs.writeFile(this.anchorsFile, JSON.stringify(updated, null, 2));
		if (deviceId != null) return scopedAnchorView(updated, deviceId);
		return updated;
	}

	/**
	 * Mirrors the legacy DELETE /api/anchors semantics. With a device query
	 * only that device's prefixed keys are nulled; otherwise the global
	 * (non-prefixed) anchor keys are reset.
	 */
	async clearAnchors(deviceQuery) {
		let updated;
		if (deviceQuery != null) {
			let existing = {};
			try {
				existing = JSON.parse(await fs.readFile(this.anchorsFile, 'utf8'));
			} catch (_) {}
			const prefix = `device_${deviceQuery}_`;
			updated = { ...existing, serverTimestamp: Date.now() };
			for (const key of Object.keys(updated)) {
				if (key.startsWith(prefix)) updated[key] = null;
			}
		} else {
			updated = {
				...EMPTY_ANCHORS,
				serverTimestamp: Date.now(),
			};
		}
		await this.ensureSpaceDir();
		await fs.writeFile(this.anchorsFile, JSON.stringify(updated, null, 2));
		return updated;
	}

	/**
	 * Mirrors the legacy GET /api/mesh semantics: a missing file is treated
	 * as "not exported yet" rather than an error.
	 */
	async getMesh() {
		try {
			const data = await fs.readFile(this.meshFile, 'utf8');
			return JSON.parse(data);
		} catch (error) {
			if (error && error.code === 'ENOENT') return { ...EMPTY_MESH };
			throw error;
		}
	}

	async saveMesh(roomMeshData) {
		roomMeshData.serverTimestamp = Date.now();
		await this.ensureSpaceDir();
		await fs.writeFile(this.meshFile, JSON.stringify(roomMeshData, null, 2));
	}

	// Legacy per-session room mesh storage (<spaceDir>/<sessionId>.json)
	async saveRoomMesh(roomMeshData) {
		roomMeshData.serverTimestamp = Date.now();
		await this.ensureSpaceDir();
		const filePath = path.join(this.spaceDir, `${roomMeshData.sessionId}.json`);
		await fs.writeFile(filePath, JSON.stringify(roomMeshData, null, 2));
	}

	async getRoomMesh(sessionId) {
		try {
			const data = await fs.readFile(path.join(this.spaceDir, `${sessionId}.json`), 'utf8');
			return JSON.parse(data);
		} catch (_) {
			return null;
		}
	}

	async listRoomMeshSessions() {
		try {
			const files = await fs.readdir(this.spaceDir);
			return files
				.filter(f => f.endsWith('.json'))
				.map(f => f.replace('.json', ''));
		} catch (_) {
			return [];
		}
	}
}
