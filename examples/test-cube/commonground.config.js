// CommonGround project configuration — this is a complete, runnable project.
//
// In the framework repo, `npm run demo` runs the CLI from THIS directory, so
// this file drives the demo and runtime data (anchors, session logs) lands in
// ./data here, dev certificates in ./.certs.
//
// For your own app: copy this directory, adjust the settings below, and run
// `npx commonground serve` (or `commonground serve` after
// `npm install commonground`) from it — the CLI picks this file up
// automatically. All settings optional — see docs/server.md for the reference.
export default {
	dashboard: {
		title: 'Test Cube',
		// One entry per headset. `color` (hex) is used across the TUI, the
		// desktop HUD, the helper page and the streamed desktop figures.
		headsets: [
			{ id: 1, label: 'Headset 1', color: '#e6533c' },
			{ id: 2, label: 'Headset 2', color: '#3ca9e6' },
			{ id: 3, label: 'Headset 3', color: '#57c785' },
			{ id: 4, label: 'Headset 4', color: '#e6c93c' },
		],
	},
};
