/**
 * Derives the anchor status of one headset from the device-scoped
 * GET api/anchors?device=N payload. A headset counts as anchored when its
 * scoped view has a scene_anchor, or — for headsets that only ever placed
 * the scene as a whole — a centroid_transform.
 */
export function anchorStatusFromScopedView(view) {
	if (!view || typeof view !== 'object') return 'unknown';
	if (view.scene_anchor != null || view.centroid_transform != null) return 'anchored';
	return 'no anchor';
}

/**
 * DesktopHud — small framework-owned DOM overlay shown in desktop mode only.
 * Top-right corner; the containers ignore pointer events so OrbitControls
 * keeps working, only the widgets themselves are interactive.
 *
 * Contents: a sync on/off toggle bound to cg.sync.enabled (runtime switch,
 * no reload), a Session Logs link to the server's integrated log viewer,
 * and — when the server's client-config lists project headsets — a
 * collapsible headset overview with per-headset anchor status (from
 * GET api/anchors?device=N) and a Clear button (DELETE api/anchors?device=N).
 * All URLs are relative so pages served at a subpath keep working.
 */
export class DesktopHud {
	constructor(cg, { logsUrl = 'commonground/logs', doc, fetchImpl } = {}) {
		this._cg = cg;
		this._doc = doc ?? (typeof document !== 'undefined' ? document : null);
		this._fetch = fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
		this._logsUrl = logsUrl;
		this._container = null;
		this._syncCheckbox = null;
		this._unsubscribeEnabled = null;
		this._headsets = [];
		this._headsetsButton = null;
		this._headsetsPanel = null;
		this._headsetRows = new Map();

		if (!this._doc) return;
		this._build();
		this._loadClientConfig();
	}

	async _loadClientConfig() {
		if (!this._fetch) return;
		try {
			const response = await this._fetch('api/client-config', { cache: 'no-store' });
			if (!response || !response.ok) return;
			const config = await response.json();
			const headsets = Array.isArray(config?.headsets) ? config.headsets : [];
			this._headsets = headsets.filter((headset) => headset && headset.id != null);
			if (this._headsets.length > 0 && this._headsetsButton) {
				this._headsetsButton.style.display = '';
			}
		} catch (_error) {
			// No client-config reachable — the headset section stays hidden.
		}
	}

	_build() {
		const doc = this._doc;

		const container = doc.createElement('div');
		container.id = 'commonground-desktop-hud';
		container.style.cssText = [
			'position:fixed',
			'top:10px',
			'right:10px',
			'z-index:1000',
			'display:flex',
			'align-items:center',
			'gap:10px',
			'padding:6px 10px',
			'border-radius:8px',
			'background:rgba(15,23,42,0.75)',
			'color:#fff',
			'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
			'pointer-events:none',
		].join(';');

		const syncLabel = doc.createElement('label');
		syncLabel.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer;pointer-events:auto;';
		const syncCheckbox = doc.createElement('input');
		syncCheckbox.type = 'checkbox';
		syncCheckbox.checked = this._cg.sync.enabled;
		syncCheckbox.addEventListener('change', () => {
			this._cg.sync.enabled = syncCheckbox.checked;
		});
		syncLabel.appendChild(syncCheckbox);
		const syncText = doc.createElement('span');
		syncText.textContent = 'Sync';
		syncLabel.appendChild(syncText);

		const logsLink = doc.createElement('a');
		logsLink.textContent = 'Session Logs';
		logsLink.href = this._logsUrl;
		logsLink.target = '_blank';
		logsLink.rel = 'noopener noreferrer';
		logsLink.style.cssText = 'color:#70d7ff;text-decoration:none;pointer-events:auto;';

		const headsetsButton = doc.createElement('button');
		headsetsButton.type = 'button';
		headsetsButton.textContent = 'Headsets';
		headsetsButton.style.cssText = 'background:none;border:1px solid rgba(255,255,255,0.35);border-radius:6px;color:#fff;font:inherit;padding:2px 8px;cursor:pointer;pointer-events:auto;';
		headsetsButton.style.display = 'none'; // shown once client-config lists headsets
		headsetsButton.addEventListener('click', () => this._toggleHeadsetsPanel());

		container.appendChild(syncLabel);
		container.appendChild(logsLink);
		container.appendChild(headsetsButton);
		doc.body.appendChild(container);

		this._container = container;
		this._syncCheckbox = syncCheckbox;
		this._headsetsButton = headsetsButton;
		this._unsubscribeEnabled = this._cg.sync.onEnabledChange((enabled) => {
			syncCheckbox.checked = enabled;
		});
	}

	_toggleHeadsetsPanel() {
		if (this._headsetsPanel) {
			this._hideHeadsetsPanel();
			return;
		}
		if (this._headsets.length === 0) return;
		this._showHeadsetsPanel();
	}

