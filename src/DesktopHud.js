/**
 * Derives the anchor status of one headset from the device-scoped
 * GET api/anchors?device=N payload. A headset counts as anchored when its
 * scoped view has a scene_anchor, or — for headsets that only ever placed
 * the scene as a whole — a centroid_transform.
 *
 * Kept for API compatibility; the HUD itself now reads the server-computed
 * anchor state from GET api/headsets.
 */
export function anchorStatusFromScopedView(view) {
	if (!view || typeof view !== 'object') return 'unknown';
	if (view.scene_anchor != null || view.centroid_transform != null) return 'anchored';
	return 'no anchor';
}

const HUD_FONT = '12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
const TAB_IDS = ['headsets', 'spaces', 'session'];
const TAB_LABELS = { headsets: 'Headsets', spaces: 'Spaces', session: 'Session' };

function pad2(value) {
	return String(value).padStart(2, '0');
}

// Same hh:mm:ss shape as the CLI dashboard.
function formatDurationMs(ms) {
	const totalSeconds = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

function truncateText(value, maxLength = 80) {
	const text = String(value);
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * DesktopHud — framework-owned DOM overlay shown in desktop mode only.
 * Top-right tab bar (Headsets | Spaces | Session) plus a persistent Helpers
 * toggle; a top-left hint shows the headset launch page address (from
 * api/client-config). The containers ignore pointer events so OrbitControls
 * keeps working, only the widgets themselves are interactive.
 *
 *   Headsets — one card per headset from GET api/headsets: presence +
 *              session time (ticking; starts on immersion enter, matching
 *              the CLI dashboard), the dashboard column strings (or raw
 *              status key: value when the project configures no columns),
 *              the anchor state of the currently selected space, a Clear
 *              button (DELETE api/anchors?device=N), and a View button
 *              (disabled while the headset is offline) toggling a "view
 *              from headset" mirror window (StreamMirrors). Refreshed by
 *              polling api/headsets (~2s) and by cg.status updates.
 *   Spaces   — current space (GET api/spaces), Select buttons per space
 *              (POST api/spaces/select), and an add-new-space row
 *              (POST api/spaces). Selecting a space switches anchors/mesh
 *              server-side; headsets follow via the cg:space broadcast.
 *   Session  — the sync on/off toggle (cg.sync.enabled, runtime switch) and
 *              a Session Log button opening the server's integrated log
 *              viewer (commonground/logs) in an iframe overlay (X, ESC or
 *              backdrop click to close).
 *
 * All URLs are relative so pages served at a subpath keep working.
 */
export class DesktopHud {
	constructor(cg, { logsUrl = 'commonground/logs', doc, fetchImpl } = {}) {
		this._cg = cg;
		this._doc = doc ?? (typeof document !== 'undefined' ? document : null);
		this._fetch = fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
		this._logsUrl = logsUrl;
		this._container = null;
		this._panel = null;
		this._activeTab = 'headsets';
		this._tabButtons = new Map();
		this._syncCheckbox = null;
		this._streamCheckbox = null;
		this._unsubscribeEnabled = null;
		this._unsubscribeStream = null;
		this._unsubscribeStatus = null;
		this._statusRefreshTimer = null;
		this._pollTimer = null;
		this._headsetsData = [];
		this._headsetsFetchedAt = 0;
		this._headsetCards = new Map();
		this._overlay = null;
		this._helperHint = null;
		this._onKeyDown = (event) => {
			if (event.key === 'Escape') this._closeLogsOverlay();
		};

		if (!this._doc) return;
		this._build();
		this._buildHelperHint();
		this._subscribeStatus();
		this._startPolling();
	}

	// ── Helper-page hint (top-left) ───────────────────────────────────────

	// "Open http://<lan-ip>/ in the headset browser" — the launch page address
	// from GET api/client-config (null there → no hint, e.g. no helper page).
	// Text stays selectable so the URL can be copied.
	async _buildHelperHint() {
		if (!this._fetch || this._helperHint) return;
		let helperUrl = null;
		try {
			const response = await this._fetch('api/client-config', { cache: 'no-store' });
			if (response && response.ok) {
				const config = await response.json();
				helperUrl = typeof config?.helperUrl === 'string' ? config.helperUrl : null;
			}
		} catch (_error) {
			return;
		}
		if (!helperUrl) return;
		const hint = this._doc.createElement('div');
		hint.id = 'commonground-desktop-hud-helper-hint';
		hint.style.cssText = [
			'position:fixed',
			'top:10px',
			'left:10px',
			'z-index:1000',
			'padding:6px 10px',
			'border-radius:8px',
			'background:rgba(15,23,42,0.75)',
			'color:#fff',
			`font:${HUD_FONT}`,
			'user-select:text',
		].join(';');
		hint.textContent = `Open ${helperUrl} in the headset browser`;
		this._doc.body.appendChild(hint);
		this._helperHint = hint;
	}

	// ── Top bar + tabs ──────────────────────────────────────────────────

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
			'gap:6px',
			'padding:6px 10px',
			'border-radius:8px',
			'background:rgba(15,23,42,0.75)',
			'color:#fff',
			`font:${HUD_FONT}`,
			'pointer-events:none',
		].join(';');

		this._tabButtons = new Map();
		for (const tabId of TAB_IDS) {
			const button = doc.createElement('button');
			button.type = 'button';
			button.textContent = TAB_LABELS[tabId];
			button.addEventListener('click', () => this._selectTab(tabId));
			this._tabButtons.set(tabId, button);
			container.appendChild(button);
		}
		this._styleTabButtons();

		const helpersLabel = doc.createElement('label');
		helpersLabel.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer;pointer-events:auto;margin-left:4px;';
		const helpersCheckbox = doc.createElement('input');
		helpersCheckbox.type = 'checkbox';
		helpersCheckbox.checked = this._cg.helpersVisible;
		helpersCheckbox.addEventListener('change', () => {
			this._cg.setHelpersVisible(helpersCheckbox.checked);
		});
		helpersLabel.appendChild(helpersCheckbox);
		const helpersText = doc.createElement('span');
		helpersText.textContent = 'Helpers';
		helpersLabel.appendChild(helpersText);

		container.appendChild(helpersLabel);
		doc.body.appendChild(container);

		this._container = container;
		// Bound once; the listeners update whichever checkbox instance the
		// Session tab currently shows.
		this._unsubscribeEnabled = this._cg.sync.onEnabledChange((enabled) => {
			if (this._syncCheckbox) this._syncCheckbox.checked = enabled;
		});
		this._unsubscribeStream = typeof this._cg.stream?.onEnabledChange === 'function'
			? this._cg.stream.onEnabledChange((enabled) => {
				if (this._streamCheckbox) this._streamCheckbox.checked = enabled;
			})
			: null;
		this._selectTab(this._activeTab);
	}

	_styleTabButtons() {
		for (const [tabId, button] of this._tabButtons) {
			const active = tabId === this._activeTab;
			button.style.cssText = [
				'background:' + (active ? 'rgba(255,255,255,0.22)' : 'none'),
				'border:1px solid rgba(255,255,255,0.35)',
				'border-radius:6px',
				'color:#fff',
				'font:inherit',
				`font-weight:${active ? 600 : 400}`,
				'padding:2px 8px',
				'cursor:pointer',
				'pointer-events:auto',
			].join(';');
		}
	}

	_selectTab(tabId) {
		this._activeTab = tabId;
		this._styleTabButtons();
		this._hidePanel();
		this._showPanel();
	}

	_hidePanel() {
		if (this._panel && this._panel.parentNode) {
			this._panel.parentNode.removeChild(this._panel);
		}
		this._panel = null;
		this._headsetCards = new Map();
		this._syncCheckbox = null;
		this._streamCheckbox = null;
	}

	_showPanel() {
		const doc = this._doc;
		const panel = doc.createElement('div');
		panel.id = 'commonground-desktop-hud-panel';
		panel.style.cssText = [
			'position:fixed',
			'top:44px',
			'right:10px',
			'z-index:1000',
			'padding:10px 12px',
			'border-radius:8px',
			'background:rgba(15,23,42,0.85)',
			'color:#fff',
			`font:${HUD_FONT}`,
			'pointer-events:auto',
			'max-width:calc(100vw - 20px)',
		].join(';');
		doc.body.appendChild(panel);
		this._panel = panel;

		if (this._activeTab === 'spaces') {
			this._renderSpacesPanelLoading();
			this.refreshSpaces();
			return;
		}
		if (this._activeTab === 'session') {
			this._renderSessionPanel();
			return;
		}
		this._renderHeadsetsPanel();
	}

	// ── Headsets tab ────────────────────────────────────────────────────

	_renderHeadsetsPanel() {
		const doc = this._doc;
		const panel = this._panel;
		if (!panel || this._activeTab !== 'headsets') return;
		panel.textContent = '';
		this._headsetCards = new Map();

		if (!Array.isArray(this._headsetsData) || this._headsetsData.length === 0) {
			const empty = doc.createElement('div');
			empty.textContent = this._fetch ? 'No headsets configured.' : 'Headset status unavailable.';
			empty.style.cssText = 'color:#9fb0d2;';
			panel.appendChild(empty);
			return;
		}

		const row = doc.createElement('div');
		row.style.cssText = 'display:flex;flex-direction:row;gap:8px;align-items:stretch;';
		panel.appendChild(row);

		for (const headset of this._headsetsData) {
			row.appendChild(this._buildHeadsetCard(headset));
		}
	}

	_buildHeadsetCard(headset) {
		const doc = this._doc;
		const card = doc.createElement('div');
		card.style.cssText = [
			'display:flex',
			'flex-direction:column',
			'gap:4px',
			'padding:8px 10px',
			'border:1px solid rgba(255,255,255,0.18)',
			'border-radius:8px',
			'min-width:150px',
			'max-width:220px',
			'background:rgba(255,255,255,0.04)',
		].join(';');

		const label = doc.createElement('div');
		label.textContent = String(headset.label ?? `Headset ${headset.id}`);
		label.style.cssText = 'font-weight:600;';
		card.appendChild(label);

		const connectionRow = doc.createElement('div');
		connectionRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
		const dot = doc.createElement('span');
		const connected = headset.connected === true;
		dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${connected ? '#6be6a3' : '#5b6b8c'};display:inline-block;`;
		connectionRow.appendChild(dot);
		const connectionText = doc.createElement('span');
		const state = headset.status && typeof headset.status === 'object' ? headset.status : null;
		connectionText.textContent = !connected ? 'Not connected' : (state?.enteredImmersion ? 'Immersed' : 'Connected');
		connectionText.style.cssText = `color:${connected ? '#6be6a3' : '#9fb0d2'};`;
		connectionRow.appendChild(connectionText);
		card.appendChild(connectionRow);

		const timeEl = doc.createElement('div');
		timeEl.style.cssText = 'color:#9fb0d2;';
		card.appendChild(timeEl);

		const fieldsEl = doc.createElement('div');
		fieldsEl.style.cssText = 'display:flex;flex-direction:column;gap:1px;color:#dbe4f5;';
		if (Array.isArray(headset.columns) && headset.columns.length > 0) {
			for (const columnLine of headset.columns) {
				const line = doc.createElement('div');
				line.textContent = String(columnLine);
				line.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;';
				fieldsEl.appendChild(line);
			}
		} else if (state) {
			// No columns configured: raw status key: value fallback.
			for (const [key, value] of Object.entries(state)) {
				const line = doc.createElement('div');
				const rendered = value && typeof value === 'object' ? JSON.stringify(value) : String(value);
				line.textContent = truncateText(`${key}: ${rendered}`);
				line.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;';
				fieldsEl.appendChild(line);
			}
		}
		card.appendChild(fieldsEl);

		const anchorRow = doc.createElement('div');
		anchorRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:2px;';
		const anchorText = doc.createElement('span');
		const anchor = typeof headset.anchor === 'string' ? headset.anchor : 'unknown';
		anchorText.textContent = anchor;
		anchorText.style.cssText = `color:${anchor === 'anchored' ? '#6be6a3' : anchor === 'unknown' ? '#ffd374' : '#9fb0d2'};`;
		anchorRow.appendChild(anchorText);

		const mirrors = this._cg.streamMirrors;
		if (mirrors && typeof mirrors.toggle === 'function') {
			const viewButton = doc.createElement('button');
			viewButton.type = 'button';
			viewButton.textContent = 'View';
			const offline = headset.connected !== true;
			viewButton.disabled = offline;
			const isOpen = typeof mirrors.isOpen === 'function' && mirrors.isOpen(headset.id);
			viewButton.style.cssText = 'background:none;border:1px solid rgba(255,255,255,0.35);border-radius:6px;font:inherit;padding:1px 6px;cursor:pointer;margin-left:auto;'
				+ `color:${isOpen ? '#70d7ff' : '#fff'};`
				+ (offline ? 'opacity:0.4;cursor:default;' : '');
			viewButton.addEventListener('click', () => mirrors.toggle(headset.id));
			anchorRow.appendChild(viewButton);
		}

		const clearButton = doc.createElement('button');
		clearButton.type = 'button';
		clearButton.textContent = 'Clear';
		clearButton.style.cssText = 'background:none;border:1px solid rgba(255,255,255,0.35);border-radius:6px;color:#ff8c8c;font:inherit;padding:1px 6px;cursor:pointer;';
		clearButton.addEventListener('click', () => this.clearHeadsetAnchors(headset));
		anchorRow.appendChild(clearButton);
		card.appendChild(anchorRow);

		this._headsetCards.set(headset.id, { timeEl });
		this._updateCardTime(headset);
		return card;
	}

	_updateCardTime(headset) {
		const card = this._headsetCards.get(headset.id);
		if (!card) return;
		// The session clock starts on immersion enter, same as the CLI
		// dashboard — connected-but-not-immersed shows the placeholder.
		if (headset.connected === true && Number.isFinite(headset.immersedDurationMs)) {
			const elapsed = headset.immersedDurationMs + Math.max(0, Date.now() - this._headsetsFetchedAt);
			card.timeEl.textContent = `Session: ${formatDurationMs(elapsed)}`;
		} else {
			card.timeEl.textContent = 'Session: --:--:--';
		}
	}

	_tickCardTimes() {
		if (this._activeTab !== 'headsets') return;
		for (const headset of this._headsetsData) {
			this._updateCardTime(headset);
		}
	}

	async refreshHeadsetStatuses() {
		if (!this._fetch) return;
		try {
			const response = await this._fetch('api/headsets', { cache: 'no-store' });
			if (!response || !response.ok) throw new Error(`HTTP ${response?.status}`);
			const data = await response.json();
			this._headsetsData = Array.isArray(data) ? data : [];
			this._headsetsFetchedAt = Date.now();
		} catch (_error) {
			if (this._headsetsData.length === 0) return; // keep the "unavailable" placeholder
			for (const headset of this._headsetsData) headset.anchor = 'unknown';
		}
		if (this._activeTab === 'headsets') {
			this._renderHeadsetsPanel();
		}
	}

	async clearHeadsetAnchors(headset) {
		if (!this._fetch) return;
		try {
			const response = await this._fetch(`api/anchors?device=${encodeURIComponent(headset.id)}`, { method: 'DELETE' });
			if (!response || !response.ok) throw new Error(`HTTP ${response?.status}`);
		} catch (_error) {
			// Refresh below surfaces the (unchanged) state.
		}
		await this.refreshHeadsetStatuses();
	}

	_subscribeStatus() {
		if (typeof this._cg?.status?.onStatus !== 'function') return;
		this._unsubscribeStatus = this._cg.status.onStatus(() => {
			// Status updates can be per-pointer-move; coalesce into one refresh.
			if (this._statusRefreshTimer) return;
			this._statusRefreshTimer = setTimeout(() => {
				this._statusRefreshTimer = null;
				this.refreshHeadsetStatuses();
			}, 300);
		});
	}

	_startPolling() {
		if (!this._fetch) return;
		this.refreshHeadsetStatuses();
		let tickCount = 0;
		this._pollTimer = setInterval(() => {
			tickCount += 1;
			this._tickCardTimes();
			if (tickCount % 2 === 0) {
				this.refreshHeadsetStatuses();
			}
		}, 1000);
	}

	// ── Spaces tab ──────────────────────────────────────────────────────

	_renderSpacesPanelLoading() {
		if (!this._panel || this._activeTab !== 'spaces') return;
		this._panel.textContent = '';
		const loading = this._doc.createElement('div');
		loading.textContent = 'Loading spaces…';
		loading.style.cssText = 'color:#9fb0d2;';
		this._panel.appendChild(loading);
	}

	_renderSpacesPanel(spacesPayload) {
		const doc = this._doc;
		const panel = this._panel;
		if (!panel || this._activeTab !== 'spaces') return;
		panel.textContent = '';
		panel.style.minWidth = '240px';

		const currentRow = doc.createElement('div');
		currentRow.style.cssText = 'margin-bottom:8px;';
		currentRow.textContent = 'Current space: ';
		const currentName = doc.createElement('b');
		currentName.textContent = String(spacesPayload?.current ?? 'default');
		currentRow.appendChild(currentName);
		panel.appendChild(currentRow);

		const spaces = Array.isArray(spacesPayload?.spaces) ? spacesPayload.spaces : [];
		for (const space of spaces) {
			const row = doc.createElement('div');
			row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 0;';
			const name = doc.createElement('span');
			const isCurrent = space === spacesPayload?.current;
			name.textContent = isCurrent ? `${space} (current)` : String(space);
			name.style.cssText = isCurrent ? 'font-weight:600;color:#6be6a3;' : '';
			const selectButton = doc.createElement('button');
			selectButton.type = 'button';
			selectButton.textContent = 'Select';
			selectButton.disabled = isCurrent;
			selectButton.style.cssText = 'background:none;border:1px solid rgba(255,255,255,0.35);border-radius:6px;color:#fff;font:inherit;padding:1px 8px;cursor:pointer;'
				+ (isCurrent ? 'opacity:0.4;cursor:default;' : '');
			selectButton.addEventListener('click', () => this._selectSpace(space));
			row.appendChild(name);
			row.appendChild(selectButton);
			panel.appendChild(row);
		}

		const addRow = doc.createElement('div');
		addRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:10px;border-top:1px solid rgba(255,255,255,0.15);padding-top:8px;';
		const input = doc.createElement('input');
		input.type = 'text';
		input.placeholder = 'New space name';
		input.style.cssText = 'background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.25);border-radius:6px;color:#fff;font:inherit;padding:3px 6px;flex:1;min-width:120px;';
		const addButton = doc.createElement('button');
		addButton.type = 'button';
		addButton.textContent = 'Add';
		addButton.style.cssText = 'background:none;border:1px solid rgba(255,255,255,0.35);border-radius:6px;color:#fff;font:inherit;padding:2px 8px;cursor:pointer;';
		const submit = () => {
			const name = input.value.trim();
			if (name) this._createSpace(name);
		};
		addButton.addEventListener('click', submit);
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') submit();
		});
		addRow.appendChild(input);
		addRow.appendChild(addButton);
		panel.appendChild(addRow);
	}

	async refreshSpaces() {
		if (!this._fetch) return;
		try {
			const response = await this._fetch('api/spaces', { cache: 'no-store' });
			if (!response || !response.ok) throw new Error(`HTTP ${response?.status}`);
			this._renderSpacesPanel(await response.json());
		} catch (_error) {
			if (!this._panel || this._activeTab !== 'spaces') return;
			this._panel.textContent = '';
			const error = this._doc.createElement('div');
			error.textContent = 'Spaces unavailable.';
			error.style.cssText = 'color:#ffd374;';
			this._panel.appendChild(error);
		}
	}

	async _createSpace(name) {
		if (!this._fetch) return;
		try {
			const response = await this._fetch('api/spaces', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name }),
			});
			if (!response || !response.ok) throw new Error(`HTTP ${response?.status}`);
			this._renderSpacesPanel(await response.json());
		} catch (_error) {
			// Refresh below surfaces the current state.
		}
	}

	async _selectSpace(name) {
		if (!this._fetch) return;
		try {
			const response = await this._fetch('api/spaces/select', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name }),
			});
			if (!response || !response.ok) throw new Error(`HTTP ${response?.status}`);
			this._renderSpacesPanel(await response.json());
		} catch (_error) {
			await this.refreshSpaces();
		}
		// Anchor state refers to the selected space — refresh the cards too.
		await this.refreshHeadsetStatuses();
	}

	// ── Session tab ─────────────────────────────────────────────────────

	_renderSessionPanel() {
		const doc = this._doc;
		const panel = this._panel;
		if (!panel || this._activeTab !== 'session') return;
		panel.textContent = '';
		panel.style.minWidth = '180px';

		const wrap = doc.createElement('div');
		wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

		const syncLabel = doc.createElement('label');
		syncLabel.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;';
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
		wrap.appendChild(syncLabel);
		this._syncCheckbox = syncCheckbox;

		if (this._cg.stream) {
			const streamLabel = doc.createElement('label');
			streamLabel.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;';
			const streamCheckbox = doc.createElement('input');
			streamCheckbox.type = 'checkbox';
			streamCheckbox.checked = this._cg.stream.enabled === true;
			streamCheckbox.addEventListener('change', () => {
				this._cg.stream.setEnabled(streamCheckbox.checked);
			});
			streamLabel.appendChild(streamCheckbox);
			const streamText = doc.createElement('span');
			streamText.textContent = 'Stream';
			streamLabel.appendChild(streamText);
			wrap.appendChild(streamLabel);
			this._streamCheckbox = streamCheckbox;
		}

		const logsButton = doc.createElement('button');
		logsButton.type = 'button';
		logsButton.textContent = 'Session Log';
		logsButton.style.cssText = 'background:none;border:1px solid rgba(255,255,255,0.35);border-radius:6px;color:#70d7ff;font:inherit;padding:4px 10px;cursor:pointer;';
		logsButton.addEventListener('click', () => this._openLogsOverlay());
		wrap.appendChild(logsButton);

		panel.appendChild(wrap);
	}

	_openLogsOverlay() {
		if (this._overlay) return;
		const doc = this._doc;

		const backdrop = doc.createElement('div');
		backdrop.id = 'commonground-desktop-hud-logs';
		backdrop.style.cssText = [
			'position:fixed',
			'inset:0',
			'z-index:1100',
			'background:rgba(0,0,0,0.6)',
			'display:flex',
			'align-items:center',
			'justify-content:center',
			'pointer-events:auto',
		].join(';');
		backdrop.addEventListener('click', (event) => {
			if (event.target === backdrop) this._closeLogsOverlay();
		});

		const dialog = doc.createElement('div');
		dialog.style.cssText = [
			'width:min(900px, 92vw)',
			'height:82vh',
			'display:flex',
			'flex-direction:column',
			'border-radius:10px',
			'background:#0f172a',
			'border:1px solid rgba(255,255,255,0.2)',
			'overflow:hidden',
			`font:${HUD_FONT}`,
			'color:#fff',
		].join(';');

		const header = doc.createElement('div');
		header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.15);';
		const title = doc.createElement('span');
		title.textContent = 'Session Log';
		title.style.cssText = 'font-weight:600;';
		const closeButton = doc.createElement('button');
		closeButton.type = 'button';
		closeButton.textContent = '✕';
		closeButton.style.cssText = 'background:none;border:1px solid rgba(255,255,255,0.35);border-radius:6px;color:#fff;font:inherit;padding:1px 8px;cursor:pointer;';
		closeButton.addEventListener('click', () => this._closeLogsOverlay());
		header.appendChild(title);
		header.appendChild(closeButton);
		dialog.appendChild(header);

		const iframe = doc.createElement('iframe');
		iframe.src = this._logsUrl;
		iframe.style.cssText = 'flex:1;border:0;background:#fff;';
		dialog.appendChild(iframe);

		backdrop.appendChild(dialog);
		doc.body.appendChild(backdrop);
		doc.addEventListener('keydown', this._onKeyDown);
		this._overlay = backdrop;
	}

	_closeLogsOverlay() {
		if (!this._overlay) return;
		if (this._overlay.parentNode) {
			this._overlay.parentNode.removeChild(this._overlay);
		}
		this._overlay = null;
		this._doc.removeEventListener('keydown', this._onKeyDown);
	}

	dispose() {
		this._closeLogsOverlay();
		if (this._pollTimer) {
			clearInterval(this._pollTimer);
			this._pollTimer = null;
		}
		if (this._statusRefreshTimer) {
			clearTimeout(this._statusRefreshTimer);
			this._statusRefreshTimer = null;
		}
		if (typeof this._unsubscribeStatus === 'function') {
			this._unsubscribeStatus();
			this._unsubscribeStatus = null;
		}
		if (typeof this._unsubscribeEnabled === 'function') {
			this._unsubscribeEnabled();
			this._unsubscribeEnabled = null;
		}
		if (typeof this._unsubscribeStream === 'function') {
			this._unsubscribeStream();
			this._unsubscribeStream = null;
		}
		this._hidePanel();
		if (this._helperHint && this._helperHint.parentNode) {
			this._helperHint.parentNode.removeChild(this._helperHint);
		}
		this._helperHint = null;
		if (this._container && this._container.parentNode) {
			this._container.parentNode.removeChild(this._container);
		}
		this._container = null;
		this._syncCheckbox = null;
		this._tabButtons = new Map();
	}
}
