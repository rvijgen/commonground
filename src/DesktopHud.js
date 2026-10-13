/**
 * DesktopHud — small framework-owned DOM overlay shown in desktop mode only.
 * Top-right corner; the container ignores pointer events so OrbitControls
 * keeps working, only the widgets themselves are interactive.
 *
 * Contents: a sync on/off toggle bound to cg.sync.enabled (runtime switch,
 * no reload) and a Session Logs link to the server's integrated log viewer.
 * URLs are relative so pages served at a subpath keep working.
 */
export class DesktopHud {
	constructor(cg, { logsUrl = 'commonground/logs', doc } = {}) {
		this._cg = cg;
		this._doc = doc ?? (typeof document !== 'undefined' ? document : null);
		this._logsUrl = logsUrl;
		this._container = null;
		this._syncCheckbox = null;
		this._unsubscribeEnabled = null;

		if (!this._doc) return;
		this._build();
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

		container.appendChild(syncLabel);
		container.appendChild(logsLink);
		doc.body.appendChild(container);

		this._container = container;
		this._syncCheckbox = syncCheckbox;
		this._unsubscribeEnabled = this._cg.sync.onEnabledChange((enabled) => {
			syncCheckbox.checked = enabled;
		});
	}

	dispose() {
		if (typeof this._unsubscribeEnabled === 'function') {
			this._unsubscribeEnabled();
			this._unsubscribeEnabled = null;
		}
		if (this._container && this._container.parentNode) {
			this._container.parentNode.removeChild(this._container);
		}
		this._container = null;
		this._syncCheckbox = null;
	}
}