	_showHeadsetsPanel() {
		const doc = this._doc;
		const panel = doc.createElement('div');
		panel.id = 'commonground-desktop-hud-headsets';
		panel.style.cssText = [
			'position:fixed',
			'top:44px',
			'right:10px',
			'z-index:1000',
			'display:flex',
			'flex-direction:column',
			'gap:6px',
			'padding:8px 10px',
			'border-radius:8px',
			'background:rgba(15,23,42,0.85)',
			'color:#fff',
			'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
			'pointer-events:auto',
			'min-width:220px',
		].join(';');

		const header = doc.createElement('div');
		header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
		const title = doc.createElement('span');
		title.textContent = 'Headsets';
		title.style.cssText = 'font-weight:600;';
		const refreshButton = doc.createElement('button');
		refreshButton.type = 'button';
		refreshButton.textContent = 'Refresh';
		refreshButton.style.cssText = 'background:none;border:1px solid rgba(255,255,255,0.35);border-radius:6px;color:#fff;font:inherit;padding:1px 6px;cursor:pointer;';
		refreshButton.addEventListener('click', () => this.refreshHeadsetStatuses());
		header.appendChild(title);
		header.appendChild(refreshButton);
		panel.appendChild(header);

		this._headsetRows = new Map();
		for (const headset of this._headsets) {
			const row = doc.createElement('div');
			row.style.cssText = 'display:flex;align-items:center;gap:8px;justify-content:space-between;';

			const label = doc.createElement('span');
			label.textContent = String(headset.label ?? `Headset ${headset.id}`);

			const status = doc.createElement('span');
			status.textContent = '…';
			status.style.cssText = 'color:#9fb0d2;margin-left:auto;margin-right:4px;';

			const clearButton = doc.createElement('button');
			clearButton.type = 'button';
			clearButton.textContent = 'Clear';
			clearButton.style.cssText = 'background:none;border:1px solid rgba(255,255,255,0.35);border-radius:6px;color:#ff8c8c;font:inherit;padding:1px 6px;cursor:pointer;';
			clearButton.addEventListener('click', () => this.clearHeadsetAnchors(headset));

			row.appendChild(label);
			row.appendChild(status);
			row.appendChild(clearButton);
			panel.appendChild(row);
			this._headsetRows.set(headset.id, { status, clearButton });
		}

		doc.body.appendChild(panel);
		this._headsetsPanel = panel;
		this._headsetsButton.textContent = 'Headsets ▾';
		this.refreshHeadsetStatuses();
	}

	_hideHeadsetsPanel() {
		if (this._headsetsPanel && this._headsetsPanel.parentNode) {
			this._headsetsPanel.parentNode.removeChild(this._headsetsPanel);
		}
		this._headsetsPanel = null;
		this._headsetRows = new Map();
		if (this._headsetsButton) {
			this._headsetsButton.textContent = 'Headsets';
		}
	}

	_setRowStatus(headsetId, text, color) {
		const row = this._headsetRows.get(headsetId);
		if (!row) return;
		row.status.textContent = text;
		row.status.style.cssText = `color:${color};margin-left:auto;margin-right:4px;`;
	}

	async refreshHeadsetStatuses() {
		if (!this._headsetsPanel || !this._fetch) return;
		for (const headset of this._headsets) {
			this._setRowStatus(headset.id, '…', '#9fb0d2');
		}
		await Promise.all(this._headsets.map(async (headset) => {
			try {
				const response = await this._fetch(`api/anchors?device=${encodeURIComponent(headset.id)}`, { cache: 'no-store' });
				if (!response || !response.ok) throw new Error(`HTTP ${response?.status}`);
				const scopedView = await response.json();
				const status = anchorStatusFromScopedView(scopedView);
				this._setRowStatus(headset.id, status, status === 'anchored' ? '#6be6a3' : '#9fb0d2');
			} catch (_error) {
				this._setRowStatus(headset.id, 'unknown', '#ffd374');
			}
		}));
	}

	async clearHeadsetAnchors(headset) {
		if (!this._fetch) return;
		const row = this._headsetRows.get(headset.id);
		if (row) row.clearButton.disabled = true;
		try {
			const response = await this._fetch(`api/anchors?device=${encodeURIComponent(headset.id)}`, { method: 'DELETE' });
			if (!response || !response.ok) throw new Error(`HTTP ${response?.status}`);
		} catch (_error) {
			this._setRowStatus(headset.id, 'unknown', '#ffd374');
			if (row) row.clearButton.disabled = false;
			return;
		}
		if (row) row.clearButton.disabled = false;
		await this.refreshHeadsetStatuses();
	}

	dispose() {
		this._hideHeadsetsPanel();
		if (typeof this._unsubscribeEnabled === 'function') {
			this._unsubscribeEnabled();
			this._unsubscribeEnabled = null;
		}
		if (this._container && this._container.parentNode) {
			this._container.parentNode.removeChild(this._container);
		}
		this._container = null;
		this._syncCheckbox = null;
		this._headsetsButton = null;
	}
}
