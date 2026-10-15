// Minimal CommonGround project configuration — the starting point for your
// own app. Copy it next to your index.html and run `npx commonground serve`
// (or `commonground serve` after `npm install commonground`) from that
// directory; the CLI picks this file up automatically.
//
// Note: this file is NOT read by `npm run demo` in the framework repo —
// that runs from the repo root, where the root commonground.config.js
// applies. All settings optional — see docs/server.md for the reference.
export default {
	space: 'default',
	httpPort: 3001,
	httpsPort: 3002,
	dataDir: 'data',
	certDir: '.certs',

	dashboard: {
		title: 'My CommonGround Project',
		// One entry per headset. `color` (hex) is used across the TUI, the
		// desktop HUD, the helper page and the streamed desktop figures.
		headsets: [
			{ id: 1, label: 'Headset 1', color: '#e6533c' },
			{ id: 2, label: 'Headset 2', color: '#3ca9e6' },
			{ id: 3, label: 'Headset 3', color: '#57c785' },
			{ id: 4, label: 'Headset 4', color: '#e6c93c' },
		],
		// Declares the status shape your app sends via cg.status.update();
		// derives the default status and the session-log entry.
		statusFields: { enteredImmersion: 'boolean' },
		// Fully generated launch page: certificate link, Session Logs,
		// Desktop, and per-headset (+admin) links.
		helperPage: {},
	},
};
